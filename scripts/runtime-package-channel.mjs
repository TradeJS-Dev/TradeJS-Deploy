const EXACT_STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const EXACT_BETA_VERSION = /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/;

const isFrameworkRuntimePackage = (packageName) =>
  packageName.startsWith('@tradejs/') &&
  packageName !== '@tradejs/base' &&
  packageName !== '@tradejs/strategy-kit' &&
  !packageName.startsWith('@tradejs/strategy-');

export const validateRuntimePackageChannel = (manifest) => {
  const packages = Object.entries(manifest.packages ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const invalidPackages = packages
    .filter(([, version]) => {
      const value = String(version);
      return !EXACT_STABLE_VERSION.test(value) && !EXACT_BETA_VERSION.test(value);
    })
    .map(([name, version]) => `${name}@${version}`);
  if (invalidPackages.length > 0) {
    throw new Error(
      `Production image contains non-exact packages: ${invalidPackages.join(', ')}`,
    );
  }

  const prereleaseHostPackages = packages
    .filter(
      ([name, version]) =>
        !isFrameworkRuntimePackage(name) &&
        !EXACT_STABLE_VERSION.test(String(version)),
    )
    .map(([name, version]) => `${name}@${version}`);
  if (prereleaseHostPackages.length > 0) {
    throw new Error(
      `Production image contains prerelease host packages: ${prereleaseHostPackages.join(', ')}`,
    );
  }

  const frameworkPackages = packages.filter(([name]) =>
    isFrameworkRuntimePackage(name),
  );
  if (frameworkPackages.length === 0) {
    throw new Error('Production image contains no TradeJS framework packages');
  }
  const frameworkVersions = new Set(
    frameworkPackages.map(([, version]) => String(version)),
  );
  if (frameworkVersions.size !== 1) {
    throw new Error(
      `Production framework packages do not form one release cohort: ${frameworkPackages
        .map(([name, version]) => `${name}@${version}`)
        .join(', ')}`,
    );
  }
  const frameworkVersion = String(frameworkPackages[0][1]);
  const releaseChannel = EXACT_STABLE_VERSION.test(frameworkVersion)
    ? 'stable'
    : 'beta';
  if (
    manifest.releaseChannel !== undefined &&
    manifest.releaseChannel !== releaseChannel
  ) {
    throw new Error(
      `Runtime manifest release channel mismatch: ${manifest.releaseChannel} != ${releaseChannel}`,
    );
  }
  if (
    manifest.frameworkVersion !== undefined &&
    manifest.frameworkVersion !== frameworkVersion
  ) {
    throw new Error(
      `Runtime manifest framework version mismatch: ${manifest.frameworkVersion} != ${frameworkVersion}`,
    );
  }
  return { releaseChannel, frameworkVersion };
};
