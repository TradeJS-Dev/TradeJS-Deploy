#!/usr/bin/env python3
"""Initialize operator-owned collector state without following shared links."""
import os
from pathlib import Path
import re
import sys

from host_files import BrokerFiles


def initialize(root, source_sha=None):
    with BrokerFiles(root) as files:
        private = files.private_directory()
        if source_sha is not None:
            if not re.fullmatch('[a-f0-9]{40}', source_sha):
                raise ValueError('Exact Deploy source SHA is required')
            payload = (source_sha + '\n').encode()
            files.atomic_bytes(private / 'deploy-source-sha', payload)
            # Keep the public diagnostic path, but never use it as host authority.
            files.atomic_bytes(root / 'data/runtime-components/deploy-source-sha', payload)
        for name in ('components.log', 'verification.log', 'mcp-host.log', 'feedback-cron.log'):
            with files.lock(private / name):
                pass
        return private


if __name__ == '__main__':
    print(initialize(Path(os.environ.get('DEPLOY_ROOT', str(Path.home()))), sys.argv[1] if len(sys.argv) > 1 else None))
