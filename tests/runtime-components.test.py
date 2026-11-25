import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('components', Path(__file__).resolve().parents[1] / 'scripts/capture-runtime-components.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ComponentsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sha = 'a' * 40
        self.digest = 'sha256:' + 'b' * 64
        self.image_id = 'sha256:' + 'c' * 64
        keys = ['PROJECT_SHA', *(c[0] for c in module.COMPONENTS.values())]
        (self.root / 'release.env').write_text(''.join(f'{k}={self.sha}\n' for k in keys))
        (self.root / 'docker-compose.prod.yml').write_text('services:\n' + ''.join(f'  {n}:\n    image: ghcr.io/tradejs-dev/tradejs-certbot@{self.digest}\n' for n in ['certbot', 'certbot-cron']))
        self.directory = self.root / 'data/runtime-components'
        self.directory.mkdir(parents=True)
        (self.directory / 'deploy-source-sha').write_text('d' * 40)
        self.container = dict(containerId='e' * 64, imageId=self.image_id, state='running', running=True, startedAt='2026-11-25T00:00:00Z', exitCode=0, restartCount=0, health=None)
        self.inventory = {n: self.container.copy() for n in [*module.COMPONENTS, 'certbot', 'certbot-cron']}
        self.mismatch = False

    def docker(self, *args):
        self.assertEqual(args[:2], ('image', 'inspect'))
        image_id = 'sha256:' + 'f' * 64 if self.mismatch and args[-1] != self.image_id else self.image_id
        return json.dumps(dict(id=image_id, repoDigests=[f'ghcr.io/tradejs-dev/{repo}@{self.digest}' for repo in ['tradejs-project-app', 'tradejs-agent', 'tradejs-ml-infer', 'tradejs-site', 'tradejs-docs', 'tradejs-certbot']]))

    def capture(self):
        with patch.object(module, 'containers', return_value=self.inventory), patch.object(module, 'docker', side_effect=self.docker):
            return module.capture(self.root)

    def test_complete_snapshot_is_sealed_and_has_no_environment(self):
        report = self.capture()
        envelope = json.loads((self.directory / 'root/latest.json').read_text())
        raw = base64.b64decode(envelope['data'])
        self.assertEqual(len(raw), envelope['bytes'])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), envelope['sha256'])
        self.assertEqual(json.loads(raw), report)
        self.assertTrue(report['ok'])
        self.assertEqual(len(report['components']), 7)
        self.assertEqual(report['deploySourceSha'], 'd' * 40)
        self.assertNotIn('deploymentVerifiedAt', report)
        self.assertNotIn('env', raw.decode())

    def test_missing_container_and_mismatched_image_are_not_success(self):
        self.inventory['agent'] = None
        report = self.capture()
        agent = next(c for c in report['components'] if c['name'] == 'agent')
        self.assertEqual(agent['state'], 'missing')
        self.assertIsNone(agent['imageDigest'])
        self.assertFalse(report['ok'])
        self.mismatch = True
        self.assertFalse(self.capture()['components'][0]['matchesRelease'])

    def test_one_shot_certbot_may_exit_successfully_but_cron_must_run(self):
        self.inventory['certbot'].update(state='exited', running=False)
        self.assertTrue(self.capture()['ok'])
        self.inventory['certbot']['exitCode'] = 1
        self.assertFalse(self.capture()['ok'])
        self.inventory['certbot']['exitCode'] = 0
        self.inventory['certbot-cron'].update(state='exited', running=False)
        self.assertFalse(self.capture()['ok'])

    def test_unknown_digest_or_unhealthy_container_are_explicit(self):
        with patch.object(module, 'docker', return_value=json.dumps(dict(id=self.image_id, repoDigests=[]))):
            c = module.component('agent', ('ghcr.io/tradejs-dev/tradejs-agent:' + self.sha, self.sha), self.container)
        self.assertIsNone(c['imageDigest'])
        self.assertFalse(c['ok'])
        self.inventory['site']['health'] = 'unhealthy'
        self.assertFalse(self.capture()['ok'])

    def test_unavailable_expected_image_is_unknown_not_a_confirmed_mismatch(self):
        def observe(*args):
            if args[-1] != self.image_id:
                raise RuntimeError('expected image unavailable')
            return self.docker(*args)
        with patch.object(module, 'docker', side_effect=observe):
            value = module.component('certbot', ('ghcr.io/tradejs-dev/tradejs-certbot@' + self.digest, None), self.container)
        self.assertIsNone(value['matchesRelease'])
        self.assertFalse(value['ok'])

    def test_paused_or_restarting_container_is_not_ok(self):
        for state in ['paused', 'restarting']:
            self.inventory['agent']['state'] = state
            self.assertFalse(self.capture()['ok'])

    def test_failed_or_crossing_capture_preserves_last_success(self):
        self.capture()
        last = (self.directory / 'root/latest.json').read_bytes()
        for error in [RuntimeError('docker failure'), ValueError('rollout')]:
            with patch.object(module, 'containers', side_effect=[self.inventory, error]), patch.object(module, 'docker', side_effect=self.docker):
                with self.assertRaises(type(error)):
                    module.capture(self.root)
            self.assertEqual(last, (self.directory / 'root/latest.json').read_bytes())
            self.assertEqual(json.loads((self.directory / 'root/latest-attempt.json').read_text())['status'], 'failed')

    def test_changed_container_is_not_sealed(self):
        changed = dict(self.inventory, app=dict(self.container, startedAt='later'))
        with patch.object(module, 'containers', side_effect=[self.inventory, changed]), patch.object(module, 'docker', side_effect=self.docker):
            with self.assertRaisesRegex(ValueError, 'changed'):
                module.capture(self.root)
        self.assertFalse((self.directory / 'root/latest.json').exists())

    def test_declaration_rejects_duplicates_missing_keys_or_mutable_certbot(self):
        release = (self.root / 'release.env').read_bytes()
        compose = (self.root / 'docker-compose.prod.yml').read_bytes()
        for bad in [release + f'PROJECT_SHA={self.sha}\n'.encode(), b'PROJECT_SHA=latest\n']:
            with self.assertRaises(ValueError):
                module.declarations(bad, compose)
        with self.assertRaises(ValueError):
            module.declarations(release, b'services:\n  certbot:\n    image: certbot:latest\n')


class DockerObservationTest(unittest.TestCase):
    def test_inspects_container_without_healthcheck(self):
        if not shutil.which('docker') or subprocess.run(
            ['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
        ).returncode:
            self.skipTest('Docker is unavailable')

        name = 'tradejs-component-test-' + uuid.uuid4().hex
        empty_filesystem = io.BytesIO()
        with tarfile.open(fileobj=empty_filesystem, mode='w'):
            pass
        image = subprocess.check_output(
            ['docker', 'import', '--change', 'LABEL tradejs.component-test=' + name, '-'],
            input=empty_filesystem.getvalue(), timeout=30,
        ).decode().strip()
        self.addCleanup(subprocess.run, ['docker', 'image', 'rm', image], check=True, capture_output=True, timeout=30)
        subprocess.run(
            ['docker', 'create', '--name', name, '--no-healthcheck', image, '/unused'],
            check=True, capture_output=True, timeout=15,
        )
        self.addCleanup(subprocess.run, ['docker', 'container', 'rm', name], check=True, capture_output=True, timeout=15)

        with patch.object(module, 'COMPONENTS', {name: None}):
            observed = module.containers()[name]

        self.assertEqual(observed['imageId'], image)
        self.assertEqual(observed['state'], 'created')
        self.assertIsNone(observed['health'])


if __name__ == '__main__':
    unittest.main()
