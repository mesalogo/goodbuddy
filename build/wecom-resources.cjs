// Prepares the offline WeCom bundle: the pinned wecom-cli binary and the Python
// wheels its skill scripts need. Every artifact is verified against
// resources/wecom-artifacts.lock.json before it enters the package.
const { createHash } = require("node:crypto");
const { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const tar = require("tar");
const { sha256File } = require("./file-hash.cjs");

async function readLock(projectDir) {
  return JSON.parse(await readFile(join(projectDir, "resources", "wecom-artifacts.lock.json"), "utf8"));
}

async function downloadWheel(cacheDirectory, wheel) {
  const target = join(cacheDirectory, wheel.filename);
  if (existsSync(target) && (await sha256File(target)) === wheel.sha256) return target;
  const response = await fetch(wheel.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to download ${wheel.filename}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== wheel.size || createHash("sha256").update(buffer).digest("hex") !== wheel.sha256) {
    throw new Error(`Integrity verification failed for ${wheel.filename}`);
  }
  const partial = `${target}.partial-${process.pid}`;
  await writeFile(partial, buffer);
  await rename(partial, target);
  return target;
}

/**
 * @param {string} projectDir
 * @param {NodeJS.Platform} platform electron platform name
 * @param {"x64"|"arm64"} architecture
 * @param {(projectDir: string, name: string, version: string, integrity: string) => Promise<string>} downloadPackage
 */
async function prepareWecomResources(projectDir, platform, architecture, downloadPackage) {
  const lock = await readLock(projectDir);
  const key = `${platform}-${architecture}`;
  const target = lock.targets[key];
  const targetDirectory = join(projectDir, ".runtime-resources", `wecom-${architecture}`);
  if (!target) {
    // Unsupported targets ship an empty folder (electron-builder needs it); the app reports WeCom as unavailable.
    await rm(targetDirectory, { recursive: true, force: true });
    await mkdir(targetDirectory, { recursive: true });
    return;
  }
  const identity = JSON.stringify({ key, cli: target.cli, wheels: target.wheels.map((wheel) => wheel.sha256) });
  const readyPath = join(targetDirectory, "ready.json");
  const executable = platform === "win32" ? "wecom-cli.exe" : "wecom-cli";
  try {
    const ready = JSON.parse(await readFile(readyPath, "utf8"));
    if (ready.identity === identity &&
      (await sha256File(join(targetDirectory, "bin", executable))) === ready.executableSha256) {
      return;
    }
  } catch {
    // Rebuild a missing, stale or incomplete bundle.
  }

  const staging = `${targetDirectory}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "bin"), { recursive: true });
  await mkdir(join(staging, "wheels"), { recursive: true });
  try {
    const archive = await downloadPackage(projectDir, target.cli.package, target.cli.version, target.cli.integrity);
    const extracted = join(staging, "package");
    await mkdir(extracted, { recursive: true });
    await tar.x({ file: archive, cwd: extracted, strip: 1 });
    const binary = join(staging, "bin", executable);
    await rename(join(extracted, "bin", executable), binary);
    await copyFile(join(extracted, "LICENSE"), join(staging, "LICENSE-wecom-cli.txt"));
    await rm(extracted, { recursive: true, force: true });
    if (platform !== "win32") await chmod(binary, 0o755);

    const cacheDirectory = join(projectDir, ".runtime-resources", "cache", "wheels");
    await mkdir(cacheDirectory, { recursive: true });
    for (const wheel of target.wheels) {
      await copyFile(await downloadWheel(cacheDirectory, wheel), join(staging, "wheels", wheel.filename));
    }
    await writeFile(join(staging, "ready.json"), `${JSON.stringify({
      identity,
      version: target.cli.version,
      pythonVersion: lock.pythonVersion,
      executableSha256: await sha256File(binary),
      wheels: target.wheels.map((wheel) => wheel.filename)
    }, null, 2)}\n`, "utf8");
    await rm(targetDirectory, { recursive: true, force: true });
    await rename(staging, targetDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

module.exports = { prepareWecomResources };

if (require.main === module) {
  // Development: node build/wecom-resources.cjs prepares the bundle for this machine.
  const { downloadPackage } = require("./runtime-hooks.cjs");
  prepareWecomResources(join(__dirname, ".."), process.platform, process.arch, downloadPackage)
    .then(() => console.log(`WeCom resources ready in .runtime-resources/wecom-${process.arch}`))
    .catch((error) => { console.error(error); process.exit(1); });
}
