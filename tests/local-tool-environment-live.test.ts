import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  defaultLocalToolEnvironmentSettings,
  type LocalToolEnvironmentSettings
} from '../src/shared/local-tool-environment-contracts'
import { LocalToolEnvironmentService } from '../src/main/local-tool-environment/local-tool-environment-service'
import { buildCredentialFilteredUserEnvironment } from '../src/main/agent/process-environment'

const runLive = process.env.GOODBUDDY_RUN_LIVE_TOOL_ENVIRONMENT === '1'
const describeLive = runLive ? describe : describe.skip
let root: string | undefined

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

describeLive('live local tool environment', () => {
  it('installs and validates the pinned Managed Python artifact', async () => {
    root = await mkdtemp(join(tmpdir(), 'goodbuddy-live-tools-'))
    let settings: LocalToolEnvironmentSettings = {
      ...defaultLocalToolEnvironmentSettings,
      artifactDownloadSource: 'native'
    }
    const service = new LocalToolEnvironmentService({
      settingsStore: {
        get: async () => ({ localToolEnvironment: settings }),
        update: async (input: {
          localToolEnvironment: LocalToolEnvironmentSettings
        }) => {
          settings = input.localToolEnvironment
          return { localToolEnvironment: settings }
        }
      } as never,
      binDirectory: join(root, 'bin'),
      managedPythonRoot: join(root, 'managed-python'),
      pythonArtifactCatalogPath: join(
        process.cwd(),
        'resources',
        'tool-environment',
        'managed-python-artifacts.json'
      ),
      packagedNpmCliPath: join(
        process.cwd(),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js'
      ),
      packagedNpxCliPath: join(
        process.cwd(),
        'node_modules',
        'npm',
        'bin',
        'npx-cli.js'
      ),
      selectExecutable: async () => undefined,
      electronExecutablePath: join(
        process.cwd(),
        'node_modules',
        'electron',
        'dist',
        process.platform === 'win32' ? 'electron.exe' : 'electron'
      ),
      baseEnvironment: buildCredentialFilteredUserEnvironment()
    })

    try {
      await service.initialize()
      const snapshot = await service.installPython()
      expect(snapshot.managedPython).toMatchObject({
        version: '3.13.15',
        installed: true
      })
      expect(snapshot.diagnostics.python).toMatchObject({
        available: true,
        source: 'managed',
        version: '3.13.15'
      })
      expect(snapshot.diagnostics.pip).toMatchObject({
        available: true,
        source: 'managed'
      })
    } finally {
      await service.dispose()
    }
  }, 180_000)
})
