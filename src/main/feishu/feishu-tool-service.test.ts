import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuToolService } from './feishu-tool-service'

type Route = (url: URL, init: RequestInit) => unknown

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'goodbuddy-feishu-')); app.enabled = true })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const app = { enabled: true }

function service(routes: Record<string, Route>, credentials = true, saveRegisteredApp = vi.fn(async () => undefined)) {
  const calls: { method: string; path: string; query: Record<string, string>; body?: unknown }[] = []
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }))
    }
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' && init.headers && JSON.stringify(init.headers).includes('json') ? JSON.parse(init.body) : init.body
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    const handler = routes[`${method} ${url.pathname}`]
    if (!handler) return new Response(JSON.stringify({ code: 404, msg: `no route ${method} ${url.pathname}` }))
    const result = handler(url, init)
    return new Response(JSON.stringify(result instanceof Object && 'code' in (result as object) ? result : { code: 0, data: result }))
  })
  const instance = new FeishuToolService({
    settingsPath: join(root, 'feishu-tools.json'),
    credentials: {
      resolve: async () => credentials ? { appId: 'cli_app', appSecret: 's', domain: 'feishu' } : undefined,
      isEnabled: async () => app.enabled,
      saveRegisteredApp
    },
    fetch
  })
  return { instance, calls, fetch, saveRegisteredApp }
}

describe('FeishuToolService', () => {
  it('follows the application switch, defaults permission management off and persists updates', async () => {
    const { instance } = service({})
    const snapshot = await instance.getSnapshot()
    expect(snapshot).toMatchObject({ credentialsConfigured: true, appEnabled: true, appId: 'cli_app', settings: { allowInMessageSessions: false } })
    expect(snapshot.settings.categories).toEqual({ doc: true, wiki: true, drive: true, bitable: true, perm: false, scopes: true })
    expect(await instance.getEnabledCategories()).toEqual(['doc', 'wiki', 'drive', 'bitable', 'scopes'])
    app.enabled = false
    expect(await instance.getEnabledCategories()).toEqual([])
    expect((await instance.getSnapshot()).appEnabled).toBe(false)
    app.enabled = true
    await instance.updateSettings({ categories: { perm: true } })
    expect(await instance.getEnabledCategories()).toContain('perm')
    expect(JSON.parse(await readFile(join(root, 'feishu-tools.json'), 'utf8'))).toMatchObject({ categories: { perm: true } })
  })

  it('makes the knowledge base unusable while 文档 is off', async () => {
    const { instance } = service({})
    await instance.updateSettings({ categories: { doc: false } })
    const categories = await instance.getEnabledCategories()
    expect(categories).not.toContain('wiki')
    expect(categories).not.toContain('doc')
    expect(categories).toContain('drive')
  })

  it('returns no categories without credentials', async () => {
    const { instance } = service({}, false)
    await instance.updateSettings({ enabled: true })
    expect(await instance.getEnabledCategories()).toEqual([])
    await expect(instance.callTool('feishu_doc', { action: 'read', doc_token: 'd' }, ['doc'])).rejects.toThrow('尚未配置')
  })

  it('rejects tools whose category is not granted', async () => {
    const { instance, calls } = service({})
    await expect(instance.callTool('feishu_perm', { action: 'list', token: 'd', type: 'docx' }, ['doc'])).rejects.toThrow('未开启')
    expect(calls).toHaveLength(0)
  })

  it('reads documents and appends converted Markdown with one descendant request', async () => {
    const { instance, calls } = service({
      'GET /open-apis/docx/v1/documents/doc1/raw_content': () => ({ content: '正文' }),
      'GET /open-apis/docx/v1/documents/doc1': () => ({ document: { title: '周报', revision_id: 3 } }),
      'POST /open-apis/docx/v1/documents/blocks/convert': () => ({
        blocks: [{ block_id: 'b1', block_type: 3, parent_id: 'x', children: 'b2' }, { block_id: 'b2', block_type: 2 }],
        first_level_block_ids: ['b1']
      }),
      'POST /open-apis/docx/v1/documents/doc1/blocks/doc1/descendant': () => ({ children: [] })
    })
    expect(await instance.callTool('feishu_doc', { action: 'read', doc_token: 'doc1' }, ['doc'])).toMatchObject({
      title: '周报', content: '正文', url: 'https://www.feishu.cn/docx/doc1'
    })
    expect(await instance.callTool('feishu_doc', { action: 'append', doc_token: 'doc1', content: '# 标题\n内容' }, ['doc']))
      .toMatchObject({ success: true, blocks_added: 2 })
    const insert = calls.find(call => call.path.endsWith('/descendant'))!
    expect(insert.body).toEqual({
      children_id: ['b1'],
      descendants: [{ block_id: 'b1', block_type: 3, children: ['b2'] }, { block_id: 'b2', block_type: 2 }],
      index: -1
    })
    expect(insert.query).toEqual({ document_revision_id: '-1' })
  })

  it('creates documents and grants the scanning owner full access', async () => {
    const { instance, calls } = service({
      'POST /open-apis/docx/v1/documents': () => ({ document: { document_id: 'newdoc', title: '纪要' } }),
      'POST /open-apis/drive/v1/permissions/newdoc/members': () => ({ member: {} })
    })
    await (instance as unknown as { saveSettings(s: unknown): Promise<void> }).saveSettings({
      ...(await instance.getSettings()), ownerOpenId: 'ou_owner'
    })
    expect(await instance.callTool('feishu_doc', { action: 'create', title: '纪要' }, ['doc'])).toMatchObject({
      document_id: 'newdoc', owner_permission: 'granted'
    })
    expect(calls.at(-1)).toMatchObject({ query: { type: 'docx', need_notification: 'false' }, body: { member_type: 'openid', member_id: 'ou_owner', perm: 'full_access' } })
  })

  it('maps wiki, drive, bitable and scope calls to the Open API', async () => {
    const { instance, calls } = service({
      'GET /open-apis/wiki/v2/spaces': () => ({ items: [] }),
      'GET /open-apis/wiki/v2/spaces/get_node': () => ({ node: { node_token: 'n', obj_token: 'o', obj_type: 'docx' } }),
      'GET /open-apis/drive/v1/files': () => ({ files: [{ token: 'f', name: '方案', type: 'docx' }] }),
      'GET /open-apis/bitable/v1/apps/app1/tables/tbl/records': () => ({ items: [{ record_id: 'r' }] }),
      'GET /open-apis/application/v6/scopes': () => ({ scopes: [{ scope_name: 'docx:document', grant_status: 1 }, { scope_name: 'wiki:wiki', grant_status: 2 }] })
    })
    expect(await instance.callTool('feishu_wiki', { action: 'spaces' }, ['wiki'])).toMatchObject({ spaces: [], hint: expect.stringContaining('群') })
    expect(await instance.callTool('feishu_wiki', { action: 'get', token: 'n' }, ['wiki'])).toMatchObject({ obj_token: 'o' })
    expect(await instance.callTool('feishu_drive', { action: 'list' }, ['drive'])).toMatchObject({ files: [{ token: 'f', name: '方案' }] })
    expect(await instance.callTool('feishu_bitable', { action: 'list_records', app_token: 'app1', table_id: 'tbl', filter: 'x' }, ['bitable']))
      .toMatchObject({ items: [{ record_id: 'r' }] })
    expect(calls.find(call => call.path.includes('/records'))!.query).toMatchObject({ filter: 'x', page_size: '100' })
    expect(await instance.callTool('feishu_app_scopes', {}, ['scopes'])).toMatchObject({ summary: '1 granted, 1 pending' })
    await expect(instance.callTool('feishu_wiki', { action: 'nodes' }, ['wiki'])).rejects.toThrow('space_id')
  })

  it('surfaces Feishu error codes', async () => {
    const { instance } = service({ 'GET /open-apis/drive/v1/files': () => ({ code: 99991672, msg: 'Access denied. One of the following scopes is required' }) })
    await expect(instance.callTool('feishu_drive', { action: 'list' }, ['drive'])).rejects.toThrow('99991672')
  })

  it('browses root spaces and drive files for the panel', async () => {
    const { instance } = service({
      'GET /open-apis/wiki/v2/spaces': () => ({ items: [{ space_id: '7', name: '产品知识库' }] }),
      'GET /open-apis/drive/v1/files': () => ({ files: [{ token: 'fold', name: '项目', type: 'folder' }, { token: 'd', name: '方案', type: 'docx' }] }),
      'GET /open-apis/wiki/v2/spaces/7/nodes': () => ({ items: [{ node_token: 'n1', title: '发布流程', obj_type: 'docx', has_child: true }] })
    })
    const root = await instance.browse({ location: { kind: 'root' } })
    expect(root.items.map(item => [item.kind, item.name, item.child?.kind ?? null])).toEqual([
      ['space', '产品知识库', 'space'], ['folder', '项目', 'folder'], ['file', '方案', null]
    ])
    expect(root.items[2]!.url).toBe('https://www.feishu.cn/docx/d')
    const nodes = await instance.browse({ location: { kind: 'space', token: '7' } })
    expect(nodes.items[0]).toMatchObject({ kind: 'node', name: '发布流程', url: 'https://www.feishu.cn/wiki/n1', child: { kind: 'node', spaceId: '7', token: 'n1' } })
  })

  it('searches titles across shared spaces and folders, respecting categories', async () => {
    const { instance } = service({
      'GET /open-apis/wiki/v2/spaces': () => ({ items: [{ space_id: '7', name: '产品知识库' }] }),
      'GET /open-apis/drive/v1/files': (url) => url.searchParams.get('folder_token') === 'fold'
        ? { files: [{ token: 'd2', name: '发布清单', type: 'sheet' }] }
        : { files: [{ token: 'fold', name: '项目', type: 'folder' }, { token: 'd', name: '方案', type: 'docx' }] },
      'GET /open-apis/wiki/v2/spaces/7/nodes': (url) => url.searchParams.get('parent_node_token') === 'n1'
        ? { items: [{ node_token: 'n2', title: '发布回滚', obj_type: 'docx' }] }
        : { items: [{ node_token: 'n1', title: '发布流程', obj_type: 'docx', has_child: true }] }
    })
    app.enabled = false
    await expect(instance.searchDocuments({ query: '发布' })).rejects.toThrow('未启用')
    app.enabled = true
    expect((await instance.searchDocuments({ query: '发布' })).map(item => [item.kind, item.name])).toEqual([
      ['node', '发布流程'], ['file', '发布清单'], ['node', '发布回滚']
    ])
    await instance.updateSettings({ categories: { wiki: false } })
    expect((await instance.searchDocuments({ query: '发布' })).map(item => item.name)).toEqual(['发布清单'])
  })

  it('creates documents in folders and pages in spaces, gated by category', async () => {
    const { instance, calls } = service({
      'POST /open-apis/docx/v1/documents': () => ({ document: { document_id: 'doc1', title: '周会' } }),
      'POST /open-apis/wiki/v2/spaces/7/nodes': () => ({ node: { node_token: 'n9', obj_type: 'docx', title: '页面' } })
    })
    expect(await instance.createDocument({ title: '周会', location: { kind: 'folder', token: 'fold' } }))
      .toMatchObject({ kind: 'file', token: 'doc1', name: '周会', type: 'docx' })
    expect(calls.find(call => call.path === '/open-apis/docx/v1/documents')!.body).toEqual({ title: '周会', folder_token: 'fold' })
    expect(await instance.createDocument({ title: '页面', location: { kind: 'node', spaceId: '7', token: 'n1' } }))
      .toMatchObject({ kind: 'node', token: 'n9', url: 'https://www.feishu.cn/wiki/n9' })
    expect(calls.find(call => call.path.endsWith('/nodes'))!.body).toMatchObject({ parent_node_token: 'n1', obj_type: 'docx' })
    await instance.updateSettings({ categories: { doc: false } })
    // 知识库 depends on 文档, so pages are blocked too.
    await expect(instance.createDocument({ title: 'x', location: { kind: 'space', token: '7' } })).rejects.toThrow('知识库')
    await expect(instance.createDocument({ title: 'x', location: { kind: 'root' } })).rejects.toThrow('文档')
  })

  it('uploads a local file into the app root folder and refuses large files', async () => {
    const file = join(root, '方案.txt')
    await writeFile(file, 'hello')
    const { instance, calls, fetch } = service({
      'GET /open-apis/drive/explorer/v2/root_folder/meta': () => ({ token: 'rootF' }),
      'POST /open-apis/drive/v1/files/upload_all': () => ({ file_token: 'ft1' })
    })
    expect(await instance.uploadFile(file, undefined)).toMatchObject({ kind: 'file', token: 'ft1', name: '方案.txt' })
    const upload = fetch.mock.calls.find(([url]) => String(url).includes('upload_all'))!
    const form = upload[1]!.body as FormData
    expect(form.get('parent_node')).toBe('rootF')
    expect(form.get('size')).toBe('5')
    expect(calls.some(call => call.path.includes('root_folder'))).toBe(true)
    await instance.updateSettings({ categories: { drive: false } })
    await expect(instance.uploadFile(file, 'fold')).rejects.toThrow('云空间')
  })

  it('registers an app by QR code and saves the credentials and owner', async () => {
    const saveRegisteredApp = vi.fn(async () => undefined)
    const fetch = vi.fn(async (_input: string, init: RequestInit = {}) => {
      const action = new URLSearchParams(String(init.body)).get('action')
      if (action === 'init') return new Response(JSON.stringify({ supported_auth_methods: ['client_secret'] }))
      if (action === 'begin') return new Response(JSON.stringify({ device_code: 'dc', verification_uri_complete: 'https://accounts.feishu.cn/x?code=1', interval: 0.01, expire_in: 60 }))
      return new Response(JSON.stringify({ client_id: 'cli_new', client_secret: 'sec', user_info: { open_id: 'ou_me' } }))
    })
    const instance = new FeishuToolService({
      settingsPath: join(root, 'feishu-tools.json'),
      credentials: { resolve: async () => undefined, saveRegisteredApp },
      fetch
    })
    const started = await instance.startRegistration('feishu')
    expect(started.registration).toMatchObject({ state: 'waiting', url: expect.stringContaining('tp=ob_cli_app') })
    await vi.waitFor(async () => expect((await instance.getSnapshot()).registration.state).toBe('completed'))
    expect(saveRegisteredApp).toHaveBeenCalledWith({ appId: 'cli_new', appSecret: 'sec', domain: 'feishu', openId: 'ou_me' })
    expect((await instance.getSettings()).ownerOpenId).toBe('ou_me')
  })
})
