import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { expect, it } from 'vitest'
import { ModelToolProvider, type ModelToolResult } from './model-tool-provider'

it('pages native rg output through the production provider in Ask and releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-rg-provider-'))
  const provider = new ModelToolProvider(root, [], undefined, undefined, false, { ripgrepExecutablePath: rgPath })
  const context = { conversationId: 'rg-pages', runtimeTarget: 'model' as const, workMode: 'ask' as const }
  const signal = new AbortController().signal
  const parse = (result: ModelToolResult) => {
    expect(result.contextBytes).toBeLessThanOrEqual(256 * 1024)
    const part = result.parts[0]!
    if (part.type !== 'text') throw new Error('Expected text')
    return JSON.parse(part.text)
  }
  try {
    const text = 'target 你好\\"'.repeat(30_000) + 'tail\n'
    await writeFile(join(root, 'large.txt'), text)
    expect(await provider.listTools(context, signal)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'workspace_rg', inputSchema: expect.objectContaining({ required: ['args'] }) }),
      expect.objectContaining({ name: 'output_read' })
    ]))
    const result = parse(await provider.callTool('workspace_rg', { args: ['--no-line-number', 'target', 'large.txt'] }, signal, context))
    let output = result.stdout
    const reference = result.stdoutReference
    let cursor = reference.nextCursor
    while (cursor < reference.totalBytes) {
      const page = parse(await provider.callTool('output_read', { handle: reference.handle, cursor }, signal, context))
      output += page.content
      expect(page.nextCursor).toBeGreaterThan(cursor)
      cursor = page.nextCursor
    }
    expect(output).toBe(text)
    const error = parse(await provider.callTool('workspace_rg', { args: ['[', '.'] }, signal, context))
    expect(error).toMatchObject({ exitCode: 2, stderr: expect.stringContaining('regex parse error') })
    await expect(provider.callTool('workspace_rg', { args: ['--pre=cmd', 'target'] }, signal, context))
      .rejects.toMatchObject({ name: 'RecoverableModelToolError' })
    await provider.releaseConversation(context.conversationId)
    await expect(provider.callTool('output_read', { handle: reference.handle }, signal, context)).rejects.toThrow('不存在')
  } finally {
    await provider.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
