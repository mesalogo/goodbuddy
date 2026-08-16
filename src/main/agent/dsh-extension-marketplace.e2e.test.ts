import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startControlledDeepSeekHarnessHost } from '../deepseek-harness-host'
import {
  DshNpmExtensionInstaller,
  DshNpmMarketplaceCatalog
} from './dsh-extension-marketplace'
import { RuntimeExtensionStore } from './runtime-extension-store'

const enabled =
  process.env.GOODBUDDY_DSH_MARKETPLACE_E2E === '1'

describe.skipIf(!enabled)('DSH marketplace live E2E', () => {
  it(
    'searches, installs, enables, loads, and calls a real npm plugin',
    async () => {
      const userDataPath = await mkdtemp(
        join(tmpdir(), 'goodbuddy-dsh-marketplace-live-')
      )
      try {
        const market = new DshNpmMarketplaceCatalog()
        const greet = (await market.list()).find(
          (entry) => entry.package.name === 'dsh-plugin-greet'
        )
        expect(greet).toBeDefined()
        const npmCliPath = process.env.GOODBUDDY_DSH_NPM_CLI
          ? resolve(process.env.GOODBUDDY_DSH_NPM_CLI)
          : resolve(
              'node_modules',
              'npm',
              'bin',
              'npm-cli.js'
            )
        const nodeExecutablePath =
          process.env.GOODBUDDY_DSH_NODE_EXECUTABLE
            ? resolve(
                process.env.GOODBUDDY_DSH_NODE_EXECUTABLE
              )
            : undefined
        const installer = new DshNpmExtensionInstaller({
          dshHome: userDataPath,
          npmCliPath,
          ...(nodeExecutablePath ? { nodeExecutablePath } : {})
        })
        const store = new RuntimeExtensionStore(userDataPath, {
          catalog: {
            list: async () => [greet!]
          },
          install: (input) => installer.install(input)
        })
        await store.apply({
          type: 'set-marketplace-enabled',
          enabled: true
        })
        const installed = await store.apply({
          type: 'install',
          extensionId: greet!.id,
          package: greet!.package
        })
        expect(installed.installed).toEqual([
          expect.objectContaining({
            id: greet!.id,
            package: greet!.package,
            enabled: true,
            integrity: expect.stringMatching(/^sha512-/u)
          })
        ])

        const extensions = await store.getEnabledExtensions()
        const inbound = new TransformStream<
          Record<string, unknown>,
          Record<string, unknown>
        >()
        const outbound = new TransformStream<
          Record<string, unknown>,
          Record<string, unknown>
        >()
        const host = await startControlledDeepSeekHarnessHost({
          workspace: userDataPath,
          dshHome: userDataPath,
          baseUrl: 'https://api.deepseek.com',
          api: 'openai-completions',
          provider: 'goodbuddy',
          model: 'deepseek-test',
          harnessVersion: '0.1.0-rc.6',
          credentialRefs: ['GOODBUDDY_API_KEY'],
          skillPackages: [],
          extensionPackages: extensions,
          stream: {
            readable: inbound.readable,
            writable: outbound.writable
          } as never
        })
        expect(host.extensionFailures).toEqual([])
        await expect(
          host.context.tools.execute({
            callId: 'marketplace-live-greet',
            name: 'greet',
            arguments: { name: 'GoodBuddy' },
            signal: new AbortController().signal
          } as never)
        ).resolves.toMatchObject({
          isError: false,
          value: 'Hello, GoodBuddy!'
        })
        await host.dispose()
      } finally {
        await rm(userDataPath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100
        })
      }
    },
    120_000
  )
})
