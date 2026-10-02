// Does an Agent call the Story Graph tools on its own? Real DeepSeek tool-calling over an isolated copy
// that already has stories and experiences. The model sees only the production tool definitions and a user
// message; no instruction to use the tools. Tool calls run against the copy through the production reader.
// Logs prompts, tool names and answer lengths only. Usage:
//   npx jiti scripts/story-graph-agent-deepseek.mjs <experiences.sqlite> <env-file> <output-directory>
/* global process, fetch, AbortSignal, console */
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { AssistantDatabase } from '../src/main/assistant/assistant-database.ts'
import { storyGraphTools } from '../src/shared/story-graph-tools.ts'

const [prepared, envPath, directory] = process.argv.slice(2)
const config = parseEnv(readFileSync(envPath, 'utf8'))
assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'DeepSeek configuration unavailable')
mkdirSync(directory, { recursive: true })
const copy = join(directory, 'assistant.sqlite')
copyFileSync(prepared, copy)
if (existsSync(join(dirname(prepared), 'notes')) && !existsSync(join(directory, 'notes'))) cpSync(join(dirname(prepared), 'notes'), join(directory, 'notes'), { recursive: true })
const db = new AssistantDatabase(copy)
db.initialize(directory)
const project = db.listProjects().find(item => item.name === 'goodbuddy')
assert(project, 'goodbuddy project not found')
const tools = storyGraphTools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description,
  parameters: z.toJSONSchema(tool.inputSchema, { target: 'draft-7', io: 'input' }) } }))
const url = config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')
const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`
let calls = 0

async function ask(prompt) {
  const messages = [{ role: 'system', content: 'You are GoodBuddy, a coding assistant working in the user\'s project "goodbuddy". Answer in the user\'s language.' },
    { role: 'user', content: prompt }]
  const used = [], trace = []
  for (let turn = 0; turn < 8; turn++) {
    assert(++calls <= 40, 'Live request budget exhausted')
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.DEEPSEEK_MODEL, messages, tools, temperature: 0, max_tokens: 4096 }), signal: AbortSignal.timeout(180_000) })
    assert(response.ok, `Provider HTTP ${response.status}`)
    const message = (await response.json()).choices[0].message
    messages.push(message)
    if (!message.tool_calls?.length) return { used, trace, answer: message.content ?? '' }
    for (const call of message.tool_calls) {
      used.push(call.function.name)
      trace.push({ tool: call.function.name, args: call.function.arguments.slice(0, 200) })
      let result
      try { result = db.readStoryGraph(call.function.name, JSON.parse(call.function.arguments || '{}'), project.id) }
      catch (error) { result = { error: String(error?.message ?? error) } }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 60_000) })
    }
  }
  return { used, trace, answer: '(turn limit)' }
}

// Should call: continuing earlier work or asking about past decisions. Should not: self-contained questions.
const only = process.argv[5] ? Number(process.argv[5]) : undefined
const cases = [
  { prompt: '继续做监督者回顾调度，按我们最后定的方案来，先说一下方案是什么。', expect: true },
  { prompt: '之前为什么取消了回顾每 300 秒自动暂停？', expect: true },
  { prompt: '我要给监督者加一个导出功能，有什么之前定下的约束要注意？', expect: true },
  { prompt: '用 TypeScript 写一个数组去重函数。', expect: false },
  { prompt: '你好', expect: false }
]
const report = { model: config.DEEPSEEK_MODEL, cases: [] }
try {
  for (const item of only === undefined ? cases : [cases[only]]) {
    const { used, trace, answer } = await ask(item.prompt)
    report.cases.push({ prompt: item.prompt, expectCall: item.expect, called: used.length > 0, tools: used, trace, answerChars: answer.length, answerStart: answer.slice(0, 300) })
  }
  report.correct = report.cases.filter(item => item.called === item.expectCall).length
  report.requests = calls
} finally {
  db.close()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
