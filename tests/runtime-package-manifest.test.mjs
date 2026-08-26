import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/compare-runtime-manifests.mjs');

const run = (manifest) => {
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
      ...manifest,
    }),
  );
  const result = spawnSync('node', [script, previous, next, output], {
    cwd: root,
    encoding: 'utf8',
  });
  const outputManifest = fs.existsSync(output)
    ? JSON.parse(fs.readFileSync(output, 'utf8'))
    : undefined;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  return { ...result, outputManifest };
};

test('accepts a legacy stable production package manifest', () => {
  const result = run({ packages: { '@tradejs/node': '3.1.8' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputManifest.nextReleaseChannel, 'stable');
});

test('accepts one exact beta framework cohort', () => {
  const result = run({
    releaseChannel: 'beta',
    frameworkVersion: '3.1.9-beta.42',
    packages: {
      '@tradejs/core': '3.1.9-beta.42',
      '@tradejs/node': '3.1.9-beta.42',
      '@tradejs/strategy-double-tap': '3.0.3',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputManifest.nextReleaseChannel, 'beta');
  assert.equal(result.outputManifest.nextFrameworkVersion, '3.1.9-beta.42');
});

test('rejects a prerelease host-provided package', () => {
  const result = run({
    packages: {
      '@tradejs/node': '3.1.9-beta.42',
      '@tradejs/strategy-double-tap': '3.0.4-beta.1',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prerelease host packages/);
});

test('rejects mixed framework versions', () => {
  const result = run({
    packages: {
      '@tradejs/core': '3.1.9-beta.42',
      '@tradejs/node': '3.1.8',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /do not form one release cohort/);
});

test('rejects release metadata that differs from the package cohort', () => {
  const result = run({
    releaseChannel: 'stable',
    frameworkVersion: '3.1.9-beta.42',
    packages: { '@tradejs/node': '3.1.9-beta.42' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release channel mismatch/);
});
