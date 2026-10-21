import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Inputs are captured by the Deploy-owned collector, never supplied by MCP clients.
export function publishVerification({ root, manifestBytes, verification, container, mode, observedAt = Date.now() }) {
  const manifest = JSON.parse(manifestBytes);
  const result = verification.results?.[0];
  if (!/^[a-f0-9]{40}$/.test(manifest.projectSha ?? '') || !result?.strategies?.length || verification.results.length !== 1 || !/^[\w-]+$/.test(verification.userName ?? '') || !/^[\w-]+$/.test(result.deploymentId ?? '')) throw Error('Invalid verification identity');
  const strategies = result.strategies;
  const composition = strategies[0].deploymentCompositionId;
  const accountId = strategies[0].accountId;
  if (!/^dc1:[a-f0-9]+$/.test(composition) || !accountId || strategies.some(s => s.deploymentCompositionId !== composition || s.accountId !== accountId)) throw Error('Mixed deployment binding');
  if (!/^sha256:[a-f0-9]{64}$/.test(container.imageDigest) || !['deploy', 'observe'].includes(mode)) throw Error('Invalid image or collection mode');
  const dir = path.join(root, verification.userName, result.deploymentId, manifest.projectSha, composition);
  fs.mkdirSync(dir, { recursive: true });
  const hash = b => createHash('sha256').update(b).digest('hex');
  const atomic = (file, bytes) => { const tmp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); };
  let deploymentVerifiedAt = null;
  if (mode === 'observe' && fs.existsSync(path.join(dir, 'deploy.json'))) {
    const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'deploy.json')));
    if (!/^[a-f0-9]{64}\.json$/.test(pointer.file)) throw Error('Invalid deploy receipt');
    const bytes = fs.readFileSync(path.join(dir, pointer.file));
    if (hash(bytes) !== pointer.sha256 || bytes.length !== pointer.bytes) throw Error('Corrupt deploy receipt');
    const deployed = JSON.parse(bytes);
    if (deployed.imageDigest !== container.imageDigest) throw Error('Image changed without deploy receipt');
    deploymentVerifiedAt = deployed.deploymentVerifiedAt;
  }
  const ok = result.ok === true && container.health === 'healthy' && strategies.every(s => ['active', 'entries_paused'].includes(s.controlState));
  if (mode === 'deploy' && !ok) throw Error('Deployment verification failed');
  if (mode === 'deploy') deploymentVerifiedAt = observedAt;
  const report = { schemaVersion: 1, reportType: 'runtime-deployment-verification', userName: verification.userName, deploymentId: result.deploymentId, accountId, deploymentCompositionId: composition, projectSha: manifest.projectSha, imageDigest: container.imageDigest, observedAt, deploymentVerifiedAt, ok, health: { status: container.health, startedAt: container.startedAt, restartCount: container.restartCount }, verification: { ok: result.ok === true, strategies: strategies.map(s => ({ strategyName: s.strategyName, strategyRevision: s.strategyRevision, controlState: s.controlState })) }, runtimePackageManifest: { sha256: hash(manifestBytes), bytes: manifestBytes.length, manifest } };
  const bytes = Buffer.from(JSON.stringify(report) + '\n');
  if (bytes.length > 48000) throw Error('Verification receipt exceeds MCP export limit');
  const sha256 = hash(bytes); const file = `${sha256}.json`;
  try { fs.writeFileSync(path.join(dir, file), bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(path.join(dir, file)).equals(bytes)) throw error; }
  const pointer = Buffer.from(JSON.stringify({ file, sha256, bytes: bytes.length }) + '\n');
  if (mode === 'deploy') atomic(path.join(dir, 'deploy.json'), pointer);
  atomic(path.join(dir, 'latest.json'), pointer);
  return report;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  const [root, manifest, verification, container, mode] = process.argv.slice(2);
  publishVerification({ root, manifestBytes: fs.readFileSync(manifest), verification: JSON.parse(fs.readFileSync(verification)), container: JSON.parse(fs.readFileSync(container)), mode });
}
