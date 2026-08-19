import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupScript = path.join(root, 'scripts/redis-backup.sh');
const cleanupScript = path.join(
  root,
  'scripts/cleanup-legacy-runtime-redis.sh',
);
const image = 'redis/redis-stack:7.4.0-v8';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
};

const waitForRedis = async (container) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync('docker', [
      'exec',
      container,
      'redis-cli',
      'ping',
    ], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.includes('PONG')) return;
    await delay(250);
  }
  throw new Error(`Redis ${container} did not become ready`);
};

test('rejects removed persistence migration arguments', () => {
  const result = spawnSync('bash', [backupScript, '--prepare-volume'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported redis-backup argument/);
});

test('preserves current runtime state and removes only legacy config keys', async (t) => {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    t.skip('Docker is unavailable');
    return;
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const container = `tradejs-redis-test-${suffix}`;
  const volume = `tradejs-redis-test-${suffix}`;
  const backupDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tradejs-redis-backup-'),
  );
  t.after(() => {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  run('docker', ['volume', 'create', volume]);
  const startRedis = () =>
    run('docker', [
      'run',
      '-d',
      '--name',
      container,
      '-v',
      `${volume}:/data`,
      image,
      'redis-stack-server',
      '--dir',
      '/data',
      '--dbfilename',
      'dump.rdb',
      '--appendonly',
      'yes',
      '--appendfsync',
      'everysec',
    ]);

  startRedis();
  await waitForRedis(container);
  const legacyReleaseKey = 'users:root:strategies:DoubleTap:releases:2';
  const legacyDeploymentKey =
    'users:root:runtime:deployments:doubletap-forward';
  const accountKey = 'users:root:trading-accounts:bybit-default';
  const controlsKey = 'users:root:runtime:controls';
  const heartbeatKey = 'users:root:runtime:deployments:production:heartbeat';
  run('docker', [
    'exec',
    container,
    'redis-cli',
    'JSON.SET',
    legacyReleaseKey,
    '$',
    JSON.stringify({ releaseVersion: 2 }),
  ]);
  run('docker', [
    'exec',
    container,
    'redis-cli',
    'JSON.SET',
    legacyDeploymentKey,
    '$',
    JSON.stringify({
      id: 'doubletap-forward',
    }),
  ]);
  run('docker', [
    'exec',
    container,
    'redis-cli',
    'JSON.SET',
    accountKey,
    '$',
    JSON.stringify({ id: 'bybit-default', provider: 'bybit' }),
  ]);
  run('docker', [
    'exec',
    container,
    'redis-cli',
    'JSON.SET',
    controlsKey,
    '$',
    JSON.stringify({
      schema: 'tradejs-runtime-controls/v1',
      deployments: {},
    }),
  ]);
  run('docker', [
    'exec',
    container,
    'redis-cli',
    'JSON.SET',
    heartbeatKey,
    '$',
    JSON.stringify({ deploymentId: 'production', status: 'healthy' }),
  ]);

  await new Promise((resolve, reject) => {
    const child = spawn('bash', [backupScript, '--verify'], {
      cwd: root,
      env: {
        ...process.env,
        REDIS_CONTAINER: container,
        REDIS_BACKUP_DIR: backupDir,
        REDIS_RESTORE_WAIT_ATTEMPTS: '120',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(output)),
    );
  });
  assert.equal(
    fs.readdirSync(backupDir).filter((name) => name.endsWith('.rdb')).length,
    1,
  );

  run('docker', ['rm', '-f', container]);
  startRedis();
  await waitForRedis(container);

  for (const key of [
    legacyReleaseKey,
    legacyDeploymentKey,
    accountKey,
    controlsKey,
    heartbeatKey,
  ]) {
    assert.equal(
      run('docker', ['exec', container, 'redis-cli', '--raw', 'EXISTS', key]),
      '1',
    );
  }

  const dryRun = run('bash', [
    cleanupScript,
    '--user',
    'root',
    '--redis-container',
    container,
  ]);
  assert.match(dryRun, /Dry run only; no keys deleted/);
  assert.equal(
    run('docker', [
      'exec',
      container,
      'redis-cli',
      '--raw',
      'EXISTS',
      legacyReleaseKey,
    ]),
    '1',
  );

  run(
    'bash',
    [
      cleanupScript,
      '--apply',
      '--user',
      'root',
      '--redis-container',
      container,
    ],
    {
      env: {
        ...process.env,
        TRADEJS_CONFIRM_LEGACY_RUNTIME_CLEANUP:
          'DELETE_LEGACY_RUNTIME_KEYS',
      },
    },
  );

  for (const key of [legacyReleaseKey, legacyDeploymentKey]) {
    assert.equal(
      run('docker', [
        'exec',
        container,
        'redis-cli',
        '--raw',
        'EXISTS',
        key,
      ]),
      '0',
    );
  }
  for (const key of [accountKey, controlsKey, heartbeatKey]) {
    assert.equal(
      run('docker', [
        'exec',
        container,
        'redis-cli',
        '--raw',
        'EXISTS',
        key,
      ]),
      '1',
    );
  }
});
