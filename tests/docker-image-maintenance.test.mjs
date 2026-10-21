import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Docker maintenance preserves releases and leases and fails safely', () => {
  const result = spawnSync('python3', ['tests/docker-image-maintenance.test.py'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('maintenance entrypoint forwards preview arguments to the helper', () => {
  const result = spawnSync('bash', ['scripts/docker-image-prune.sh', '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--dry-run/);
});
