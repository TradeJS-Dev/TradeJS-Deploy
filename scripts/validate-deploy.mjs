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
  compose.includes('--appendonly') && compose.includes('everysec'),
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
    runtimeConfigWorkflow.includes('$volume_name:/source:ro') &&
    runtimeConfigWorkflow.includes('config_base64') &&
    runtimeConfigWorkflow.includes('bootstrap_config_path="/tmp/'),
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
    redisBackup.includes('DBSIZE mismatch') &&
    redisBackup.includes('tradejs-redis-backup/v1'),
  'Redis backup script does not save, checksum, and restore-drill the data',
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
