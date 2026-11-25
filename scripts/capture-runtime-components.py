#!/usr/bin/env python3
"""Publish a secret-free, observed component inventory for the read-only MCP."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

COMPONENTS = {
    'app': ('APP_IMAGE_TAG', 'tradejs-project-app'),
    'agent': ('AGENT_IMAGE_TAG', 'tradejs-agent'),
    'ml-infer': ('ML_INFER_IMAGE_TAG', 'tradejs-ml-infer'),
    'site': ('SITE_IMAGE_TAG', 'tradejs-site'),
    'docs': ('DOCS_IMAGE_TAG', 'tradejs-docs'),
}
SHA = re.compile(r'[a-f0-9]{40}')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
# Docker omits the Health key for containers without a healthcheck.
CONTAINER_FORMAT = '{"containerId":{{json .Id}},"imageId":{{json .Image}},"state":{{json .State.Status}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"exitCode":{{json .State.ExitCode}},"restartCount":{{json .RestartCount}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}}'
IMAGE_FORMAT = '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}'


def docker(*args):
    # Never export docker's full inspect output, Compose environment or stderr.
    try:
        return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.DEVNULL, timeout=30).strip()
    except (subprocess.SubprocessError, OSError) as error:
        raise RuntimeError('Docker component observation failed') from error


def atomic(file, value):
    temporary = file.with_name('.' + file.name + '.' + uuid.uuid4().hex)
    try:
        temporary.write_text(json.dumps(value, separators=(',', ':')) + '\n')
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def declarations(release_bytes, compose_bytes):
    values = {}
    for line in release_bytes.decode().splitlines():
        key, separator, value = line.partition('=')
        if not separator or key in values or key not in {'PROJECT_SHA', *(c[0] for c in COMPONENTS.values())} or not SHA.fullmatch(value):
            raise ValueError('Invalid component release declaration')
        values[key] = value
    if len(values) != 6 or values.get('PROJECT_SHA') != values.get('APP_IMAGE_TAG'):
        raise ValueError('Incomplete component release declaration')
    expected = {name: (f'ghcr.io/tradejs-dev/{repo}:{values[key]}', values[key]) for name, (key, repo) in COMPONENTS.items()}
    # These services use immutable digests declared in Deploy, not release.env.
    for name in ('certbot', 'certbot-cron'):
        block = re.search(r'^  ' + name + r':\n(.*?)(?=^  [\w-]+:|\Z)', compose_bytes.decode(), re.M | re.S)
        image = re.search(r'^    image: (ghcr\.io/tradejs-dev/tradejs-certbot@sha256:[a-f0-9]{64})\s*$', block[1], re.M) if block else None
        if not image:
            raise ValueError('Certbot must declare an immutable image digest')
        expected[name] = (image[1], None)
    return values['PROJECT_SHA'], expected


def containers():
    names = set(docker('container', 'ls', '--all', '--format', '{{.Names}}').splitlines())
    return {name: json.loads(docker('inspect', '--format', CONTAINER_FORMAT, name)) if name in names else None for name in (*COMPONENTS, 'certbot', 'certbot-cron')}


def component(name, expected, container):
    image, source_sha = expected
    result = dict(name=name, declaredImage=image, sourceSha=source_sha, containerId=None, imageId=None, imageDigest=None, state='missing', running=False, health=None, startedAt=None, restartCount=None, exitCode=None, matchesRelease=None, ok=False)
    if container is None:
        return result
    if not DIGEST.fullmatch(container['imageId']):
        raise ValueError('Invalid observed image ID')
    actual = json.loads(docker('image', 'inspect', '--format', IMAGE_FORMAT, container['imageId']))
    repository = image.split('@')[0].split(':')[0]
    digests = sorted(set(d[len(repository) + 1:] for d in actual.get('repoDigests') or [] if d.startswith(repository + '@')))
    if any(not DIGEST.fullmatch(d) for d in digests):
        raise ValueError('Invalid observed repository digest')
    digest = image.split('@')[1] if '@' in image and image.split('@')[1] in digests else digests[0] if len(digests) == 1 else None
    try:
        desired = json.loads(docker('image', 'inspect', '--format', IMAGE_FORMAT, image))
        matches = actual['id'] == container['imageId'] == desired['id']
    except RuntimeError:
        matches = None
    if '@' in image and matches is not None:
        matches = matches is True and digest == image.split('@')[1]
    acceptable_state = (container['running'] and container['state'] == 'running') or (name == 'certbot' and container['state'] == 'exited' and container['exitCode'] == 0)
    result.update({k: container[k] for k in ('containerId', 'imageId', 'state', 'running', 'health', 'startedAt', 'restartCount', 'exitCode')})
    result.update(imageDigest=digest, matchesRelease=matches, ok=bool(matches and digest and acceptable_state and container['health'] in (None, 'healthy')))
    return result


def capture(root):
    directory = root / 'data/runtime-components/root'
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.capture.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        attempt = directory / 'latest-attempt.json'
        atomic(attempt, dict(observedAt=int(time.time() * 1000), status='running'))
        try:
            release = (root / 'release.env').read_bytes()
            compose = (root / 'docker-compose.prod.yml').read_bytes()
            deploy_sha = (root / 'data/runtime-components/deploy-source-sha').read_text().strip()
            if not SHA.fullmatch(deploy_sha):
                raise ValueError('Invalid Deploy source SHA')
            project_sha, expected = declarations(release, compose)
            before = containers()
            components = [component(name, definition, before[name]) for name, definition in expected.items()]
            # Reject a rollout crossing this capture rather than seal a mixed snapshot.
            if release != (root / 'release.env').read_bytes() or compose != (root / 'docker-compose.prod.yml').read_bytes() or before != containers() or deploy_sha != (root / 'data/runtime-components/deploy-source-sha').read_text().strip():
                raise ValueError('Component state changed during observation')
            report = dict(schemaVersion=1, reportType='runtime-components', userName='root', projectSha=project_sha, deploySourceSha=deploy_sha, observedAt=int(time.time() * 1000), ok=all(c['ok'] for c in components), components=components)
            payload = (json.dumps(report, separators=(',', ':')) + '\n').encode()
            if len(payload) > 48000:
                raise ValueError('Component snapshot exceeds MCP limit')
            sha = hashlib.sha256(payload).hexdigest()
            # A single atomic envelope binds the payload and checksum.
            atomic(directory / 'latest.json', dict(bytes=len(payload), sha256=sha, data=base64.b64encode(payload).decode()))
            atomic(attempt, dict(observedAt=report['observedAt'], status='succeeded', sha256=sha))
            return report
        except Exception:
            atomic(attempt, dict(observedAt=int(time.time() * 1000), status='failed'))
            raise


if __name__ == '__main__':
    try:
        capture(Path(os.environ.get('DEPLOY_ROOT', str(Path.home()))))
    except Exception:
        raise SystemExit('Component snapshot collection failed; see latest-attempt.json')
