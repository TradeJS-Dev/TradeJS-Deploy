import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('injects the pulled immutable app digest without preserving a mutable value', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tradejs-runtime-digest-'),
  );
  const binRoot = path.join(fixtureRoot, 'bin');
  const envFile = path.join(fixtureRoot, '.env');
  const digest = `sha256:${'d'.repeat(64)}`;
  fs.mkdirSync(binRoot);
  fs.writeFileSync(
    envFile,
    `PG_DATABASE=app\nTRADEJS_PROJECT_IMAGE_DIGEST=sha256:${'e'.repeat(64)}\n`,
  );
  fs.writeFileSync(
    path.join(binRoot, 'docker'),
    `#!/usr/bin/env bash\nprintf 'ghcr.io/tradejs-dev/tradejs-project-app@${digest}\\n'\n`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const result = spawnSync(
    'bash',
    [
      path.join(root, 'scripts/set-runtime-image-digest.sh'),
      envFile,
      `ghcr.io/tradejs-dev/tradejs-project-app:${'a'.repeat(40)}`,
    ],
    {
      cwd: root,
      env: { ...process.env, PATH: `${binRoot}:${process.env.PATH}` },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), digest);
  assert.deepEqual(fs.readFileSync(envFile, 'utf8').trim().split('\n'), [
    'PG_DATABASE=app',
    `TRADEJS_PROJECT_IMAGE_DIGEST=${digest}`,
  ]);
});

test('all runtime feedback shell entrypoints pass syntax validation', () => {
  for (const file of [
    'docker-image-prune.sh',
    'ensure-runtime-feedback-db.sh',
    'install-runtime-feedback-cron.sh',
    'runtime-feedback-replay.sh',
    'set-runtime-image-digest.sh',
  ]) {
    const result = spawnSync('bash', ['-n', path.join(root, 'scripts', file)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('creates a least-privilege replay database environment', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tradejs-runtime-db-'),
  );
  const binRoot = path.join(fixtureRoot, 'bin');
  const sqlFile = path.join(fixtureRoot, 'reader.sql');
  const envFile = path.join(fixtureRoot, 'runtime-feedback.env');
  fs.mkdirSync(binRoot);
  fs.writeFileSync(
    path.join(binRoot, 'docker'),
    `#!/usr/bin/env bash
if [ "$1" = "exec" ]; then
  cat > "$RUNTIME_FEEDBACK_TEST_SQL"
  exit 0
fi
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then
  exit 1
fi
if [ "$1" = "inspect" ] && [ "$2" = "ml-infer" ]; then
  exit 1
fi
if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then
  printf '{}\\n'
fi
exit 0
`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const result = spawnSync(
    'bash',
    [path.join(root, 'scripts/ensure-runtime-feedback-db.sh')],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH}`,
        REPLAY_PG_PASSWORD: 'replay-password',
        RUNTIME_FEEDBACK_ENV_FILE: envFile,
        RUNTIME_FEEDBACK_TEST_SQL: sqlFile,
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const sql = fs.readFileSync(sqlFile, 'utf8');
  assert.match(sql, /^DO \$\$ BEGIN/);
  assert.ok(!sql.includes('\\$'));
  assert.match(sql, /ALTER ROLE runtime_replay SET default_transaction_read_only = on/);
  assert.match(sql, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO runtime_replay/);
  assert.deepEqual(fs.readFileSync(envFile, 'utf8').trim().split('\n'), [
    'PG_USER=runtime_replay',
    'PG_PASSWORD=replay-password',
    'PG_DATABASE=app',
  ]);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
});

test('derives a stable replay password when no override is configured', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tradejs-runtime-db-default-'),
  );
  const binRoot = path.join(fixtureRoot, 'bin');
  const envFile = path.join(fixtureRoot, 'runtime-feedback.env');
  const primaryPassword = 'production-database-password';
  fs.mkdirSync(binRoot);
  fs.writeFileSync(
    path.join(binRoot, 'docker'),
    `#!/usr/bin/env bash
if [ "$1" = "exec" ]; then
  cat >/dev/null
  exit 0
fi
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then
  exit 1
fi
if [ "$1" = "inspect" ] && [ "$2" = "ml-infer" ]; then
  exit 1
fi
if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then
  printf '{}\\n'
fi
exit 0
`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const result = spawnSync(
    'bash',
    [path.join(root, 'scripts/ensure-runtime-feedback-db.sh')],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH}`,
        PG_PASSWORD: primaryPassword,
        REPLAY_PG_PASSWORD: '',
        RUNTIME_FEEDBACK_ENV_FILE: envFile,
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const expectedDigest = createHash('sha256')
    .update('tradejs-runtime-replay-password/v1\0')
    .update(primaryPassword)
    .digest('hex');
  assert.deepEqual(fs.readFileSync(envFile, 'utf8').trim().split('\n'), [
    'PG_USER=runtime_replay',
    `PG_PASSWORD=tradejs_replay_${expectedDigest}`,
    'PG_DATABASE=app',
  ]);
  assert.ok(!fs.readFileSync(envFile, 'utf8').includes(primaryPassword));
});
