import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('collectors do not let shared filesystem entries select host-write targets', () => {
  const result = spawnSync('python3', ['-B', 'tests/collector-files.test.py'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
