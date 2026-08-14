import {
  DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
  DEEPSEEK_HARNESS_CONTROL_VERSION,
  parseHarnessControlMessage,
  type DeepSeekHarnessControlMessage
} from './agent/deepseek-harness-utility-launcher'
import { createDeepSeekHarnessHostTransport } from './agent/deepseek-harness-utility-transport'
import {
  createBoundedNdJsonStream,
  ControlledHarnessHostStartupError,
  installHarnessDiagnosticGuard,
  startControlledDeepSeekHarnessHost,
  type ControlledHarnessHost
} from './deepseek-harness-host'

const parentPort = process.parentPort
const restoreDiagnostics = installHarnessDiagnosticGuard()
let host: ControlledHarnessHost | undefined
let transport:
  | ReturnType<typeof createDeepSeekHarnessHostTransport>
  | undefined
let starting = false
let closed = false

function post(message: DeepSeekHarnessControlMessage): void {
  if (!closed) {
    parentPort.postMessage(message)
  }
}

async function close(): Promise<void> {
  if (closed) {
    return
  }
  closed = true
  await host?.dispose().catch(() => undefined)
  transport?.dispose()
  restoreDiagnostics()
}

function fatal(code: string): void {
  post({
    protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
    version: DEEPSEEK_HARNESS_CONTROL_VERSION,
    type: 'fatal',
    code
  })
  void close().finally(() => {
    process.exitCode = 1
  })
}

parentPort.on('message', (event) => {
  const message = parseHarnessControlMessage(event.data)
  if (!message) {
    // Once the byte transport is installed, non-control messages belong to
    // that transport's listener on the shared UtilityProcess port.
    if (transport) {
      return
    }
    fatal('INVALID_START')
    return
  }
  if (message.type !== 'start') {
    fatal('INVALID_START')
    return
  }
  if (starting || host || closed) {
    fatal('DUPLICATE_START')
    return
  }
  starting = true
  transport = createDeepSeekHarnessHostTransport(parentPort)
  void startControlledDeepSeekHarnessHost({
    ...message.config,
    stream: createBoundedNdJsonStream(
      transport.stdout,
      transport.stdin,
      message.config.maxFrameBytes
    )
  })
    .then((startedHost) => {
      host = startedHost
      starting = false
      post({
        protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
        version: DEEPSEEK_HARNESS_CONTROL_VERSION,
        type: 'ready'
      })
    })
    .catch((error: unknown) => {
      transport?.dispose()
      fatal(
        error instanceof ControlledHarnessHostStartupError
          ? error.code
          : 'HOST_START_FAILED'
      )
    })
})

process.once('disconnect', () => {
  void close()
})
process.once('SIGTERM', () => {
  void close()
})
