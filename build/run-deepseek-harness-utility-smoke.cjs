'use strict'

const { spawn } = require('node:child_process')
const {
  readFile,
  rm,
  writeFile
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const electronPath = process.env.GOODBUDDY_HARNESS_SMOKE_ELECTRON
  ? resolve(process.env.GOODBUDDY_HARNESS_SMOKE_ELECTRON)
  : require('electron')
const configuredAppPath =
  process.env.GOODBUDDY_HARNESS_SMOKE_APP
const appPath = configuredAppPath
  ? resolve(configuredAppPath)
  : resolve('build/smoke-app')
const temporaryAppPath =
  configuredAppPath ||
  process.env.GOODBUDDY_HARNESS_SMOKE_ELECTRON
    ? undefined
    : join(
        tmpdir(),
        `goodbuddy-harness-smoke-app-${process.pid}`
      )
const resultPath = join(
  tmpdir(),
  `goodbuddy-harness-utility-smoke-result-${process.pid}.json`
)
const profilePath = join(
  tmpdir(),
  `goodbuddy-harness-utility-smoke-profile-${process.pid}`
)
const environment = {
  ...process.env,
  GOODBUDDY_HARNESS_SMOKE_RESULT: resultPath
}
delete environment.ELECTRON_RUN_AS_NODE

function runElectron(applicationPath) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      electronPath,
      [
        applicationPath,
        '--no-sandbox',
        `--user-data-dir=${profilePath}`,
        '--no-first-run'
      ],
      {
        cwd: resolve('.'),
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    let output = ''
    const capture = (chunk) => {
      output = (output + String(chunk)).slice(-8_192)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const timeout = setTimeout(() => {
      child.kill()
      rejectRun(
        new Error(
          `DeepSeek Harness Electron smoke timed out: ${output.trim()}`
        )
      )
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveRun({ code, signal, output })
    })
  })
}

async function main() {
  await rm(resultPath, { force: true })
  await writeFile(
    resolve('out/main/package.json'),
    `${JSON.stringify(
      {
        name: '@deepseek-ai/dsh-llm',
        version: '0.1.0-rc.6',
        private: true,
        type: 'module'
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  if (temporaryAppPath) {
    await rm(temporaryAppPath, {
      recursive: true,
      force: true
    })
    const { cp, copyFile, mkdir } = require('node:fs/promises')
    await mkdir(temporaryAppPath, { recursive: true })
    await cp(resolve('build/smoke-app'), temporaryAppPath, {
      recursive: true
    })
    await copyFile(
      resolve('build/deepseek-harness-utility-smoke.cjs'),
      join(temporaryAppPath, 'deepseek-harness-utility-smoke.cjs')
    )
  }
  const execution = await runElectron(
    temporaryAppPath ?? appPath
  )
  let result
  try {
    result = JSON.parse(await readFile(resultPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `DeepSeek Harness Electron smoke produced no valid result (code ${execution.code}, signal ${execution.signal ?? 'none'}): ${execution.output.trim()}`,
      { cause: error }
    )
  } finally {
    await Promise.all([
      rm(resultPath, { force: true }),
      rm(profilePath, { recursive: true, force: true }),
      temporaryAppPath
        ? rm(temporaryAppPath, {
            recursive: true,
            force: true
          })
        : Promise.resolve()
    ])
  }
  if (execution.code !== 0 || result.status !== 'ready') {
    throw new Error(
      `DeepSeek Harness Electron smoke failed (code ${execution.code}, status ${String(result.status)}): ${String(result.detail ?? execution.output).trim()}`
    )
  }
  console.log('DeepSeek Harness Electron utility smoke: ready')
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
