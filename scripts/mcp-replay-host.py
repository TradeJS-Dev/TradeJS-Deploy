#!/usr/bin/env python3
"""Consume exact evidence requests; Docker access stays on the deployment host."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import subprocess
import time


def atomic(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(file)


def validate(request, data, identifier):
    if not re.fullmatch(r'[a-f0-9]{64}', identifier) or request.get('id') != identifier or request.get('schemaVersion') != 1:
        raise ValueError('Invalid replay request identity')
    evidence = (data / request['evidence']).resolve(strict=True)
    if data.resolve() not in evidence.parents or evidence.name != 'runtime-evidence.json':
        raise ValueError('Evidence is outside shared data')
    if not (evidence.parent / '.complete').is_file():
        raise ValueError('Evidence bundle is not sealed')
    payload = evidence.read_bytes()
    if hashlib.sha256(payload).hexdigest() != request['payloadSha256']:
        raise ValueError('Evidence checksum changed')
    manifest = json.loads((evidence.parent / 'manifest.json').read_text())
    if manifest['artifactId'] != request['artifactId'] or manifest['deploymentId'] != request['deploymentId']:
        raise ValueError('Evidence manifest binding mismatch')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', request['deploymentId']):
        raise ValueError('Invalid deployment')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', request['artifactId']):
        raise ValueError('Invalid artifact')
    if (evidence.parent / '.complete').read_text().strip() != manifest['artifactId']:
        raise ValueError('Evidence completion binding mismatch')
    if manifest.get('payload', {}).get('sha256') != request['payloadSha256'] or manifest['payload'].get('bytes') != len(payload):
        raise ValueError('Evidence manifest checksum mismatch')
    return evidence


def prior_result(queue, request):
    # Preserve terminal outcomes from the previous broker protocol as well.
    for result_file in queue.glob('*.result'):
        for suffix in ('.consumed', '.interrupted', '.running', '.request'):
            source = result_file.with_suffix(suffix)
            if source.is_file():
                previous = json.loads(source.read_text())
                if all(previous.get(key) == request.get(key) for key in ('deploymentId', 'artifactId', 'payloadSha256')):
                    return json.loads(result_file.read_text())
                break
    return None


def enqueue_daily(root):
    """Cron publishes to the same queue; failed artifacts are never retried here."""
    data = root / 'data'
    queue = data / 'mcp-replay-requests'
    queue.mkdir(parents=True, exist_ok=True)
    for marker in sorted((data / 'runtime-evidence/ready').glob('*/*/*/*/*/.complete')):
        bundle = marker.parent
        manifest = json.loads((bundle / 'manifest.json').read_text())
        payload = (bundle / 'runtime-evidence.json').read_bytes()
        artifact = manifest['artifactId']
        deployment = manifest['deploymentId']
        if (data / 'runtime-feedback/completed' / deployment / (artifact + '.json')).exists():
            continue
        if any((data / 'runtime-feedback/failed').glob(artifact + '-*')):
            continue
        identifier = hashlib.sha256(('cron:' + manifest['userName'] + ':' + deployment + ':' + artifact + ':' + hashlib.sha256(payload).hexdigest()).encode()).hexdigest()
        request = {'schemaVersion': 1, 'id': identifier, 'evidence': str((bundle / 'runtime-evidence.json').relative_to(data)),
                   'artifactId': artifact, 'deploymentId': deployment, 'payloadSha256': hashlib.sha256(payload).hexdigest(), 'source': 'cron'}
        validate(request, data, identifier)
        if prior_result(queue, request) is not None:
            continue
        file = queue / (identifier + '.request')
        if file.with_suffix('.result').exists() or file.with_suffix('.running').exists():
            continue
        temporary = queue / (identifier + '.publish-' + str(os.getpid()))
        temporary.write_text(json.dumps(request))
        try:
            os.link(temporary, file)
        except FileExistsError:
            pass
        finally:
            temporary.unlink()


def run(root):
    data = root / 'data'
    queue = data / 'mcp-replay-requests'
    queue.mkdir(parents=True, exist_ok=True)
    lock = (queue / '.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    def heartbeat():
        available = next((int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')), None) if Path('/proc/meminfo').exists() else None
        minimum = int(os.environ.get('RUNTIME_FEEDBACK_MIN_AVAILABLE_KB', '7340032'))
        atomic(queue / 'heartbeat.json', {'protocolVersion': 2, 'observedAt': int(time.time() * 1000),
               'memoryAvailableKb': available, 'minimumAvailableKb': minimum,
               'readiness': 'unknown' if available is None else 'waiting_resources' if available < minimum else 'ready'})
    heartbeat()
    # A claimed request is never retried after a host interruption.
    for file in queue.glob('*.running'):
        atomic(file.with_suffix('.result'), {'exitCode': 1, 'message': 'Host replay interrupted; automatic retry forbidden'})
        file.rename(file.with_suffix('.interrupted'))
    for file in sorted(queue.glob('*.request')):
        identifier = file.stem
        if file.with_suffix('.result').exists():
            file.rename(file.with_suffix('.consumed'))
            continue
        claimed = file
        pair = None
        executor = None
        try:
            request = json.loads(claimed.read_text())
            evidence = validate(request, data, identifier)
            if file.with_suffix('.cancel').exists():
                raise ValueError('Replay cancelled before execution')
            payload = json.loads(evidence.read_text())
            identity = [payload['userName'], request['deploymentId'], request['artifactId'], request['payloadSha256']]
            pair = queue / ('pair-' + hashlib.sha256(json.dumps(identity).encode()).hexdigest() + '.json')
            previous = json.loads(pair.read_text()) if pair.exists() else prior_result(queue, request)
            if previous is not None:
                result = previous
                atomic(file.with_suffix('.result'), result)
                claimed.rename(file.with_suffix('.consumed'))
                continue
            completion = data / 'runtime-feedback/completed' / request['deploymentId'] / (request['artifactId'] + '.json')
            if completion.is_file():
                result = {'exitCode': 0, 'message': 'Verified image-bound replay already completed'}
                atomic(file.with_suffix('.result'), result)
                atomic(pair, result)
                claimed.rename(file.with_suffix('.consumed'))
                continue
            env = dict(os.environ, HOME=str(root), RUNTIME_FEEDBACK_DEPLOYMENT_ID=request['deploymentId'],
                       RUNTIME_EVIDENCE_READY_DIR=str(evidence.parent.parent),
                       RUNTIME_FEEDBACK_NOTIFY='true' if request.get('source') == 'cron' else 'false', RUNTIME_FEEDBACK_MAX_BUNDLES_PER_RUN='1')
            # Reserve the same lock used by direct/legacy cron before preflight.
            executor = Path(os.environ.get('RUNTIME_FEEDBACK_LOCK_FILE', root / '.runtime-feedback.lock')).open('a')
            try:
                fcntl.flock(executor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                atomic(file.with_suffix('.state'), {'status': 'waiting_executor'})
                continue
            env['RUNTIME_FEEDBACK_LOCK_FD'] = str(executor.fileno())
            # Preflight does not execute replay. The reservation survives both children.
            preflight = subprocess.run(['bash', str(root / 'scripts/runtime-feedback-replay.sh'), '--preflight'], env=env, capture_output=True, text=True, pass_fds=(executor.fileno(),))
            file.with_suffix('.log').write_text(preflight.stdout + preflight.stderr)
            if preflight.returncode in (75, 76):
                atomic(file.with_suffix('.state'), {'status': 'waiting_resources' if preflight.returncode == 76 else 'waiting_executor'})
                claimed.rename(file)
                continue
            if preflight.returncode != 0:
                raise ValueError('Host replay preflight failed')
            claimed = file.with_suffix('.running')
            file.rename(claimed)
            atomic(pair, {'exitCode': 1, 'message': 'Host replay interrupted; automatic retry forbidden'})
            atomic(file.with_suffix('.state'), {'status': 'running'})
            with file.with_suffix('.log').open('w') as log:
                child = subprocess.Popen(['bash', str(root / 'scripts/runtime-feedback-replay.sh'), '--artifact', request['artifactId']],
                                         env=env, stdout=log, stderr=log, start_new_session=True, pass_fds=(executor.fileno(),))
                deadline = time.monotonic() + 3500
                while child.poll() is None:
                    heartbeat()
                    if file.with_suffix('.cancel').exists() or time.monotonic() > deadline:
                        os.killpg(child.pid, signal.SIGTERM)
                        try:
                            child.wait(timeout=40)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL)
                        raise ValueError('Replay cancelled or timed out; no automatic retry')
                    time.sleep(1)
            if child.returncode in (75, 76):
                pair.unlink()
                atomic(file.with_suffix('.state'), {'status': 'waiting_resources' if child.returncode == 76 else 'waiting_executor'})
                claimed.rename(file)
                continue
            if child.returncode != 0 or not completion.is_file():
                raise ValueError('Host image-bound replay failed; inspect retained host replay logs')
            result = {'exitCode': 0, 'message': 'Verified image-bound replay completed'}
        except Exception as error:
            result = {'exitCode': 1, 'message': str(error)}
        finally:
            if executor is not None:
                executor.close()
        atomic(file.with_suffix('.result'), result)
        if pair is not None:
            atomic(pair, result)
        claimed.rename(file.with_suffix('.consumed'))
        heartbeat()


if __name__ == '__main__':
    root = Path(os.environ.get('DEPLOY_ROOT', Path.home())).resolve()
    if '--enqueue-daily' in sys.argv:
        enqueue_daily(root)
    run(root)
