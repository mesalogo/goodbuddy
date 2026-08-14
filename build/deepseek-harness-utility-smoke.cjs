'use strict'

const {
  mkdirSync,
  mkdtempSync
} = require('node:fs')
const {
  rm,
  writeFile
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const {
  isAbsolute,
  join,
  resolve
} = require('node:path')
const { app, utilityProcess } = require('electron/main')

const protocol = 'goodbuddy.deepseek-harness.control'
const version = 1
const byteProtocol = 'goodbuddy.deepseek-harness.byte-stream'
const configuredHostPath =
  process.env.GOODBUDDY_HARNESS_SMOKE_HOST
const hostPath = configuredHostPath
  ? isAbsolute(configuredHostPath)
    ? configuredHostPath
    : resolve(configuredHostPath)
  : resolve('out/main/deepseek-harness-host-bootstrap.js')
const workspace = mkdtempSync(
  join(tmpdir(), 'goodbuddy-harness-electron-smoke-')
)
const dshHome = join(workspace, 'dsh-home')
mkdirSync(dshHome)
const configuredResultPath =
  process.env.GOODBUDDY_HARNESS_SMOKE_RESULT
const resultPath =
  configuredResultPath && isAbsolute(configuredResultPath)
    ? configuredResultPath
    : join(
        tmpdir(),
        `goodbuddy-harness-utility-smoke-${process.pid}.json`
      )

let child
let timeout
let stderr = ''
let settled = false
let transportProbed = false

void writeFile(
  resultPath,
  JSON.stringify({ status: 'checkpoint', stage: 'script-start' }),
  'utf8'
)

async function checkpoint(stage, detail = '') {
  await writeFile(
    resultPath,
    JSON.stringify({ status: 'checkpoint', stage, detail }),
    'utf8'
  )
}

function finish(status, detail = '') {
  if (settled) {
    return
  }
  settled = true
  if (timeout) {
    clearTimeout(timeout)
  }
  void writeFile(
    resultPath,
    JSON.stringify({
      status,
      detail: detail.slice(0, 4_096)
    }),
    'utf8'
  )
    .catch(() => undefined)
    .finally(() => {
      child?.kill()
      void rm(workspace, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      })
        .catch(() => undefined)
        .finally(() => {
          if (!configuredResultPath) {
            console.log(
              `GoodBuddy packaged Harness smoke: ${status}`
            )
          }
          app.exit(status === 'ready' ? 0 : 1)
        })
    })
}

async function run() {
  await checkpoint('module-loaded')
  await app.whenReady()
  await checkpoint('app-ready')
  child = utilityProcess.fork(hostPath, [], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? '',
      Path: process.env.Path ?? '',
      PATHEXT: process.env.PATHEXT ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      COMSPEC: process.env.COMSPEC ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      APPDATA: process.env.APPDATA ?? '',
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      OTEL_SDK_DISABLED: 'true'
    },
    serviceName: 'GoodBuddy DeepSeek Harness Smoke',
    stdio: ['ignore', 'ignore', 'pipe'],
    allowLoadingUnsignedLibraries: false,
    disclaim: false
  })
  await checkpoint('utility-forked', String(child.pid ?? ''))

  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4_096)
  })
  child.on('message', (message) => {
    if (
      message?.protocol === protocol &&
      message.version === version &&
      message.type === 'ready'
    ) {
      child.postMessage({
        protocol: byteProtocol,
        version,
        type: 'data',
        stream: 'stdin',
        seq: 0,
        bytes: Buffer.from('{}\n')
      })
      return
    }
    if (
      message?.protocol === byteProtocol &&
      message.version === version &&
      message.type === 'ack' &&
      message.stream === 'stdin' &&
      message.seq === 0
    ) {
      transportProbed = true
      finish('ready')
      return
    }
    if (
      message?.protocol === protocol &&
      message.version === version &&
      message.type === 'fatal'
    ) {
      finish('fatal', String(message.code))
    }
  })
  child.on('exit', (code) => {
    finish(
      'exit',
      `${code}:${stderr.replaceAll(/\s+/gu, ' ').trim()}`
    )
  })
  child.postMessage({
    protocol,
    version,
    type: 'start',
    config: {
      workspace,
      dshHome,
      baseUrl: 'https://gateway.example/openai/v1',
      api: 'openai-completions',
      provider: 'goodbuddy',
      model: 'qwen-plus',
      harnessVersion: '0.1.0-rc.6',
      credentialRefs: ['GOODBUDDY_HARNESS_MODEL_API_KEY'],
      skillPackages: [],
      maxFrameBytes: 1024 * 1024
    }
  })

  timeout = setTimeout(() => {
    finish(
      'timeout',
      `${transportProbed ? 'transport-probed ' : ''}${stderr.replaceAll(/\s+/gu, ' ').trim()}`
    )
  }, 20_000)
}

void run().catch((error) => {
  finish(
    'bootstrap-error',
    error instanceof Error ? error.message : 'unknown error'
  )
})
