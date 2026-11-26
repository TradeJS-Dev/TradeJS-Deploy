import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
test('component collector seals observations and exposes failures', () => {
  const result = spawnSync('python3', ['-B', 'tests/runtime-components.test.py'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('daily cron is idempotent and preserves the five-minute Project collector', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'component-cron-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  const cron = path.join(directory, 'cron');
  fs.writeFileSync(cron, '*/5 * * * * project-verification # tradejs-runtime-verification\n');
  fs.writeFileSync(path.join(bin, 'crontab'), '#!/bin/sh\nif [ "$1" = -l ]; then cat "$CRON_FILE"; else cat > "$CRON_FILE"; fi\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_ROOT: directory, CRON_FILE: cron };
  for (let i = 0; i < 2; i++) {
    const result = spawnSync('bash', ['scripts/install-runtime-components-cron.sh', 'a'.repeat(40)], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const installed = fs.readFileSync(cron, 'utf8');
  assert.match(installed, /CRON_TZ=Europe\/Moscow\n30 10 \* \* \* DEPLOY_ROOT=.+ python3/);
  assert.equal(installed.split('capture-runtime-components.py').length - 1, 1);
  assert.match(installed, /\*\/5 \* \* \* \* project-verification/);
  assert.equal(fs.readFileSync(path.join(directory, 'data/runtime-components/deploy-source-sha'), 'utf8').trim(), 'a'.repeat(40));
  assert.match(installed, /\.tradejs-collector-state\/components\.log/);
  assert.doesNotMatch(installed, /data\/runtime-components\/collector\.log/);
});
