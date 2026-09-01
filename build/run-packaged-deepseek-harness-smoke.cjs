'use strict'

const { spawn } = require('node:child_process')
const {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} = require('node:fs/promises')
const { statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, join, resolve } = require('node:path')

const unpackedPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve('dist/harness-package-probe/win-unpacked')
const executable = join(
  unpackedPath,
  process.platform === 'win32' ? 'GoodBuddy.exe' : 'goodbuddy'
)
const host = join(
  unpackedPath,
  'resources',
  'app.asar.unpacked',
  'out',
  'main',
  'deepseek-harness-host-bootstrap.js'
)
const npmRoot = join(unpackedPath, 'resources', 'runtimes', 'npm')
const npmCli = join(npmRoot, 'bin', 'npm-cli.js')
const npmManifestPath = join(npmRoot, 'package.json')

for (const [path, description] of [
  [executable, 'packaged Electron executable'],
  [host, 'packaged DeepSeek Harness host'],
  [npmCli, 'packaged npm CLI'],
  [npmManifestPath, 'packaged npm manifest']
]) {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${description} is missing: ${path}`)
  }
}

function quotePosixShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function prepareNodeCommand(directory) {
  await mkdir(directory, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(
      join(directory, 'node.cmd'),
      [
        '@echo off',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `"${executable.replaceAll('%', '%%')}" %*`,
        ''
      ].join('\r\n'),
      'utf8'
    )
    return
  }
  const commandPath = join(directory, 'node')
  await writeFile(
    commandPath,
    [
      '#!/bin/sh',
      `ELECTRON_RUN_AS_NODE=1 exec ${quotePosixShell(executable)} "$@"`,
      ''
    ].join('\n'),
    'utf8'
  )
  await chmod(commandPath, 0o700)
}

function run(command, args, env, cwd = resolve('.')) {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    const capture = (chunk) => {
      output = (output + String(chunk)).slice(-8_192)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', rejectExit)
    child.once('exit', (exitCode, signal) => {
      resolveExit({ exitCode, signal, output })
    })
  })
}

async function main() {
  const root = await mkdtemp(
    join(tmpdir(), 'goodbuddy-packaged-harness-smoke-')
  )
  try {
    const project = join(root, 'app')
    const profile = join(root, 'profile')
    const resultPath = join(root, 'result.json')
    const packageManagerBin = join(root, 'package-manager-bin')
    const npmProject = join(root, 'npm-project')
    const npmFixture = join(root, 'npm-fixture')
    await mkdir(project, { recursive: true })

    await copyFile(
      resolve('build/deepseek-harness-utility-smoke.cjs'),
      join(project, 'deepseek-harness-utility-smoke.cjs')
    )
    await writeFile(
      join(project, 'package.json'),
      `${JSON.stringify(
        {
          name: 'goodbuddy-packaged-harness-smoke',
          version: '1.0.0',
          private: true,
          main: 'deepseek-harness-utility-smoke.cjs'
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    await writeFile(
      join(project, 'electron-builder.yml'),
      [
        'appId: live.digiman.goodbuddy.harness-smoke',
        'productName: GoodBuddyHarnessSmoke',
        'electronVersion: "43.2.0"',
        'asar: true',
        'npmRebuild: false',
        'files:',
        '  - package.json',
        '  - deepseek-harness-utility-smoke.cjs',
        'win:',
        '  target:',
        '    - dir'
      ].join('\n'),
      'utf8'
    )

    const packageArguments = [
      resolve('build/run-electron-builder.cjs'),
      '--projectDir',
      project,
      '--win',
      'dir',
      '--x64',
      '--publish',
      'never',
      `--config.directories.output=${join(root, 'dist')}`
    ]
    const electronDist = process.env.GOODBUDDY_ELECTRON_DIST
      ? resolve(process.env.GOODBUDDY_ELECTRON_DIST)
      : resolve('node_modules/electron/dist')
    if (
      statSync(electronDist, {
        throwIfNoEntry: false
      })?.isDirectory()
    ) {
      packageArguments.push(
        `--config.electronDist=${electronDist}`
      )
    }
    const packaged = await run(
      process.execPath,
      packageArguments,
      process.env
    )
    if (packaged.exitCode !== 0 || packaged.signal) {
      throw new Error(
        `Unable to package Harness smoke app: ${packaged.output.trim()}`
      )
    }

    const smokeEnvironment = {
      ...process.env,
      GOODBUDDY_HARNESS_SMOKE_HOST: host,
      GOODBUDDY_HARNESS_SMOKE_RESULT: resultPath
    }
    delete smokeEnvironment.ELECTRON_RUN_AS_NODE
    const executed = await run(
      join(root, 'dist', 'win-unpacked', 'GoodBuddyHarnessSmoke.exe'),
      [`--user-data-dir=${profile}`, '--no-first-run'],
      smokeEnvironment
    )
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    if (
      executed.exitCode !== 0 ||
      executed.signal ||
      result.status !== 'ready'
    ) {
      throw new Error(
        `Packaged DeepSeek Harness smoke failed (${executed.exitCode}, ${executed.signal ?? 'no signal'}): ${JSON.stringify(result)} ${executed.output.trim()}`
      )
    }

    const npmManifest = JSON.parse(
      await readFile(npmManifestPath, 'utf8')
    )
    await prepareNodeCommand(packageManagerBin)
    await mkdir(npmProject, { recursive: true })
    await mkdir(npmFixture, { recursive: true })
    await writeFile(
      join(npmProject, 'package.json'),
      '{"name":"goodbuddy-packaged-npm-project","version":"1.0.0","private":true}\n',
      'utf8'
    )
    await writeFile(
      join(npmFixture, 'package.json'),
      `${JSON.stringify({
        name: 'goodbuddy-packaged-npm-smoke',
        version: '1.0.0',
        scripts: {
          install: 'node install.cjs'
        }
      })}\n`,
      'utf8'
    )
    await writeFile(
      join(npmFixture, 'install.cjs'),
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'lifecycle-ran.txt'), 'ready\\n')\n",
      'utf8'
    )
    const inheritedPath =
      process.env.PATH ?? process.env.Path ?? ''
    const npmEnvironment = {
      ...process.env,
      PATH: inheritedPath
        ? `${packageManagerBin}${delimiter}${inheritedPath}`
        : packageManagerBin,
      Path: inheritedPath
        ? `${packageManagerBin}${delimiter}${inheritedPath}`
        : packageManagerBin,
      ELECTRON_RUN_AS_NODE: '1',
      npm_execpath: npmCli,
      npm_node_execpath: executable,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false'
    }
    const npmVersion = await run(
      executable,
      [npmCli, '--version'],
      npmEnvironment,
      npmProject
    )
    if (
      npmVersion.exitCode !== 0 ||
      npmVersion.signal ||
      npmVersion.output.trim() !== npmManifest.version
    ) {
      throw new Error(
        `Packaged npm version smoke failed: ${npmVersion.output.trim()}`
      )
    }
    const installed = await run(
      executable,
      [
        npmCli,
        'install',
        '--save-exact',
        '--no-audit',
        '--no-fund',
        '--dangerously-allow-all-scripts',
        '--loglevel=error',
        npmFixture
      ],
      npmEnvironment,
      npmProject
    )
    if (installed.exitCode !== 0 || installed.signal) {
      throw new Error(
        `Packaged npm install smoke failed: ${installed.output.trim()}`
      )
    }
    const lifecycleMarker = await readFile(
      join(
        npmProject,
        'node_modules',
        'goodbuddy-packaged-npm-smoke',
        'lifecycle-ran.txt'
      ),
      'utf8'
    )
    if (lifecycleMarker !== 'ready\n') {
      throw new Error('Packaged npm lifecycle smoke failed')
    }
    console.log('Packaged DeepSeek Harness utility smoke: ready')
    console.log(
      `Packaged npm install smoke: ready (${npmManifest.version})`
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
