import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'maintenance', Path(__file__).resolve().parents[1] / 'scripts/docker-image-maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = 1800000000


def image(number, repo=None, created='2026-01-01T00:00:00Z'):
    return {'Id': f'sha256:{number:064x}', 'Created': created,
            'RepoTags': [f'{repo}:{number:040x}'] if repo else [], 'RepoDigests': []}


def container(im, expiry=None, status='created'):
    return {'Id': f'container-{im["Id"]}', 'Image': im['Id'],
            'Config': {'Labels': {m.LEASE: 'true', m.EXPIRES: expiry} if expiry is not None else {}},
            'State': {'Status': status, 'Running': status == 'running'}}


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.images = [image(n, repo) for n, repo in enumerate(m.REPOSITORIES.values(), 1)]
        self.release = ''.join(f'{key}={n:040x}\n' for n, key in enumerate(m.REPOSITORIES, 1))
        self.release += f'PROJECT_SHA={1:040x}\n'
        (self.root / 'release.env').write_text(self.release)
        self.snapshot = m.release_snapshot(self.root)
        self.repo = m.REPOSITORIES['APP_IMAGE_TAG']
        self.old = image(10, self.repo)
        self.newer = image(11, self.repo, '2026-02-01T00:00:00Z')
        self.newest = image(12, self.repo, '2026-03-01T00:00:00Z')
        self.images += [self.old, self.newer, self.newest]

    def plan(self, containers=()):
        return m.plan(self.images, containers, self.snapshot, NOW, 86400)

    def test_current_and_two_latest_versions_are_preserved(self):
        _, delete, keep = self.plan()
        self.assertEqual([i['Id'] for i in delete], [self.old['Id']])
        self.assertTrue({i['Id'] for i in self.images if i is not self.old} <= keep)

    def test_previous_release_survives_even_when_older_than_latest_versions(self):
        (self.root / 'release.env.previous').write_text(self.release.replace(f'{1:040x}', f'{10:040x}'))
        self.snapshot = m.release_snapshot(self.root)
        self.assertEqual(self.plan()[1], [])

    def test_only_stopped_expired_positive_leases_are_deleted(self):
        for expiry, status, should_expire in [
                ('1', 'created', True), ('1', 'exited', True),
                ('1', 'running', False), ('1', 'dead', False),
                (str(NOW + 1), 'created', False), ('0', 'created', False),
                ('unknown', 'created', False), ('', 'created', False)]:
            with self.subTest(expiry=expiry, status=status):
                c = container(self.old, expiry, status)
                leases, delete, _ = self.plan([c])
                self.assertEqual(bool(leases), should_expire)
                self.assertEqual(bool(delete), should_expire)
        self.assertEqual(self.plan([container(self.old)])[1], [])

    def test_recent_unmanaged_and_mixed_repository_images_are_preserved(self):
        recent = image(13, self.repo, '2027-01-15T08:00:00Z')
        unknown = image(14, 'example.org/another-service')
        mixed = image(15, self.repo)
        mixed['RepoTags'].append('example.org/another-service:old')
        self.images += [recent, unknown, mixed]
        self.assertFalse({recent['Id'], unknown['Id'], mixed['Id']} & {i['Id'] for i in self.plan()[1]})

    def test_missing_malformed_or_incomplete_release_refuses_cleanup(self):
        for content in [self.release.replace(f'{1:040x}', 'latest'), 'APP_IMAGE_TAG=bad\n',
                        self.release + f'APP_IMAGE_TAG={1:040x}\n', self.release.replace(f'{1:040x}', f'{99:040x}')]:
            with self.subTest(content=content):
                self.snapshot['release.env'] = content.encode()
                with self.assertRaises(ValueError):
                    self.plan()
        (self.root / 'release.env').unlink()
        with self.assertRaises(ValueError):
            m.release_snapshot(self.root)

    def test_apply_deletes_only_expired_containers_and_planned_images(self):
        lease = container(self.old, '1')
        calls = []

        def docker(*args):
            calls.append(args)
            if args[:2] == ('container', 'inspect'):
                return json.dumps([lease])
            if args[:2] == ('image', 'inspect'):
                return json.dumps([self.old])
            return ''

        with patch.object(m, 'docker', side_effect=docker), contextlib.redirect_stdout(io.StringIO()):
            m.apply(self.root, self.snapshot, [lease], [self.old], set())
        mutations = [c for c in calls if c[1] == 'rm']
        self.assertEqual(mutations, [('container', 'rm', lease['Id']), ('image', 'rm', *self.old['RepoTags'])])

    def test_renewed_lease_and_new_container_reference_prevent_deletion(self):
        lease = container(self.old, '1')
        renewed = container(self.old, str(NOW + 10**9))
        calls = []

        def docker(*args):
            calls.append(args)
            return json.dumps([renewed]) if args[1] == 'inspect' else 'new-container'

        with patch.object(m, 'docker', side_effect=docker):
            m.apply(self.root, self.snapshot, [lease], [self.old], set())
        self.assertFalse(any(c[1] == 'rm' for c in calls))

    def test_release_changes_stop_all_mutations(self):
        (self.root / 'release.env.previous').write_text(self.release)
        with patch.object(m, 'docker') as docker, self.assertRaises(ValueError):
            m.apply(self.root, self.snapshot, [], [self.old], set())
        docker.assert_not_called()

    def test_changed_tags_stop_image_removal(self):
        changed = copy.deepcopy(self.old)
        changed['RepoTags'].append(f'{self.repo}:new-tag')
        with patch.object(m, 'docker', side_effect=['', json.dumps([changed])]) as docker:
            with self.assertRaises(ValueError):
                m.apply(self.root, self.snapshot, [], [self.old], set())
        self.assertFalse(any(call.args[1] == 'rm' for call in docker.call_args_list))

    def test_docker_failure_stops_cleanup(self):
        with patch.object(m, 'docker', side_effect=RuntimeError('Docker unavailable')):
            with self.assertRaises(RuntimeError):
                m.apply(self.root, self.snapshot, [], [self.old], set())

    def test_main_verifies_running_containers_and_reports_disk_delta(self):
        running = container(self.images[0], status='running')
        running.update(Name='/app', RestartCount=0)
        running['State'].update(StartedAt='2026-10-21T00:00:00Z', Health={'Status': 'healthy'})
        retained = [i for i in self.images if i is not self.old]
        for changed in (False, True):
            after = copy.deepcopy(running)
            if changed:
                after['RestartCount'] = 1
            with self.subTest(changed=changed), \
                    patch.object(sys, 'argv', ['maintenance', '--release-dir', str(self.root)]), \
                    patch.object(m, 'inventory', side_effect=[[running], self.images, [after], retained]), \
                    patch.object(m, 'apply') as apply, \
                    patch.object(m, 'available_bytes', side_effect=[100, 150, 150]), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                if changed:
                    with self.assertRaises(ValueError):
                        m.main()
                else:
                    m.main()
                    report = json.loads(output.getvalue().splitlines()[-1])
                    self.assertEqual(report['freedBytes'], 50)
                    self.assertTrue(report['runningContainersVerified'])
                apply.assert_called_once()

    def test_dry_run_never_applies_or_checks_disk(self):
        with patch.object(sys, 'argv', ['maintenance', '--dry-run', '--release-dir', str(self.root)]), \
                patch.object(m, 'inventory', side_effect=[[], self.images]), \
                patch.object(m, 'apply') as apply, \
                patch.object(m, 'available_bytes') as disk, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            m.main()
        apply.assert_not_called()
        disk.assert_not_called()
        self.assertTrue(json.loads(output.getvalue())['dryRun'])


if __name__ == '__main__':
    unittest.main()
