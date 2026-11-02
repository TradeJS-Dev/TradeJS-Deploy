import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2];
if (!image) throw new Error('Pass the exact Redis image to validate.');
const name = `redis-security-smoke-${process.pid}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const cli = (...args) => docker('exec', name, 'redis-cli', '--raw', ...args);
try {
  docker('run', '-d', '--name', name, '--network', 'none', image);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      ready = cli('PING') === 'PONG';
      if (ready) break;
    } catch {}
    await setTimeout(1000);
  }
  assert.ok(ready, 'Redis Stack must start with its existing modules.');
  assert.match(cli('INFO', 'server'), /redis_version:7\.4\.12\r?\n/);
  const modules = JSON.parse(docker('exec', name, 'redis-cli', '--json', 'MODULE', 'LIST'));
  const names = new Set(modules.map((module) => module.name));
  for (const required of ['bf', 'search', 'timeseries', 'ReJSON', 'redisgears_2', 'RedisCompat']) {
    assert.ok(names.has(required), `The existing ${required} module must remain available.`);
  }
  assert.equal(cli('JSON.SET', 'smoke:document', '$', '{"value":42}'), 'OK');
  assert.equal(cli('JSON.GET', 'smoke:document', '$.value'), '[42]');
  assert.equal(cli('FT.CREATE', 'smoke:index', 'ON', 'JSON', 'PREFIX', '1', 'smoke:', 'SCHEMA', '$.value', 'AS', 'value', 'NUMERIC'), 'OK');
  assert.equal(cli('TS.ADD', 'smoke:series', '1', '42'), '1');
  assert.equal(cli('BF.ADD', 'smoke:bloom', 'value'), '1');
  assert.equal(cli('BF.EXISTS', 'smoke:bloom', 'value'), '1');
  assert.equal(cli('SAVE'), 'OK');
  docker('restart', name);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if (cli('PING') === 'PONG') break;
    } catch {}
    await setTimeout(1000);
  }
  assert.equal(cli('JSON.GET', 'smoke:document', '$.value'), '[42]');
  assert.equal(cli('BF.EXISTS', 'smoke:bloom', 'value'), '1');
  assert.equal(cli('FT.INFO', 'smoke:index').includes('smoke:index'), true);
  console.log('Patched Redis Stack preserves modules, JSON, Search, time series, Bloom and RDB restart.');
} finally {
  try { docker('rm', '-f', name); } catch {}
}
