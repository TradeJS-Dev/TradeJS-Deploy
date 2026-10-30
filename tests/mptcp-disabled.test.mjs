import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/verify-mptcp-disabled.sh');

function verify(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mptcp-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const commands = {
    id: '#!/bin/sh\necho 0\n',
    docker: `#!/bin/sh
case "$1" in
  compose) [ "\${TEST_EMPTY:-0}" = 1 ] || printf '%s\\n' first second ;;
  inspect)
    case "$3" in
      '{{.Name}}') echo "/$4" ;;
      '{{.State.Pid}}') echo "\${TEST_PID:-123}" ;;
      *) echo "\${TEST_CONFIGURED:-0}" ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    nsenter: '#!/bin/sh\necho "${TEST_ENABLED:-0}"\n',
  };
  for (const [name, content] of Object.entries(commands)) {
    fs.writeFileSync(path.join(directory, name), content, { mode: 0o755 });
  }
  return spawnSync('bash', [script, '-f', 'compose.yml'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, ...overrides },
  });
}

test('accepts containers with both persistent and effective MPTCP disabled', (t) => {
  const result = verify(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all 2 running Compose containers/);
});

test('rejects MPTCP enabled in a running network namespace', (t) => {
  const result = verify(t, { TEST_ENABLED: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enabled in the network namespace/);
});

test('rejects a missing persistent MPTCP setting even if disabled at runtime', (t) => {
  const result = verify(t, { TEST_CONFIGURED: '<no value>' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not persistently disabled/);
});

test('rejects a deployment without running containers', (t) => {
  const result = verify(t, { TEST_EMPTY: '1' });
  assert.notEqual(result.status, 0);
});

test('rejects a container that stopped before namespace inspection', (t) => {
  const result = verify(t, { TEST_PID: '0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot inspect the network namespace/);
});
