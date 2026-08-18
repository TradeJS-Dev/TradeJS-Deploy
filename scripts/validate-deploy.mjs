import fs from 'node:fs';

const read = (relativePath) => fs.readFileSync(relativePath, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const workflow = read('.github/workflows/deploy.yml');
const backupWorkflow = read('.github/workflows/redis-backup.yml');
const runtimeConfigWorkflow = read('.github/workflows/runtime-config.yml');
const compose = read('docker-compose.prod.yml');
const redisBackup = read('scripts/redis-backup.sh');
const redisVolumeRestore = read('scripts/redis-volume-restore.sh');

assert(
  workflow.includes('tradejs-project-image-published'),
  'Deploy does not listen for TradeJS-Project releases',
);
assert(
  !workflow.includes('tradejs-images-published'),
  'Deploy still accepts the ambiguous monorepo image event',
);
assert(
  workflow.includes('repository: TradeJS-Dev/TradeJS-Project'),
  'Deploy does not fetch the project repository',
);
assert(
  workflow.includes('ref: ${{ steps.release.outputs.project_sha }}'),
  'Deploy does not pin project runtime config to an immutable ref',
);
assert(
  workflow.includes('cp tradejs-project/deploy/runtime.env .env'),
  'Runtime env is not sourced from TradeJS-Project',
);
assert(
  workflow.includes('DEPLOY_NEXTAUTH_SECRET: ${{ secrets.NEXTAUTH_SECRET }}') &&
    workflow.includes("printf 'AUTH_SECRET=%s\\n'"),
  'Runtime auth secret is not injected by Deploy',
);
assert(
  workflow.includes('DEPLOY_PG_PASSWORD: ${{ secrets.PG_PASSWORD }}') &&
    workflow.includes("printf 'PG_PASSWORD=%s\\n'") &&
    workflow.includes('.runtime-pg-password.env') &&
    workflow.includes('PG_PASSWORD is missing from GitHub secrets'),
  'Timescale password has no secret injection or server bootstrap path',
);
assert(
  !workflow.includes('AUTH_SECRET=${{ secrets.NEXTAUTH_SECRET }}') &&
    !workflow.includes('PG_PASSWORD=${{ secrets.PG_PASSWORD }}') &&
    !workflow.includes('AGENT_GITHUB_TOKEN=${{ secrets.AGENT_GITHUB_TOKEN }}'),
  'Runtime secrets are interpolated directly into the shell program',
);
assert(
  workflow.includes('ALTER ROLE app WITH PASSWORD'),
  'Existing Timescale roles are not synchronized with PG_PASSWORD',
);
assert(
  workflow.includes('AGENT_GITHUB_ORGANIZATION=TradeJS-Dev') &&
    workflow.includes('AGENT_GITHUB_BASE_BRANCH=main'),
  'Research agent is not routed to standalone strategy repositories',
);
assert(
  !workflow.includes('AGENT_GITHUB_REPOSITORY=TradeJS-Dev/TradeJS'),
  'Research agent still targets the engine repository',
);
assert(
  workflow.includes('AGENT_IMAGE_TAG=latest') &&
    workflow.includes('ML_INFER_IMAGE_TAG=latest'),
  'Initial Project deploy must not reuse the app SHA for engine images',
);
assert(
  compose.includes('ghcr.io/tradejs-dev/tradejs-project-app:${APP_IMAGE_TAG}'),
  'Compose still uses the TradeJS monorepo app image',
);
assert(
  compose.includes(
    'ghcr.io/tradejs-dev/tradejs-ml-infer:${ML_INFER_IMAGE_TAG}',
  ),
  'ML inference image ownership changed accidentally',
);
assert(
  compose.includes('ghcr.io/tradejs-dev/tradejs-agent:${AGENT_IMAGE_TAG}'),
  'Research agent image ownership changed accidentally',
);
assert(
  compose.includes('POSTGRES_PASSWORD=${PG_PASSWORD:?PG_PASSWORD is required}'),
  'Compose does not require the Deploy-owned Timescale password',
);
assert(
  !compose.includes('POSTGRES_PASSWORD=app'),
  'Compose still contains the legacy Timescale password',
);
assert(
  compose.includes('redis/redis-stack:7.4.0-v8') &&
    !compose.includes('redis/redis-stack:latest'),
  'Redis Stack image is not pinned',
);
assert(
  compose.includes('--dir') &&
    compose.includes('/data') &&
    compose.includes('--dbfilename') &&
    compose.includes('dump.rdb') &&
    compose.includes('--appendonly') &&
    compose.includes('everysec'),
  'Redis AOF persistence is not enabled',
);
assert(
  workflow.includes('./scripts/redis-backup.sh --verify'),
  'Deploy does not back up and restore-drill Redis',
);
assert(
  backupWorkflow.includes('schedule:') &&
    backupWorkflow.includes('redis-backup.sh --verify'),
  'Redis backup restore drill is not scheduled',
);
assert(
  runtimeConfigWorkflow.includes('environment: production') &&
    runtimeConfigWorkflow.includes('confirm_mutation') &&
    runtimeConfigWorkflow.includes('./scripts/redis-backup.sh --verify') &&
    runtimeConfigWorkflow.includes('runtime-config verify') &&
    runtimeConfigWorkflow.includes('redis-cli --scan --pattern') &&
    runtimeConfigWorkflow.includes('users:*:trading-accounts:*') &&
    runtimeConfigWorkflow.includes('$volume_name:/source:ro') &&
    runtimeConfigWorkflow.includes('config_base64') &&
    runtimeConfigWorkflow.includes('runtime_config_path="/tmp/') &&
    runtimeConfigWorkflow.includes('bootstrap | rollout') &&
    runtimeConfigWorkflow.includes('RUNTIME_PROVIDER: ${{ inputs.connector_name }}') &&
    runtimeConfigWorkflow.includes('restore-volume') &&
    runtimeConfigWorkflow.includes('restore-account') &&
    runtimeConfigWorkflow.includes('Restored Redis does not contain the versioned runtime binding') &&
    runtimeConfigWorkflow.includes('pre-manual-restore') &&
    runtimeConfigWorkflow.includes('without exposing its value') &&
    runtimeConfigWorkflow.includes('refusing to overwrite it') &&
    runtimeConfigWorkflow.includes('--user 0'),
  'Runtime config writes are not guarded by confirmation, backup, and verification',
);
assert(
  runtimeConfigWorkflow.includes('runtime-package-manifest.json') &&
    runtimeConfigWorkflow.includes('./node_modules/.bin/tradejs runtime-config') &&
    !runtimeConfigWorkflow.includes('redis-cli JSON.SET'),
  'Runtime config workflow bypasses the versioned CLI or package manifest',
);
assert(
  redisBackup.includes('BGSAVE') &&
    redisBackup.includes('sha256sum') &&
    redisBackup.includes('LASTSAVE') &&
    redisBackup.includes('CONFIG GET dir') &&
    redisBackup.includes('CONFIG GET dbfilename') &&
    redisBackup.includes('redis-check-rdb') &&
    redisBackup.includes('PTTL') &&
    redisBackup.includes('--user 0') &&
    redisBackup.includes('/data/dump.rdb:ro') &&
    redisBackup.includes('--dir /data --dbfilename dump.rdb') &&
    redisBackup.includes('--prepare-volume') &&
    redisBackup.includes('pre-canonical') &&
    redisBackup.includes('loaded no persistent keys') &&
    redisBackup.includes('tradejs-redis-backup/v1'),
  'Redis backup script does not save, checksum, and restore-drill the data',
);
assert(
  workflow.includes('./scripts/redis-backup.sh --verify --prepare-volume') &&
    workflow.includes('Redis persistent-key mismatch after Compose update') &&
    workflow.includes('redis_persistent_count_script') &&
    workflow.includes('Recovered interrupted Redis volume migration') &&
    workflow.includes('./scripts/redis-volume-restore.sh'),
  'Deploy does not migrate and verify Redis persistence before Compose updates',
);
assert(
  redisVolumeRestore.includes('redis-check-rdb') &&
    redisVolumeRestore.includes('CONFIG SET appendonly yes') &&
    redisVolumeRestore.includes('aof_last_bgrewrite_status') &&
    redisVolumeRestore.includes('volume restore persistent-key mismatch') &&
    redisVolumeRestore.includes('SHUTDOWN NOSAVE'),
  'Redis volume restore does not verify RDB, persistent keys, and durable AOF',
);
assert(
  workflow.includes('runtime-package-manifest.json') &&
    workflow.includes('compare-runtime-manifests.mjs'),
  'Deploy does not inspect the immutable runtime package manifest',
);
assert(
  workflow.includes('release.env.previous') &&
    workflow.includes('rollback_app'),
  'App rollout has no automatic image rollback',
);
assert(
  workflow.includes('App image tag must be a full commit SHA') &&
    !workflow.includes('APP_IMAGE_TAG=latest'),
  'App rollout still accepts a mutable image tag',
);

console.log('Validated TradeJS-Project to TradeJS-Deploy handoff.');
