import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/release-state.sh');
const sha = (character) => character.repeat(40);

const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tradejs-release-state-'));
  const releaseFile = path.join(directory, 'release.env');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync('bash', [script, ...args], {
      cwd: root,
      env: { ...process.env, RELEASE_STATE_FILE: releaseFile },
      encoding: 'utf8',
    });
  return { releaseFile, run };
};

test('initializes and validates one complete immutable release', (t) => {
  const { releaseFile, run } = fixture(t);
  const result = run(
    'initialize',
    sha('a'),
    sha('b'),
    sha('c'),
    sha('d'),
    sha('e'),
    sha('f'),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(run('validate').status, 0);
  assert.deepEqual(fs.readFileSync(releaseFile, 'utf8').trim().split('\n'), [
    `APP_IMAGE_TAG=${sha('a')}`,
    `PROJECT_SHA=${sha('b')}`,
    `AGENT_IMAGE_TAG=${sha('c')}`,
    `ML_INFER_IMAGE_TAG=${sha('d')}`,
    `SITE_IMAGE_TAG=${sha('e')}`,
    `DOCS_IMAGE_TAG=${sha('f')}`,
  ]);
  assert.equal(
    fs.statSync(releaseFile).mode & 0o777,
    0o644,
    'release state contains only immutable public refs and must be readable by the SCP action container',
  );
});

test('updates exactly one component and preserves the other refs', (t) => {
  const { releaseFile, run } = fixture(t);
  assert.equal(
    run(
      'initialize',
      sha('a'),
      sha('b'),
      sha('c'),
      sha('d'),
      sha('e'),
      sha('f'),
    ).status,
    0,
  );

  const result = run('update', 'site', sha('1'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run('value', 'site').stdout.trim(), sha('1'));
  assert.equal(run('value', 'app').stdout.trim(), sha('a'));
  assert.equal(run('value', 'project').stdout.trim(), sha('b'));
  assert.match(fs.readFileSync(releaseFile, 'utf8'), new RegExp(sha('c')));
});

test('updates app and Project SHA as one atomic identity', (t) => {
  const { run } = fixture(t);
  assert.equal(
    run(
      'initialize',
      sha('a'),
      sha('b'),
      sha('c'),
      sha('d'),
      sha('e'),
      sha('f'),
    ).status,
    0,
  );

  assert.equal(run('update', 'app', sha('1'), sha('2')).status, 0);
  assert.equal(run('value', 'app').stdout.trim(), sha('1'));
  assert.equal(run('value', 'project').stdout.trim(), sha('2'));
});

test('rejects partial, duplicate, unknown, and mutable release state', (t) => {
  const { releaseFile, run } = fixture(t);

  fs.writeFileSync(releaseFile, `APP_IMAGE_TAG=${sha('a')}\n`);
  assert.notEqual(run('validate').status, 0);

  fs.writeFileSync(
    releaseFile,
    `APP_IMAGE_TAG=${sha('a')}\nAPP_IMAGE_TAG=${sha('b')}\n`,
  );
  assert.notEqual(run('validate').status, 0);

  fs.writeFileSync(releaseFile, `UNKNOWN=${sha('a')}\n`);
  assert.notEqual(run('validate').status, 0);

  const mutable = run(
    'initialize',
    'latest',
    sha('b'),
    sha('c'),
    sha('d'),
    sha('e'),
    sha('f'),
  );
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /full lowercase Git SHA/);
});
