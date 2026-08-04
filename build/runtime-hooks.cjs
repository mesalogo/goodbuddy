const { createHash } = require('node:crypto')
const {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const tar = require('tar')
const { sha256File } = require('./file-hash.cjs')

const opencodeVersion = '1.18.9'
const architectureNames = {
  1: 'x64',
  3: 'arm64'
}
const platformNames = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows'
}

function sha512Integrity(contents) {
  return `sha512-${createHash('sha512').update(contents).digest('base64')}`
}

async function lockedIntegrity(projectDir, packageName) {
  const lock = JSON.parse(
    await readFile(join(projectDir, 'package-lock.json'), 'utf8')
  )
  const entry = lock.packages?.[`node_modules/${packageName}`]
  if (
    entry?.version !== opencodeVersion ||
    typeof entry.integrity !== 'string'
  ) {
    throw new Error(
      `Missing locked ${packageName}@${opencodeVersion} integrity`
    )
  }
  return entry.integrity
}

function npmInvocation() {
  const npmCli = process.env.npm_execpath
  if (npmCli) {
    return {
      command: process.execPath,
      prefixArgs: [npmCli]
    }
  }
  if (process.platform === 'win32') {
    throw new Error('npm_execpath is required to prepare bundled runtimes')
  }
  return {
    command: 'npm',
    prefixArgs: []
  }
}

async function downloadPackage(projectDir, packageName, integrity) {
  const cacheDirectory = join(
    projectDir,
    '.runtime-resources',
    'cache'
  )
  await mkdir(cacheDirectory, { recursive: true })
  const archivePath = join(
    cacheDirectory,
    `${packageName}-${opencodeVersion}.tgz`
  )
  if (existsSync(archivePath)) {
    const cached = await readFile(archivePath)
    if (sha512Integrity(cached) === integrity) {
      return archivePath
    }
    await rm(archivePath, { force: true })
  }

  const npm = npmInvocation()
  const result = spawnSync(
    npm.command,
    [
      ...npm.prefixArgs,
      'pack',
      `${packageName}@${opencodeVersion}`,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      cacheDirectory
    ],
    {
      cwd: projectDir,
      encoding: 'utf8',
      shell: false,
      windowsHide: true
    }
  )
  if (result.status !== 0) {
    throw new Error(
      `Unable to fetch ${packageName}: ${result.stderr || result.stdout}`
    )
  }
  const output = JSON.parse(result.stdout)
  const downloadedPath = join(cacheDirectory, output[0].filename)
  const contents = await readFile(downloadedPath)
  if (sha512Integrity(contents) !== integrity) {
    await rm(downloadedPath, { force: true })
    throw new Error(`Integrity verification failed for ${packageName}`)
  }
  if (downloadedPath !== archivePath) {
    await rm(archivePath, { force: true })
    await rename(downloadedPath, archivePath)
  }
  return archivePath
}

module.exports = async function prepareBundledRuntimes(context) {
  const platform = context.electronPlatformName
  const architecture = architectureNames[context.arch]
  const packagePlatform = platformNames[platform]
  if (!architecture || !packagePlatform) {
    throw new Error(
      `Bundled OpenCode does not support ${platform}/${context.arch}`
    )
  }

  const suffix =
    architecture === 'x64' ? `${architecture}-baseline` : architecture
  const packageName = `opencode-${packagePlatform}-${suffix}`
  const projectDir = context.packager.projectDir
  const integrity = await lockedIntegrity(projectDir, packageName)
  const targetDirectory = join(
    projectDir,
    '.runtime-resources',
    architecture
  )
  const readyPath = join(targetDirectory, '.ready.json')
  const executable = platform === 'win32' ? 'opencode.exe' : 'opencode'
  const preparedPath = join(targetDirectory, executable)
  const identity = {
    packageName,
    version: opencodeVersion,
    integrity
  }
  try {
    const ready = JSON.parse(await readFile(readyPath, 'utf8'))
    if (
      ready.packageName === identity.packageName &&
      ready.version === identity.version &&
      ready.integrity === identity.integrity &&
      typeof ready.executableSha256 === 'string' &&
      (platform === 'win32' ||
        ((await stat(preparedPath)).mode & 0o111) !== 0) &&
      (await sha256File(preparedPath)) === ready.executableSha256
    ) {
      return
    }
  } catch {
    // Rebuild an incomplete or stale runtime cache.
  }

  const archivePath = await downloadPackage(
    projectDir,
    packageName,
    integrity
  )
  const stagingDirectory = `${targetDirectory}.staging-${process.pid}`
  await rm(stagingDirectory, { recursive: true, force: true })
  await mkdir(stagingDirectory, { recursive: true })
  try {
    await tar.x({
      file: archivePath,
      cwd: stagingDirectory,
      strip: 1
    })
    const sourcePath = join(stagingDirectory, 'bin', executable)
    const stagingExecutable = join(stagingDirectory, executable)
    await rename(sourcePath, stagingExecutable)
    if (platform !== 'win32') {
      await chmod(stagingExecutable, 0o755)
    }
    const executableSha256 = await sha256File(stagingExecutable)
    await writeFile(
      join(stagingDirectory, '.ready.json'),
      JSON.stringify({ ...identity, executableSha256 }),
      'utf8'
    )
    await rm(targetDirectory, { recursive: true, force: true })
    await rename(stagingDirectory, targetDirectory)
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}
