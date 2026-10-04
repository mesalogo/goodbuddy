import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, safeStorage } from 'electron'
import { RuntimeSettingsStore } from '../src/main/runtime-settings-store'
import { ObsidianService } from '../src/main/obsidian/obsidian-service'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'
import { OpenCodeRuntime } from '../src/main/agent/opencode-runtime'
import { ContinueAgentRuntime } from '../src/main/agent/continue-runtime'
import { createLocalToolEnvironment } from '../src/main/local-tool-environment/local-tool-environment'
import { createModelRequestProbe } from './support/model-request-probe'
import { createAnthropicMessagesUrl } from '../src/main/agent/anthropic-endpoint'
import { createOpenAIChatCompletionsUrl, createOpenAIResponsesUrl } from '../src/main/agent/openai-endpoint'
import type { CapabilitySnapshot } from '../src/shared/capability-contracts'

export async function prepareChat(root: string, profileDirectory: string) {
  const source = process.env.GOODBUDDY_ACCEPTANCE_SETTINGS ?? join(app.getPath('appData'), 'goodbuddy', 'runtime-settings.json')
  const saved = JSON.parse(await readFile(source, 'utf8'))
  const profile = saved.modelProfiles.find((item: { id: string }) => item.id === saved.defaultModelProfileId)
  assert(profile && profile.protocol !== 'openai-images-generations')
  const upstreamUrl = profile.protocol === 'anthropic-messages' ? createAnthropicMessagesUrl(profile.baseUrl)
    : profile.protocol === 'openai-responses' ? createOpenAIResponsesUrl(profile.baseUrl)
      : createOpenAIChatCompletionsUrl(profile.baseUrl)
  const probe = await createModelRequestProbe({ upstreamUrl, headerName: 'x-goodbuddy-obsidian-chat' })
  profile.baseUrl = probe.baseUrl
  saved.provider = 'opencode'
  saved.workspacePath = join(root, 'chat-workspace')
  saved.opencodeBaseUrl = ''
  saved.opencodeEmbedded = true
  saved.opencodeBinaryPath = ''
  saved.opencodeConfigPath = ''
  saved.continueBinaryPath = ''
  saved.continueConfigPath = ''
  saved.opencodeModelSource = { kind: 'default' }
  saved.continueModelSource = { kind: 'default' }
  await mkdir(saved.workspacePath)
  await writeFile(join(profileDirectory, 'runtime-settings.json'), JSON.stringify(saved))
  return probe
}

export async function run(root: string, snapshot: CapabilitySnapshot): Promise<void> {
  // Resolve credentials only in Main from a disposable copy. Never update the source profile.
  const source = process.env.GOODBUDDY_ACCEPTANCE_SETTINGS ?? join(app.getPath('appData'), 'goodbuddy', 'runtime-settings.json')
  const copy = join(root, 'model-settings.json')
  await copyFile(source, copy)
  const settings = await new RuntimeSettingsStore(copy, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: value => safeStorage.encryptString(value),
    decrypt: value => safeStorage.decryptString(value)
  }).getResolvedSettings()
  const profile = settings.modelProfiles.find(item => item.id === settings.defaultModelProfileId)
  console.log('MODEL_AVAILABILITY', JSON.stringify(settings.modelProfiles.map(item => ({
    protocol: item.protocol, authentication: item.authentication, credentialAvailable: Boolean(item.apiKey),
    isDefault: item.id === settings.defaultModelProfileId
  }))))
  assert(profile, 'A saved default text model is required')
  assert(profile.authentication === 'none' || profile.apiKey, 'The saved model credential must decrypt')
  const prepared = await createLocalToolEnvironment({
    binDirectory: join(root, 'managed-bin'), nodeSelection: { source: 'managed' },
    pythonSelection: { source: 'managed' },
    packagedNpmCliPath: resolve('node_modules/npm/bin/npm-cli.js'),
    packagedNpxCliPath: resolve('node_modules/npm/bin/npx-cli.js')
  }, { electronExecutablePath: process.execPath })
  const vaultPath = snapshot.obsidian.vaultPath
  assert.equal(vaultPath, join(root, 'Temporary Vault'), 'Use the scope saved through the production UI')
  const assignment = snapshot.builtinMcpServers?.find(item => item.id === 'obsidian')
  assert(assignment?.enabled, 'Obsidian must be enabled through the production UI')
  const service = new ObsidianService({ appPath: resolve('.'), launchEnvironmentProvider: () => prepared.environment })
  let failures = 0
  for (const provider of ['opencode', 'continue'] as const) {
    assert(assignment.assignments.includes(provider), `Obsidian must be assigned to ${provider}`)
    const workspace = join(root, provider)
    await mkdir(workspace)
    const upstreamUrl = profile.protocol === 'anthropic-messages' ? createAnthropicMessagesUrl(profile.baseUrl)
      : profile.protocol === 'openai-responses' ? createOpenAIResponsesUrl(profile.baseUrl)
        : createOpenAIChatCompletionsUrl(profile.baseUrl)
    const probe = await createModelRequestProbe({ upstreamUrl, headerName: 'x-goodbuddy-obsidian-acceptance' })
    const gateway = new KnowledgeMcpGateway({} as never, { obsidianService: service })
    await gateway.start()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)
    const requestId = crypto.randomUUID()
    const token = gateway.grant(requestId, [], controller.signal, 'none', undefined, undefined, undefined, undefined,
      { settings: { vaultPath }, access: 'write' })!
    const common = { modelProfile: { ...profile, baseUrl: probe.baseUrl }, defaultWorkspace: workspace, knowledgeGateway: gateway }
    const runtime = provider === 'opencode'
      ? new OpenCodeRuntime({ embedded: true, binaryPath: '', configPath: '',
        bundledBinaryPath: resolve('.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode'), ...common })
      : new ContinueAgentRuntime({ binaryPath: '', configPath: '',
        bundledBinaryPath: resolve('node_modules/@continuedev/cli/dist/cn.js'), hostCacheRoot: join(root, 'continue-host'), ...common })
    const marker = `OBSIDIAN_${provider}_${crypto.randomUUID()}`
    try {
      let output = ''
      const tools: string[] = []
      for await (const event of runtime.run({ requestId, conversationId: crypto.randomUUID(),
        knowledgeCapabilityToken: token,
        prompt: `Use only the assigned Obsidian tools. Call obsidian_write_note to write ${provider}.md with content ${marker}, then obsidian_read_note to read it. Reply with the content read. Do not use shell or other tools.`
      }, controller.signal)) {
        if (event.type === 'text') output += event.delta
        if (event.type === 'tool') tools.push(JSON.stringify(event))
      }
      assert((await readFile(join(vaultPath, `${provider}.md`), 'utf8')).includes(marker), 'Real vault must contain model-requested note')
      assert(output.includes(marker), 'Model must return the read marker')
      assert(tools.some(item => item.includes('obsidian_write_note')) && tools.some(item => item.includes('obsidian_read_note')), 'Runtime events must show both Obsidian tools')
      console.log(`PASS: real ${provider} Obsidian write/read session`)
    } catch (error) {
      failures++
      console.error(`FAIL: ${provider}: ${error instanceof Error ? error.message : 'Unknown failure'}`)
    } finally {
      console.log(JSON.stringify({ provider, realModelHttpRequests: probe.observations.length }))
      clearTimeout(timeout)
      controller.abort()
      await runtime.dispose()
      await gateway.dispose()
      await probe.close()
    }
  }
  assert.equal(failures, 0, 'Both real runtime sessions must pass')
}
