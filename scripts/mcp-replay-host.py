#!/usr/bin/env python3
"""Consume exact evidence requests; Docker access stays on the deployment host."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import secrets
from contextlib import contextmanager
import sys
import subprocess
import time


sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_files import BrokerFiles


def validate(request, data, identifier, files=None):
    read = files.read if files else lambda file: file.read_bytes()
    if not re.fullmatch(r'[a-f0-9]{64}', identifier) or request.get('id') != identifier or request.get('schemaVersion') != 1:
        raise ValueError('Invalid replay request identity')
    evidence = (data / request['evidence']).resolve(strict=True)
    if data.resolve() not in evidence.parents or evidence.name != 'runtime-evidence.json':
        raise ValueError('Evidence is outside shared data')
    if not (evidence.parent / '.complete').is_file():
        raise ValueError('Evidence bundle is not sealed')
    payload = read(evidence)
    if hashlib.sha256(payload).hexdigest() != request['payloadSha256']:
        raise ValueError('Evidence checksum changed')
    manifest = json.loads(read(evidence.parent / 'manifest.json'))
    if manifest['artifactId'] != request['artifactId'] or manifest['deploymentId'] != request['deploymentId']:
        raise ValueError('Evidence manifest binding mismatch')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', request['deploymentId']):
        raise ValueError('Invalid deployment')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', request['artifactId']):
        raise ValueError('Invalid artifact')
    if read(evidence.parent / '.complete').decode().strip() != manifest['artifactId']:
        raise ValueError('Evidence completion binding mismatch')
    if manifest.get('payload', {}).get('sha256') != request['payloadSha256'] or manifest['payload'].get('bytes') != len(payload):
        raise ValueError('Evidence manifest checksum mismatch')
    return evidence


def prior_result(queue, request, files):
    # Preserve terminal outcomes from the previous broker protocol as well.
    fallback = None
    for result_file in queue.glob('*.result'):
        for suffix in ('.consumed', '.interrupted', '.running', '.request'):
            source = result_file.with_suffix(suffix)
            if source.is_file():
                previous = json.loads(files.read(source))
                if all(previous.get(key) == request.get(key) for key in ('deploymentId', 'artifactId', 'payloadSha256')):
                    result = json.loads(files.read(result_file))
                    result.setdefault('logRequestId', result_file.stem)
                    log_id = result['logRequestId']
                    if re.fullmatch(r'[a-f0-9]{64}', log_id) and (queue / (log_id + '.log')).is_file():
                        return result
                    fallback = result
                break
    return fallback


def enqueue_daily(root):
    with BrokerFiles(root) as files:
        return _enqueue_daily(root, files)


def _enqueue_daily(root, files):
    """Cron publishes to the same queue; failed artifacts are never retried here."""
    data = root / 'data'
    queue = data / 'mcp-replay-requests'
    with files.parent(queue / '.directory-check'):
        pass
    for marker in sorted((data / 'runtime-evidence/ready').glob('*/*/*/*/*/.complete')):
        bundle = marker.parent
        manifest = json.loads(files.read(bundle / 'manifest.json'))
        payload = files.read(bundle / 'runtime-evidence.json')
        artifact = manifest['artifactId']
        deployment = manifest['deploymentId']
        if (data / 'runtime-feedback/completed' / deployment / (artifact + '.json')).exists():
            continue
        if any((data / 'runtime-feedback/failed').glob(artifact + '-*')):
            continue
        identifier = hashlib.sha256(('cron:' + manifest['userName'] + ':' + deployment + ':' + artifact + ':' + hashlib.sha256(payload).hexdigest()).encode()).hexdigest()
        request = {'schemaVersion': 1, 'id': identifier, 'evidence': str((bundle / 'runtime-evidence.json').relative_to(data)),
                   'artifactId': artifact, 'deploymentId': deployment, 'payloadSha256': hashlib.sha256(payload).hexdigest(), 'source': 'cron'}
        validate(request, data, identifier, files)
        if prior_result(queue, request, files) is not None:
            continue
        file = queue / (identifier + '.request')
        if file.with_suffix('.result').exists() or file.with_suffix('.running').exists():
            continue
        files.publish(file, request)


def run(root):
    with BrokerFiles(root) as files:
        return _run(root, files)


def _run(root, files):
    atomic = files.atomic
    data = root / 'data'
    queue = data / 'mcp-replay-requests'
    with files.parent(queue / '.directory-check'):
        pass
    lock = files.lock(root / '.mcp-replay-host.lock')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Serialize with a broker from the previous release without truncation.
        legacy_lock = files.lock(queue / '.lock')
        fcntl.flock(legacy_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    def heartbeat():
        available = next((int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')), None) if Path('/proc/meminfo').exists() else None
        minimum = int(os.environ.get('RUNTIME_FEEDBACK_MIN_AVAILABLE_KB', '5242880'))
        atomic(queue / 'heartbeat.json', {'protocolVersion': 2, 'observedAt': int(time.time() * 1000),
               'memoryAvailableKb': available, 'minimumAvailableKb': minimum,
               'readiness': 'unknown' if available is None else 'waiting_resources' if available < minimum else 'ready'})
    heartbeat()
    # A claimed request is never retried after a host interruption.
    for file in queue.glob('*.running'):
        atomic(file.with_suffix('.result'), {'exitCode': 1, 'message': 'Host replay interrupted; automatic retry forbidden'})
        files.rename(file, file.with_suffix('.interrupted'))
    for file in sorted(queue.glob('*.request')):
        identifier = file.stem
        if file.with_suffix('.result').exists():
            files.rename(file, file.with_suffix('.consumed'))
            continue
        claimed = file
        pair = None
        executor = None
        try:
            request = json.loads(files.read(claimed))
            evidence = validate(request, data, identifier, files)
            if file.with_suffix('.cancel').exists():
                raise ValueError('Replay cancelled before execution')
            payload = json.loads(files.read(evidence))
            identity = [payload['userName'], request['deploymentId'], request['artifactId'], request['payloadSha256']]
            pair = root / '.mcp-replay-host' / ('pair-' + hashlib.sha256(json.dumps(identity).encode()).hexdigest() + '.json')
            previous = json.loads(files.read(pair)) if pair.exists() else prior_result(queue, request, files)
            if previous is not None:
                if 'logRequestId' not in previous:
                    previous = prior_result(queue, request, files) or previous
                result = previous
                atomic(file.with_suffix('.result'), result)
                files.rename(claimed, file.with_suffix('.consumed'))
                continue
            completion = data / 'runtime-feedback/completed' / request['deploymentId'] / (request['artifactId'] + '.json')
            if completion.is_file():
                result = {'exitCode': 0, 'message': 'Verified image-bound replay already completed'}
                atomic(file.with_suffix('.result'), result)
                atomic(pair, result)
                files.rename(claimed, file.with_suffix('.consumed'))
                continue
            env = dict(os.environ, HOME=str(root), RUNTIME_FEEDBACK_DEPLOYMENT_ID=request['deploymentId'],
                       RUNTIME_EVIDENCE_READY_DIR=str(evidence.parent.parent),
                       RUNTIME_FEEDBACK_NOTIFY=os.environ.get('RUNTIME_FEEDBACK_NOTIFY', 'true') if request.get('source') == 'cron' else 'false', RUNTIME_FEEDBACK_MAX_BUNDLES_PER_RUN='1')
            # Reserve the same lock used by direct/legacy cron before preflight.
            executor = files.host_lock(Path(os.environ.get('RUNTIME_FEEDBACK_LOCK_FILE', root / '.runtime-feedback.lock')))
            try:
                fcntl.flock(executor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                atomic(file.with_suffix('.state'), {'status': 'waiting_executor'})
                continue
            env['RUNTIME_FEEDBACK_LOCK_FD'] = str(executor.fileno())
            # Preflight does not execute replay. The reservation survives both children.
            preflight = subprocess.run(['bash', str(root / 'scripts/runtime-feedback-replay.sh'), '--preflight'], env=env, capture_output=True, text=True, pass_fds=(executor.fileno(),))
            with files.output(file.with_suffix('.log')) as log:
                log.write(preflight.stdout + preflight.stderr)
            if preflight.returncode in (75, 76):
                atomic(file.with_suffix('.state'), {'status': 'waiting_resources' if preflight.returncode == 76 else 'waiting_executor'})
                files.rename(claimed, file)
                continue
            if preflight.returncode != 0:
                raise ValueError('Host replay preflight failed')
            claimed = file.with_suffix('.running')
            files.rename(file, claimed)
            atomic(pair, {'exitCode': 1, 'message': 'Host replay interrupted; automatic retry forbidden'})
            atomic(file.with_suffix('.state'), {'status': 'running'})
            with files.output(file.with_suffix('.log')) as log:
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
                files.rename(claimed, file)
                continue
            if child.returncode != 0 or not completion.is_file():
                raise ValueError('Host image-bound replay failed; inspect retained host replay logs')
            result = {'exitCode': 0, 'message': 'Verified image-bound replay completed'}
        except Exception as error:
            result = {'exitCode': 1, 'message': str(error)}
        finally:
            if executor is not None:
                executor.close()
        result.setdefault('logRequestId', identifier)
        atomic(file.with_suffix('.result'), result)
        if pair is not None:
            atomic(pair, result)
        files.rename(claimed, file.with_suffix('.consumed'))
        heartbeat()


if __name__ == '__main__':
    root = Path(os.environ.get('DEPLOY_ROOT', Path.home())).resolve()
    if '--enqueue-daily' in sys.argv:
        enqueue_daily(root)
    run(root)
