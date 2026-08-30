import fs from 'node:fs';

const read = (relativePath) => fs.readFileSync(relativePath, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const workflow = read('.github/workflows/deploy.yml');
const componentWorkflow = read('.github/workflows/deploy-component.yml');
const initializeWorkflow = read('.github/workflows/initialize-release.yml');
const backupWorkflow = read('.github/workflows/redis-backup.yml');
const maintenanceWorkflow = read('.github/workflows/docker-maintenance.yml');
const runtimeControlWorkflow = read('.github/workflows/runtime-control.yml');
const compose = read('docker-compose.prod.yml');
const redisBackup = read('scripts/redis-backup.sh');
const appRollback = read('scripts/rollback-app.sh');
const releaseState = read('scripts/release-state.sh');
const legacyCleanup = read('scripts/cleanup-legacy-runtime-redis.sh');
const runtimeFeedbackReplay = read('scripts/runtime-feedback-replay.sh');
const runtimeFeedbackDb = read('scripts/ensure-runtime-feedback-db.sh');
const runtimeFeedbackCron = read('scripts/install-runtime-feedback-cron.sh');
const runtimeImageDigest = read('scripts/set-runtime-image-digest.sh');
const dockerImagePrune = read('scripts/docker-image-prune.sh');
const packageJson = JSON.parse(read('package.json'));

assert(
  workflow.includes('group: production-deploy') &&
    workflow.includes('cancel-in-progress: false'),
  'Production deploys must be serialized',
);
assert(
  !workflow.includes('environment:') &&
    !componentWorkflow.includes('environment:') &&
    !initializeWorkflow.includes('environment:') &&
    !backupWorkflow.includes('environment:') &&
    !maintenanceWorkflow.includes('environment:') &&
    !runtimeControlWorkflow.includes('environment:'),
  'Deploy workflows must read repository or organization secrets directly',
);

assert(
  workflow.includes('tradejs-project-image-published') &&
    !workflow.includes('tradejs-images-published') &&
    workflow.includes(
      'run-name: Deploy Project ${{ inputs.project_sha || github.event.client_payload.project_sha }}',
    ),
  'Deploy must accept only the immutable Project image event',
);
assert(
  workflow.includes('repository: TradeJS-Dev/TradeJS-Project') &&
    workflow.includes('ref: ${{ steps.release.outputs.project_sha }}') &&
    workflow.includes('cp tradejs-project/deploy/runtime.env runtime.env.incoming'),
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
    workflow.includes('Root Coinalyze credential is configured') &&
    workflow.includes('process.exit(0);'),
  'Deploy secret injection is incomplete',
);
assert(
  !workflow.includes('AUTH_SECRET=${{ secrets.NEXTAUTH_SECRET }}') &&
    !workflow.includes('PG_PASSWORD=${{ secrets.PG_PASSWORD }}') &&
    !workflow.includes('COINALYZE_API_KEY=${{ secrets.COINALYZE_API_KEY }}'),
  'Deploy interpolates secrets directly into its shell program',
);
assert(
  !workflow.includes('Preserve existing server-owned database password') &&
    !workflow.includes('.runtime-pg-password.env') &&
    !workflow.includes('if [ -n "$DEPLOY_PG_PASSWORD" ]'),
  'PG_PASSWORD must be required and injected without a server fallback',
);
assert(
  compose.includes('ghcr.io/tradejs-dev/tradejs-project-app:${APP_IMAGE_TAG:?APP_IMAGE_TAG is required}') &&
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
  compose.includes('name: tradejs-runtime-replay') &&
    compose.includes('internal: true') &&
    compose.match(/timescale:[\s\S]*networks:[\s\S]*- runtime-replay/) &&
    compose.match(/ml-infer:[\s\S]*networks:[\s\S]*- runtime-replay/),
  'Replay must reach Timescale and ML inference only through the internal replay network',
);
assert(
  workflow.includes('REPLAY_PG_PASSWORD: ${{ secrets.REPLAY_PG_PASSWORD }}') &&
    !workflow.match(/for name in [^\n]*REPLAY_PG_PASSWORD/) &&
    workflow.includes('PG_PASSWORD="$DEPLOY_PG_PASSWORD"') &&
    workflow.includes('set-runtime-image-digest.sh') &&
    workflow.includes('ensure-runtime-feedback-db.sh') &&
    workflow.includes('install-runtime-feedback-cron.sh') &&
    initializeWorkflow.includes(
      'REPLAY_PG_PASSWORD: ${{ secrets.REPLAY_PG_PASSWORD }}',
    ) &&
    !initializeWorkflow.match(/for name in [^\n]*REPLAY_PG_PASSWORD/) &&
    initializeWorkflow.includes('PG_PASSWORD="$DEPLOY_PG_PASSWORD"') &&
    initializeWorkflow.includes('set-runtime-image-digest.sh') &&
    initializeWorkflow.includes('ensure-runtime-feedback-db.sh') &&
    initializeWorkflow.includes('install-runtime-feedback-cron.sh'),
  'App rollout must install the image-bound runtime feedback contour',
);
assert(
  runtimeImageDigest.includes('RepoDigests') &&
    runtimeImageDigest.includes('TRADEJS_PROJECT_IMAGE_DIGEST') &&
    runtimeImageDigest.includes('sha256:[0-9a-f]{64}'),
  'Runtime evidence must receive the pulled application image digest',
);
assert(
  runtimeFeedbackDb.includes('runtime_replay') &&
    runtimeFeedbackDb.includes('tradejs-runtime-replay-password/v1') &&
    runtimeFeedbackDb.includes('tradejs_replay_$password_digest') &&
    runtimeFeedbackDb.includes('PG_PASSWORD is required when REPLAY_PG_PASSWORD is not set') &&
    runtimeFeedbackDb.includes('default_transaction_read_only = on') &&
    runtimeFeedbackDb.includes('GRANT SELECT ON ALL TABLES') &&
    runtimeFeedbackDb.includes('docker network create --internal') &&
    runtimeFeedbackDb.includes('--alias ml-infer') &&
    !runtimeFeedbackDb.includes('REDIS_HOST=redis'),
  'Runtime feedback storage credentials must be read-only and isolated',
);
assert(
  runtimeFeedbackReplay.includes('--pull=never') &&
    runtimeFeedbackReplay.includes('image_repository@$image_digest') &&
    runtimeFeedbackReplay.includes('--read-only') &&
    runtimeFeedbackReplay.includes('--network "$network"') &&
    runtimeFeedbackReplay.includes('RUNTIME_FEEDBACK_ISOLATED_REDIS=true') &&
    runtimeFeedbackReplay.includes('TRADEJS_TIMESCALE_READ_ONLY=true') &&
    runtimeFeedbackReplay.includes('ML_GRPC_ADDRESS=ml-infer:50051') &&
    runtimeFeedbackReplay.includes('MAKE_ORDERS=false') &&
    runtimeFeedbackReplay.includes(
      'TRADEJS_EXTERNAL_ORDER_PLACEMENT=false',
    ) &&
    runtimeFeedbackReplay.includes('RUNTIME_FEEDBACK_MIN_AVAILABLE_KB:-6291456') &&
    runtimeFeedbackReplay.includes('RUNTIME_FEEDBACK_REPLAY_MEMORY:-5g') &&
    runtimeFeedbackReplay.includes('RUNTIME_FEEDBACK_NODE_HEAP_MB:-4096') &&
    runtimeFeedbackReplay.includes('--memory "$replay_memory"') &&
    runtimeFeedbackReplay.includes('--cpus 1.5') &&
    runtimeFeedbackReplay.includes('$bundle_dir:/runtime-evidence:ro') &&
    !runtimeFeedbackReplay.includes('-v "$HOME/.env') &&
    !runtimeFeedbackReplay.includes('REDIS_HOST=redis'),
  'Runtime feedback replay must use the exact image with hard resource and IO boundaries',
);
assert(
  runtimeFeedbackCron.includes('20 21 * * *') &&
    runtimeFeedbackCron.includes('CRON_TZ=Europe/Moscow'),
  'Runtime feedback replay must run only after the daily evidence window closes',
);
assert(
  dockerImagePrune.includes('tradejs.runtime-feedback.image-lease=true') &&
    dockerImagePrune.includes('tradejs.runtime-feedback.expires-at') &&
    dockerImagePrune.includes('docker image prune -a -f') &&
    maintenanceWorkflow.includes('docker-image-prune.sh') &&
    !maintenanceWorkflow.includes('docker image prune -a -f'),
  'Docker maintenance must preserve unexpired replay image leases',
);
assert(
  workflow.includes('./scripts/redis-backup.sh --verify') &&
    backupWorkflow.includes('schedule:') &&
    backupWorkflow.includes('redis-backup.sh --verify'),
  'Redis backup drill and post-Compose persistence checks are missing',
);
assert(
  !runtimeControlWorkflow.includes('confirm_mutation') &&
    runtimeControlWorkflow.includes('./scripts/redis-backup.sh --verify') &&
    runtimeControlWorkflow.includes('runtime-control') &&
    runtimeControlWorkflow.includes('cleanup-legacy') &&
    runtimeControlWorkflow.includes('signals-dry-run') &&
    runtimeControlWorkflow.includes('runtime-package-manifest.json') &&
    runtimeControlWorkflow.includes('--showSkipStats') &&
    !runtimeControlWorkflow.includes('signals \\\n                  --makeOrders') &&
    !runtimeControlWorkflow.includes('redis-cli JSON.SET'),
  'Runtime controls must use the Git-owned CLI with backup protection',
);
assert(
  legacyCleanup.includes('DELETE_LEGACY_RUNTIME_KEYS') &&
    legacyCleanup.includes('redis-cli --raw UNLINK "$key"') &&
    legacyCleanup.includes('[[ "$suffix" != *:* ]]') &&
    !legacyCleanup.includes('FLUSHALL') &&
    !legacyCleanup.includes('FLUSHDB'),
  'Legacy cleanup must be explicit, allowlisted, and recoverable from backup',
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
    !runtimeControlWorkflow.includes(forbidden) &&
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
  !workflow.includes('image_tag:') &&
    !workflow.includes('app_changed') &&
    !workflow.includes('agent_changed') &&
    !workflow.includes('ml_infer_changed') &&
    workflow.includes('update app "$DEPLOY_PROJECT_SHA" "$DEPLOY_PROJECT_SHA"') &&
    workflow.includes('runtime-control verify') &&
    !workflow.includes('up -d timescale redis') &&
    !workflow.includes('up -d site docs'),
  'App rollout must advance only one exact Project identity',
);
assert(
  componentWorkflow.includes('type: choice') &&
    componentWorkflow.includes('- agent') &&
    componentWorkflow.includes('- ml-infer') &&
    componentWorkflow.includes('- site') &&
    componentWorkflow.includes('- docs') &&
    componentWorkflow.includes('update "$DEPLOY_COMPONENT" "$DEPLOY_IMAGE_SHA"') &&
    !componentWorkflow.includes('IMAGE_SHA: latest'),
  'Non-app components need one typed immutable rollout interface',
);
assert(
  initializeWorkflow.includes('Initialize complete production release') &&
    initializeWorkflow.includes('release.env.incoming') &&
    initializeWorkflow.includes('runtime-control verify') &&
    initializeWorkflow.includes('redis-backup.sh --verify'),
  'A complete exact release must have one explicit initialization path',
);
assert(
  releaseState.includes('APP_IMAGE_TAG') &&
    releaseState.includes('PROJECT_SHA') &&
    releaseState.includes('AGENT_IMAGE_TAG') &&
    releaseState.includes('ML_INFER_IMAGE_TAG') &&
    releaseState.includes('SITE_IMAGE_TAG') &&
    releaseState.includes('DOCS_IMAGE_TAG') &&
    releaseState.includes('full lowercase Git SHA') &&
    !releaseState.includes('latest'),
  'Release state must be complete, declarative, and immutable',
);
assert(
  compose.includes('tradejs-site:${SITE_IMAGE_TAG:?SITE_IMAGE_TAG is required}') &&
    compose.includes('tradejs-docs:${DOCS_IMAGE_TAG:?DOCS_IMAGE_TAG is required}') &&
    !compose.includes('tradejs-site:latest') &&
    !compose.includes('tradejs-docs:latest'),
  'Public web images must use exact Deploy-owned release refs',
);
assert(
    workflow.includes('runtime-package-manifest.json') &&
    workflow.includes('compare-runtime-manifests.mjs') &&
    read('scripts/compare-runtime-manifests.mjs').includes(
      'validateRuntimePackageChannel',
    ) &&
    read('scripts/runtime-package-channel.mjs').includes(
      'Production framework packages do not form one release cohort',
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
