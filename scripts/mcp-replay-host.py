#!/usr/bin/env python3
"""Consume exact evidence requests; Docker access stays on the deployment host."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
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
    return evidence


def run(root):
    data = root / 'data'
    queue = data / 'mcp-replay-requests'
    queue.mkdir(parents=True, exist_ok=True)
    lock = (queue / '.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    heartbeat = lambda: atomic(queue / 'heartbeat.json', {'observedAt': int(time.time() * 1000)})
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
        claimed = file.with_suffix('.running')
        file.rename(claimed)
        try:
            request = json.loads(claimed.read_text())
            evidence = validate(request, data, identifier)
            if file.with_suffix('.cancel').exists():
                raise ValueError('Replay cancelled before execution')
            env = dict(os.environ, HOME=str(root), RUNTIME_FEEDBACK_DEPLOYMENT_ID=request['deploymentId'],
                       RUNTIME_EVIDENCE_READY_DIR=str(evidence.parent.parent),
                       RUNTIME_FEEDBACK_NOTIFY='false', RUNTIME_FEEDBACK_MAX_BUNDLES_PER_RUN='1')
            with file.with_suffix('.log').open('w') as log:
                child = subprocess.Popen(['bash', str(root / 'scripts/runtime-feedback-replay.sh'), '--artifact', request['artifactId']],
                                         env=env, stdout=log, stderr=log, start_new_session=True)
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
            completion = data / 'runtime-feedback/completed' / request['deploymentId'] / (request['artifactId'] + '.json')
            if child.returncode != 0 or not completion.is_file():
                raise ValueError('Host image-bound replay failed; inspect retained host replay logs')
            result = {'exitCode': 0, 'message': 'Verified image-bound replay completed'}
        except Exception as error:
            result = {'exitCode': 1, 'message': str(error)}
        atomic(file.with_suffix('.result'), result)
        claimed.rename(file.with_suffix('.consumed'))
        heartbeat()


if __name__ == '__main__':
    run(Path(os.environ.get('DEPLOY_ROOT', Path.home())).resolve())
