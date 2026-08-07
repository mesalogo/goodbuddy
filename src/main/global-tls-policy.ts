import type { App, Certificate, Event, WebContents } from 'electron'
import {
  Agent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher
} from 'undici'

type CertificateErrorListener = (
  event: Event,
  webContents: WebContents,
  url: string,
  error: string,
  certificate: Certificate,
  callback: (isTrusted: boolean) => void,
  isMainFrame: boolean
) => void

type CertificateErrorApp = Pick<App, 'on' | 'removeListener'>

type GlobalTlsPolicyDependencies = {
  environment: NodeJS.ProcessEnv
  getDispatcher: () => Dispatcher
  setDispatcher: (dispatcher: Dispatcher) => void
  createInsecureDispatcher: () => Dispatcher
}

const defaultDependencies: GlobalTlsPolicyDependencies = {
  environment: process.env,
  getDispatcher: getGlobalDispatcher,
  setDispatcher: setGlobalDispatcher,
  createInsecureDispatcher: () =>
    new Agent({
      connect: {
        rejectUnauthorized: false
      }
    })
}

/**
 * GoodBuddy targets intranet deployments where model, vector, and MCP
 * endpoints commonly use self-signed or expired certificates, so certificate
 * validation is disabled for traffic this Electron process owns. URLs handed
 * to an external OS browser are outside the process and keep that browser's
 * own certificate policy.
 */
export class GlobalTlsPolicy {
  private readonly originalDispatcher: Dispatcher
  private insecureDispatcher?: Dispatcher
  private installed = false

  private readonly certificateErrorListener: CertificateErrorListener = (
    event,
    ...parameters
  ) => {
    const callback = parameters[4]
    event.preventDefault()
    callback(true)
  }

  constructor(
    private readonly app: CertificateErrorApp,
    private readonly dependencies: GlobalTlsPolicyDependencies =
      defaultDependencies
  ) {
    this.originalDispatcher = dependencies.getDispatcher()
  }

  install(): void {
    if (this.installed) {
      return
    }
    this.insecureDispatcher ??=
      this.dependencies.createInsecureDispatcher()
    this.dependencies.environment.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    this.dependencies.setDispatcher(this.insecureDispatcher)
    this.app.on('certificate-error', this.certificateErrorListener)
    this.installed = true
  }

  async dispose(): Promise<void> {
    if (this.installed) {
      this.dependencies.setDispatcher(this.originalDispatcher)
      this.app.removeListener(
        'certificate-error',
        this.certificateErrorListener
      )
      this.installed = false
    }
    await this.insecureDispatcher?.close()
    this.insecureDispatcher = undefined
  }
}
