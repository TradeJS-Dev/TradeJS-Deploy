import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const source of ['cron', 'mcp']) test(`host consumes once with disabled notifications for ${source}`, () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, tempfile, pathlib, json, hashlib, fcntl, os
os.environ['RUNTIME_FEEDBACK_NOTIFY']='false'
spec=importlib.util.spec_from_file_location('runner','scripts/mcp-replay-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);data=root/'data';q=data/'mcp-replay-requests';q.mkdir(parents=True)
 bundle=data/'runtime-evidence/ready/production/test';bundle.mkdir(parents=True)
 (bundle/'runtime-evidence.json').write_text('{"userName":"root"}');(bundle/'.complete').write_text('test')
 (bundle/'manifest.json').write_text(json.dumps({'artifactId':'test','deploymentId':'production','payload':{'sha256':hashlib.sha256((bundle/'runtime-evidence.json').read_bytes()).hexdigest(),'bytes':(bundle/'runtime-evidence.json').stat().st_size}}))
 request={'schemaVersion':1,'id':'a'*64,'evidence':str((bundle/'runtime-evidence.json').relative_to(data)), 'artifactId':'test','deploymentId':'production','payloadSha256':hashlib.sha256((bundle/'runtime-evidence.json').read_bytes()).hexdigest()}
 request['source']='${source}'
 scripts=root/'scripts';scripts.mkdir()
 (scripts/'runtime-feedback-replay.sh').write_text('if [ "$1" = --preflight ]; then exit 0; fi\\ntest "$RUNTIME_FEEDBACK_NOTIFY" = false || exit 9\\nmkdir -p "$HOME/data/runtime-feedback/completed/production"\\necho "{}" > "$HOME/data/runtime-feedback/completed/production/test.json"\\necho run >> "$HOME/calls"\\n')
 file=q/(request['id']+'.request');file.write_text(json.dumps(request));m.run(root)
 assert json.loads(file.with_suffix('.result').read_text())['exitCode']==0
 file.write_text(json.dumps(request));m.run(root);assert (root/'calls').read_text().count('run')==1
 request['id']='b'*64;request['payloadSha256']='0'*64
 file=q/(request['id']+'.request');file.write_text(json.dumps(request));m.run(root)
 assert json.loads(file.with_suffix('.result').read_text())['exitCode']==1
 interrupted=q/('c'*64+'.running');interrupted.write_text('{}');m.run(root)
 assert 'automatic retry forbidden' in interrupted.with_suffix('.result').read_text()
 request['id']='d'*64;request['evidence']='../../outside/runtime-evidence.json'
 try:m.validate(request,data,request['id'])
 except (ValueError,FileNotFoundError):pass
 else:raise AssertionError('path escaped')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('resource and executor waits survive cycles without executing replay or consuming the request', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, tempfile, pathlib, json, hashlib, fcntl
spec=importlib.util.spec_from_file_location('runner','scripts/mcp-replay-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);data=root/'data';q=data/'mcp-replay-requests';q.mkdir(parents=True)
 bundle=data/'runtime-evidence/ready/production/test';bundle.mkdir(parents=True)
 payload=b'{"userName":"root"}'
 (bundle/'runtime-evidence.json').write_bytes(payload);(bundle/'.complete').write_text('test')
 (bundle/'manifest.json').write_text(json.dumps({'artifactId':'test','deploymentId':'production','userName':'root','payload':{'sha256':hashlib.sha256(payload).hexdigest(),'bytes':len(payload)}}))
 request={'schemaVersion':1,'id':'e'*64,'evidence':str((bundle/'runtime-evidence.json').relative_to(data)), 'artifactId':'test','deploymentId':'production','payloadSha256':hashlib.sha256(payload).hexdigest()}
 scripts=root/'scripts';scripts.mkdir();script=scripts/'runtime-feedback-replay.sh'
 file=q/(request['id']+'.request');file.write_text(json.dumps(request))
 held=(root/'.runtime-feedback.lock').open('a');fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
 m.run(root)
 assert json.loads(file.with_suffix('.state').read_text())['status']=='waiting_executor'
 assert not file.with_suffix('.result').exists()
 held.close()
 for code,status in [(76,'waiting_resources'),(75,'waiting_executor')]:
  script.write_text('exit '+str(code))
  m.run(root);m.run(root)
  assert file.is_file() and not file.with_suffix('.result').exists()
  assert not file.with_suffix('.running').exists()
  assert json.loads(file.with_suffix('.state').read_text())['status']==status
 script.write_text('python3 -c "import fcntl,sys;fcntl.flock(int(sys.argv[1]),fcntl.LOCK_EX|fcntl.LOCK_NB)" "$RUNTIME_FEEDBACK_LOCK_FD" || exit 99\\nif [ "$1" = --preflight ]; then exit 0; fi\\nmkdir -p "$HOME/data/runtime-feedback/completed/production"\\necho "{}" > "$HOME/data/runtime-feedback/completed/production/test.json"\\necho run >> "$HOME/calls"\\n')
 m.run(root)
 assert json.loads(file.with_suffix('.result').read_text())['exitCode']==0
 # A second client has another id but the same pair and must reuse the result.
 request['id']='f'*64;second=q/(request['id']+'.request');second.write_text(json.dumps(request));m.run(root)
 assert json.loads(second.with_suffix('.result').read_text())['exitCode']==0
 assert (root/'calls').read_text().count('run')==1
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('cron discovers dated bundles and never requeues a historical terminal failure', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util,tempfile,pathlib,json,hashlib
spec=importlib.util.spec_from_file_location('runner','scripts/mcp-replay-host.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);data=root/'data';bundle=data/'runtime-evidence/ready/production/2026/10/29/test';bundle.mkdir(parents=True)
 payload=b'{"userName":"root"}';sha=hashlib.sha256(payload).hexdigest()
 (bundle/'runtime-evidence.json').write_bytes(payload);(bundle/'.complete').write_text('test')
 (bundle/'manifest.json').write_text(json.dumps({'artifactId':'test','deploymentId':'production','userName':'root','payload':{'bytes':len(payload),'sha256':sha}}))
 m.enqueue_daily(root);q=data/'mcp-replay-requests';files=list(q.glob('*.request'));assert len(files)==1
 request=json.loads(files[0].read_text());assert request['source']=='cron'
 files[0].with_suffix('.log').write_text('original replay failure\\n')
 files[0].rename(files[0].with_suffix('.consumed'));files[0].with_suffix('.result').write_text(json.dumps({'exitCode':1,'message':'old preflight failure'}))
 m.enqueue_daily(root);assert len(list(q.glob('*.request')))==0
 # A new MCP id must also return the original failed result, never run shell.
 request['id']='a'*64;file=q/(request['id']+'.request');file.write_text(json.dumps(request));m.run(root)
 result=json.loads(file.with_suffix('.result').read_text())
 assert result['message']=='old preflight failure'
 assert result['logRequestId']==files[0].stem
 assert (q/(result['logRequestId']+'.log')).read_text()=='original replay failure\\n'
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('broker never truncates shared symlink or hard-link targets and rejects linked parents', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, tempfile, pathlib, os, json
spec=importlib.util.spec_from_file_location('runner','scripts/mcp-replay-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)/'host';root.mkdir();outside=pathlib.Path(tmp)/'outside';outside.mkdir()
 victim=outside/'keep';victim.write_text('unchanged')
 q=root/'data/mcp-replay-requests';q.mkdir(parents=True)
 (q/'.lock').symlink_to(victim)
 (q/'heartbeat.json.tmp').symlink_to(victim)
 (q/'heartbeat.json').symlink_to(victim)
 with m.BrokerFiles(root) as files:
  files.atomic(q/'heartbeat.json', {'ok':True})
  assert json.loads((q/'heartbeat.json').read_text())=={'ok':True}
  log=q/'test.log';os.link(victim, log)
  with files.output(log) as stream:stream.write('new log')
  assert log.read_text()=='new log' and victim.read_text()=='unchanged'
  for name in ['linked.request','linked.result']:
   file=q/name;file.symlink_to(victim)
   try:files.read(file)
   except OSError:pass
   else:raise AssertionError('followed linked input')
  (root/'data/linked').symlink_to(outside, target_is_directory=True)
  for operation in [lambda:files.atomic(root/'data/linked/keep', {}), lambda:files.publish(root/'data/linked/new.request', {})]:
   try:operation()
   except OSError:pass
   else:raise AssertionError('followed directory link')
  # Renaming the shared parent after it has been opened cannot redirect writes.
  with files.parent(q/'swap.json') as (fd,name):
   moved=q.with_name('original');q.rename(moved);q.symlink_to(outside,target_is_directory=True)
   descriptor=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=fd)
   os.write(descriptor,b'ok');os.close(descriptor)
   assert (moved/'swap.json').read_text()=='ok'
   assert not (outside/'swap.json').exists()
 assert victim.read_text()=='unchanged'
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('broker keeps operator lock overrides and waits for an old-release lock', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util,tempfile,pathlib,fcntl
spec=importlib.util.spec_from_file_location('runner','scripts/mcp-replay-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)/'host';root.mkdir();queue=root/'data/mcp-replay-requests';queue.mkdir(parents=True)
 with m.BrokerFiles(root) as files:
  outside=pathlib.Path(tmp)/'operator.lock';outside.write_text('keep')
  with files.host_lock(outside) as lock:
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   assert outside.read_text()=='keep'
 with (queue/'.lock').open('w') as legacy:
  fcntl.flock(legacy,fcntl.LOCK_EX|fcntl.LOCK_NB)
  m.run(root)
  assert not (queue/'heartbeat.json').exists()
 m.run(root)
 assert (queue/'heartbeat.json').is_file()
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
