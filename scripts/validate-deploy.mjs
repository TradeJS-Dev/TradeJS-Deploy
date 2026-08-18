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
const appRollback = read('scripts/rollback-app.sh');
const packageJson = JSON.parse(read('package.json'));

assert(
  workflow.includes('tradejs-project-image-published') &&
    !workflow.includes('tradejs-images-published'),
  'Deploy must accept only the immutable Project image event',
);
assert(
  workflow.includes('repository: TradeJS-Dev/TradeJS-Project') &&
    workflow.includes('ref: ${{ steps.release.outputs.project_sha }}') &&
    workflow.includes('cp tradejs-project/deploy/runtime.env .env'),
  'Deploy does not pin runtime config to the dispatched Project SHA',
);
assert(
  workflow.includes('DEPLOY_NEXTAUTH_SECRET: ${{ secrets.NEXTAUTH_SECRET }}') &&
    workflow.includes("printf 'AUTH_SECRET=%s\\n'") &&
    workflow.includes('DEPLOY_PG_PASSWORD: ${{ secrets.PG_PASSWORD }}') &&
    workflow.includes("printf 'PG_PASSWORD=%s\\n'") &&
    workflow.includes('DEPLOY_COINALYZE_API_KEY: ${{ secrets.COINALYZE_API_KEY }}') &&
    workflow.includes("printf 'COINALYZE_API_KEY=%s\\n'") &&
    workflow.includes('await updateUserRecord("root", { COINALYZE_API_KEY: apiKey })') &&
    workflow.includes('Root Coinalyze credential is configured'),
  'Deploy secret injection is incomplete',
);
assert(
  !workflow.includes('AUTH_SECRET=${{ secrets.NEXTAUTH_SECRET }}') &&
    !workflow.includes('PG_PASSWORD=${{ secrets.PG_PASSWORD }}') &&
    !workflow.includes('COINALYZE_API_KEY=${{ secrets.COINALYZE_API_KEY }}'),
  'Deploy interpolates secrets directly into its shell program',
);
assert(
  compose.includes('ghcr.io/tradejs-dev/tradejs-project-app:${APP_IMAGE_TAG}') &&
    compose.includes('POSTGRES_PASSWORD=${PG_PASSWORD:?PG_PASSWORD is required}') &&
    !compose.includes('POSTGRES_PASSWORD=app'),
  'Production Compose does not use the immutable Project image and secret DB password',
);
assert(
  compose.includes('redis/redis-stack:7.4.0-v8') &&
    !compose.includes('redis/redis-stack:latest') &&
    compose.includes('--dir') &&
    compose.includes('/data') &&
    compose.includes('--dbfilename') &&
    compose.includes('dump.rdb') &&
    compose.includes('--appendonly') &&
    compose.includes('everysec'),
  'Redis must use the pinned image and canonical /data persistence',
);
assert(
  workflow.includes('./scripts/redis-backup.sh --verify') &&
    workflow.includes('Redis persistent-key mismatch after Compose update') &&
    backupWorkflow.includes('schedule:') &&
    backupWorkflow.includes('redis-backup.sh --verify'),
  'Redis backup drill and post-Compose persistence checks are missing',
);
assert(
  runtimeConfigWorkflow.includes('environment: production') &&
    runtimeConfigWorkflow.includes('confirm_mutation') &&
    runtimeConfigWorkflow.includes('./scripts/redis-backup.sh --verify') &&
    runtimeConfigWorkflow.includes('runtime-config verify') &&
    runtimeConfigWorkflow.includes('provision | rollout') &&
    runtimeConfigWorkflow.includes('runtime-package-manifest.json') &&
    !runtimeConfigWorkflow.includes('redis-cli JSON.SET'),
  'Runtime writes must use the versioned CLI after confirmation and backup',
);

for (const forbidden of [
  'restore-volume',
  'restore-account',
  'bootstrap',
  'migrate',
  'legacy_config',
  'prepare-volume',
  'redis-volume-restore',
  'pre-canonical',
]) {
  assert(
    !runtimeConfigWorkflow.includes(forbidden) &&
      !workflow.includes(forbidden) &&
      !redisBackup.includes(forbidden),
    `Legacy runtime fallback remains: ${forbidden}`,
  );
}

assert(
  redisBackup.includes('BGSAVE') &&
    redisBackup.includes('sha256sum') &&
    redisBackup.includes('LASTSAVE') &&
    redisBackup.includes('redis-check-rdb') &&
    redisBackup.includes('PTTL') &&
    redisBackup.includes('/data/dump.rdb:ro') &&
    redisBackup.includes('--dir /data --dbfilename dump.rdb') &&
    redisBackup.includes('Redis persistence must use /data/dump.rdb') &&
    redisBackup.includes('tradejs-redis-backup/v1'),
  'Redis backup script does not verify the canonical snapshot',
);
assert(
    workflow.includes('runtime-package-manifest.json') &&
    workflow.includes('compare-runtime-manifests.mjs') &&
    read('scripts/compare-runtime-manifests.mjs').includes(
      'Production image contains non-stable packages',
    ) &&
    workflow.includes('release.env.previous') &&
    workflow.includes('rollback_app') &&
    workflow.includes('./scripts/rollback-app.sh') &&
    appRollback.includes('APP_IMAGE_TAG="$rollback_app_image_tag"') &&
    appRollback.includes('--force-recreate app'),
  'Image manifest comparison or app rollback is missing',
);
assert(
  packageJson.scripts.test === 'node --test ./tests/*.test.mjs' &&
    packageJson.scripts.checks ===
      'node ./scripts/validate-deploy.mjs && yarn test',
  'Deploy checks must include behavioral tests',
);

console.log('Validated canonical TradeJS production deployment.');
