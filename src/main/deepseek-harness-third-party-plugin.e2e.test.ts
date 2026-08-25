import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startControlledDeepSeekHarnessHost } from './deepseek-harness-host'

const entrypoint =
  process.env.GOODBUDDY_DSH_PLUGIN_ENTRYPOINT?.trim()

describe.skipIf(!entrypoint)(
  'controlled DeepSeek Harness third-party plugin',
  () => {
    it('loads and executes a real marketplace tool with full Execute capability', async () => {
      const workspace = await realpath(
        await mkdtemp(
          join(tmpdir(), 'goodbuddy-harness-marketplace-e2e-')
        )
      )
      const inbound = new TransformStream<
        Record<string, unknown>,
        Record<string, unknown>
      >()
      const outbound = new TransformStream<
        Record<string, unknown>,
        Record<string, unknown>
      >()
      const host = await startControlledDeepSeekHarnessHost({
        workspace,
        dshHome: workspace,
        baseUrl: 'https://api.deepseek.com',
        api: 'openai-completions',
        provider: 'goodbuddy',
        model: 'deepseek-test',
        harnessVersion: '0.1.0-rc.8',
        credentialRefs: ['GOODBUDDY_API_KEY'],
        skillPackages: [],
        extensionPackages: [
          {
            id: 'marketplace-e2e',
            entrypoint: entrypoint!,
            configuration: {}
          }
        ],
        stream: {
          readable: inbound.readable,
          writable: outbound.writable
        } as never
      })

      expect(host.extensionFailures).toEqual([])
      expect(
        host.context.tools.schemas().map((tool) => tool.name)
      ).toContain('greet')
      await expect(
        host.context.tools.execute({
          callId: 'marketplace-greet',
          name: 'greet',
          arguments: { name: 'Ada' },
          signal: new AbortController().signal
        } as never)
      ).resolves.toMatchObject({
        isError: false,
        value: 'Hello, Ada!'
      })
      await host.dispose()
    })
  }
)
