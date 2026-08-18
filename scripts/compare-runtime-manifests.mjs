import fs from 'node:fs';

const [previousPath, nextPath, outputPath] = process.argv.slice(2);
if (!nextPath || !outputPath) {
  throw new Error(
    'Usage: compare-runtime-manifests [previous] <next> <output>',
  );
}
const read = (filePath) =>
  filePath && fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : { packages: {} };
const previous = read(previousPath);
const next = read(nextPath);
if (next.schema !== 'tradejs-runtime-package-manifest/v1') {
  throw new Error('Incoming image has an invalid runtime package manifest');
}
const prereleasePackages = Object.entries(next.packages ?? {})
  .filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(String(version)))
  .map(([name, version]) => `${name}@${version}`);
if (prereleasePackages.length) {
  throw new Error(
    `Production image contains non-stable packages: ${prereleasePackages.join(', ')}`,
  );
}
const names = [
  ...new Set([
    ...Object.keys(previous.packages ?? {}),
    ...Object.keys(next.packages ?? {}),
  ]),
].sort();
const changedPackages = names
  .filter((name) => previous.packages?.[name] !== next.packages?.[name])
  .map((name) => ({
    name,
    previous: previous.packages?.[name] ?? null,
    next: next.packages?.[name] ?? null,
  }));
const result = {
  schema: 'tradejs-runtime-package-diff/v1',
  previousProjectSha: previous.projectSha ?? null,
  nextProjectSha: next.projectSha ?? null,
  changedPackages,
  changedStrategies: changedPackages.filter((entry) =>
    entry.name.startsWith('@tradejs/strategy-'),
  ),
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
