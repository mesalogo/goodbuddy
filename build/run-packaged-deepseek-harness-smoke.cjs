'use strict'

const { spawn } = require('node:child_process')
const {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} = require('node:fs/promises')
const { statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

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

for (const [path, description] of [
  [executable, 'packaged Electron executable'],
  [host, 'packaged DeepSeek Harness host']
]) {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${description} is missing: ${path}`)
  }
}

function run(command, args, env) {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, {
      cwd: resolve('.'),
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
      resolve('node_modules/electron-builder/cli.js'),
      '--projectDir',
      project,
      '--win',
      'dir',
      '--x64',
      '--publish',
      'never',
      `--config.directories.output=${join(root, 'dist')}`
    ]
    if (process.env.GOODBUDDY_ELECTRON_DIST) {
      packageArguments.push(
        `--config.electronDist=${resolve(process.env.GOODBUDDY_ELECTRON_DIST)}`
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
    console.log('Packaged DeepSeek Harness utility smoke: ready')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
