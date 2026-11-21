// Electron UtilityProcess host for the Pi SDK validation. Started by validate-pi-main.mjs.
// It loads only the official Pi bundle, owns one AgentSession and reports simplified events.
// Ask/Todo/Subagent below are historical probe-only extensions, not native Pi or planned product tools.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers'

const port = process.parentPort
let session
let pi
let config
let questionSequence = 0
const questions = new Map()
const post = message => port.postMessage(message)
const textOf = result => (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')

function mapEvent(event, parent) {
  const base = parent ? { parent } : {}
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent
    if (update.type === 'text_delta') return { ...base, kind: 'text', delta: update.delta }
    if (update.type === 'thinking_delta') return { ...base, kind: 'reasoning', delta: update.delta }
    return undefined
  }
  if (event.type === 'tool_execution_start') return { ...base, kind: 'tool', id: event.toolCallId, name: event.toolName, state: 'running' }
  if (event.type === 'tool_execution_end') return { ...base, kind: 'tool', id: event.toolCallId, name: event.toolName, state: event.isError ? 'failed' : 'completed', output: textOf(event.result).slice(0, 600) }
  if (event.type === 'message_end' && event.message.role === 'assistant') return { ...base, kind: 'assistant-end', stopReason: event.message.stopReason, usage: event.message.usage ? { input: event.message.usage.input, output: event.message.usage.output } : undefined }
  if (event.type === 'agent_settled') return { ...base, kind: 'settled' }
  return undefined
}

function ask(title, options, signal) {
  const id = `q${++questionSequence}`
  post({ type: 'question', id, title, options })
  return new Promise(resolve => {
    const abort = () => { questions.delete(id); post({ type: 'question-cancelled', id }); resolve(undefined) }
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    questions.set(id, value => { signal?.removeEventListener('abort', abort); resolve(value) })
  })
}

// Only dialog methods are routed to GoodBuddy; TUI rendering methods are inert in a headless host.
const uiContext = new Proxy({
  select: (title, options, opts) => ask(title, options, opts?.signal),
  confirm: async (title, message, opts) => (await ask(`${title}\n${message}`, ['Yes', 'No'], opts?.signal)) === 'Yes',
  input: (title, _placeholder, opts) => ask(title, [], opts?.signal),
  notify: (message, type) => post({ type: 'notify', message: String(message).slice(0, 200), level: type })
}, { get: (target, key) => key in target ? target[key] : () => undefined })

const objectSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })

function goodbuddyExtension(api) {
  api.registerTool({
    name: 'goodbuddy_ask_user', label: 'Ask user', description: 'Ask the GoodBuddy user one structured question and return the answer.',
    parameters: objectSchema({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question', 'options']),
    async execute(_id, params, signal, _update, ctx) {
      const answer = await ctx.ui.select(params.question, params.options, { signal })
      if (answer === undefined) return { content: [{ type: 'text', text: 'User skipped the question.' }], details: { skipped: true } }
      return { content: [{ type: 'text', text: answer }], details: { answer } }
    }
  })
  api.registerTool({
    name: 'goodbuddy_todo_write', label: 'Todo', description: 'Replace the GoodBuddy todo list.',
    parameters: objectSchema({ items: { type: 'array', items: objectSchema({ content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, ['content', 'status']) } }, ['items']),
    async execute(id, params) {
      post({ type: 'todo', callId: id, items: params.items })
      return { content: [{ type: 'text', text: `Todo updated (${params.items.length})` }], details: {} }
    }
  })
  api.registerTool({
    name: 'goodbuddy_subagent', label: 'Subagent', description: 'Delegate a read-only task to a child agent and return its answer.',
    parameters: objectSchema({ task: { type: 'string' } }, ['task']),
    async execute(id, params, signal) {
      const { session: child } = await pi.createAgentSession({
        cwd: config.workspace, agentDir: config.agentDir, modelRuntime: session.modelRuntime ?? config.modelRuntime, model: session.model, thinkingLevel: 'off',
        sessionManager: pi.SessionManager.inMemory(config.workspace),
        settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoader: minimalLoader('You are a read-only child agent.'), tools: ['read', 'grep', 'find', 'ls']
      })
      post({ type: 'subagent', parent: id, state: 'running', childSessionId: child.sessionId })
      const unsubscribe = child.subscribe(event => { const mapped = mapEvent(event, id); if (mapped) post({ type: 'event', event: mapped }) })
      const abort = () => void child.abort()
      signal?.addEventListener('abort', abort, { once: true })
      try {
        await child.prompt(params.task)
        const last = child.messages.findLast(message => message.role === 'assistant')
        const state = last?.stopReason === 'aborted' ? 'cancelled' : last?.stopReason === 'error' ? 'failed' : 'completed'
        post({ type: 'subagent', parent: id, state })
        if (state !== 'completed') throw new Error(`Child ${state}`)
        return { content: [{ type: 'text', text: child.getLastAssistantText() ?? '' }], details: { childSessionId: child.sessionId } }
      } finally { signal?.removeEventListener('abort', abort); unsubscribe(); child.dispose() }
    }
  })
}

function minimalLoader(systemPrompt) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {}
  }
}

async function start(value) {
  config = value
  const started = performance.now()
  pi = await import(pathToFileURL(config.bundle).href)
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(config.agentDir, 'auth.json'), modelsPath: join(config.agentDir, 'models.json') })
  config.modelRuntime = modelRuntime
  const model = modelRuntime.getModel('goodbuddy', config.model)
  if (!model) throw new Error('GoodBuddy model missing from Pi runtime')
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: config.tools })
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: config.workspace, agentDir: config.agentDir, settingsManager,
    noContextFiles: true, noPromptTemplates: true, noThemes: true, noExtensions: config.noDiscoveredExtensions,
    additionalSkillPaths: [config.skillDirectory],
    skillsOverride: base => ({ skills: base.skills.filter(skill => skill.filePath.startsWith(config.skillDirectory)), diagnostics: base.diagnostics }),
    appendSystemPrompt: [config.instructions],
    extensionFactories: [{ name: 'goodbuddy', factory: goodbuddyExtension }, pi.createMcpExtension()]
  })
  await resourceLoader.reload()
  const sessionManager = config.sessionFile ? pi.SessionManager.open(config.sessionFile, config.sessionDirectory) : pi.SessionManager.create(config.workspace, config.sessionDirectory)
  ;({ session } = await pi.createAgentSession({ cwd: config.workspace, agentDir: config.agentDir, modelRuntime, model, thinkingLevel: 'off', settingsManager, resourceLoader, sessionManager }))
  await session.bindExtensions({ uiContext })
  session.subscribe(event => { const mapped = mapEvent(event); if (mapped) post({ type: 'event', event: mapped }) })
  post({
    type: 'ready', ms: Math.round(performance.now() - started), rss: process.memoryUsage().rss, version: pi.VERSION,
    sessionId: session.sessionId, sessionFile: session.sessionFile, tools: session.getActiveToolNames(),
    skills: resourceLoader.getSkills().skills.map(skill => skill.name), extensionErrors: resourceLoader.getExtensions().errors.map(error => String(error.error ?? error).slice(0, 200))
  })
}

port.on('message', async ({ data }) => {
  try {
    if (data.type === 'start') await start(data.config)
    else if (data.type === 'prompt') {
      try { await session.prompt(data.text) } catch (error) { post({ type: 'prompt-error', id: data.id, message: String(error?.message ?? error).slice(0, 300) }) }
      const last = session.messages.findLast(message => message.role === 'assistant')
      post({ type: 'prompt-done', id: data.id, stopReason: last?.stopReason, error: last?.errorMessage?.slice(0, 300), text: (session.getLastAssistantText() ?? '').slice(0, 300), rss: process.memoryUsage().rss })
    } else if (data.type === 'abort') { await session.abort(); post({ type: 'aborted' }) }
    else if (data.type === 'answer') { const resolve = questions.get(data.id); questions.delete(data.id); resolve?.(data.value) }
    else if (data.type === 'dispose') { session?.dispose(); post({ type: 'disposed' }); setTimeout(() => process.exit(0), 50) }
  } catch (error) { post({ type: 'fatal', message: String(error?.stack ?? error).slice(0, 800) }) }
})
