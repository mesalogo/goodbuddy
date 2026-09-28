const { cp, mkdir, readFile, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { dirname, join, relative } = require('node:path');
const tar = require('tar');

// Preserve npm's installed layout (including nested versions) and every package
// asset. The official loader discovers plugins and browser assets at runtime.
async function prepareNativeDshResources(projectDir, platform, architecture, downloadPackage, lockedIntegrity) {
  const target = join(projectDir, '.runtime-resources', `dsh-${architecture}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const visited = new Set();
  function locate(name, from) {
    for (let directory = from; ; directory = dirname(directory)) {
      const candidate = join(directory, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      if (dirname(directory) === directory) return undefined;
    }
  }
  async function copyPackage(directory) {
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    await cp(directory, join(target, relative(projectDir, directory)), { recursive: true, verbatimSymlinks: true });
    const optional = manifest.optionalDependencies ?? {};
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...optional })) {
      const dependency = locate(name, directory);
      if (dependency) await copyPackage(dependency);
      else if (!(name in optional) && !manifest.peerDependenciesMeta?.[name]?.optional) {
        throw new Error(`DS Web bundle is missing ${name} required by ${manifest.name}`);
      }
    }
  }
  await copyPackage(join(projectDir, 'node_modules', '@deepseek-ai', 'dsh'));
  // Cross-architecture packaging cannot rely on the build host's npm optional
  // selection. Fetch the exact target Sharp packages from the existing lock.
  const sharp = JSON.parse(await readFile(join(projectDir, 'node_modules', 'sharp', 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(projectDir, 'package-lock.json'), 'utf8'));
  const nativePackages = [`@img/sharp-${platform}-${architecture}`];
  if (platform !== 'win32') nativePackages.push(`@img/sharp-libvips-${platform}-${architecture}`);
  for (const name of nativePackages) {
    const version = sharp.optionalDependencies[name];
    if (!version) throw new Error(`DS Web Sharp does not support ${platform}/${architecture}`);
    const destination = join(target, 'node_modules', 'sharp', 'node_modules', name);
    if (existsSync(join(destination, 'package.json'))) continue;
    const locked = lock.packages[`node_modules/sharp/node_modules/${name}`] ?? lock.packages[`node_modules/${name}`];
    if (locked?.version !== version || !locked.integrity) throw new Error(`Missing locked ${name}@${version}`);
    const integrity = locked.integrity;
    const archive = await downloadPackage(projectDir, name, version, integrity);
    await mkdir(destination, { recursive: true });
    await tar.x({ file: archive, cwd: destination, strip: 1 });
  }
  const koffi = JSON.parse(await readFile(join(projectDir, 'node_modules', 'koffi', 'package.json'), 'utf8'));
  const koffiName = `@koromix/koffi-${platform}-${architecture}`;
  const koffiDestination = join(target, 'node_modules', koffiName);
  if (!existsSync(join(koffiDestination, 'package.json'))) {
    const integrity = await lockedIntegrity(projectDir, koffiName, koffi.version);
    const archive = await downloadPackage(projectDir, koffiName, koffi.version, integrity);
    await mkdir(koffiDestination, { recursive: true });
    await tar.x({ file: archive, cwd: koffiDestination, strip: 1 });
  }
  return target;
}

module.exports = { prepareNativeDshResources };
