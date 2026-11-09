// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DeviceSharingService } from './device-sharing-service'
import type { SharingDevice, SharingPublication } from '../shared/device-sharing-contracts'
import type { SharingModelCatalog } from '../shared/device-sharing-contracts'
import { RuntimeSettingsStore } from './runtime-settings-store'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function setup(timeout = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-sharing-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const devices: SharingDevice[] = []
  const publications: SharingPublication[] = []
  const models: SharingModelCatalog = { items: [] }
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = []
  let failure = 0
  let stall = false
  const authorizations: (string | undefined)[] = []
  const server = createServer(async (request, response) => {
    if (stall) return
    if (failure) { response.writeHead(failure).end(); return }
    authorizations.push(request.headers.authorization)
    const buffers: Buffer[] = []
    for await (const chunk of request) buffers.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(buffers).toString() || '{}')
    const path = request.url!
    requests.push({ path, method: request.method!, body })
    let value: unknown
    if (path.endsWith('/devices/register')) {
      value = { ...body, registrationStatus: 'approved', registeredAt: '2026-10-01', updatedAt: '2026-10-01' }
      devices.splice(0, devices.length, value as SharingDevice)
    } else if (path.endsWith('/status')) value = devices[0]
    else if (path.endsWith('/devices')) value = { devices }
    else if (path.endsWith('/model-configs')) value = models
    else if (request.method === 'GET') value = { publications }
    else if (path.endsWith('/revoke')) {
      const entry = publications.find(item => path.includes(item.id))!
      entry.status = 'revoked'; value = entry
    } else {
      value = { ...body, status: 'published', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
      publications.push(value as SharingPublication)
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const file = join(directory, 'settings.json')
  const modelSettings = new RuntimeSettingsStore(join(directory, 'models.json'), { isAvailable: () => false, encrypt: () => { throw new Error('unused') }, decrypt: () => { throw new Error('unused') } }, {})
  const service = new DeviceSharingService(file, 'test-version', timeout, modelSettings)
  await service.saveSettings({ name: 'Desktop', serverUrl: url })
  return { service, file, url, requests, publications, devices, models, modelSettings, authorizations, fail: (code: number) => { failure = code }, stall: () => { stall = true } }
}

it('imports both endpoint types, deduplicates and rejects stale releases or server selection', async () => {
  const { service, models, modelSettings, url } = await setup()
  await service.registerDevice()
  const before = await modelSettings.getPublicSettings()
  for (const routeType of ['gateway', 'custom'] as const) models.items.push({ id: routeType, releaseId: 'release', name: routeType,
    version: '1', model: 'chat', baseURL: `http://192.168.0.2/${routeType}/v1`, protocol: 'openai-chat-completions', routeType, authentication: 'client-supplied-api-key' })
  expect(await service.getModelConfigs()).toEqual(models)
  for (const item of models.items) {
    const input = { serverUrl: url, id: item.id, releaseId: item.releaseId }
    expect(await service.importModelConfig(input)).toEqual({ imported: true })
    expect(await service.importModelConfig(input)).toEqual({ imported: false })
    await expect(service.importModelConfig({ ...input, releaseId: 'old' })).rejects.toThrow('重新获取')
    await expect(service.importModelConfig({ ...input, serverUrl: 'http://other.example' })).rejects.toThrow('Server 已改变')
  }
  expect((await modelSettings.getPublicSettings()).modelProfiles).toHaveLength(before.modelProfiles.length + 2)
  models.items = []
  await expect(service.importModelConfig({ serverUrl: url, id: 'gateway', releaseId: 'release' })).rejects.toThrow('重新获取')
})

it('persists one identity across concurrent first reads, saves and restarts without accepting renderer identity', async () => {
  const setupResult = await setup()
  const file = `${setupResult.file}.first-read`
  const url = setupResult.url
  const service = new DeviceSharingService(file, 'test-version')
  const [first, second] = await Promise.all([service.getSettings(), service.getSettings()])
  expect(first.deviceId).toBe(second.deviceId)
  await service.saveSettings({ name: 'Renamed', serverUrl: `${url}/` })
  expect(await new DeviceSharingService(file, 'v2').getSettings()).toEqual({ ...first, name: 'Renamed', serverUrl: url })
  await expect(service.saveSettings({ name: 'Bad', serverUrl: url, deviceId: 'forged' })).rejects.toThrow()
  expect(JSON.parse(await readFile(file, 'utf8')).deviceId).toBe(first.deviceId)
  await writeFile(file, '{broken')
  await expect(new DeviceSharingService(file, 'v2').getSettings()).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('{broken')
})

it('uses the exact HTTP contract for registration, catalog, both publication kinds and own-device revocation', async () => {
  const { service, requests, publications } = await setup()
  const device = await service.registerDevice()
  expect(requests[0]).toEqual({ path: '/api/v1/device-sharing/devices/register', method: 'POST', body: {
    id: device.id, name: 'Desktop', platform: process.platform, appVersion: 'test-version'
  } })
  const draft = { name: 'Knowledge', description: 'Metadata only', kind: 'knowledge', sourceMode: 'server', permissions: { search: true, read: false, download: true } }
  const publication = await service.publish(draft)
  expect(publication).toMatchObject({ ...draft, deviceId: device.id, status: 'published' })
  expect(await service.getCatalog()).toEqual({ devices: [device], publications: [publication], registrationStatus: 'approved' })
  expect(await service.publish({ ...draft, kind: 'capability', sourceMode: 'device' })).toMatchObject({ permissions: { search: false, read: false, download: false } })
  publications.push({ ...publication, id: 'other-publication', deviceId: 'other-device' })
  await expect(service.revoke('other-publication')).rejects.toThrow('does not belong')
  expect(requests.some(item => item.path.includes('other-publication/revoke'))).toBe(false)
  expect(await service.revoke(publication.id)).toMatchObject({ status: 'revoked' })
  expect(requests.at(-2)?.path).toBe(`/api/v1/device-sharing/publications?deviceId=${device.id}`)
  expect(requests.at(-1)).toMatchObject({ path: `/api/v1/device-sharing/publications/${publication.id}/revoke`, method: 'POST', body: {} })
})

it('preserves HTTP failure status and bounds a stalled request', async () => {
  const { service, fail, stall } = await setup(50)
  await service.registerDevice()
  fail(503)
  await expect(service.getCatalog()).rejects.toThrow('HTTP 503')
  fail(0); stall()
  await expect(service.registerDevice()).rejects.toThrow(/timeout/i)
})

it('persists a per-server credential across restart without exposing it in settings', async () => {
  const { service, file, authorizations, url } = await setup()
  expect((await service.getCatalog()).registrationStatus).toBe('unregistered')
  await service.registerDevice()
  const first = authorizations[0]
  expect(first).toMatch(/^Bearer [a-f0-9]{64}$/)
  expect(await service.officeHeaders(url)).toEqual({ Authorization: first, 'X-Device-Id': (await service.getSettings()).deviceId })
  await new DeviceSharingService(file, 'v2').registerDevice()
  expect(authorizations[1]).toBe(first)
  expect(JSON.stringify(await service.getSettings())).not.toContain(first!.slice(7))
  const other = await setup()
  await expect(service.officeHeaders(other.url)).rejects.toThrow()
  await service.saveSettings({ serverUrl: other.url, name: 'Desktop' })
  await service.registerDevice()
  expect(other.authorizations[0]).not.toBe(first)
  await service.saveSettings({ serverUrl: url, name: 'Desktop' })
  await service.registerDevice()
  expect(authorizations.at(-1)).toBe(first)
})

it('returns pending, rejected and disabled status without requesting the protected catalog', async () => {
  const { service, devices, requests } = await setup()
  await service.registerDevice()
  for (const status of ['pending', 'rejected', 'disabled'] as const) {
    devices[0]!.registrationStatus = status
    requests.length = 0
    expect(await service.getCatalog()).toEqual({ devices: [], publications: [], registrationStatus: status })
    expect(requests.map(r => r.path)).toEqual(['/api/v1/device-sharing/status'])
  }
})
