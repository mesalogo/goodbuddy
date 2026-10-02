import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, isAbsolute } from 'node:path'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  imageSaveMimeTypeForPath, imageSaveToolInputSchema, imageSaveToolName,
  imageToolInputSchema, imageToolName, type ImageSaveResult, type ImageSaveToolInput
} from '../shared/image-generation-contracts'
import { storyGraphTools, type StoryGraphToolName } from '../shared/story-graph-tools'
import {
  decodeRemoteImageToolMessage, encodeRemoteImageToolMessage,
  remoteImageSaveChunkSchema, remoteImageToolMaximumBytes, remoteImageToolReplySchema, type remoteImageToolSchema
} from '../shared/remote-image-tool-contracts'

/** One prompt's local MCP adapter. It never holds provider credentials or image bytes. */
export class AgentImageToolMcp {
  private readonly calls = new Map<string, { input: string; result: Promise<CallToolResult> }>()
  private readonly pending = new Map<string, {
    resolve: (value: CallToolResult) => void
    reject: (error: Error) => void
  }>()
  private server?: Server
  private closed = false
  url?: string

  constructor(
    readonly descriptor: z.infer<typeof remoteImageToolSchema>,
    private readonly send: (payload: Uint8Array) => Promise<void>
  ) {}

  async start(): Promise<void> {
    const path = `/${randomUUID()}/mcp`
    const schema = z.toJSONSchema(imageToolInputSchema, { target: 'draft-7', io: 'input' })
    Reflect.deleteProperty(schema, '$schema')
    const saveSchema = z.toJSONSchema(imageSaveToolInputSchema, { target: 'draft-7', io: 'input' })
    Reflect.deleteProperty(saveSchema, '$schema')
    this.server = createServer((request, response) => {
      void (async () => {
        if (this.closed || request.url !== path) { response.writeHead(404).end(); return }
        if (request.method !== 'POST') { response.writeHead(405).end(); return }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > remoteImageToolMaximumBytes) { response.writeHead(413).end(); return }
          chunks.push(bytes)
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const mcp = new McpServer({ name: 'goodbuddy-image', version: '1' }, { capabilities: { tools: {} } })
        mcp.setRequestHandler(ListToolsRequestSchema, async () => {
          const available = this.descriptor.storyGraph ? await this.call({}, 'story_graph_list') : undefined
          const graphEnabled = available?.content.some(part => part.type === 'text' && JSON.parse(part.text).available === true)
          return { tools: [
            ...(this.descriptor.description ? [{ name: imageToolName, description: this.descriptor.description, inputSchema: schema as { type: 'object' } }] : []),
            ...(this.descriptor.saveDescription ? [{ name: imageSaveToolName, description: this.descriptor.saveDescription, inputSchema: saveSchema as { type: 'object' },
              annotations: { readOnlyHint: false, destructiveHint: true } }] : []),
            ...(graphEnabled ? storyGraphTools.map(tool => ({ name: tool.name, description: tool.description,
              inputSchema: z.toJSONSchema(tool.inputSchema, { target: 'draft-7', io: 'input' }) as { type: 'object' },
              annotations: { readOnlyHint: true, destructiveHint: false } })) : [])
          ] }
        })
        mcp.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
          const graphTool = storyGraphTools.find(tool => tool.name === call.params.name)
          if (graphTool && this.descriptor.storyGraph) {
            try { return await this.call(call.params.arguments ?? {}, graphTool.name) }
            catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Story Graph read failed' }] } }
          }
          if (call.params.name === imageSaveToolName && this.descriptor.saveDescription) {
            try {
              const saved = await this.saveImage(imageSaveToolInputSchema.parse(call.params.arguments ?? {}))
              return { content: [{ type: 'text', text: JSON.stringify(saved) }] }
            } catch (error) {
              return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Saving image failed' }] }
            }
          }
          if (call.params.name !== imageToolName || !this.descriptor.description) throw new Error('Unknown image tool')
          const input = imageToolInputSchema.parse(call.params.arguments)
          // Repeated delivery of an MCP request returns the same outcome, including unknown delivery.
          const key = `${typeof extra.requestId}:${extra.requestId}`
          let existing = this.calls.get(key)
          if (existing && existing.input !== JSON.stringify(input)) throw new Error('Image tool request ID reused with different input')
          if (!existing) {
            const result = this.call(input).catch((error: unknown) => ({
              isError: true,
              content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Image tool delivery failed; do not retry automatically' }]
            }))
            existing = { input: JSON.stringify(input), result }
            this.calls.set(key, existing)
          }
          return await existing.result
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        response.once('close', () => { void mcp.close().catch(() => undefined) })
        await mcp.connect(transport)
        await transport.handleRequest(request, response, body)
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400)
        response.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Image MCP endpoint did not start')
    this.url = `http://127.0.0.1:${address.port}${path}`
  }

  onReply(payload: Uint8Array): void {
    const reply = remoteImageToolReplySchema.parse(decodeRemoteImageToolMessage(payload))
    const pending = this.pending.get(reply.callId)
    if (!pending) return
    if (reply.error || (!reply.result && !reply.storyGraphResult && !reply.imageChunk)) pending.reject(new Error(reply.error ?? 'Tool response has no result'))
    else pending.resolve({ content: [{ type: 'text', text: JSON.stringify(reply.imageChunk ?? reply.storyGraphResult ?? reply.result) }] })
  }

  /** Pulls the encoded image from Desktop in bounded chunks and writes it on this host. */
  private async saveImage(input: ImageSaveToolInput): Promise<ImageSaveResult> {
    const target = input.path
    if (!isAbsolute(target)) throw new Error('path must be an absolute file path')
    const mimeType = imageSaveMimeTypeForPath(target)
    if (!mimeType) throw new Error('path must end with .png, .jpg, .jpeg or .webp')
    const chunks: Buffer[] = []
    let offset = 0
    let totalBytes: number | undefined
    do {
      const result = await this.call({ artifactId: input.artifactId, mimeType, offset }, 'save_image_read')
      const part = result.content[0]
      if (part?.type !== 'text') throw new Error('Image chunk response is invalid')
      const chunk = remoteImageSaveChunkSchema.parse(JSON.parse(part.text))
      if (chunk.offset !== offset || chunk.mimeType !== mimeType || (totalBytes !== undefined && chunk.totalBytes !== totalBytes)) {
        throw new Error('Image chunk response is inconsistent')
      }
      totalBytes = chunk.totalBytes
      const bytes = Buffer.from(chunk.data, 'base64')
      if (bytes.byteLength === 0 || offset + bytes.byteLength > totalBytes) throw new Error('Image chunk response is inconsistent')
      chunks.push(bytes)
      offset += bytes.byteLength
    } while (offset < totalBytes)
    const data = Buffer.concat(chunks)
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, data, { flag: input.overwrite ? 'w' : 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('File already exists; choose another path or set overwrite=true', { cause: error })
      throw error
    }
    return { artifactId: input.artifactId, path: target, mimeType, byteSize: data.byteLength }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('Desktop image tool disconnected; delivery may be unknown. Do not retry automatically.'))
    this.pending.clear()
    this.server?.closeAllConnections()
    this.server?.close()
  }

  private async call(input: Record<string, unknown>, name?: StoryGraphToolName | 'story_graph_list' | 'save_image_read'): Promise<CallToolResult> {
    if (this.closed) throw new Error('Image tool prompt has ended')
    const callId = randomUUID()
    let timer: NodeJS.Timeout | undefined
    const result = new Promise<CallToolResult>((resolve, reject) => {
      this.pending.set(callId, { resolve, reject })
      timer = setTimeout(() => reject(new Error('Image tool wait timed out; delivery may be unknown. Do not retry automatically.')), 5 * 60_000)
      timer.unref()
    })
    // Register the wait before sending; send failures must not cause a retry.
    void this.send(encodeRemoteImageToolMessage({ callId, input, ...(name ? { name } : {}) })).catch(() => {
      this.pending.get(callId)?.reject(new Error('Image tool delivery may be unknown. Do not retry automatically.'))
    })
    try { return await result } finally {
      clearTimeout(timer)
      this.pending.delete(callId)
    }
  }
}
