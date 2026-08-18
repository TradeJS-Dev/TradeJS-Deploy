import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rollbackScript = path.join(root, 'scripts/rollback-app.sh');

test('rollback overrides an exported incoming image with release.env', (t) => {
  const deployRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tradejs-rollback-'));
  const binRoot = path.join(deployRoot, 'bin');
  const invocationPath = path.join(deployRoot, 'docker-invocation.txt');
  fs.mkdirSync(binRoot);
  fs.writeFileSync(path.join(deployRoot, '.env'), 'APP_MEMORY_LIMIT=5g\n');
  fs.writeFileSync(
    path.join(deployRoot, 'release.env'),
    `APP_IMAGE_TAG=${'a'.repeat(40)}\n`,
  );
  fs.writeFileSync(
    path.join(binRoot, 'docker'),
    `#!/usr/bin/env bash\nprintf 'APP_IMAGE_TAG=%s\\nARGS=%s\\n' "$APP_IMAGE_TAG" "$*" > "$ROLLBACK_INVOCATION_PATH"\n`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(deployRoot, { recursive: true, force: true }));

  const result = spawnSync('bash', [rollbackScript], {
    cwd: root,
    env: {
      ...process.env,
      APP_IMAGE_TAG: 'b'.repeat(40),
      DEPLOY_ROOT: deployRoot,
      PATH: `${binRoot}:${process.env.PATH}`,
      ROLLBACK_INVOCATION_PATH: invocationPath,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const invocation = fs.readFileSync(invocationPath, 'utf8');
  assert.match(invocation, new RegExp(`APP_IMAGE_TAG=${'a'.repeat(40)}`));
  assert.match(invocation, /--force-recreate app/);
});
