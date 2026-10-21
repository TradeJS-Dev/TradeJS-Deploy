import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('host consumes once, binds checksum, suppresses notifications and never retries interrupted requests', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, tempfile, pathlib, json, hashlib
spec=importlib.util.spec_from_file_location('runner','scripts/mcp-replay-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);data=root/'data';q=data/'mcp-replay-requests';q.mkdir(parents=True)
 bundle=data/'runtime-evidence/ready/production/test';bundle.mkdir(parents=True)
 (bundle/'runtime-evidence.json').write_text('{}');(bundle/'.complete').touch()
 (bundle/'manifest.json').write_text(json.dumps({'artifactId':'test','deploymentId':'production'}))
 request={'schemaVersion':1,'id':'a'*64,'evidence':str((bundle/'runtime-evidence.json').relative_to(data)), 'artifactId':'test','deploymentId':'production','payloadSha256':hashlib.sha256(b'{}').hexdigest()}
 scripts=root/'scripts';scripts.mkdir()
 (scripts/'runtime-feedback-replay.sh').write_text('test "$RUNTIME_FEEDBACK_NOTIFY" = false || exit 9\\nmkdir -p "$HOME/data/runtime-feedback/completed/production"\\necho "{}" > "$HOME/data/runtime-feedback/completed/production/test.json"\\necho run >> "$HOME/calls"\\n')
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
