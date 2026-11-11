import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

/** Isolated real-server publication setup; secrets are never returned to Renderer. */
export async function publishSharingModels(directory: string, serverUrl: string, deviceId: string) {
  let cookie = ''
  async function request(path: string, body: unknown, method = 'POST') {
    const response = await fetch(`${serverUrl}/api/v1/${path}`, { method,
      headers: { 'Content-Type': 'application/json', Origin: serverUrl, Cookie: cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    assert.equal(response.ok, true, `${path}: HTTP ${response.status}`)
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
    return await response.json() as { id: string; key: string; detail: string; revision: number }
  }
  await request('auth/setup', { username: 'model-test', password: 'isolated-model-test-password',
    setupToken: await readFile(join(directory, 'server-data/admin-setup-token'), 'utf8') })
  const envFile = process.env.GOODBUDDY_SHARING_MODEL_ENV
  const env = envFile ? parseEnv(await readFile(envFile, 'utf8')) : undefined
  const baseURL = env?.DEEPSEEK_BASE_URL ?? 'http://192.168.0.2:8000/v1'
  const model = env?.DEEPSEEK_MODEL ?? 'test-chat'
  const key = env?.DEEPSEEK_API_KEY
  const keys = new Map<string, string>()
  if (envFile) assert.ok(key, 'DEEPSEEK_API_KEY is required for real validation')
  if (key) {
    const upstream = await request('gateway/upstreams', { name: 'Import validation', baseUrl: baseURL, protocol: 'openai-chat-completions', authentication: 'api-key', credentialAction: 'replace', apiKey: key, enabled: true })
    const mapped = await request('gateway/models', { alias: 'import-test', upstreamId: upstream.id, remoteModel: model, enabled: true })
    const owner = await request('organization/members', { username: 'import-user', displayName: 'Import test', email: '', password: 'isolated-member-password' })
    const credential = await request('gateway/access-keys', { name: 'Import test', modelIds: [mapped.id], ownerMemberId: owner.id, expiresAt: null })
    keys.set('Gateway import', credential.key)
    keys.set('Custom import', key)
  }
  for (const routeType of ['gateway', 'custom']) {
    const name = routeType === 'gateway' ? 'Gateway import' : 'Custom import'
    const fields = { version: '1', routeType, baseUrl: routeType === 'gateway' ? `${serverUrl}/api/v1/gateway/v1` : baseURL,
      models: routeType === 'gateway' ? 'import-test' : model }
    let draft = await request('console/distribution', { name, detail: 'Isolated model import test', fields })
    for (const status of ['pending', 'approved']) draft = await request(`console/distribution/${draft.id}`, { name, detail: draft.detail, revision: draft.revision, status }, 'PUT')
    await request(`console/versions/${draft.id}/publish`, { revision: draft.revision, channel: 'stable', targets: [{ kind: 'device', id: deviceId }], previousId: null })
  }
  return keys
}

export async function prepareAccountRegistration(serverUrl: string) {
  const login = await fetch(`${serverUrl}/api/v1/auth/login`, { method: 'POST', headers: { Origin: serverUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'model-test', password: 'isolated-model-test-password' }) })
  assert.equal(login.ok, true)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const headers = { Origin: serverUrl, 'Content-Type': 'application/json', Cookie: cookie }
  const username = 'registration-member', password = 'isolated-registration-password'
  const memberResponse = await fetch(`${serverUrl}/api/v1/organization/members`, { method: 'POST', headers, body: JSON.stringify({ username, password, displayName: 'Registration member', email: '', role: 'member' }) })
  assert.equal(memberResponse.ok, true)
  const member = await memberResponse.json() as { id: string }
  const policy = await fetch(`${serverUrl}/api/v1/sharing/registration`, { method: 'PUT', headers, body: JSON.stringify({ authenticationModes: ['account'] }) })
  assert.equal(policy.ok, true)
  return { username, password, async ownedDeviceIds(): Promise<string[]> {
    const response = await fetch(`${serverUrl}/api/v1/organization`, { headers })
    assert.equal(response.ok, true)
    const data = await response.json() as { members: { id: string; deviceIds: string[] }[] }
    return data.members.find(item => item.id === member.id)!.deviceIds
  } }
}
