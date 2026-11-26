"""Descriptor-anchored access to data shared with application containers."""
import os
import stat
import secrets
import json
from contextlib import contextmanager


class BrokerFiles:
    """Anchor host writes to directory descriptors, never shared path links."""
    def __init__(self, root):
        self.root = root
        self.resolved_root = root.resolve(strict=True)
        self.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        os.close(self.fd)

    @contextmanager
    def parent(self, file):
        try:
            parts = file.relative_to(self.root).parts
        except ValueError:
            parts = file.relative_to(self.resolved_root).parts
        if not parts or any(part in ('.', '..') for part in parts):
            raise ValueError('Invalid broker path')
        fd = os.dup(self.fd)
        try:
            for part in parts[:-1]:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            yield fd, parts[-1]
        finally:
            os.close(fd)

    def read(self, file, limit=None):
        with self.parent(file) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('Broker input must be a regular unlinked file')
                with os.fdopen(fd, 'rb', closefd=False) as stream:
                    payload = stream.read() if limit is None else stream.read(limit + 1)
                    if limit is not None and len(payload) > limit:
                        raise ValueError('Broker input exceeds its size limit')
                    return payload
            finally:
                os.close(fd)

    @contextmanager
    def output(self, file):
        with self.parent(file) as (parent, name):
            temporary = '.broker-' + secrets.token_hex(16)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
            try:
                # Replacing the entry also breaks existing hard links. The open
                # descriptor remains ours if a shared writer replaces it again.
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                with os.fdopen(fd, 'w', closefd=False) as stream:
                    yield stream
            finally:
                os.close(fd)
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass

    def atomic(self, file, value):
        self.atomic_bytes(file, (json.dumps(value) + '\n').encode())

    def atomic_bytes(self, file, value):
        with self.parent(file) as (parent, name):
            temporary = '.broker-' + secrets.token_hex(16)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(value)
                    stream.flush()
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            finally:
                os.close(fd)
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass

    def private_directory(self, name='.tradejs-collector-state'):
        if '/' in name or name in ('', '.', '..'):
            raise ValueError('Invalid private state directory')
        try:
            os.mkdir(name, 0o700, dir_fd=self.fd)
        except FileExistsError:
            pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise ValueError('Collector state must be private to its owner')
        finally:
            os.close(fd)
        return self.root / name

    def rename(self, source, target):
        with self.parent(source) as (src, name), self.parent(target) as (dst, destination):
            os.replace(name, destination, src_dir_fd=src, dst_dir_fd=dst)

    def publish(self, file, value):
        with self.parent(file) as (parent, name):
            temporary = '.broker-' + secrets.token_hex(16)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
            try:
                with os.fdopen(fd, 'w', closefd=False) as stream:
                    stream.write(json.dumps(value))
                    stream.flush()
                try:
                    os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                except FileExistsError:
                    pass
            finally:
                os.close(fd)
                os.unlink(temporary, dir_fd=parent)

    def host_lock(self, file):
        # The override is trusted host configuration, not a queue request.
        # Preserve operator-selected lock directories outside DEPLOY_ROOT.
        file = file.absolute()
        if file.is_relative_to(self.root) or file.is_relative_to(self.resolved_root):
            return self.lock(file)
        directory = file.parent.resolve(strict=True)
        with BrokerFiles(directory) as external:
            return external.lock(directory / file.name)

    def lock(self, file):
        with self.parent(file) as (parent, name):
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                os.close(fd)
                raise ValueError('Invalid host lock')
            return os.fdopen(fd, 'a')
