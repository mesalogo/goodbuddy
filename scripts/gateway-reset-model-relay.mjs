// Run remote-recovery-host-probe --gateway-reset over pinned SSH. The one
// paid request contains only the synthetic fixture marker, never Host history.
/* global process, fetch, AbortSignal, console, URL */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { createInterface } from 'node:readline'
import { parseEnv } from 'node:util'

const [host, dir, node, runtimeRoot, helper, envFile] = process.argv.slice(2)
assert(host && dir?.startsWith('/root/tmp/') && node && runtimeRoot && helper && envFile,
  'Expected pinned SSH target, private test dir containing probe.cjs, Host Node, Runtime registry, Agent helper and local provider env file')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const command = `cd ${quote(dir)} && HOME=${quote(`${dir}/home`)} TMPDIR=${quote(dir)} NODE_PATH=${quote(`${posix.dirname(helper)}/lib/node_modules`)} GB_PROBE_RUNTIME_ROOT=${quote(runtimeRoot)} GB_PROBE_AGENT_EXECUTABLE=${quote(helper)} ${quote(node)} probe.cjs --gateway-reset`
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host, command],
  { stdio: ['pipe', 'pipe', 'inherit'], signal: AbortSignal.timeout(200_000) })
const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
const lines = createInterface({ input: child.stdout })
let calls = 0
let passed = false
const statuses = []
try {
  for await (const line of lines) {
    const value = JSON.parse(line)
    if (value.gatewayToolResult !== 'GB_GATEWAY_TOOL_OK') {
      assert(value.passed === true && value.relayedFinalResponses === 1)
      passed = true
      console.log(JSON.stringify(value))
      continue
    }
    assert.equal(calls, 0, 'External validation is limited to one request')
    const config = parseEnv(await readFile(envFile, 'utf8'))
    assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'Missing local model configuration')
    const base = config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')
    assert.equal(new URL(base).protocol, 'https:', 'The external validation provider must use HTTPS')
    // This test process must not inherit a development TLS override when attaching a key.
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    calls++
    const response = await fetch(base.endsWith('/chat/completions') ? base : `${base}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.DEEPSEEK_MODEL, messages: [{ role: 'user', content:
        `Tool result: ${value.gatewayToolResult}. Reply exactly GB_GATEWAY_OK.` }], stream: true, max_tokens: 128, thinking: { type: 'disabled' } })
    })
    statuses.push(response.status)
    child.stdin.write(`${JSON.stringify({ status: response.status, body: response.ok ? await response.text() : '' })}\n`)
  }
  assert.equal(await exit, 0, 'Host probe failed')
  assert(passed && calls === 1, 'Missing Host completion or paid request')
} finally {
  lines.close()
  child.kill()
  console.log(JSON.stringify({ externalProviderCalls: calls, statuses }))
}
