// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import type { TerminalSnapshot } from '../../shared/terminal-contracts'
import type { NativeTerminalLaunch } from '../terminal/terminal-session-manager'
import { LocalTerminalSession } from '../terminal/local-terminal-session'
import { resolveBundledRuntimePaths } from './bundled-runtimes'
import { NativeTerminalClient } from './native-terminal-client'

// Opt-in because these tests execute the installed native clients and a real PTY.
describe.skipIf(!process.env.GOODBUDDY_NATIVE_NODE)('installed native terminal clients', () => {
  for (const runtime of ['continue', 'opencode'] as const) {
    for (const workMode of ['ask', 'execute'] as const) {
    it(`${runtime} ${workMode} enforces tool mode and starts its interactive PTY`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'native-client-e2e-'))
      let launch: NativeTerminalLaunch | undefined
      let pty: LocalTerminalSession | undefined
      const requests: Array<Record<string, unknown>> = []
      const profile = { id: 'native-test', name: 'Native Test Model', modelName: 'native-test-model', baseUrl: 'https://native-test.invalid/v1', protocol: 'openai-chat-completions' as const, authentication: 'api-key' as const, apiKey: 'test-provider-secret' }
      const client = new NativeTerminalClient({
        rootDirectory: root,
        nodeExecutable: process.env.GOODBUDDY_NATIVE_NODE,
        bundledRuntimePaths: resolveBundledRuntimePaths({ appPath: process.cwd(), resourcesPath: '', packaged: false }),
        fetcher: async (_url, options) => {
          const request = JSON.parse(String(options?.body))
          requests.push(request)
          if (!request.stream) return new Response(JSON.stringify({ id: 'native-test', object: 'chat.completion', created: 1, model: profile.modelName, choices: [{ index: 0, message: { role: 'assistant', content: 'NATIVE_BRIDGE_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
          const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'native-test', object: 'chat.completion.chunk', created: 1, model: profile.modelName, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          if (requests.length === 1) return new Response(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'write-attempt', type: 'function', function: { name: runtime === 'continue' ? 'Bash' : 'bash', arguments: JSON.stringify({ command: 'echo NATIVE_WRITE > native-write-probe.txt', description: 'Write the test-owned marker' }) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
          return new Response(chunk({ role: 'assistant', content: 'NATIVE_BRIDGE_OK' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        },
        terminalManager: { create: async (_owner, _request, prepared) => {
          launch = prepared
          return { sessionId: 'native-test', state: 'running' } as TerminalSnapshot
        } }
      })
      try {
        await client.open(1, {
          projectId: 'project', projectName: 'Native Test', directory: root, runtime, workMode,
          settings: { continueBinaryPath: '', opencodeBinaryPath: '', continueConfigPath: '', continueModelProfile: profile, opencodeModelProfile: profile } as ResolvedRuntimeSettings
        })
        const spec = launch!.spawnSpec
        spec.env.NODE_ENV = 'production'
        delete spec.env.VITEST
        delete spec.env.VITEST_WORKER_ID
        delete spec.env.VITEST_POOL_ID
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(spec.executable, [...spec.args, ...(runtime === 'continue' ? ['-p', 'Reply with NATIVE_BRIDGE_OK'] : ['--print-logs', 'run', 'Reply with NATIVE_BRIDGE_OK'])], { cwd: root, env: spec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
          let text = ''
          const timeout = setTimeout(() => { child.kill(); reject(new Error(`Native CLI timeout: ${text.slice(-2000)}`)) }, 45_000)
          child.stdout.on('data', data => { text += data })
          child.stderr.on('data', data => { text += data })
          child.on('error', error => { clearTimeout(timeout); reject(error) })
          child.on('close', code => { clearTimeout(timeout); if (code === 0) resolve(text); else reject(new Error(`Native CLI exit ${code}: ${text.slice(-2000)}`)) })
        })
        expect(output, `requests: ${requests.length}; executable: ${spec.executable}; args: ${JSON.stringify(spec.args)}`).toContain('NATIVE_BRIDGE_OK')
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every(request => request.model === profile.modelName)).toBe(true)
        if (runtime === 'continue') {
          const tools = requests.flatMap(request => (request.tools ?? []) as Array<{ function: { name: string } }>).map(tool => tool.function.name)
          expect(tools).toContain('Read')
          if (workMode === 'ask') expect(tools).not.toContain('Write')
        }
        if (workMode === 'ask') await expect(stat(join(root, 'native-write-probe.txt'))).rejects.toThrow()
        else expect((await stat(join(root, 'native-write-probe.txt'))).isFile()).toBe(true)
        expect(requests.length).toBeGreaterThan(1)
        pty = await LocalTerminalSession.create({ target: { type: 'project', projectId: 'project' }, targetLabel: 'Native Test', title: runtime, size: { cols: 100, rows: 30 }, projectDirectory: root, spawnSpec: spec })
        expect(pty.snapshot().state).toBe('running')
        const session = pty
        await new Promise<void>((resolve, reject) => {
          let text = ''
          const timeout = setTimeout(() => { remove(); reject(new Error(`Interactive PTY did not become ready: ${text.slice(-1000)}`)) }, 15_000)
          const remove = session.onEvent(event => {
            session.acknowledge(event.sequence)
            if (event.type === 'output') {
              text += event.data
              if (/Continue|OpenCode|opencode|Native Test Model|native-test-model/u.test(text)) { clearTimeout(timeout); resolve() }
            }
            if (event.type === 'exit') { clearTimeout(timeout); reject(new Error(`Interactive PTY exited: ${text.slice(-1000)}`)) }
          })
        })
      } finally {
        await pty?.close()
        await launch?.dispose()
        await rm(root, { recursive: true, force: true })
      }
    }, 70_000)
    }
  }
})
