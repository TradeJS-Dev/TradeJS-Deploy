import fs from 'node:fs';

const read = (relativePath) => fs.readFileSync(relativePath, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const workflow = read('.github/workflows/deploy.yml');
const compose = read('docker-compose.prod.yml');

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
  workflow.includes('AUTH_SECRET=${{ secrets.NEXTAUTH_SECRET }}'),
  'Runtime auth secret is not injected by Deploy',
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
  compose.includes('ghcr.io/tradejs-dev/tradejs-ml-infer:${ML_INFER_IMAGE_TAG}'),
  'ML inference image ownership changed accidentally',
);
assert(
  compose.includes('ghcr.io/tradejs-dev/tradejs-agent:${AGENT_IMAGE_TAG}'),
  'Research agent image ownership changed accidentally',
);

console.log('Validated TradeJS-Project to TradeJS-Deploy handoff.');
