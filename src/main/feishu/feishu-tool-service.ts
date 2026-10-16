import { readFile } from 'node:fs/promises'
import type { FeishuDomain } from '../../shared/channel-settings-contracts'
import {
  defaultFeishuToolSettings,
  feishuToolCategories,
  feishuToolSettingsSchema,
  type FeishuBrowseInput,
  type FeishuSearchInput,
  type FeishuBrowseItem,
  type FeishuRegistration,
  type FeishuSnapshot,
  type FeishuToolCategory,
  type FeishuToolSettings,
  type FeishuToolSettingsUpdate
} from '../../shared/feishu-contracts'
import {
  feishuBitableInputSchema,
  feishuDocInputSchema,
  feishuDriveInputSchema,
  feishuPermInputSchema,
  feishuToolCategory,
  feishuWikiInputSchema,
  type FeishuToolName
} from '../../shared/feishu-tools'
import { isMissingFileError, writeJsonFileAtomically } from '../settings-file-utils'
import { FeishuApi, type FeishuCredentials, type FeishuFetch } from './feishu-api'
import { beginAppRegistration, pollAppRegistration, type AppRegistrationResult } from './feishu-app-registration'

const MAX_READ_CHARACTERS = 100_000
const FEISHU_SEARCH_MAX_REQUESTS = 30
const FEISHU_SEARCH_MAX_RESULTS = 30
// Per the Feishu Wiki FAQ: the space member search does not list apps, so an
// app joins a space through a group that contains its bot.
const WIKI_ACCESS_HINT = '应用看不到知识空间时：知识空间成员里搜不到应用，需要先建一个飞书群并把本应用的机器人拉进群，再由知识空间管理员在“知识空间设置 › 成员”中添加这个群（成员或管理员）。只需要单个页面时，也可以在该页面右上角“… › 更多 › 添加文档应用”中添加本应用。'
const DRIVE_ACCESS_HINT = '云空间文件夹同理：在文件夹或文档右上角“… › 更多 › 添加文档应用”中添加本应用，或把文件夹共享给包含机器人的群。'
const WIKI_SCOPE_HINT = '应用还没有知识库读取权限：请在飞书开放平台为该应用开通 wiki:wiki:readonly（需要写入时开通 wiki:wiki），然后发布新版本。'

/** Block types the Markdown importer may emit but children.create cannot accept. */
const UNSUPPORTED_CREATE_TYPES = new Set([31, 32])

type Block = { block_id?: string; parent_id?: string; block_type?: number; children?: string[] | string; [key: string]: unknown }

export type FeishuCredentialSource = {
  resolve(): Promise<FeishuCredentials | undefined>
  /** Persists scanned credentials into the Feishu message channel settings. */
  saveRegisteredApp(result: AppRegistrationResult): Promise<void>
}

export type FeishuToolServiceOptions = {
  settingsPath: string
  credentials: FeishuCredentialSource
  fetch?: FeishuFetch
}

function requireField<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined || value === '') throw new Error(`${action} 需要参数 ${name}`)
  return value
}

/** Feishu work tools; runs as the app identity with the channel's App ID and Secret. */
export class FeishuToolService {
  private readonly listeners = new Set<(snapshot: FeishuSnapshot) => void>()
  private settings?: FeishuToolSettings
  private registration: FeishuRegistration = { state: 'idle' }
  private registrationController?: AbortController
  private revision = 0
  private api?: { key: string; api: FeishuApi }

  constructor(private readonly options: FeishuToolServiceOptions) {}

  onChanged(listener: (snapshot: FeishuSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async emit(): Promise<FeishuSnapshot> {
    this.revision += 1
    const snapshot = await this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }

  async getSettings(): Promise<FeishuToolSettings> {
    if (this.settings) return this.settings
    try {
      const parsed = feishuToolSettingsSchema.safeParse(JSON.parse(await readFile(this.options.settingsPath, 'utf8')))
      const defaults = defaultFeishuToolSettings()
      this.settings = parsed.success
        ? { ...parsed.data, categories: { ...defaults.categories, ...parsed.data.categories } }
        : defaults
    } catch (error) {
      if (!isMissingFileError(error) && !(error instanceof SyntaxError)) throw error
      this.settings = defaultFeishuToolSettings()
    }
    return this.settings
  }

  private async saveSettings(next: FeishuToolSettings): Promise<void> {
    const parsed = feishuToolSettingsSchema.parse(next)
    await writeJsonFileAtomically(this.options.settingsPath, parsed)
    this.settings = parsed
  }

  async getSnapshot(): Promise<FeishuSnapshot> {
    const [settings, credentials] = await Promise.all([this.getSettings(), this.options.credentials.resolve()])
    return {
      revision: this.revision,
      credentialsConfigured: Boolean(credentials),
      ...(credentials ? { appId: credentials.appId, domain: credentials.domain } : {}),
      settings,
      registration: this.registration
    }
  }

  async updateSettings(input: FeishuToolSettingsUpdate): Promise<FeishuSnapshot> {
    const current = await this.getSettings()
    await this.saveSettings({
      ...current,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.allowInMessageSessions === undefined ? {} : { allowInMessageSessions: input.allowInMessageSessions }),
      categories: { ...current.categories, ...Object.fromEntries(
        Object.entries(input.categories ?? {}).filter(([, value]) => value !== undefined)
      ) }
    })
    return this.emit()
  }

  /** Categories usable now: empty when the tools are off or credentials are missing. */
  async getEnabledCategories(): Promise<FeishuToolCategory[]> {
    const [settings, credentials] = await Promise.all([this.getSettings(), this.options.credentials.resolve()])
    if (!settings.enabled || !credentials) return []
    return feishuToolCategories.filter(category => settings.categories[category])
  }

  async startRegistration(domain: FeishuDomain): Promise<FeishuSnapshot> {
    this.registrationController?.abort()
    const controller = new AbortController()
    this.registrationController = controller
    this.registration = { state: 'starting' }
    await this.emit()
    const fetchImpl = this.options.fetch ?? ((input, init) => fetch(input, init))
    try {
      const begun = await beginAppRegistration(fetchImpl, domain, controller.signal)
      this.registration = { state: 'waiting', url: begun.qrUrl, expiresAt: new Date(Date.now() + begun.expireIn * 1000).toISOString() }
      void pollAppRegistration({ fetch: fetchImpl, ...begun, initialDomain: domain, signal: controller.signal }).then(async (outcome) => {
        if (this.registrationController !== controller) return
        this.registrationController = undefined
        if (outcome.status === 'success') {
          await this.options.credentials.saveRegisteredApp(outcome.result)
          if (outcome.result.openId) await this.saveSettings({ ...await this.getSettings(), ownerOpenId: outcome.result.openId })
          this.registration = { state: 'completed' }
        } else {
          this.registration = {
            state: 'failed',
            message: outcome.status === 'access_denied' ? '已在手机上拒绝创建应用'
              : outcome.status === 'expired' || outcome.status === 'timeout' ? '二维码已过期，请重新扫码'
                : outcome.message
          }
        }
        await this.emit()
      }).catch(async (error: unknown) => {
        if (this.registrationController !== controller) return
        this.registrationController = undefined
        this.registration = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
        await this.emit()
      })
    } catch (error) {
      this.registrationController = undefined
      this.registration = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    return this.emit()
  }

  async cancelRegistration(): Promise<FeishuSnapshot> {
    this.registrationController?.abort()
    this.registrationController = undefined
    this.registration = { state: 'idle' }
    return this.emit()
  }

  private async client(): Promise<FeishuApi> {
    const credentials = await this.options.credentials.resolve()
    if (!credentials) throw new Error('飞书 App ID 和 App Secret 尚未配置')
    const key = `${credentials.domain}:${credentials.appId}:${credentials.appSecret}`
    if (this.api?.key !== key) this.api = { key, api: new FeishuApi(credentials, this.options.fetch) }
    return this.api.api
  }

  private documentUrl(api: FeishuApi, kind: string, token: string): string {
    const host = api.baseUrl.includes('larksuite') ? 'https://www.larksuite.com' : 'https://www.feishu.cn'
    return `${host}/${kind}/${token}`
  }

  /** Lists spaces, folders and nodes for the workbar panel. */
  async browse(input: FeishuBrowseInput, signal?: AbortSignal): Promise<{ items: FeishuBrowseItem[]; hint?: string }> {
    const api = await this.client()
    const { location } = input
    if (location.kind === 'root') {
      const failures: string[] = []
      const [spaces, root] = await Promise.all([
        api.request<{ items?: { space_id?: string; name?: string }[] }>('GET', '/open-apis/wiki/v2/spaces', { query: { page_size: 50 }, signal })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            // A missing scope is a different fix than "the app was not added".
            failures.push(/scope|99991672|99991679|权限/iu.test(message) ? `${WIKI_SCOPE_HINT}（${message}）` : `知识空间：${message}`)
            return { items: [] }
          }),
        api.request<{ files?: { token?: string; name?: string; type?: string; url?: string }[] }>('GET', '/open-apis/drive/v1/files', { query: { page_size: 100 }, signal })
          .catch((error: unknown) => {
            failures.push(`云空间：${error instanceof Error ? error.message : String(error)}`)
            return { files: [] }
          })
      ])
      const items: FeishuBrowseItem[] = [
        ...(spaces.items ?? []).flatMap((space): FeishuBrowseItem[] => space.space_id
          ? [{ kind: 'space', token: space.space_id, name: space.name ?? space.space_id, child: { kind: 'space', token: space.space_id } }] : []),
        ...this.driveItems(api, root.files ?? [])
      ]
      const hints = [...failures, ...(items.length === 0 ? [WIKI_ACCESS_HINT, DRIVE_ACCESS_HINT] : [])]
      return { items, ...(hints.length > 0 ? { hint: hints.join('\n') } : {}) }
    }
    if (location.kind === 'folder') {
      const result = await api.request<{ files?: { token?: string; name?: string; type?: string; url?: string }[] }>(
        'GET', '/open-apis/drive/v1/files', { query: { folder_token: location.token, page_size: 200 }, signal })
      return { items: this.driveItems(api, result.files ?? []) }
    }
    const spaceId = location.kind === 'space' ? location.token : location.spaceId
    const result = await api.request<{ items?: { node_token?: string; obj_token?: string; obj_type?: string; title?: string; has_child?: boolean }[] }>(
      'GET', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      { query: { page_size: 50, parent_node_token: location.kind === 'node' ? location.token : undefined }, signal })
    return {
      items: (result.items ?? []).flatMap((node): FeishuBrowseItem[] => node.node_token ? [{
        kind: 'node',
        token: node.node_token,
        name: node.title || node.node_token,
        ...(node.obj_type ? { type: node.obj_type } : {}),
        url: this.documentUrl(api, 'wiki', node.node_token),
        ...(node.has_child ? { child: { kind: 'node', spaceId, token: node.node_token } } : {})
      }] : [])
    }
  }

  /**
   * Title search over what the app can see, for `@` references. Feishu's
   * document search needs a user token, so this walks shared wiki spaces and
   * drive folders breadth-first and filters titles. Bounded by request count.
   */
  async searchDocuments(input: FeishuSearchInput, signal?: AbortSignal): Promise<FeishuBrowseItem[]> {
    const enabled = await this.getEnabledCategories()
    const wiki = enabled.includes('wiki')
    const drive = enabled.includes('drive') || enabled.includes('doc')
    if (!wiki && !drive) throw new Error('飞书工具未启用，或已关闭“知识库”“云空间”和“文档”类别')
    const query = input.query.trim().toLocaleLowerCase()
    const matches: FeishuBrowseItem[] = []
    const queue: FeishuBrowseInput['location'][] = []
    const root = await this.browse({ location: { kind: 'root' } }, signal)
    const visit = (items: FeishuBrowseItem[]): void => {
      for (const item of items) {
        const document = item.kind === 'node' || item.kind === 'file'
        if (document && (item.kind === 'node' ? wiki : drive) && item.name.toLocaleLowerCase().includes(query)) matches.push(item)
        if (item.child && (item.child.kind === 'folder' ? drive : wiki)) {
          queue.push(item.child.kind === 'node'
            ? { kind: 'node', spaceId: item.child.spaceId!, token: item.child.token }
            : { kind: item.child.kind, token: item.child.token })
        }
      }
    }
    visit(root.items)
    let requests = 0
    while (queue.length > 0 && requests < FEISHU_SEARCH_MAX_REQUESTS && matches.length < FEISHU_SEARCH_MAX_RESULTS) {
      signal?.throwIfAborted()
      requests += 1
      const result = await this.browse({ location: queue.shift()! }, signal).catch(() => ({ items: [] }))
      visit(result.items)
    }
    return matches.slice(0, FEISHU_SEARCH_MAX_RESULTS)
  }

  private driveItems(api: FeishuApi, files: { token?: string; name?: string; type?: string; url?: string }[]): FeishuBrowseItem[] {
    return files.flatMap((file): FeishuBrowseItem[] => {
      if (!file.token) return []
      const folder = file.type === 'folder'
      return [{
        kind: folder ? 'folder' : 'file',
        token: file.token,
        name: file.name || file.token,
        ...(file.type ? { type: file.type } : {}),
        ...(file.url?.startsWith('https://') ? { url: file.url } : folder ? {} : { url: this.documentUrl(api, file.type ?? 'file', file.token) }),
        ...(folder ? { child: { kind: 'folder', token: file.token } } : {})
      }]
    })
  }

  /** Runs one model tool call after checking its category is granted. */
  async callTool(name: FeishuToolName, input: unknown, categories: readonly FeishuToolCategory[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const category = feishuToolCategory(name)
    if (!categories.includes(category)) {
      throw new Error(`飞书工具 ${name} 所属类别未开启；请在 应用 › 飞书 › 应用设置 中开启`)
    }
    const api = await this.client()
    switch (name) {
      case 'feishu_doc': return this.doc(api, feishuDocInputSchema.parse(input), signal)
      case 'feishu_wiki': return this.wiki(api, feishuWikiInputSchema.parse(input), signal)
      case 'feishu_drive': return this.drive(api, feishuDriveInputSchema.parse(input), signal)
      case 'feishu_bitable': return this.bitable(api, feishuBitableInputSchema.parse(input), signal)
      case 'feishu_perm': return this.perm(api, feishuPermInputSchema.parse(input), signal)
      case 'feishu_app_scopes': {
        const result = await api.request<{ scopes?: { scope_name?: string; scope_type?: string; grant_status?: number }[] }>(
          'GET', '/open-apis/application/v6/scopes', { signal })
        const scopes = result.scopes ?? []
        const granted = scopes.filter(scope => scope.grant_status === 1)
        const pending = scopes.filter(scope => scope.grant_status !== 1)
        return {
          granted: granted.map(scope => ({ name: scope.scope_name, type: scope.scope_type })),
          pending: pending.map(scope => ({ name: scope.scope_name, type: scope.scope_type })),
          summary: `${granted.length} granted, ${pending.length} pending`
        }
      }
    }
  }

  private async listBlocks(api: FeishuApi, docToken: string, signal?: AbortSignal): Promise<Block[]> {
    const blocks: Block[] = []
    let pageToken: string | undefined
    for (let page = 0; page < 50; page++) {
      const result = await api.request<{ items?: Block[]; has_more?: boolean; page_token?: string }>(
        'GET', `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks`, { query: { page_size: 500, page_token: pageToken }, signal })
      blocks.push(...(result.items ?? []))
      if (!result.has_more || !result.page_token) break
      pageToken = result.page_token
    }
    return blocks
  }

  /** Converts Markdown with the Feishu importer and inserts it at the end of the document. */
  private async insertMarkdown(api: FeishuApi, docToken: string, content: string, signal?: AbortSignal): Promise<number> {
    const converted = await api.request<{ blocks?: Block[]; first_level_block_ids?: string[] }>(
      'POST', '/open-apis/docx/v1/documents/blocks/convert', { body: { content_type: 'markdown', content }, signal })
    const blocks = (converted.blocks ?? []).map(block => {
      const clean: Block = { ...block }
      delete clean.parent_id
      if (typeof clean.children === 'string') clean.children = [clean.children]
      if (clean.block_type === 31 && clean.table && typeof clean.table === 'object') {
        const table = clean.table as { property?: { row_size?: number; column_size?: number } }
        clean.table = { property: { row_size: table.property?.row_size, column_size: table.property?.column_size } }
      }
      return clean
    })
    const roots = converted.first_level_block_ids ?? []
    if (blocks.length === 0 || roots.length === 0) return 0
    if (blocks.length <= 1000) {
      await api.request('POST', `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(docToken)}/descendant`, {
        query: { document_revision_id: -1 },
        body: { children_id: roots, descendants: blocks, index: -1 },
        signal
      })
      return blocks.length
    }
    // Very large documents: insert top-level blocks one at a time, skipping unsupported types.
    const byId = new Map(blocks.map(block => [block.block_id, block]))
    let inserted = 0
    for (const id of roots) {
      const block = byId.get(id)
      if (!block || UNSUPPORTED_CREATE_TYPES.has(block.block_type ?? 0)) continue
      const payload: Block = { ...block }
      delete payload.block_id
      delete payload.children
      await api.request('POST', `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(docToken)}/children`, {
        query: { document_revision_id: -1 },
        body: { children: [payload], index: -1 },
        signal
      })
      inserted++
    }
    return inserted
  }

  private async doc(api: FeishuApi, p: ReturnType<typeof feishuDocInputSchema.parse>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const action = `feishu_doc ${p.action}`
    const path = (token: string) => `/open-apis/docx/v1/documents/${encodeURIComponent(token)}`
    switch (p.action) {
      case 'read': {
        const doc = requireField(p.doc_token, 'doc_token', action)
        const [raw, info] = await Promise.all([
          api.request<{ content?: string }>('GET', `${path(doc)}/raw_content`, { signal }),
          api.request<{ document?: { title?: string; revision_id?: number } }>('GET', path(doc), { signal })
        ])
        const content = raw.content ?? ''
        return {
          title: info.document?.title,
          revision_id: info.document?.revision_id,
          content: content.slice(0, MAX_READ_CHARACTERS),
          ...(content.length > MAX_READ_CHARACTERS ? { truncated: true, hint: 'Content truncated; use list_blocks for structure.' } : {}),
          url: this.documentUrl(api, 'docx', doc)
        }
      }
      case 'create': {
        const title = requireField(p.title, 'title', action)
        const result = await api.request<{ document?: { document_id?: string; title?: string } }>(
          'POST', '/open-apis/docx/v1/documents', { body: { title, ...(p.folder_token ? { folder_token: p.folder_token } : {}) }, signal })
        const documentId = result.document?.document_id
        if (!documentId) throw new Error('飞书创建文档成功但没有返回 document_id')
        const owner = (await this.getSettings()).ownerOpenId
        let ownerPermission: string | undefined
        if (owner) {
          ownerPermission = await api.request('POST', `/open-apis/drive/v1/permissions/${encodeURIComponent(documentId)}/members`, {
            query: { type: 'docx', need_notification: false },
            body: { member_type: 'openid', member_id: owner, perm: 'full_access' },
            signal
          }).then(() => 'granted', (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return {
          document_id: documentId,
          title: result.document?.title,
          url: this.documentUrl(api, 'docx', documentId),
          ...(ownerPermission ? { owner_permission: ownerPermission } : {}),
          next: 'Call feishu_doc write with this document_id as doc_token to add content.'
        }
      }
      case 'write':
      case 'append': {
        const doc = requireField(p.doc_token, 'doc_token', action)
        const content = requireField(p.content, 'content', action)
        let deleted = 0
        if (p.action === 'write') {
          const children = (await this.listBlocks(api, doc, signal)).filter(block => block.parent_id === doc && block.block_type !== 1)
          if (children.length > 0) {
            await api.request('DELETE', `${path(doc)}/blocks/${encodeURIComponent(doc)}/children/batch_delete`, {
              query: { document_revision_id: -1 }, body: { start_index: 0, end_index: children.length }, signal
            })
            deleted = children.length
          }
        }
        const added = await this.insertMarkdown(api, doc, content, signal)
        return { success: true, ...(p.action === 'write' ? { blocks_deleted: deleted } : {}), blocks_added: added, url: this.documentUrl(api, 'docx', doc) }
      }
      case 'list_blocks': {
        const blocks = await this.listBlocks(api, requireField(p.doc_token, 'doc_token', action), signal)
        return { blocks: blocks.slice(0, 500), ...(blocks.length > 500 ? { truncated: true } : {}) }
      }
      case 'get_block': {
        const doc = requireField(p.doc_token, 'doc_token', action)
        const block = requireField(p.block_id, 'block_id', action)
        return api.request('GET', `${path(doc)}/blocks/${encodeURIComponent(block)}`, { signal })
      }
      case 'update_block': {
        const doc = requireField(p.doc_token, 'doc_token', action)
        const block = requireField(p.block_id, 'block_id', action)
        const content = requireField(p.content, 'content', action)
        await api.request('PATCH', `${path(doc)}/blocks/${encodeURIComponent(block)}`, {
          query: { document_revision_id: -1 },
          body: { update_text_elements: { elements: [{ text_run: { content } }] } },
          signal
        })
        return { success: true, block_id: block }
      }
      case 'delete_block': {
        const doc = requireField(p.doc_token, 'doc_token', action)
        const blockId = requireField(p.block_id, 'block_id', action)
        const { block } = await api.request<{ block?: Block }>('GET', `${path(doc)}/blocks/${encodeURIComponent(blockId)}`, { signal })
        const parent = block?.parent_id ?? doc
        const children = await api.request<{ items?: Block[] }>('GET', `${path(doc)}/blocks/${encodeURIComponent(parent)}/children`, { query: { page_size: 500 }, signal })
        const index = (children.items ?? []).findIndex(item => item.block_id === blockId)
        if (index < 0) throw new Error('未找到该 block')
        await api.request('DELETE', `${path(doc)}/blocks/${encodeURIComponent(parent)}/children/batch_delete`, {
          query: { document_revision_id: -1 }, body: { start_index: index, end_index: index + 1 }, signal
        })
        return { success: true, deleted_block_id: blockId }
      }
    }
  }

  private async wiki(api: FeishuApi, p: ReturnType<typeof feishuWikiInputSchema.parse>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const action = `feishu_wiki ${p.action}`
    const spaces = '/open-apis/wiki/v2/spaces'
    switch (p.action) {
      case 'spaces': {
        const result = await api.request<{ items?: { space_id?: string; name?: string; description?: string }[]; has_more?: boolean; page_token?: string }>(
          'GET', spaces, { query: { page_size: p.page_size ?? 50, page_token: p.page_token }, signal })
        const items = (result.items ?? []).map(space => ({ space_id: space.space_id, name: space.name, description: space.description }))
        return { spaces: items, has_more: result.has_more ?? false, page_token: result.page_token, ...(items.length === 0 && !p.page_token ? { hint: WIKI_ACCESS_HINT } : {}) }
      }
      case 'nodes': {
        const space = requireField(p.space_id, 'space_id', action)
        const result = await api.request<{ items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string }>(
          'GET', `${spaces}/${encodeURIComponent(space)}/nodes`,
          { query: { page_size: p.page_size ?? 50, page_token: p.page_token, parent_node_token: p.parent_node_token }, signal })
        return {
          nodes: (result.items ?? []).map(node => ({ node_token: node.node_token, obj_token: node.obj_token, obj_type: node.obj_type, title: node.title, has_child: node.has_child })),
          has_more: result.has_more ?? false,
          page_token: result.page_token
        }
      }
      case 'get': {
        const result = await api.request<{ node?: Record<string, unknown> }>('GET', `${spaces}/get_node`, { query: { token: requireField(p.token, 'token', action) }, signal })
        const node = result.node ?? {}
        return { node_token: node.node_token, space_id: node.space_id, obj_token: node.obj_token, obj_type: node.obj_type, title: node.title, parent_node_token: node.parent_node_token, has_child: node.has_child }
      }
      case 'create': {
        const space = requireField(p.space_id, 'space_id', action)
        const result = await api.request<{ node?: Record<string, unknown> }>('POST', `${spaces}/${encodeURIComponent(space)}/nodes`, {
          body: { obj_type: p.obj_type ?? 'docx', node_type: 'origin', title: requireField(p.title, 'title', action), parent_node_token: p.parent_node_token },
          signal
        })
        const node = result.node ?? {}
        return { node_token: node.node_token, obj_token: node.obj_token, obj_type: node.obj_type, title: node.title }
      }
      case 'move': {
        const space = requireField(p.space_id, 'space_id', action)
        const node = requireField(p.node_token, 'node_token', action)
        const result = await api.request<{ node?: { node_token?: string } }>('POST', `${spaces}/${encodeURIComponent(space)}/nodes/${encodeURIComponent(node)}/move`, {
          body: { target_space_id: p.target_space_id ?? space, target_parent_token: p.target_parent_token }, signal
        })
        return { success: true, node_token: result.node?.node_token ?? node }
      }
      case 'rename': {
        const space = requireField(p.space_id, 'space_id', action)
        const node = requireField(p.node_token, 'node_token', action)
        const title = requireField(p.title, 'title', action)
        await api.request('POST', `${spaces}/${encodeURIComponent(space)}/nodes/${encodeURIComponent(node)}/update_title`, { body: { title }, signal })
        return { success: true, node_token: node, title }
      }
    }
  }

  private async drive(api: FeishuApi, p: ReturnType<typeof feishuDriveInputSchema.parse>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const action = `feishu_drive ${p.action}`
    switch (p.action) {
      case 'list': {
        const result = await api.request<{ files?: Record<string, unknown>[]; has_more?: boolean; next_page_token?: string }>(
          'GET', '/open-apis/drive/v1/files', { query: { folder_token: p.folder_token, page_size: p.page_size ?? 100, page_token: p.page_token }, signal })
        const files = (result.files ?? []).map(file => ({ token: file.token, name: file.name, type: file.type, url: file.url, modified_time: file.modified_time }))
        return { files, has_more: result.has_more ?? false, page_token: result.next_page_token, ...(files.length === 0 && !p.folder_token ? { hint: DRIVE_ACCESS_HINT } : {}) }
      }
      case 'info': {
        const file = requireField(p.file_token, 'file_token', action)
        return api.request('POST', '/open-apis/drive/v1/metas/batch_query', {
          body: { request_docs: [{ doc_token: file, doc_type: requireField(p.type, 'type', action) }], with_url: true }, signal
        })
      }
      case 'create_folder': {
        const result = await api.request<{ token?: string; url?: string }>('POST', '/open-apis/drive/v1/files/create_folder', {
          body: { name: requireField(p.name, 'name', action), folder_token: p.folder_token ?? '' }, signal
        })
        return { token: result.token, url: result.url }
      }
      case 'move': {
        const file = requireField(p.file_token, 'file_token', action)
        const result = await api.request<{ task_id?: string }>('POST', `/open-apis/drive/v1/files/${encodeURIComponent(file)}/move`, {
          body: { type: requireField(p.type, 'type', action), folder_token: requireField(p.folder_token, 'folder_token', action) }, signal
        })
        return { success: true, ...(result.task_id ? { task_id: result.task_id, status: 'pending' } : {}) }
      }
      case 'delete': {
        const file = requireField(p.file_token, 'file_token', action)
        const result = await api.request<{ task_id?: string }>('DELETE', `/open-apis/drive/v1/files/${encodeURIComponent(file)}`, {
          query: { type: requireField(p.type, 'type', action) }, signal
        })
        return { success: true, ...(result.task_id ? { task_id: result.task_id, status: 'pending' } : {}) }
      }
      case 'list_comments': {
        const file = requireField(p.file_token, 'file_token', action)
        return api.request('GET', `/open-apis/drive/v1/files/${encodeURIComponent(file)}/comments`, {
          query: { file_type: p.type ?? 'docx', page_size: p.page_size ?? 50, page_token: p.page_token }, signal
        })
      }
      case 'add_comment': {
        const file = requireField(p.file_token, 'file_token', action)
        const content = requireField(p.content, 'content', action)
        const result = await api.request<{ comment_id?: string }>('POST', `/open-apis/drive/v1/files/${encodeURIComponent(file)}/comments`, {
          query: { file_type: p.type === 'doc' ? 'doc' : 'docx' },
          body: { reply_list: { replies: [{ content: { elements: [{ type: 'text_run', text_run: { text: content } }] } }] } },
          signal
        })
        return { success: true, comment_id: result.comment_id }
      }
    }
  }

  private async bitable(api: FeishuApi, p: ReturnType<typeof feishuBitableInputSchema.parse>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const action = `feishu_bitable ${p.action}`
    const base = (app: string) => `/open-apis/bitable/v1/apps/${encodeURIComponent(app)}`
    const table = () => `${base(requireField(p.app_token, 'app_token', action))}/tables/${encodeURIComponent(requireField(p.table_id, 'table_id', action))}`
    switch (p.action) {
      case 'create_app': {
        const result = await api.request<{ app?: { app_token?: string; name?: string; url?: string } }>('POST', '/open-apis/bitable/v1/apps', {
          body: { name: requireField(p.name, 'name', action), ...(p.folder_token ? { folder_token: p.folder_token } : {}) }, signal
        })
        return { app_token: result.app?.app_token, name: result.app?.name, url: result.app?.url }
      }
      case 'list_tables':
        return api.request('GET', `${base(requireField(p.app_token, 'app_token', action))}/tables`, { query: { page_size: p.page_size ?? 100, page_token: p.page_token }, signal })
      case 'list_fields':
        return api.request('GET', `${table()}/fields`, { query: { page_size: p.page_size ?? 100, page_token: p.page_token }, signal })
      case 'list_records':
        return api.request('GET', `${table()}/records`, { query: { page_size: p.page_size ?? 100, page_token: p.page_token, filter: p.filter }, signal })
      case 'get_record':
        return api.request('GET', `${table()}/records/${encodeURIComponent(requireField(p.record_id, 'record_id', action))}`, { signal })
      case 'create_record':
        return api.request('POST', `${table()}/records`, { body: { fields: requireField(p.fields, 'fields', action) }, signal })
      case 'update_record':
        return api.request('PUT', `${table()}/records/${encodeURIComponent(requireField(p.record_id, 'record_id', action))}`, {
          body: { fields: requireField(p.fields, 'fields', action) }, signal
        })
    }
  }

  private async perm(api: FeishuApi, p: ReturnType<typeof feishuPermInputSchema.parse>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const action = `feishu_perm ${p.action}`
    const members = `/open-apis/drive/v1/permissions/${encodeURIComponent(p.token)}/members`
    switch (p.action) {
      case 'list': {
        const result = await api.request<{ items?: Record<string, unknown>[] }>('GET', members, { query: { type: p.type }, signal })
        return { members: (result.items ?? []).map(member => ({ member_type: member.member_type, member_id: member.member_id, perm: member.perm, name: member.name })) }
      }
      case 'add': {
        const result = await api.request<{ member?: unknown }>('POST', members, {
          query: { type: p.type, need_notification: false },
          body: { member_type: requireField(p.member_type, 'member_type', action), member_id: requireField(p.member_id, 'member_id', action), perm: requireField(p.perm, 'perm', action) },
          signal
        })
        return { success: true, member: result.member }
      }
      case 'remove': {
        await api.request('DELETE', `${members}/${encodeURIComponent(requireField(p.member_id, 'member_id', action))}`, {
          query: { type: p.type, member_type: requireField(p.member_type, 'member_type', action) }, signal
        })
        return { success: true }
      }
    }
  }

  dispose(): void {
    this.registrationController?.abort()
    this.registrationController = undefined
  }
}
