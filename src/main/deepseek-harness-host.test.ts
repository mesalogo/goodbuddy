import { describe, expect, it } from 'vitest'
import {
  createBoundedNdJsonStream,
  installHarnessDiagnosticGuard,
  startControlledDeepSeekHarnessHost
} from './deepseek-harness-host'
import { vi } from 'vitest'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import type {
  Agent,
  CreateAgentOptions
} from '@deepseek-ai/dsh-agent'
import { GOODBUDDY_HARNESS_MAX_STEP_TOKENS } from './agent/goodbuddy-harness-control-plane'
import { GoodBuddyHarnessAttachmentStore } from './agent/goodbuddy-harness-attachment-store'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

async function readAllMessages(
  readable: ReadableStream<unknown>
): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of readable) {
    values.push(value)
  }
  return values
}

describe('controlled DeepSeek Harness host', () => {
  it('rejects unsupported endpoint protocols before Cordis starts', async () => {
    await expect(
      startControlledDeepSeekHarnessHost({
        workspace: 'C:\\workspace',
        baseUrl: 'file:///private/config',
        api: 'openai-completions',
        provider: 'goodbuddy',
        model: 'deepseek-test',
        harnessVersion: '0.1.0-rc.8',
        credentialRefs: ['GOODBUDDY_API_KEY'],
        dshHome: 'C:\\controlled-dsh-home',
        skillPackages: []
      })
    ).rejects.toThrow('secure OpenAI-compatible')
  })

  it('suppresses console payloads instead of contaminating stdout', () => {
    const restore = installHarnessDiagnosticGuard()
    const originalWrite = process.stderr.write
    const writes: string[] = []
    process.stderr.write = ((value: string | Uint8Array) => {
      writes.push(String(value))
      return true
    }) as typeof process.stderr.write
    try {
      console.log('prompt and secret must not reach protocol stdout')
      expect(writes.join('')).toBe(
        'DeepSeek Harness diagnostic suppressed\n'
      )
      expect(writes.join('')).not.toContain('secret')
    } finally {
      process.stderr.write = originalWrite
      restore()
    }
  })

  it('starts the controlled host with local execution providers', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'goodbuddy-harness-host-'))
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
      workspace: root,
      dshHome: root,
      baseUrl: 'https://gateway.example/openai/v1',
      api: 'openai-completions',
      provider: 'goodbuddy',
      model: 'qwen-plus',
      supportsImageInput: true,
      harnessVersion: '0.1.0-rc.8',
      credentialRefs: ['GOODBUDDY_API_KEY'],
      skillPackages: [],
      stream: {
        readable: inbound.readable,
        writable: outbound.writable
      } as never
    })

    expect(host.context.fs.sandboxMode).toBeUndefined()
    expect(host.context.shell.sandboxMode).toBeUndefined()
    expect(host.context.get('attachments')).toBeInstanceOf(
      GoodBuddyHarnessAttachmentStore
    )
    expect(
      host.context.shell.resolve({
        command: 'echo goodbuddy-host-execution'
      }).workdir
    ).toBe(root)
    const execution = await host.context.shell.run(
      host.context.shell.resolve({
        command:
          process.platform === 'win32'
            ? 'Write-Output goodbuddy-host-execution'
            : 'printf goodbuddy-host-execution'
      })
    )
    expect(execution).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false
    })
    expect(execution.stdout.text).toContain(
      'goodbuddy-host-execution'
    )
    await host.dispose()
  })

  it('canonicalizes workspace aliases before binding the host', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'goodbuddy-harness-alias-'))
    )
    const alias = join(root, '..', basename(root))
    const inbound = new TransformStream<
      Record<string, unknown>,
      Record<string, unknown>
    >()
    const outbound = new TransformStream<
      Record<string, unknown>,
      Record<string, unknown>
    >()
    const host = await startControlledDeepSeekHarnessHost({
      workspace: alias,
      dshHome: alias,
      baseUrl: 'https://api.deepseek.com',
      api: 'openai-completions',
      provider: 'goodbuddy',
      model: 'deepseek-test',
      harnessVersion: '0.1.0-rc.8',
      credentialRefs: ['GOODBUDDY_API_KEY'],
      skillPackages: [],
      stream: {
        readable: inbound.readable,
        writable: outbound.writable
      } as never
    })

    await host.dispose()
  })

  it('reports extension startup failures without failing the Host', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'goodbuddy-harness-extensions-'))
    )
    const brokenEntrypoint = join(root, 'broken.mjs')
    await writeFile(
      brokenEntrypoint,
      'export const value = 1\n',
      'utf8'
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
      workspace: root,
      dshHome: root,
      baseUrl: 'https://api.deepseek.com',
      api: 'openai-completions',
      provider: 'goodbuddy',
      model: 'deepseek-test',
      harnessVersion: '0.1.0-rc.8',
      credentialRefs: ['GOODBUDDY_API_KEY'],
      skillPackages: [],
      extensionPackages: [
        {
          id: 'broken',
          entrypoint: brokenEntrypoint,
          configuration: {}
        }
      ],
      stream: {
        readable: inbound.readable,
        writable: outbound.writable
      } as never
    })

    expect(host.failedExtensionIds).toEqual(['broken'])
    await host.dispose()
  })

  it('loads only explicitly supplied Skill packages into a session scope', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'goodbuddy-harness-skill-'))
    )
    const skillDirectory = join(root, 'web-3d-game')
    await mkdir(skillDirectory)
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: web-3d-game',
        'description: Build a playable browser 3D game.',
        '---',
        '',
        '# Web 3D game',
        '',
        'Create and validate a playable project.'
      ].join('\n'),
      'utf8'
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
      workspace: root,
      dshHome: root,
      baseUrl: 'https://api.deepseek.com',
      api: 'openai-completions',
      provider: 'goodbuddy',
      model: 'deepseek-test',
      harnessVersion: '0.1.0-rc.8',
      credentialRefs: ['GOODBUDDY_API_KEY'],
      skillPackages: [
        { id: 'web-3d-game', directory: skillDirectory }
      ],
      stream: {
        readable: inbound.readable,
        writable: outbound.writable
      } as never
    })
    let createdContext: typeof host.context | undefined
    let createdAgent: Agent | undefined
    const create = vi
      .spyOn(host.context.agents, 'create')
      .mockImplementation(async (options: CreateAgentOptions) => {
        const agentContext = host.context.extend({
          isolate: ['skills', 'tools']
        })
        createdContext = agentContext
        await options.setup?.(agentContext)
        const agent = {
          options: options.agentOptions ?? {},
          session: {
            id: options.sessionId,
            header: { cwd: options.meta?.cwd ?? root },
            events: [],
            append: vi.fn()
          },
          ctx: agentContext,
          cancel: vi.fn()
        }
        createdAgent = agent as never
        return {
          agent,
          dispose: async () => {
            await agentContext.fiber.dispose()
          }
        } as never
      })

    const api = (
      host.controlPlane as unknown as {
        createAgentApi(): {
          newSession(params: {
            cwd: string
            mcpServers: never[]
          }): Promise<{ sessionId: string }>
        }
      }
    ).createAgentApi()
    const session = await api.newSession({
      cwd: root,
      mcpServers: []
    })

    expect(session.sessionId).toBeTruthy()
    expect(
      (
        await createdContext!.skills.list({
          cwd: root,
          scope: createdAgent
        })
      ).map((skill) => skill.name)
    ).toEqual(['web-3d-game'])
    expect(
      createdContext!.tools
        .schemas(createdAgent)
        .map((tool) => tool.name)
    ).toContain('skill')
    const loadedSkill = await createdContext!.tools.execute({
      callId: 'skill-call',
      name: 'skill',
      arguments: { name: 'web-3d-game' },
      agent: createdAgent,
      signal: new AbortController().signal
    } as never)
    expect(loadedSkill).toMatchObject({
      isError: false,
      value: {
        name: 'web-3d-game',
        content: expect.stringContaining(
          'Create and validate a playable project.'
        )
      }
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentOptions: {
          provider: 'goodbuddy',
          model: 'deepseek-test',
          maxTokens: GOODBUDDY_HARNESS_MAX_STEP_TOKENS
        }
      })
    )
    const assembly = await createdContext!.systemPrompt.assemble({
      agent: createdAgent,
      scope: createdAgent
    })
    expect(
      assembly.sections.find(
        (section) =>
          section.name === 'goodbuddy:controlled-execution'
      )?.text
    ).toContain('create or update the requested workspace files promptly')
    await host.dispose()
  })

  it('frames fragmented and coalesced ACP messages individually', async () => {
    const inbound = new TransformStream<Uint8Array, Uint8Array>()
    const outbound = new TransformStream<Uint8Array, Uint8Array>()
    const stream = createBoundedNdJsonStream(
      outbound.writable,
      inbound.readable,
      24
    )
    const reading = readAllMessages(stream.readable)
    const writer = inbound.writable.getWriter()
    const encoder = new TextEncoder()
    await writer.write(encoder.encode('{"text":"你'))
    await writer.write(
      encoder.encode('好"}\n{"value":"1234567890"}\n')
    )
    await writer.close()

    await expect(reading).resolves.toEqual([
      { text: '你好' },
      { value: '1234567890' }
    ])
  })

  it('rejects oversized ACP frames at EOF in both directions', async () => {
    const inbound = new TransformStream<Uint8Array, Uint8Array>()
    const outbound = new TransformStream<Uint8Array, Uint8Array>()
    const stream = createBoundedNdJsonStream(
      outbound.writable,
      inbound.readable,
      8
    )
    const reading = readAllMessages(stream.readable)
    const inputWriter = inbound.writable.getWriter()
    await inputWriter.write(
      new TextEncoder().encode('{"value":"too large"}')
    )
    await inputWriter.close()
    await expect(reading).rejects.toThrow('input frame exceeds')

    const outputWriter = stream.writable.getWriter()
    await expect(
      outputWriter.write({ value: 'too large' } as never)
    ).rejects.toThrow('output frame exceeds')
  })
})
