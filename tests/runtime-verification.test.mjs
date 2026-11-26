import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishVerification } from '../scripts/write-runtime-verification.mjs';

test('sealed deploy receipt binds manifest, image and verify; observations preserve soak start', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const input = { root, manifestBytes: Buffer.from(JSON.stringify({ projectSha: 'a'.repeat(40), packages: {} })), verification: { userName: 'root', results: [{ deploymentId: 'production', ok: true, strategies: [{ strategyName: 'Test', strategyRevision: 'sr1:abc', deploymentCompositionId: 'dc1:abc', accountId: 'bybit-default', controlState: 'entries_paused' }] }] }, container: { imageDigest: 'sha256:' + 'b'.repeat(64), health: 'healthy', startedAt: '2026-10-21T00:00:00Z', restartCount: 0 }, mode: 'deploy', observedAt: 1000 };
  assert.equal(publishVerification(input).deploymentVerifiedAt, 1000);
  const observed = publishVerification({ ...input, mode: 'observe', observedAt: 2000 });
  assert.equal(observed.deploymentVerifiedAt, 1000);
  assert.equal(observed.observedAt, 2000);
  assert.throws(() => publishVerification({ ...input, mode: 'observe', container: { ...input.container, imageDigest: 'sha256:' + 'c'.repeat(64) } }), /Image changed/);
  assert.throws(() => publishVerification({ ...input, container: { ...input.container, health: 'unhealthy' } }), /verification failed/);
});

test('periodic capture without a deploy receipt cannot invent soak start', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const report = publishVerification({ root, manifestBytes: Buffer.from(JSON.stringify({ projectSha: 'a'.repeat(40) })), verification: { userName: 'root', results: [{ deploymentId: 'production', ok: true, strategies: [{ strategyName: 'Test', strategyRevision: 'sr1:abc', deploymentCompositionId: 'dc1:abc', accountId: 'account', controlState: 'active' }] }] }, container: { imageDigest: 'sha256:' + 'b'.repeat(64), health: 'healthy' }, mode: 'observe', observedAt: 1000 });
  assert.equal(report.deploymentVerifiedAt, null);
});

test('collector seals both targets and exposes one failed capture without blocking the other', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin')); fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(repository, 'scripts/write-runtime-verification.mjs'), path.join(root, 'scripts/write-runtime-verification.mjs'));
  fs.writeFileSync(path.join(root, 'release.env'), `APP_IMAGE_TAG=${'a'.repeat(40)}\n`);
  fs.writeFileSync(path.join(root, 'bin/flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin/docker'), `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const a=process.argv.slice(2),id='sha256:'+'c'.repeat(64),start='2026-10-21T00:00:00Z',digest='sha256:'+'b'.repeat(64);
if(a[0]==='inspect')console.log(a[2]==='{{json .State}}'?JSON.stringify({Health:{Status:'healthy'},StartedAt:start}):a[2]==='{{.RestartCount}}'?'0':a[2].includes('StartedAt')?id+':'+start:id);
else if(a[0]==='image')console.log(a[3].includes('RepoDigests')?'ghcr.io/tradejs-dev/tradejs-project-app@'+digest:id);
else if(a[0]==='cp'){const body=Buffer.from(JSON.stringify({projectSha:'a'.repeat(40),packages:{}})),h=Buffer.alloc(512);h.write('runtime-package-manifest.json');h.write('0000644',100);h.write(body.length.toString(8).padStart(11,'0'),124);h.fill(32,148,156);h[156]=48;h.write([...h].reduce((n,x)=>n+x,0).toString(8).padStart(6,'0')+'\\0 ',148);process.stdout.write(Buffer.concat([h,body,Buffer.alloc((512-body.length%512)%512+1024)]));}
else if(a[0]==='exec'&&a.includes('printenv'))console.log('production,CopyTrading');
else if(a[0]==='exec'){const d=a[a.indexOf('--deployment')+1];if(d==='production'&&process.env.FAIL_CAPTURE==='1')process.exit(1);console.log(JSON.stringify({userName:'root',results:[{deploymentId:d,ok:true,strategies:[{strategyName:'Test',strategyRevision:'sr1:abc',deploymentCompositionId:'dc1:abc',accountId:'account',controlState:'active'}]}]}));}
else if(a[0]==='run'){const i=a.indexOf('/collector/write-runtime-verification.mjs');const work=a[a.lastIndexOf('-v')+1].split(':')[0];process.exit(cp.spawnSync(process.execPath,a.slice(i).map(x=>x.startsWith('/collector-work')?x.replace('/collector-work',work):x.startsWith('/collector/')?x.replace('/collector',process.env.DEPLOY_ROOT+'/scripts'):x),{stdio:'inherit'}).status);}
else process.exit(2);
`, { mode: 0o755 });
  const run = (fail, mode = 'deploy') => spawnSync('bash', [path.join(repository, 'scripts/capture-runtime-verification.sh'), mode], { env: { ...process.env, DEPLOY_ROOT: root, PATH: `${root}/bin:${process.env.PATH}`, FAIL_CAPTURE: fail }, encoding: 'utf8' });
  const failure = run('1'); assert.equal(failure.status, 1, failure.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/runtime-verification/root/production/latest-attempt.json'))).status, 'failed');
  assert.ok(fs.existsSync(path.join(root, 'data/runtime-verification/root/CopyTrading', 'a'.repeat(40), 'dc1:abc/deploy.json')), failure.stderr);
  const success = run('0'); assert.equal(success.status, 0, success.stderr);
  const dir = path.join(root, 'data/runtime-verification/root/production', 'a'.repeat(40), 'dc1:abc');
  const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, pointer.file))).ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, pointer.file)));
  fs.writeFileSync(path.join(dir, 'deploy.json'), '{"file":"untrusted"}');
  const observation = run('0', 'observe'); assert.equal(observation.status, 0, observation.stderr);
  const observedPointer = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, observedPointer.file))).deploymentVerifiedAt, receipt.deploymentVerifiedAt);
  fs.rmSync(path.join(root, 'data/runtime-verification/root/production'), { recursive: true });
  fs.symlinkSync(path.join(root, 'bin'), path.join(root, 'data/runtime-verification/root/production'));
  const rejected = run('0'); assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/runtime-verification/root/CopyTrading/latest-attempt.json'))).status, 'succeeded');
  fs.rmSync(path.join(root, '.tradejs-collector-state/verification'), { recursive: true });
  const firstObservation = run('0', 'observe'); assert.equal(firstObservation.status, 1, firstObservation.stderr);
  const copyDir = path.join(root, 'data/runtime-verification/root/CopyTrading', 'a'.repeat(40), 'dc1:abc');
  const firstPointer = JSON.parse(fs.readFileSync(path.join(copyDir, 'latest.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(copyDir, firstPointer.file))).deploymentVerifiedAt, null);
});
