// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ContextManager } from '../context-manager'
import { ConversationAttachmentStorage } from '../conversation-attachment-storage'
import { DocumentResultStorage } from '../document-result-storage'
import { ModelAgentRuntime } from './model-runtime'
import { ModelToolProvider } from './model-tool-provider'

vi.mock('electron', () => ({
  clipboard: {}, desktopCapturer: {}, dialog: {}, nativeImage: {}
}))

async function fixture() {
  const parent = resolve('temp/release-0.16.13')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'attachments-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const results = new DocumentResultStorage(join(root, 'parsing'))
  const assets = new ConversationAttachmentStorage(join(root, 'assets'), results)
  const manager = new ContextManager({ assets })
  const source = join(root, 'payload.bin')
  const bytes = Buffer.from('attachment-token\n'.repeat(8_000))
  await writeFile(source, bytes)
  const [attachment] = await manager.importFiles([source])
  const request = await manager.enrichRequest({
    requestId: randomUUID(), conversationId: randomUUID(),
    prompt: 'Read the attached file with workspace_read_text.',
    contextIds: [attachment!.id]
  })
  return { root, workspace, bytes, request, close: async () => {
    await manager.dispose()
    assets.close()
    await results.close()
    await rm(root, { recursive: true, force: true })
  } }
}

it('keeps raw attachment bytes out of prompts while retaining transfer data', async () => {
  const test = await fixture()
  try {
    expect(test.request.files?.[0]?.dataBase64).toBe(test.bytes.toString('base64'))
    expect(test.request.prompt).not.toContain('dataBase64')
    expect(test.request.prompt).not.toContain(test.bytes.toString('base64'))
    expect(test.request.prompt.length).toBeLessThan(2_000)
    expect(test.request.prompt).toContain('"name":"payload.bin"')
  } finally { await test.close() }
})

it('reads a local raw attachment through the production direct-model tool path', async () => {
  const test = await fixture()
  const provider = new ModelToolProvider(test.workspace)
  let calls = 0
  let attachmentPath = ''
  const runtime = new ModelAgentRuntime({
    apiKey: '', authentication: 'none', baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture', protocol: 'openai-chat-completions',
    defaultWorkspace: test.workspace, toolProvider: provider,
    fetcher: async (_url, init) => {
      const body = String(init?.body)
      expect(body).not.toContain('dataBase64')
      expect(body).not.toContain(test.bytes.toString('base64'))
      calls++
      if (calls === 1) {
        const prompt = JSON.parse(body).messages.at(-1).content as string
        attachmentPath = JSON.parse(prompt.match(/<attachment-file>(.*?)<\/attachment-file>/u)![1]!).path
        expect(attachmentPath).toMatch(/^\.goodbuddy\/sessions\//u)
        return Response.json({ choices: [{ message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'read-attachment', type: 'function', function: {
            name: 'workspace_read_text', arguments: JSON.stringify({ path: attachmentPath, limit: 1 })
          } }]
        } }] })
      }
      expect(body).toContain('attachment-token')
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'read complete' } }] })
    }
  })
  try {
    const events = []
    for await (const event of runtime.run(test.request, AbortSignal.timeout(10_000))) events.push(event)
    expect(events.filter(event => event.type === 'error' || event.type === 'tool' && event.state === 'failed')).toEqual([])
    expect(calls).toBe(2)
    expect(await readFile(join(test.workspace, attachmentPath))).toEqual(test.bytes)
    expect(await readFile(test.request.files![0]!.path)).toEqual(test.bytes)
  } finally { await runtime.dispose(); await test.close() }
})
