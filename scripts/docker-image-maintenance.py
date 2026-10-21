#!/usr/bin/env python3
"""Remove only planned images and expired replay leases; never prune volumes."""

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time


REPOSITORIES = {
    'APP_IMAGE_TAG': 'ghcr.io/tradejs-dev/tradejs-project-app',
    'AGENT_IMAGE_TAG': 'ghcr.io/tradejs-dev/tradejs-agent',
    'ML_INFER_IMAGE_TAG': 'ghcr.io/tradejs-dev/tradejs-ml-infer',
    'SITE_IMAGE_TAG': 'ghcr.io/tradejs-dev/tradejs-site',
    'DOCS_IMAGE_TAG': 'ghcr.io/tradejs-dev/tradejs-docs',
}
LEASE = 'tradejs.runtime-feedback.image-lease'
EXPIRES = 'tradejs.runtime-feedback.expires-at'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def inventory(kind):
    ids = sorted(set(docker(kind, 'ls', '-aq', '--no-trunc').split()))
    return json.loads(docker(kind, 'inspect', *ids)) if ids else []


def release_snapshot(root):
    current = root / 'release.env'
    if not current.is_file():
        raise ValueError('release.env is required; refusing cleanup')
    return {
        name: (root / name).read_bytes() if (root / name).exists() else None
        for name in ('release.env', 'release.env.previous')
    }


def release_refs(snapshot):
    refs = set()
    for name, content in snapshot.items():
        if content is None:
            continue
        values = {}
        for line in content.decode().splitlines():
            key, separator, value = line.partition('=')
            if (not separator or key in values
                    or key not in {*REPOSITORIES, 'PROJECT_SHA'}
                    or not re.fullmatch('[0-9a-f]{40}', value)):
                raise ValueError(f'Invalid release state: {name}')
            values[key] = value
        if set(values) != {*REPOSITORIES, 'PROJECT_SHA'}:
            raise ValueError(f'Incomplete release state: {name}')
        refs.update(f'{repo}:{values[key]}' for key, repo in REPOSITORIES.items())
    return refs


def expired(container, now):
    labels = container['Config'].get('Labels') or {}
    expiry = labels.get(EXPIRES, '')
    return (labels.get(LEASE) == 'true'
            and container['State']['Status'] in ('created', 'exited')
            and not container['State']['Running']
            and re.fullmatch('[0-9]+', expiry) is not None
            and 0 < int(expiry) <= now)


def created_at(image):
    return datetime.datetime.fromisoformat(image['Created'].replace('Z', '+00:00')).timestamp()


def plan(images, containers, snapshot, now, min_age):
    required = release_refs(snapshot)
    local_tags = {tag: image['Id'] for image in images for tag in image.get('RepoTags') or []}
    missing = required - local_tags.keys()
    if missing:
        raise ValueError('Release images missing locally; refusing cleanup: ' + ', '.join(sorted(missing)))
    leases = [c for c in containers if expired(c, now)]
    removed = {c['Id'] for c in leases}
    keep = {c['Image'] for c in containers if c['Id'] not in removed}
    keep.update(local_tags[tag] for tag in required)
    # In addition to declared releases, retain two newest immutable images per component.
    for repo in REPOSITORIES.values():
        versions = [image for image in images if any(
            re.fullmatch(re.escape(repo) + ':[0-9a-f]{40}', tag)
            for tag in image.get('RepoTags') or [])]
        keep.update(image['Id'] for image in sorted(versions, key=created_at, reverse=True)[:2])
    candidates = []
    for image in images:
        tags = image.get('RepoTags') or []
        managed = all(tag.rsplit(':', 1)[0] in REPOSITORIES.values() for tag in tags)
        if image['Id'] not in keep and managed and now - created_at(image) >= min_age:
            candidates.append(image)
    return leases, candidates, keep


def apply(root, snapshot, leases, images, keep):
    def check_release():
        if release_snapshot(root) != snapshot:
            raise ValueError('Release state changed during cleanup; stopping')

    for lease in leases:
        check_release()
        current = json.loads(docker('container', 'inspect', lease['Id']))[0]
        if expired(current, time.time()):
            # No force and no -v: running containers and their volumes cannot be removed.
            docker('container', 'rm', lease['Id'])
            print('Removed expired lease:', lease['Id'], flush=True)
    for image in images:
        check_release()
        image_id = image['Id']
        if image_id in keep or docker('container', 'ls', '-aq', '--filter', f'ancestor={image_id}'):
            continue
        current = json.loads(docker('image', 'inspect', image_id))[0]
        if (sorted(current.get('RepoTags') or []) != sorted(image.get('RepoTags') or [])
                or sorted(current.get('RepoDigests') or []) != sorted(image.get('RepoDigests') or [])):
            raise ValueError('Image references changed during cleanup; stopping')
        refs = current.get('RepoTags') or [image_id]
        for ref in refs:
            if json.loads(docker('image', 'inspect', ref))[0]['Id'] != image_id:
                raise ValueError('Image tag changed during cleanup; stopping')
        # Docker also refuses removal if a container acquired the image meanwhile.
        docker('image', 'rm', *refs)
        print('Removed image:', image_id, flush=True)


def available_bytes(root):
    stat = os.statvfs(root)
    return stat.f_bavail * stat.f_frsize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--release-dir', type=Path, default=Path.home())
    args = parser.parse_args()
    root = args.release_dir.resolve()
    with (root / '.docker-image-maintenance.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        snapshot = release_snapshot(root)
        before_containers = inventory('container')
        leases, images, keep = plan(inventory('image'), before_containers, snapshot, time.time(), 86400)
        print(json.dumps({'dryRun': args.dry_run, 'expiredContainers': [c['Id'] for c in leases],
                          'deleteImages': [{'id': i['Id'], 'tags': i.get('RepoTags')} for i in images],
                          'preserveImages': sorted(keep)}, indent=2), flush=True)
        if args.dry_run:
            return
        before = available_bytes(root)
        apply(root, snapshot, leases, images, keep)
        after_containers = {c['Id']: c for c in inventory('container')}
        for old in before_containers:
            if not old['State']['Running']:
                continue
            current = after_containers.get(old['Id'])
            if (current is None or not current['State']['Running']
                    or current['Image'] != old['Image']
                    or current['State']['StartedAt'] != old['State']['StartedAt']
                    or current['RestartCount'] != old['RestartCount']
                    or (old['State'].get('Health', {}).get('Status') == 'healthy'
                        and current['State'].get('Health', {}).get('Status') != 'healthy')):
                raise ValueError('Running container changed or became unhealthy: ' + old['Name'])
        remaining = {image['Id'] for image in inventory('image')}
        if not keep <= remaining:
            raise ValueError('A protected image is missing after cleanup')
        print(json.dumps({'freedBytes': available_bytes(root) - before,
                          'availableBytes': available_bytes(root),
                          'runningContainersVerified': True}))


if __name__ == '__main__':
    main()
