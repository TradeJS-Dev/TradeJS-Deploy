import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from host_files import BrokerFiles

spec = importlib.util.spec_from_file_location('components', Path(__file__).resolve().parents[1] / 'scripts/capture-runtime-components.py')
components = importlib.util.module_from_spec(spec)
spec.loader.exec_module(components)


class CollectorFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'deploy'
        self.root.mkdir()
        self.sentinel = Path(self.temp.name) / 'control.txt'
        self.sentinel.write_bytes(b'control unchanged')

    def test_private_state_rejects_link_or_world_accessible_directory(self):
        private = self.root / '.tradejs-collector-state'
        private.symlink_to(self.root, target_is_directory=True)
        with BrokerFiles(self.root) as files, self.assertRaises(OSError):
            files.private_directory()
        private.unlink()
        private.mkdir(mode=0o777)
        private.chmod(0o777)
        with BrokerFiles(self.root) as files, self.assertRaises(ValueError):
            files.private_directory()

    def test_leaf_links_replaced_without_writing_control_file(self):
        for hard in [False, True]:
            target = self.root / 'data/receipt.json'
            target.parent.mkdir(exist_ok=True)
            if hard:
                os.link(self.sentinel, target)
            else:
                target.symlink_to(self.sentinel)
            with BrokerFiles(self.root) as files:
                files.atomic_bytes(target, b'{"ok":true}\n')
            self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')
            self.assertEqual(target.read_bytes(), b'{"ok":true}\n')
            target.unlink()

    def test_parent_link_rejected_before_publication(self):
        (self.root / 'data').symlink_to(self.sentinel.parent, target_is_directory=True)
        with BrokerFiles(self.root) as files, self.assertRaises(OSError):
            files.atomic_bytes(self.root / 'data/control.txt', b'new')
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')

    def test_pinned_parent_survives_directory_entry_swap(self):
        parent = self.root / 'data'
        parent.mkdir()
        with BrokerFiles(self.root) as files:
            context = files.parent(parent / 'receipt.json')
            with context as (fd, name):
                parent.rename(self.root / 'old-data')
                parent.symlink_to(self.sentinel.parent, target_is_directory=True)
                descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
                os.write(descriptor, b'isolated')
                os.close(descriptor)
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')
        self.assertFalse((self.sentinel.parent / 'receipt.json').exists())

    def test_lock_rejects_link_fifo_and_directory_without_blocking(self):
        with BrokerFiles(self.root) as files:
            private = files.private_directory()
            lock = private / 'components.lock'
            lock.symlink_to(self.sentinel)
            with self.assertRaises(OSError):
                files.lock(lock)
            lock.unlink()
            os.mkfifo(lock)
            with self.assertRaises(ValueError):
                files.lock(lock)
            lock.unlink()
            lock.mkdir()
            with self.assertRaises(OSError):
                files.lock(lock)
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')

    def test_component_does_not_open_legacy_shared_lock(self):
        directory = self.root / 'data/runtime-components/root'
        directory.mkdir(parents=True)
        (directory / '.capture.lock').symlink_to(self.sentinel)
        with patch.object(components, 'capture_locked', return_value={'ok': True}):
            self.assertEqual(components.capture(self.root), {'ok': True})
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')
        self.assertTrue((self.root / '.tradejs-collector-state/components.lock').is_file())


class ManifestArchiveTest(unittest.TestCase):
    def test_only_a_bounded_regular_manifest_is_accepted(self):
        import io
        import tarfile
        spec = importlib.util.spec_from_file_location('verification', Path(__file__).resolve().parents[1] / 'scripts/capture-runtime-verification.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for kind in ('regular', 'symlink', 'fifo', 'oversize'):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                info = tarfile.TarInfo('runtime-package-manifest.json')
                payload = b'{"fixture":true}'
                if kind == 'symlink':
                    info.type = tarfile.SYMTYPE
                    info.linkname = '/outside-fixture-control'
                elif kind == 'fifo':
                    info.type = tarfile.FIFOTYPE
                elif kind == 'oversize':
                    payload = b'x' * (module.LIMIT + 1)
                    info.size = len(payload)
                else:
                    info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload) if info.isfile() else None)
            with patch.object(module, 'docker', return_value=buffer.getvalue()):
                if kind == 'regular':
                    self.assertEqual(module.app_manifest(), payload)
                else:
                    with self.assertRaises(ValueError):
                        module.app_manifest()


class FeedbackFilesTest(CollectorFilesTest):
    def helper(self, *args, input=None):
        script = Path(__file__).resolve().parents[1] / 'scripts/feedback-files.py'
        return subprocess.run([sys.executable, str(script), *map(str, args)], input=input, env={**os.environ, 'DEPLOY_ROOT': str(self.root)}, capture_output=True, timeout=5)

    def test_snapshot_rejects_source_links_and_uses_private_directory(self):
        source = self.root / 'data/source'
        source.mkdir(parents=True)
        (source / 'ordinary.json').write_bytes(b'{"fixture":true}')
        copied = self.helper('snapshot', source)
        self.assertEqual(copied.returncode, 0, copied.stderr)
        private = Path(copied.stdout.decode().strip())
        self.assertTrue(private.is_relative_to(self.root / '.tradejs-collector-state') if hasattr(private, 'is_relative_to') else str(private).startswith(str(self.root / '.tradejs-collector-state')))
        self.assertEqual((private / 'ordinary.json').read_bytes(), b'{"fixture":true}')
        (source / 'linked').symlink_to(self.sentinel)
        self.assertNotEqual(self.helper('snapshot', source).returncode, 0)
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')

    def test_publication_and_cleanup_reject_linked_parents(self):
        source = self.root / 'data/source'
        source.mkdir(parents=True)
        (source / '.complete').write_bytes(b'fixture')
        target = self.root / 'data/target'
        target.symlink_to(self.sentinel.parent, target_is_directory=True)
        self.assertNotEqual(self.helper('publish', source, target).returncode, 0)
        self.assertFalse((self.sentinel.parent / '.complete').exists())
        # Removing a symlink entry must never remove the directory it points to.
        self.assertEqual(self.helper('remove', target).returncode, 0)
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')

    def test_metadata_replaces_leaf_link_without_truncation(self):
        target = self.root / 'data/receipt.json'
        target.parent.mkdir()
        target.symlink_to(self.sentinel)
        result = self.helper('write', target, input=b'{"fixture":true}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')
        self.assertEqual(target.read_bytes(), b'{"fixture":true}')

    def test_maintenance_rejects_shared_log_link(self):
        log = self.root / 'data/cron.log'
        log.parent.mkdir()
        log.symlink_to(self.sentinel)
        result = self.helper('maintenance', self.root / 'data', 'production', log, '1', '1', '1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.sentinel.read_bytes(), b'control unchanged')


if __name__ == '__main__':
    unittest.main()
