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

test('reserves enough memory for the full-universe replay heap', () => {
  const script = fs.readFileSync(
    path.join(root, 'scripts/runtime-feedback-replay.sh'),
    'utf8',
  );

  assert.match(
    script,
    /RUNTIME_FEEDBACK_MIN_AVAILABLE_KB:-7340032/,
  );
  assert.match(script, /RUNTIME_FEEDBACK_REPLAY_MEMORY:-7g/);
  assert.match(script, /RUNTIME_FEEDBACK_NODE_HEAP_MB:-6144/);
  assert.match(script, /--memory "\$replay_memory" --memory-swap "\$replay_memory"/);
  assert.match(
    script,
    /NODE_OPTIONS="--max-old-space-size=\$replay_node_heap_mb"/,
  );
});

test('records a failed replay without blocking the next evidence bundle', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tradejs-runtime-feedback-queue-'),
  );
  const binRoot = path.join(fixtureRoot, 'bin');
  const evidenceRoot = path.join(fixtureRoot, 'evidence');
  const feedbackRoot = path.join(fixtureRoot, 'feedback');
  const envFile = path.join(fixtureRoot, 'runtime-feedback.env');
  const dockerLog = path.join(fixtureRoot, 'docker.log');
  const firstArtifact = '20260827T180000Z_20260828T180000Z_first';
  const secondArtifact = '20260828T180000Z_20260829T180000Z_second';
  const projectSha = 'a'.repeat(40);
  const imageDigest = `sha256:${'d'.repeat(64)}`;

  fs.mkdirSync(binRoot);
  for (const [artifact, endTime] of [
    [firstArtifact, 1787940000000],
    [secondArtifact, 1788026400000],
  ]) {
    const bundleDir = path.join(evidenceRoot, artifact);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, '.complete'), '');
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), '{}\n');
    fs.writeFileSync(path.join(bundleDir, 'runtime-evidence.json'), '{}\n');
    fs.writeFileSync(
      path.join(bundleDir, 'test-metadata'),
      `${imageDigest}\t${projectSha}\tproduction\t${endTime}`,
    );
  }
  fs.writeFileSync(envFile, 'PG_USER=runtime_replay\n');
  fs.writeFileSync(
    path.join(binRoot, 'chown'),
    '#!/usr/bin/env bash\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binRoot, 'flock'),
    '#!/usr/bin/env bash\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binRoot, 'timeout'),
    '#!/usr/bin/env bash\nshift 3\nexec "$@"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binRoot, 'awk'),
    `#!/usr/bin/env bash
if [ "\${*: -1}" = "/proc/meminfo" ]; then
  printf '9999999\\n'
  exit 0
fi
exec /usr/bin/awk "$@"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binRoot, 'date'),
    `#!/usr/bin/env bash
case "$*" in
  '-u +%Y%m%dT%H%M%SZ') printf '20260830T052500Z\\n' ;;
  '-u -d '*' +%Y/%m/%d') printf '2026/08/29\\n' ;;
  '+%s') printf '1788067500\\n' ;;
  '+%s000') printf '1788067500000\\n' ;;
  *) exec /bin/date "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binRoot, 'docker'),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$RUNTIME_FEEDBACK_TEST_DOCKER_LOG"
if [ "\${1:-}" = "network" ]; then
  exit 0
fi
if [ "\${1:-}" = "inspect" ]; then
  case "$*" in
    *State.Health*) printf 'healthy\\n' ;;
    *) printf 'sha256:%064d\\n' 0 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "image" ]; then
  printf 'sha256:%064d\\n' 1
  exit 0
fi
if [ "\${1:-}" = "exec" ]; then
  printf 'PONG\\n'
  exit 0
fi
if [ "\${1:-}" = "rm" ] || [ "\${1:-}" = "create" ]; then
  exit 0
fi
if [ "\${1:-}" != "run" ]; then
  exit 0
fi
runtime_mount=''
output_mount=''
for argument in "$@"; do
  case "$argument" in
    *:/runtime-evidence:ro) runtime_mount="\${argument%:/runtime-evidence:ro}" ;;
    *:/runtime-feedback-output:rw) output_mount="\${argument%:/runtime-feedback-output:rw}" ;;
  esac
done
if [ -n "$output_mount" ]; then
  if [ "$(basename "$runtime_mount")" = "${firstArtifact}" ]; then
    exit 134
  fi
  mkdir -p "$output_mount"
  : > "$output_mount/.complete"
  printf '{}\\n' > "$output_mount/replay-runtime-evidence.json"
  exit 0
fi
if [ -n "$runtime_mount" ]; then
  cat "$runtime_mount/test-metadata"
fi
exit 0
`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const result = spawnSync(
    'bash',
    [path.join(root, 'scripts/runtime-feedback-replay.sh')],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: fixtureRoot,
        PATH: `${binRoot}:${process.env.PATH}`,
        RUNTIME_EVIDENCE_READY_DIR: evidenceRoot,
        RUNTIME_FEEDBACK_ROOT: feedbackRoot,
        RUNTIME_FEEDBACK_ENV_FILE: envFile,
        RUNTIME_FEEDBACK_LOCK_FILE: path.join(fixtureRoot, 'feedback.lock'),
        RUNTIME_FEEDBACK_MIN_AVAILABLE_KB: '1',
        RUNTIME_FEEDBACK_TEST_DOCKER_LOG: dockerLog,
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Runtime feedback replay failed: .*status=134/);
  assert.match(result.stderr, /failed=1 ready=1/);
  assert.equal(
    fs.readdirSync(path.join(feedbackRoot, 'failed')).filter((entry) =>
      entry.startsWith(`${firstArtifact}-`),
    ).length,
    1,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        feedbackRoot,
        'completed',
        'production',
        `${secondArtifact}.json`,
      ),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        feedbackRoot,
        'completed',
        'production',
        `${firstArtifact}.json`,
      ),
    ),
    false,
  );
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
