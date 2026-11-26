#!/usr/bin/env python3
"""Collect observations in host-private scratch and safely publish shared receipts."""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tempfile
import tarfile
import time

from host_files import BrokerFiles

LIMIT = 48_000
SHA = re.compile('[a-f0-9]{40}')
DIGEST = re.compile('sha256:[a-f0-9]{64}')
IDENTITY = re.compile('[a-zA-Z0-9_-]+')


def docker(*args, limit=1024 * 1024):
    process = subprocess.Popen(['docker', *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    output = bytearray()
    deadline = time.monotonic() + 120
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Docker observation timed out')
                if not selector.select(min(remaining, 1)):
                    continue
                chunk = os.read(process.stdout.fileno(), min(65536, limit + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > limit:
                    raise ValueError('Docker observation exceeds its size limit')
        if process.wait(timeout=max(0.1, deadline - time.monotonic())):
            raise RuntimeError('Docker observation failed')
        return bytes(output).strip()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()


def app_manifest():
    # Read the bounded archive in memory. Never extract app-controlled filesystem
    # entries (links, devices or paths) into the host's private workspace.
    raw = docker('cp', 'app:/app/runtime-package-manifest.json', '-', limit=LIMIT + 10240)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) != 1 or not members[0].isfile() or members[0].size > LIMIT:
            raise ValueError('Manifest must be one bounded ordinary file')
        return archive.extractfile(members[0]).read(LIMIT + 1)


def previous_deploy(files, source, target):
    pointer_path = source / 'deploy.json'
    try:
        raw = files.read(pointer_path, LIMIT)
    except FileNotFoundError:
        return
    if len(raw) > LIMIT:
        raise ValueError('Oversized verification pointer')
    pointer = json.loads(raw)
    if not re.fullmatch(r'[a-f0-9]{64}\.json', pointer.get('file', '')):
        raise ValueError('Invalid deploy receipt')
    payload = files.read(source / pointer['file'], LIMIT)
    if len(payload) > LIMIT or len(payload) != pointer['bytes'] or hashlib.sha256(payload).hexdigest() != pointer['sha256']:
        raise ValueError('Corrupt deploy receipt')
    target.mkdir(parents=True, exist_ok=True)
    (target / 'deploy.json').write_bytes(raw)
    (target / pointer['file']).write_bytes(payload)


def publish(files, source, target):
    # The private codec output contains only allowlisted receipts/pointers.
    for file in source.iterdir():
        if not file.is_file() or file.is_symlink() or not re.fullmatch(r'(?:[a-f0-9]{64}|deploy|latest)\.json', file.name):
            raise ValueError('Unexpected verification codec output')
        payload = file.read_bytes()
        if len(payload) > LIMIT:
            raise ValueError('Oversized verification output')
        if re.fullmatch(r'[a-f0-9]{64}\.json', file.name) and hashlib.sha256(payload).hexdigest() != file.stem:
            raise ValueError('Corrupt verification codec output')
    # Publish content-addressed data before its pointers, preserving exact bytes.
    for file in sorted(source.iterdir(), key=lambda p: p.name in ('latest.json', 'deploy.json')):
        files.atomic_bytes(target / file.name, file.read_bytes())


def capture(root, mode):
    if mode not in ('deploy', 'observe'):
        raise ValueError('Invalid verification mode')
    with BrokerFiles(root) as files:
        private = files.private_directory()
        with files.lock(private / 'verification.lock') as lock:
            deadline = time.monotonic() + (60 if mode == 'deploy' else 0)
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if mode == 'observe':
                        return 0
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Verification collector lock timed out')
                    time.sleep(0.1)
            return collect(root, mode, files, private)


def collect(root, mode, files, private):
    image_id = docker('inspect', '--format', '{{.Image}}', 'app').decode()
    entries = dict(line.split('=', 1) for line in (root / 'release.env').read_text().splitlines() if '=' in line)
    project_sha = entries.get('APP_IMAGE_TAG', '')
    if not SHA.fullmatch(project_sha):
        raise ValueError('Invalid Project SHA')
    expected_id = docker('image', 'inspect', '--format', '{{.Id}}', 'ghcr.io/tradejs-dev/tradejs-project-app:' + project_sha).decode()
    if image_id != expected_id or not DIGEST.fullmatch(image_id):
        raise ValueError('App image differs from release')
    digests = docker('image', 'inspect', '--format', '{{range .RepoDigests}}{{println .}}{{end}}', image_id).decode().splitlines()
    digest = next((x.split('@', 1)[1] for x in digests if x.startswith('ghcr.io/tradejs-dev/tradejs-project-app@')), '')
    if not DIGEST.fullmatch(digest):
        raise ValueError('Invalid app image digest')
    targets = docker('exec', 'app', 'printenv', 'SIGNALS_DAEMON_DEPLOYMENT_ID').decode().split(',')
    status = 0
    with tempfile.TemporaryDirectory(prefix='verification-', dir=private) as directory:
        work = Path(directory)
        manifest_bytes = app_manifest()
        files.atomic_bytes(work / 'manifest.json', manifest_bytes)
        manifest = json.loads(manifest_bytes)
        if manifest.get('projectSha') != project_sha:
            raise ValueError('Manifest Project SHA differs from release')
        info = '{{json .State}}'
        state = json.loads(docker('inspect', '--format', info, 'app'))
        container = {'health': state.get('Health', {}).get('Status', 'missing'), 'startedAt': state['StartedAt'], 'restartCount': int(docker('inspect', '--format', '{{.RestartCount}}', 'app')), 'imageDigest': digest}
        (work / 'container.json').write_text(json.dumps(container))
        for deployment in targets:
            if not IDENTITY.fullmatch(deployment):
                status = 1
                continue
            target = root / 'data/runtime-verification/root' / deployment
            def attempt(value):
                files.atomic(target / 'latest-attempt.json', {'projectSha': project_sha, 'imageDigest': digest, 'observedAt': int(time.time() * 1000), 'status': value})
            try:
                attempt('running')
                verified = docker('exec', 'app', './node_modules/.bin/tradejs', 'runtime-control', 'verify', '--user', 'root', '--deployment', deployment)
                if len(verified) > LIMIT:
                    raise ValueError('Oversized verification input')
                verification = json.loads(verified)
                result = verification.get('results', [])[0]
                if verification.get('userName') != 'root' or len(verification['results']) != 1 or result.get('deploymentId') != deployment:
                    raise ValueError('Verification target changed')
                composition = result['strategies'][0]['deploymentCompositionId']
                if not re.fullmatch('dc1:[a-f0-9]+', composition):
                    raise ValueError('Invalid composition identity')
                (work / 'verify.json').write_bytes(verified)
                identity = f'{image_id}:{container["startedAt"]}'
                if docker('inspect', '--format', '{{.Image}}:{{.State.StartedAt}}', 'app').decode() != identity:
                    raise ValueError('App changed during verification')
                relative = Path('root') / deployment / project_sha / composition
                private_output = work / 'published' / relative
                if mode == 'observe':
                    previous_deploy(files, private / 'verification' / relative, private_output)
                docker('run', '--sysctl', 'net.mptcp.enabled=0', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', '-v', f'{root / "scripts"}:/collector:ro', '-v', f'{work}:/collector-work', image_id, '/collector/write-runtime-verification.mjs', '/collector-work/published', '/collector-work/manifest.json', '/collector-work/verify.json', '/collector-work/container.json', mode)
                publish(files, private_output, private / 'verification' / relative)
                publish(files, private_output, root / 'data/runtime-verification' / relative)
                attempt('succeeded')
            except Exception as error:
                print('Verification observation failed:', type(error).__name__, file=sys.stderr)
                try:
                    attempt('failed')
                except Exception as marker_error:
                    print('Verification failure marker unavailable:', type(marker_error).__name__, file=sys.stderr)
                status = 1
    return status


if __name__ == '__main__':
    try:
        raise SystemExit(capture(Path(os.environ.get('DEPLOY_ROOT', str(Path.home()))), sys.argv[1] if len(sys.argv) > 1 else 'observe'))
    except Exception:
        raise SystemExit('Verification collection failed')
