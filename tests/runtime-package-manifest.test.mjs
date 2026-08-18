import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/compare-runtime-manifests.mjs');

const run = (version) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tradejs-manifest-'));
  const previous = path.join(fixtureRoot, 'previous.json');
  const next = path.join(fixtureRoot, 'next.json');
  const output = path.join(fixtureRoot, 'output.json');
  fs.writeFileSync(previous, JSON.stringify({ packages: {} }));
  fs.writeFileSync(
    next,
    JSON.stringify({
      schema: 'tradejs-runtime-package-manifest/v1',
      projectSha: 'a'.repeat(40),
      packages: { '@tradejs/node': version },
    }),
  );
  const result = spawnSync('node', [script, previous, next, output], {
    cwd: root,
    encoding: 'utf8',
  });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  return result;
};

test('accepts a stable production package manifest', () => {
  const result = run('3.1.8');
  assert.equal(result.status, 0, result.stderr);
});

test('rejects a beta package before production Compose is changed', () => {
  const result = run('3.1.9-beta.42');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production image contains non-stable packages/);
});
