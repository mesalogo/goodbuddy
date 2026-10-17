import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wecomCommandCategory } from '../../shared/wecom-contracts'
import { WecomCliService } from './wecom-cli-service'

type Script = { stdout?: string; stderr?: string; exitCode?: number; hold?: boolean }

function fakeSpawn(scripts: (args: string[]) => Script) {
  const calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
  const children: (EventEmitter & { kill: () => void })[] = []
  const spawnProcess = vi.fn((binary: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => {
    calls.push({ binary, args: [...args], env: options.env, cwd: options.cwd })
    const script = scripts([...args])
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => { setImmediate(() => child.emit('close', null)) }
    })
    children.push(child)
    setImmediate(() => {
      if (script.stdout) child.stdout.write(script.stdout)
      if (script.stderr) child.stderr.write(script.stderr)
      if (!script.hold) setImmediate(() => child.emit('close', script.exitCode ?? 0))
    })
    return child
  })
  return { spawnProcess, calls, children }
}

let root: string

const bundle = () => join(root, 'bundle')
const bundledBinary = () => join(bundle(), 'bin', 'wecom-cli.exe')

async function installBundle(): Promise<void> {
  await mkdir(join(bundle(), 'bin'), { recursive: true })
  await mkdir(join(bundle(), 'wheels'), { recursive: true })
  await writeFile(bundledBinary(), '')
}

function service(scripts: (args: string[]) => Script, extra: Partial<ConstructorParameters<typeof WecomCliService>[0]> = {}) {
  const fake = fakeSpawn(scripts)
  const instance = new WecomCliService({
    rootDirectory: join(root, 'wecom'),
    skillsDirectory: join(root, 'skills'),
    bundleDirectory: bundle(),
    platform: 'win32',
    spawnProcess: fake.spawnProcess as never,
    ...extra
  })
  return { instance, ...fake }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'goodbuddy-wecom-'))
  await installBundle()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('wecomCommandCategory', () => {
  it('maps commands to enabled categories only', () => {
    const enabled = new Set(['doc-manage', 'todo'] as const)
    expect(wecomCommandCategory(['doc', 'search', '--json', '{}'], enabled)).toBe('doc-manage')
    expect(wecomCommandCategory(['doc', 'create'], enabled)).toBeUndefined()
    expect(wecomCommandCategory(['todo', 'create'], enabled)).toBe('todo')
    expect(wecomCommandCategory(['identity', 'whoami'], new Set())).toBe('identity')
    expect(wecomCommandCategory(['mail', 'send'], enabled)).toBeUndefined()
  })
})

describe('WecomCliService', () => {
  it('defaults to disabled tools with mail and messages off, and persists updates', async () => {
    const { instance } = service(() => ({ stdout: 'Status: unauthorized' }))
    const snapshot = await instance.getSnapshot()
    expect(snapshot.settings.enabled).toBe(false)
    expect(snapshot.settings.categories.email).toBe(false)
    expect(snapshot.settings.categories.message).toBe(false)
    expect(snapshot.settings.categories.doc).toBe(true)
    expect(snapshot.settings.allowInMessageSessions).toBe(false)
    await instance.updateSettings({ enabled: true, categories: { email: true } })
    const saved = JSON.parse(await readFile(join(root, 'wecom', 'settings.json'), 'utf8')) as { enabled: boolean; categories: { email: boolean; doc: boolean } }
    expect(saved.enabled).toBe(true)
    expect(saved.categories).toMatchObject({ email: true, doc: true })
  })

  it('runs the pinned binary with an isolated config directory and no inherited WeCom token', async () => {
    vi.stubEnv('WECOM_CLI_ACCESS_TOKEN', 'user-token')
    vi.stubEnv('WECOM_CLI_CONFIG_DIR', 'C:\\user\\wecom')
    const { instance, calls } = service(() => ({ stdout: 'Status: authorized\nBot ID: bot-1\n' }))
    const snapshot = await instance.getSnapshot()
    expect(snapshot.authorization).toEqual({ state: 'authorized', botId: 'bot-1' })
    expect(calls[0]!.binary).toBe(bundledBinary())
    expect(calls[0]!.args).toEqual(['auth', 'show'])
    expect(calls[0]!.env.WECOM_CLI_CONFIG_DIR).toBe(join(root, 'wecom', 'config'))
    expect(calls[0]!.env.WECOM_CLI_ACCESS_TOKEN).toBeUndefined()
  })

  it('reports enabled categories only when the application is on and authorized', async () => {
    let authorized = false
    let appEnabled = true
    const { instance } = service((args) => args[0] === 'auth'
      ? { stdout: authorized ? 'Status: authorized' : 'Status: unauthorized' }
      : { stdout: '{}' }, { resolveAppEnabled: async () => appEnabled })
    expect(await instance.getEnabledCategories()).toEqual([])
    authorized = true
    await instance.authorizeManually({ botId: 'bot', secret: 'secret' })
    expect(await instance.getEnabledCategories()).toContain('doc-manage')
    expect(await instance.getEnabledCategories()).not.toContain('email')
    // One application switch: turning the channel off removes the tools.
    appEnabled = false
    expect(await instance.getEnabledCategories()).toEqual([])
    expect((await instance.getSnapshot()).appEnabled).toBe(false)
  })

  it('verifies manual credentials through the CLI and surfaces its error message', async () => {
    const { instance, calls } = service((args) => args[1] === 'init'
      ? { exitCode: 1, stdout: '{"errcode":853000,"errmsg":"invalid bot_id or secret"}' }
      : { stdout: 'Status: unauthorized' })
    await expect(instance.authorizeManually({ botId: 'bot', secret: 'bad' })).rejects.toThrow('invalid bot_id or secret')
    expect(calls.find(call => call.args[1] === 'init')!.args).toEqual(['auth', 'init', '--bot-id', 'bot', '--secret', 'bad'])
  })

  it('reuses the message channel bot credentials', async () => {
    const { instance, calls } = service(() => ({ stdout: 'Status: authorized' }), {
      resolveChannelCredentials: async () => ({ botId: 'channel-bot', secret: 'channel-secret' })
    })
    await instance.authorizeWithChannelBot()
    expect(calls.find(call => call.args[1] === 'init')!.args).toEqual(['auth', 'init', '--bot-id', 'channel-bot', '--secret', 'channel-secret'])
  })

  function scanFetch(results: Record<string, unknown>[]) {
    const urls: string[] = []
    let poll = 0
    const fetch = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/ai/qc/generate')) {
        return new Response(JSON.stringify({ data: {
          scode: 'abc_D-1',
          auth_url: 'https://work.weixin.qq.com/ai/qc/c?s=abc_D-1&hide_more_btn=true&for_native=true'
        } }))
      }
      const body = results[Math.min(poll, results.length - 1)]
      poll += 1
      return new Response(JSON.stringify(body))
    })
    return { fetch, urls }
  }

  it('scans through GoodBuddy, signs the CLI in and saves the same bot for the message channel', async () => {
    let authorized = false
    const saved: unknown[] = []
    const saveBot = async (bot: unknown): Promise<void> => { saved.push(bot) }
    const { instance, calls } = service((args) => args[0] === 'auth' && args[1] === 'init'
      ? (authorized = true, { stdout: '' })
      : args[0] === 'identity'
        ? { stdout: '{"errcode":0,"bot":{"botid":"bot-new"},"user":{"userid":"zhangsan"}}' }
        : { stdout: authorized ? 'Status: authorized\nBot ID: bot-new' : 'Status: unauthorized' }, {
      fetch: scanFetch([
        { data: { status: 'init' } },
        { data: { status: 'success', bot_info: { botid: 'bot-new', secret: 'sec-new' } } }
      ]).fetch,
      qrPollIntervalMs: 1,
      saveRegisteredBot: saveBot
    })
    const waiting = await instance.startQrAuthorization()
    expect(waiting.qr).toMatchObject({
      state: 'waiting',
      url: 'https://work.weixin.qq.com/ai/qc/c?s=abc_D-1&hide_more_btn=true&for_native=true',
      webUrl: 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=abc_D-1'
    })
    await vi.waitFor(async () => expect((await instance.getSnapshot()).qr.state).toBe('completed'))
    expect((await instance.getSnapshot()).qr).toEqual({ state: 'completed', channelSaved: true, userId: 'zhangsan' })
    expect((await instance.getSnapshot()).authorization).toEqual({ state: 'authorized', botId: 'bot-new' })
    expect(calls.find(call => call.args[1] === 'init')!.args).toEqual(['auth', 'init', '--bot-id', 'bot-new', '--secret', 'sec-new'])
    expect(saved).toEqual([{ botId: 'bot-new', secret: 'sec-new', userId: 'zhangsan' }])
  })

  it('reports an expired code and does not save anything', async () => {
    const saveRegisteredBot = vi.fn(async () => undefined)
    const { instance, calls } = service(() => ({ stdout: 'Status: unauthorized' }), {
      fetch: scanFetch([{ data: { status: 'expired' } }]).fetch,
      qrPollIntervalMs: 1,
      saveRegisteredBot
    })
    await instance.startQrAuthorization()
    await vi.waitFor(async () => expect((await instance.getSnapshot()).qr).toEqual({ state: 'failed', message: '二维码已过期，请重新扫码' }))
    expect(saveRegisteredBot).not.toHaveBeenCalled()
    expect(calls.some(call => call.args[1] === 'init')).toBe(false)
  })

  it('keeps the tools authorized when saving the channel bot fails, and hides the secret in CLI errors', async () => {
    const { instance } = service((args) => args[1] === 'init'
      ? { stdout: '' }
      : args[0] === 'identity' ? { exitCode: 1 } : { stdout: 'Status: authorized' }, {
      fetch: scanFetch([{ data: { bot_info: { bot_id: 'b', secret: 's3cret' } } }]).fetch,
      qrPollIntervalMs: 1,
      saveRegisteredBot: async () => { throw new Error('企业微信由环境变量配置') }
    })
    await instance.startQrAuthorization()
    await vi.waitFor(async () => expect((await instance.getSnapshot()).qr).toEqual({
      state: 'completed', channelSaved: false, message: '企业微信由环境变量配置'
    }))
    const failing = service((args) => args[1] === 'init'
      ? { exitCode: 1, stdout: '{"errmsg":"bad secret s3cret"}' }
      : { stdout: 'Status: unauthorized' })
    await expect(failing.instance.authorizeManually({ botId: 'b', secret: 's3cret' })).rejects.toThrow('bad secret ***')
  })

  it('stops polling when the scan is cancelled', async () => {
    const scan = scanFetch([{ data: { status: 'init' } }])
    const { instance } = service(() => ({ stdout: 'Status: unauthorized' }), { fetch: scan.fetch, qrPollIntervalMs: 5 })
    await instance.startQrAuthorization()
    await vi.waitFor(() => expect(scan.urls.some(url => url.includes('query_result'))).toBe(true))
    await instance.cancelQrAuthorization()
    const count = scan.urls.length
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(scan.urls.length).toBeLessThanOrEqual(count + 1)
    expect((await instance.getSnapshot()).qr.state).toBe('idle')
  })

  it('rejects model commands outside enabled categories and administrative commands', async () => {
    const { instance, calls } = service(() => ({ stdout: '{"docs":[]}' }))
    await expect(instance.runModelCommand(['auth', 'init'], ['doc'])).rejects.toThrow('auth')
    await expect(instance.runModelCommand(['wecom-cli', 'doc', 'search'], ['doc-manage'])).rejects.toThrow('wecom-cli')
    await expect(instance.runModelCommand(['mail', 'send'], ['doc'])).rejects.toThrow('不属于已开启')
    expect(calls).toHaveLength(0)
    const result = await instance.runModelCommand(['doc', 'search', '--json', '{"keywords":["周报"]}'], ['doc-manage'])
    expect(result).toMatchObject({ exitCode: 0, category: 'doc-manage', stdout: '{"docs":[]}' })
    expect(calls[0]!.cwd).toBe(join(root, 'wecom', 'downloads'))
  })

  it('maps document search results and drops IDs without names', async () => {
    let appEnabled = false
    const { instance, calls } = service((args) => args[0] === 'auth' ? { stdout: 'Status: authorized' } : { stdout: JSON.stringify({ docs: [
      { docid: 'd1', doc_name: '周报', doc_type: 'doc', url: 'https://doc.weixin.qq.com/doc/1', modify_time: '2026-10-01 10:00:00' },
      { docid: 'd2' },
      { docid: 'd3', doc_name: 'x', url: 'javascript:alert(1)' }
    ] }) }, { resolveAppEnabled: async () => appEnabled })
    // Search uses the same gate as the doc-manage tools.
    await expect(instance.searchDocuments('周报')).rejects.toThrow('文档管理')
    expect(calls.some(call => call.args[0] === 'doc')).toBe(false)
    appEnabled = true
    await instance.updateSettings({ categories: { 'doc-manage': false } })
    await expect(instance.searchDocuments('周报')).rejects.toThrow('文档管理')
    await instance.updateSettings({ categories: { 'doc-manage': true } })
    expect(await instance.searchDocuments('周报')).toEqual([
      { id: 'd1', name: '周报', type: 'doc', url: 'https://doc.weixin.qq.com/doc/1', modifiedAt: '2026-10-01 10:00:00' },
      { id: 'd3', name: 'x', type: 'doc' }
    ])
  })

  it('lists recent, created and drive views as the authorized person, gated by category', async () => {
    const { instance, calls } = service((args) => args[0] === 'auth' ? { stdout: 'Status: authorized' }
      : args[0] === 'identity' ? { stdout: '{"user":{"userid":"zhangsan"}}' }
      : args[0] === 'disk' ? { stdout: JSON.stringify({ files: [{ id: 'f1', file_name: '合同.pdf', type: 'file', path: '法务/合同', update_time: '2026-10-11 10:00:00' }, { id: 'x' }] }) }
      : { stdout: JSON.stringify({ docs: [{ docid: 'd1', doc_name: '周报', doc_type: 'doc' }] }) })
    expect(await instance.listView('recent')).toEqual([{ id: 'd1', name: '周报', type: 'doc' }])
    const recent = JSON.parse(calls.find(call => call.args[1] === 'search')!.args[3]!) as Record<string, unknown>
    expect(recent).toMatchObject({ keywords: [], visitor_userids: ['zhangsan'], sort_by: 'best_match' })
    await instance.listView('created')
    const created = JSON.parse(calls.filter(call => call.args[1] === 'search').at(-1)!.args[3]!) as Record<string, unknown>
    expect(created).toMatchObject({ creator_userids: ['zhangsan'], sort_by: 'create_time' })
    expect(await instance.listView('disk')).toEqual([
      { id: 'f1', name: '合同.pdf', type: 'file', source: 'disk', path: '法务/合同', modifiedAt: '2026-10-11 10:00:00' }
    ])
    await instance.updateSettings({ categories: { disk: false } })
    await expect(instance.listView('disk')).rejects.toThrow('微盘')
  })

  it('creates online documents through doc create and requires the 在线文档 category', async () => {
    const { instance, calls } = service((args) => args[0] === 'auth' ? { stdout: 'Status: authorized' }
      : { stdout: JSON.stringify({ docid: 'new1', doc_name: '周会', url: 'https://doc.weixin.qq.com/doc/new1' }) })
    expect(await instance.createDocument('周会')).toEqual({ id: 'new1', name: '周会', type: 'doc', source: 'doc', url: 'https://doc.weixin.qq.com/doc/new1' })
    expect(JSON.parse(calls.find(call => call.args[1] === 'create')!.args[3]!)).toEqual({ doc_type: 'doc', doc_name: '周会' })
    await instance.updateSettings({ categories: { doc: false } })
    await expect(instance.createDocument('x')).rejects.toThrow('在线文档')
  })

  it('serves guides only for enabled categories and stays inside the skill directory', async () => {
    await mkdir(join(root, 'skills', 'wecomcli-doc', 'references'), { recursive: true })
    await mkdir(join(root, 'skills', 'wecomcli-shared'), { recursive: true })
    await writeFile(join(root, 'skills', 'wecomcli-doc', 'SKILL.md'), '# doc')
    await writeFile(join(root, 'skills', 'wecomcli-doc', 'references', 'doc-create.md'), '# create')
    await writeFile(join(root, 'skills', 'wecomcli-shared', 'SKILL.md'), '# shared')
    await writeFile(join(root, 'skills', 'secret.md'), 'secret')
    const { instance } = service(() => ({}))
    expect(await instance.readGuide('wecomcli-doc', ['doc'])).toMatchObject({ content: '# doc', files: ['references/doc-create.md'] })
    expect(await instance.readGuide('wecomcli-shared', [])).toMatchObject({ content: '# shared' })
    await expect(instance.readGuide('wecomcli-email', ['doc'])).rejects.toThrow('未开启')
    await expect(instance.readGuide('wecomcli-doc', ['doc'], '../secret.md')).rejects.toThrow('技能目录')
  })

  it('deletes only the isolated config directory on disconnect', async () => {
    const { instance } = service(() => ({ stdout: 'Status: authorized' }))
    await mkdir(join(root, 'wecom', 'config'), { recursive: true })
    await writeFile(join(root, 'wecom', 'config', 'credentials.enc'), 'x')
    const snapshot = await instance.disconnect()
    expect(snapshot.authorization.state).toBe('unauthorized')
    await expect(readFile(join(root, 'wecom', 'config', 'credentials.enc'))).rejects.toThrow()
    await expect(readFile(bundledBinary())).resolves.toBeDefined()
  })

  it('runs skill scripts in an isolated venv, confined to enabled skills and the work folder', async () => {
    await mkdir(join(root, 'skills', 'wecomcli-doc', 'scripts'), { recursive: true })
    await writeFile(join(root, 'skills', 'wecomcli-doc', 'scripts', 'build_docx.py'), 'print(1)')
    const venvPython = join(root, 'wecom', 'python', 'venv', 'Scripts', 'python.exe')
    const { instance, calls } = service((args) => {
      if (args[0] === '-c') return { stdout: '3.13\n' }
      if (args[0] === '-m' && args[1] === 'venv') return { exitCode: 0 }
      if (args[0] === '-m' && args[1] === 'pip') return { exitCode: 0 }
      return { stdout: 'built' }
    }, { resolvePython: async () => 'C:\\Python\\python.exe' })
    await mkdir(join(root, 'wecom', 'python', 'venv', 'Scripts'), { recursive: true })
    await writeFile(venvPython, '')
    await expect(instance.runSkillScript({ skill: 'wecomcli-pptx', script: 'build_page.py', args: [], files: [] }, ['doc'])).rejects.toThrow('未开启')
    await expect(instance.runSkillScript({ skill: 'wecomcli-doc', script: 'build_docx.py', args: [], files: [{ path: '../escape.txt', content: 'x' }] }, ['doc']))
      .rejects.toThrow('工作目录内')
    const result = await instance.runSkillScript({ skill: 'wecomcli-doc', script: 'build_docx.py', args: ['in.jsonl'],
      files: [{ path: 'in.jsonl', content: '{}' }] }, ['doc'])
    expect(result).toMatchObject({ exitCode: 0, stdout: 'built', workDirectory: join(root, 'wecom', 'downloads') })
    expect(await readFile(join(root, 'wecom', 'downloads', 'in.jsonl'), 'utf8')).toBe('{}')
    expect(calls.filter(call => !call.binary.endsWith('wecom-cli.exe')).map(call => [call.binary, call.args.slice(0, 2)])).toEqual([
      ['C:\\Python\\python.exe', ['-c', expect.any(String)]],
      ['C:\\Python\\python.exe', ['-m', 'venv']],
      [venvPython, ['-m', 'pip']],
      [venvPython, [join(root, 'skills', 'wecomcli-doc', 'scripts', 'build_docx.py'), 'in.jsonl']]
    ])
    const pip = calls.find(call => call.args[1] === 'pip')!
    expect(pip.args).toEqual(expect.arrayContaining(['--no-index', '--find-links', join(bundle(), 'wheels'), 'python-docx==1.2.0']))
    const scriptEnv = calls.at(-1)!.env
    expect(scriptEnv.WECOM_CLI_CONFIG_DIR).toBe(join(root, 'wecom', 'config'))
    expect(scriptEnv.PYTHONUTF8).toBe('1')
    const pathKey = Object.keys(scriptEnv).find(key => key.toLowerCase() === 'path')!
    expect(scriptEnv[pathKey]!.startsWith(join(bundle(), 'bin'))).toBe(true)
  })

  it('rejects a Python version the bundled wheels do not target', async () => {
    await mkdir(join(root, 'skills', 'wecomcli-doc', 'scripts'), { recursive: true })
    await writeFile(join(root, 'skills', 'wecomcli-doc', 'scripts', 'build_docx.py'), '')
    const { instance, calls } = service((args) => args[0] === '-c' ? { stdout: '3.11\n' } : {}, { resolvePython: async () => 'C:\\Python\\python.exe' })
    await expect(instance.runSkillScript({ skill: 'wecomcli-doc', script: 'build_docx.py', args: [], files: [] }, ['doc'])).rejects.toThrow('3.13')
    expect(calls.some(call => call.args[1] === 'pip')).toBe(false)
  })

  it('explains how to get Python when none is available', async () => {
    await mkdir(join(root, 'skills', 'wecomcli-doc', 'scripts'), { recursive: true })
    await writeFile(join(root, 'skills', 'wecomcli-doc', 'scripts', 'build_docx.py'), '')
    const { instance } = service(() => ({}), { resolvePython: async () => undefined })
    await expect(instance.runSkillScript({ skill: 'wecomcli-doc', script: 'build_docx.py', args: [], files: [] }, ['doc'])).rejects.toThrow('本机工具环境')
  })

  it('reports unsupported platforms without installing', async () => {
    await rm(bundle(), { recursive: true, force: true })
    const { instance } = service(() => ({}))
    expect((await instance.getSnapshot()).platformSupported).toBe(false)
    await expect(instance.ensureInstalled()).rejects.toThrow('不支持')
  })
})
