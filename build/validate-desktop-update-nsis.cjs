// Small Windows-only installer experiment. Uses an isolated product identity and
// a tiny executable, with the repository's NSIS settings and include hook.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { mkdir, readFile, writeFile, rm, access, stat, copyFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const directory = join(root, 'temp', 'desktop-update-nsis-probe')
const identityPath = join(directory, 'identity.json')

async function exists(path) {
  try { await access(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options
    })
    let output = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${executable}\n${output}`)) }, 45_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`Exit ${code}: ${executable}\n${output}`))
    })
  })
}

async function identity() {
  if (await exists(identityPath)) return JSON.parse(await readFile(identityPath, 'utf8'))
  await mkdir(directory, { recursive: true })
  const guid = randomUUID()
  const value = { guid, name: `GoodBuddyUpdateProbe-${guid.slice(0, 8)}` }
  await writeFile(identityPath, JSON.stringify(value))
  return value
}

async function buildVersion(version) {
  const { build, Platform, Arch } = require('electron-builder')
  const id = await identity()
  const project = join(directory, `project-${version}`)
  const unpacked = join(project, 'unpacked')
  await mkdir(unpacked, { recursive: true })
  await mkdir(join(unpacked, 'resources'), { recursive: true })
  await writeFile(join(project, 'package.json'), JSON.stringify({
    name: id.name.toLowerCase(), productName: id.name, version,
    description: 'Isolated GoodBuddy NSIS update experiment', author: 'GoodBuddy', main: 'index.js'
  }))
  const source = join(project, 'Probe.cs')
  await writeFile(source, `using System; using System.IO; using System.Reflection;
class Probe { static void Main(string[] args) {
  string folder = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
  File.WriteAllText(Path.Combine(folder, "launched.txt"), File.ReadAllText(Path.Combine(folder, "version.txt")) + "|" + String.Join(" ", args));
} }`)
  const compiler = join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', `/out:${join(unpacked, `${id.name}.exe`)}`, source])
  await writeFile(join(unpacked, 'version.txt'), version)
  if (version === '1.0.0') await writeFile(join(unpacked, 'obsolete.txt'), 'Only in version one')
  const pkg = require('../package.json')
  const output = join(directory, `output-${version}`)
  await build({ projectDir: project, prepackaged: unpacked, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never', config: {
    appId: `live.digiman.goodbuddy.update-probe.${id.guid}`, productName: id.name,
    electronVersion: require('electron/package.json').version,
    directories: { output, buildResources: join(root, 'build') },
    artifactName: 'probe-${version}.${ext}', compression: pkg.build.compression,
    npmRebuild: false, publish: null,
    win: { target: ['nsis'], signAndEditExecutable: false, icon: join(root, 'build', 'icon-taskbar.ico') },
    nsis: {
      ...pkg.build.nsis, guid: id.guid,
      include: join(root, 'build', 'installer.nsh'),
      // Avoid creating desktop/start-menu shortcuts for the experiment.
      createDesktopShortcut: false, createStartMenuShortcut: false
    }
  } })
  console.log(JSON.stringify({ event: 'built', version, bytes: (await stat(join(output, `probe-${version}.exe`))).size }))
}

async function exercise() {
  const id = await identity()
  const install = join(directory, 'custom install path', id.name)
  const userData = join(directory, 'isolated-user-data', 'settings.json')
  await mkdir(join(directory, 'isolated-user-data'), { recursive: true })
  await writeFile(userData, '{"keep":"original user settings"}')
  const first = join(directory, 'output-1.0.0', 'probe-1.0.0.exe')
  const next = join(directory, 'output-1.0.1', 'probe-1.0.1.exe')
  // NSIS /D= is last and consumes the rest of the command line, including spaces.
  await run(first, ['/S', '/currentuser', `/D=${install}`])
  assert.equal(await readFile(join(install, 'version.txt'), 'utf8'), '1.0.0')
  assert.equal(await exists(join(install, 'launched.txt')), false)
  console.log('NSIS_PROBE: first /S install succeeded at custom path; did not auto-launch')

  // Deliberately omit /D: the real installer must recover the old location.
  const helper = join(directory, 'install.cjs')
  await require('esbuild').build({ entryPoints: [join(root, 'src/main/desktop-update-install.ts')], outfile: helper, bundle: true, platform: 'node', format: 'cjs' })
  const cacheDirectory = join(directory, 'update-cache', 'package')
  await mkdir(cacheDirectory, { recursive: true })
  const cachedInstaller = join(cacheDirectory, 'GoodBuddy-1.0.1-windows-x64-setup.exe')
  const abandonedPartial = join(cacheDirectory, 'GoodBuddy-1.0.2-windows-x64-setup.exe.partial')
  await copyFile(next, cachedInstaller)
  await writeFile(abandonedPartial, 'abandoned download')
  await require(helper).launchDesktopUpdateInstaller(cachedInstaller)
  const launched = join(install, 'launched.txt')
  for (let count = 0; count < 100 && !(await exists(launched)); count++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(await readFile(join(install, 'version.txt'), 'utf8'), '1.0.1')
  assert.equal(await exists(join(install, 'obsolete.txt')), false)
  assert.equal(await readFile(userData, 'utf8'), '{"keep":"original user settings"}')
  assert.equal(await readFile(launched, 'utf8'), '1.0.1|--updated')
  console.log('NSIS_PROBE_OK: production launchDesktopUpdateInstaller (/S --updated --force-run) retained custom path, removed obsolete application file, preserved external user-data fixture, and launched v1.0.1 with --updated')
  // The product intentionally exits after spawning NSIS, not after installation.
  // The new app can start before NSIS releases its single-installer mutex.
  const installerLiteral = cachedInstaller.replace(/'/g, "''")
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Get-Process | Where-Object { $_.Path -eq '${installerLiteral}' } | Wait-Process -Timeout 30`])
  const cacheHelper = join(directory, 'cache.cjs')
  await require('esbuild').build({ entryPoints: [join(root, 'src/main/desktop-update-cache.ts')], outfile: cacheHelper, bundle: true, platform: 'node', format: 'cjs' })
  await require(cacheHelper).cleanupDesktopUpdateCache({ kind: 'cleanup', directory: cacheDirectory,
    currentVersion: await readFile(join(install, 'version.txt'), 'utf8'), mode: 'stale' })
  assert.equal(await exists(cachedInstaller), false)
  assert.equal(await exists(abandonedPartial), false)
  assert.equal(await readFile(userData, 'utf8'), '{"keep":"original user settings"}')
  console.log('NSIS_PROBE_CACHE_OK: installed version drives production cleanup; cached installer and abandoned partial removed after installer exit; user data preserved')
  await rm(launched)
  await run(next, ['/S', '--updated'])
  assert.equal(await readFile(join(install, 'version.txt'), 'utf8'), '1.0.1')
  assert.equal(await exists(launched), false)
  console.log('NSIS_PROBE_OK: /S --updated without /currentuser or /D recovered the existing installation; without --force-run it did not launch')
}

async function cleanup() {
  if (!(await exists(identityPath))) return
  const id = await identity()
  const install = join(directory, 'custom install path', id.name)
  const uninstaller = join(install, `Uninstall ${id.name}.exe`)
  if (await exists(uninstaller)) await run(uninstaller, ['/S', '/currentuser', `_?=${install}`])
  // Confirm the test's registration is gone before removing its only identity record.
  for (const key of [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id.guid}`,
    `HKCU\\Software\\${id.guid}`
  ]) {
    let present = true
    // NSIS may finish in its copied uninstaller process after the launcher exits.
    for (let count = 0; count < 50 && present; count++) {
      try { await run('reg.exe', ['query', key, '/reg:64']) } catch (error) {
        if (!error.message.startsWith('Exit 1:')) throw error
        present = false
      }
      if (present) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(present, false, `Test registry entry remains: ${key}`)
  }
  await rm(directory, { recursive: true, force: true })
  console.log('NSIS_PROBE_CLEAN: dedicated installation, registration and build files removed')
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This experiment requires Windows x64')
  const temporaryDirectory = join(directory, 'tool-temp')
  await mkdir(temporaryDirectory, { recursive: true })
  process.env.TEMP = temporaryDirectory
  process.env.TMP = temporaryDirectory
  process.env.TMPDIR = temporaryDirectory
  const action = process.argv[2]
  if (action === 'build-v1') return buildVersion('1.0.0')
  if (action === 'build-v2') return buildVersion('1.0.1')
  if (action === 'exercise') return exercise()
  if (action === 'clean') return cleanup()
  throw new Error('Usage: node build/validate-desktop-update-nsis.cjs build-v1|build-v2|exercise|clean')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
