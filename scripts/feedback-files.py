#!/usr/bin/env python3
"""Host filesystem operations for feedback; shared names never select host targets."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

from host_files import BrokerFiles


def remove_tree(files, path):
    with files.parent(path) as (parent, name):
        try:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(info.st_mode):
            os.unlink(name, dir_fd=parent)
            return
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            for entry in os.listdir(fd):
                remove_at(fd, entry)
        finally:
            os.close(fd)
        os.rmdir(name, dir_fd=parent)


def remove_at(parent, name):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            for entry in os.listdir(fd):
                remove_at(fd, entry)
        finally:
            os.close(fd)
        os.rmdir(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)


def copy_tree(files, source, destination):
    # The source is host-private staging or a previously pinned shared directory.
    # Open every directory/file with no-follow and stream file contents by fd.
    with files.parent(source / '.check') as (source_fd, _):
        with files.parent(destination / '.check') as (target_fd, _):
            copy_at(source_fd, target_fd)


def copy_at(source, target):
    entries = sorted(os.listdir(source), key=lambda name: name == '.complete')
    for name in entries:
        info = os.stat(name, dir_fd=source, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            try:
                os.mkdir(name, 0o755, dir_fd=target)
            except FileExistsError:
                pass
            src = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source)
            dst = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target)
            try:
                copy_at(src, dst)
            finally:
                os.close(src)
                os.close(dst)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source)
            temporary = '.feedback-' + os.urandom(16).hex()
            dst = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=target)
            try:
                current = os.fstat(src)
                if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                    raise ValueError('Invalid feedback source file')
                with os.fdopen(src, 'rb', closefd=False) as stream, os.fdopen(dst, 'wb', closefd=False) as output:
                    remaining = current.st_size
                    while remaining:
                        chunk = stream.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError('Feedback source changed during copy')
                        output.write(chunk)
                        remaining -= len(chunk)
                    if stream.read(1) or os.fstat(src).st_mtime_ns != current.st_mtime_ns:
                        raise ValueError('Feedback source changed during copy')
                    output.flush()
                os.replace(temporary, name, src_dir_fd=target, dst_dir_fd=target)
            finally:
                os.close(src)
                os.close(dst)
                try:
                    os.unlink(temporary, dir_fd=target)
                except FileNotFoundError:
                    pass
        else:
            raise ValueError('Feedback bundles must contain ordinary files and directories')


def maintenance(files, feedback, deployment, log, failed_days, log_days, log_max):
    failed = feedback / 'failed'
    completed = feedback / 'completed' / deployment
    now = time.time()
    with files.parent(failed / '.check') as (fd, _):
        for name in os.listdir(fd):
            match = re.fullmatch(r'(.+)-[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9]+', name)
            if not match:
                continue
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or now - info.st_mtime <= (failed_days + 1) * 86400:
                continue
            try:
                files.read(completed / (match[1] + '.json'), 48_000)
            except FileNotFoundError:
                continue
            remove_tree(files, failed / name)
    # Rotation is anchored even for an explicitly configured legacy log path.
    with files.parent(log) as (fd, name):
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError:
            descriptor = None
        if descriptor is not None:
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('Invalid feedback log')
                if info.st_size >= log_max:
                    rotated = name + '.' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
                    os.replace(name, rotated, src_dir_fd=fd, dst_dir_fd=fd)
                    files.atomic_bytes(log, b'')
            finally:
                os.close(descriptor)
        for entry in os.listdir(fd):
            info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
            if entry.startswith(name + '.') and stat.S_ISREG(info.st_mode) and now - info.st_mtime > (log_days + 1) * 86400:
                os.unlink(entry, dir_fd=fd)


def main():
    root = Path(os.environ.get('DEPLOY_ROOT', str(Path.home())))
    command, *args = sys.argv[1:]
    with BrokerFiles(root) as files:
        private = files.private_directory()
        if command == 'init':
            for name in args:
                with files.parent(Path(name) / '.check'):
                    pass
        elif command == 'prepare':
            work = Path(tempfile.mkdtemp(prefix='feedback-', dir=private))
            for name in ('incoming', 'work'):
                directory = work / name
                directory.mkdir()
                subprocess.run(['chown', '1000:1000', str(directory)], check=True)
            print(str(work / 'incoming') + '\t' + str(work / 'work'))
        elif command == 'snapshot':
            name = Path(args[0]).name
            if name in ('', '.', '..') or not re.fullmatch(r'[a-zA-Z0-9._-]+', name):
                raise ValueError('Invalid evidence bundle identity')
            directory = Path(tempfile.mkdtemp(prefix='evidence-', dir=private))
            snapshot = directory / name
            try:
                copy_tree(files, Path(args[0]), snapshot)
            except Exception:
                remove_tree(files, directory)
                raise
            print(snapshot)
        elif command == 'publish':
            copy_tree(files, Path(args[0]), Path(args[1]))
        elif command == 'remove':
            for name in args:
                remove_tree(files, Path(name))
        elif command == 'write':
            payload = sys.stdin.buffer.read(48_001)
            if len(payload) > 48_000:
                raise ValueError('Oversized feedback metadata')
            files.atomic_bytes(Path(args[0]), payload)
        elif command == 'read':
            sys.stdout.buffer.write(files.read(Path(args[0]), 48_000))
        elif command == 'maintenance':
            maintenance(files, Path(args[0]), args[1], Path(args[2]), *map(int, args[3:]))
        else:
            raise ValueError('Unknown feedback filesystem operation')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit('Feedback filesystem operation failed: ' + type(error).__name__)
