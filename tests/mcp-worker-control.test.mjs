import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/mcp-worker-control.sh');
const fixture = (t, enabled = 'true', tag = 'a'.repeat(40)) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tradejs-mcp-rollout-'));
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/mcp-replay-host.py'), path.join(directory, 'scripts/mcp-replay-host.py'));
  fs.writeFileSync(path.join(directory, '.env'), `MCP_WORKER_ENABLED=${enabled}\n`);
  fs.writeFileSync(path.join(directory, 'release.env'), `APP_IMAGE_TAG=${tag}\n`);
  fs.writeFileSync(path.join(directory, 'bin/docker'), '#!/usr/bin/env bash\nprintf "%s %s\\n" "$APP_IMAGE_TAG" "$*" >> "$MCP_TEST_INVOCATIONS"\n', { mode: 0o755 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'invocations');
  const run = (mode = 'reconcile') => spawnSync('bash', [script, mode], { encoding: 'utf8', env: { ...process.env, APP_IMAGE_TAG: 'b'.repeat(40), DEPLOY_ROOT: directory, PATH: `${directory}/bin:${process.env.PATH}`, MCP_TEST_INVOCATIONS: log } });
  return { run, log };
};
test('worker rollout waits for isolated Redis and uses the exact app release despite exported incoming tags', (t) => {
  const { run, log } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const commands = fs.readFileSync(log, 'utf8');
  assert.ok(commands.split('\n').filter((line) => /^[a-f0-9]{40} /.test(line)).every((line) => line.startsWith('a'.repeat(40))));
  assert.match(commands, /--profile mcp up -d --wait --wait-timeout 60 mcp-replay-redis/);
  assert.match(commands, /--force-recreate mcp-worker/);
  assert.match(commands, /heartbeat.packageManifestSha256 !== hash/);
});
test('disabled profile stops worker services without starting an incompatible image', (t) => {
  const { run, log } = fixture(t, 'false');
  assert.equal(run().status, 0);
  const commands = fs.readFileSync(log, 'utf8');
  assert.match(commands, /stop -t 15 mcp-worker mcp-replay-redis/);
  assert.doesNotMatch(commands, / pull | up /);
});
test('invalid release identity is rejected before any Docker mutation', (t) => {
  const { run, log } = fixture(t, 'true', 'latest');
  assert.notEqual(run().status, 0);
  assert.equal(fs.existsSync(log), false);
});
