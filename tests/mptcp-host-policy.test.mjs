import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('host policy preserves GODEBUG, running containers, and is idempotent', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("policy", "scripts/configure-mptcp.py")
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
with tempfile.TemporaryDirectory() as root:
    root = Path(root)
    def mapped(value): return root / str(value).lstrip("/")
    mapped("/etc/sysctl.d").mkdir(parents=True)
    mapped("/proc/10").mkdir(parents=True)
    mapped("/proc/10/environ").write_bytes(b"GODEBUG=other=1\\0")
    calls = []
    def command(*args):
        if "Environment" in args: return 'GODEBUG=other=1,multipathtcp=1'
        if "MainPID" in args: return "10"
        if args[0] == "lsns": return "10"
        if args[:2] == ("docker", "ps"): return "app\\nworker" if not any(c[:2] == ["systemctl", "restart"] for c in calls) else "app"
        raise AssertionError(args)
    def run(args, **kwargs):
        calls.append(args)
        if args[:2] == ["systemctl", "restart"]:
            mapped("/proc/10/environ").write_bytes(b"GODEBUG=other=1,multipathtcp=0\\0")
        return type("Result", (), {"returncode": 0})()
    with patch.object(p, "Path", side_effect=mapped), patch.object(p.os, "geteuid", return_value=0), patch.object(p, "command", side_effect=command), patch.object(p.subprocess, "run", side_effect=run):
        p.configure_host_network()
        for unit in ("docker", "containerd"):
            content = mapped("/etc/systemd/system/"+unit+".service.d/99-disable-mptcp.conf").read_text()
            assert 'GODEBUG=other=1,multipathtcp=0' in content
        assert ["docker", "start", "worker"] in calls
        assert ["docker", "start", "app"] not in calls
        calls.clear()
        p.configure_host_network()
        assert not any(c[:2] == ["systemctl", "restart"] for c in calls)
        assert ["systemctl", "daemon-reload"] not in calls
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
