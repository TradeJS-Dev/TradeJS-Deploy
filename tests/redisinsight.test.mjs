import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('Redis Insight has its own private service in both proxy modes', (t) => {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('Docker Compose is unavailable');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tradejs-insight-compose-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['docker-compose.prod.yml', 'docker-compose.ingress.yml']) {
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  const sha = 'a'.repeat(40);
  fs.writeFileSync(path.join(directory, '.env'), 'PG_PASSWORD=compose-test\n');
  fs.writeFileSync(
    path.join(directory, 'release.env'),
    ['APP', 'AGENT', 'ML_INFER', 'SITE', 'DOCS'].map((key) => `${key}_IMAGE_TAG=${sha}\n`).join(''),
  );

  for (const mode of ['ssl', 'ingress']) {
    const files = ['-f', 'docker-compose.prod.yml'];
    if (mode === 'ingress') files.push('-f', 'docker-compose.ingress.yml');
    const result = spawnSync(
      'docker',
      [
        'compose', '--env-file', '.env', '--env-file', 'release.env',
        ...files, 'config', '--format', 'json',
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const { redis, redisinsight } = JSON.parse(result.stdout).services;
    assert.equal(redis.command[0], 'redis-stack-server');
    assert.equal(redisinsight.environment.RI_REDIS_HOST, 'redis');
    assert.equal(redisinsight.volumes[0].source, 'redisinsight-data');
    assert.deepEqual(Object.keys(redisinsight.networks), ['web']);
    assert.equal(redisinsight.ports, undefined);
    assert.match(redisinsight.image, /@sha256:[a-f0-9]{64}$/);

    const nginx = fs.readFileSync(path.join(root, 'nginx', 'nginx.conf.' + mode), 'utf8');
    const redisinsightRoute = nginx.match(/location \/ \{\s*auth_basic "Restricted";[^}]+\}/)?.[0];
    assert.match(redisinsightRoute || '', /redisinsight:5540/);
    assert.match(redisinsightRoute || '', /proxy_pass http:\/\/\$redisinsight_upstream/);
  }
});
