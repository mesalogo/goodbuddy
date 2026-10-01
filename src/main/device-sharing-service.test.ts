// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DeviceSharingService } from './device-sharing-service'
import type { SharingDevice, SharingPublication } from '../shared/device-sharing-contracts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function setup(timeout = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-sharing-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const devices: SharingDevice[] = []
  const publications: SharingPublication[] = []
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = []
  let failure = 0
  let stall = false
  const server = createServer(async (request, response) => {
    if (stall) return
    if (failure) { response.writeHead(failure).end(); return }
    const buffers: Buffer[] = []
    for await (const chunk of request) buffers.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(buffers).toString() || '{}')
    const path = request.url!
    requests.push({ path, method: request.method!, body })
    let value: unknown
    if (path.endsWith('/devices/register')) {
      value = { ...body, registeredAt: '2026-10-01', updatedAt: '2026-10-01' }
      devices.splice(0, devices.length, value as SharingDevice)
    } else if (path.endsWith('/devices')) value = { devices }
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
  const service = new DeviceSharingService(file, 'test-version', timeout)
  await service.saveSettings({ name: 'Desktop', serverUrl: url })
  return { service, file, url, requests, publications, fail: (code: number) => { failure = code }, stall: () => { stall = true } }
}

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
  expect(requests[0]).toEqual({ path: '/api/v1/sharing/devices/register', method: 'POST', body: {
    id: device.id, name: 'Desktop', platform: process.platform, appVersion: 'test-version'
  } })
  const draft = { name: 'Knowledge', description: 'Metadata only', kind: 'knowledge', sourceMode: 'server', permissions: { search: true, read: false, download: true } }
  const publication = await service.publish(draft)
  expect(publication).toMatchObject({ ...draft, deviceId: device.id, status: 'published' })
  expect(await service.getCatalog()).toEqual({ devices: [device], publications: [publication] })
  expect(await service.publish({ ...draft, kind: 'capability', sourceMode: 'device' })).toMatchObject({ permissions: { search: false, read: false, download: false } })
  publications.push({ ...publication, id: 'other-publication', deviceId: 'other-device' })
  await expect(service.revoke('other-publication')).rejects.toThrow('does not belong')
  expect(requests.some(item => item.path.includes('other-publication/revoke'))).toBe(false)
  expect(await service.revoke(publication.id)).toMatchObject({ status: 'revoked' })
  expect(requests.at(-2)?.path).toBe(`/api/v1/sharing/publications?deviceId=${device.id}`)
  expect(requests.at(-1)).toMatchObject({ path: `/api/v1/sharing/publications/${publication.id}/revoke`, method: 'POST', body: {} })
})

it('preserves HTTP failure status and bounds a stalled request', async () => {
  const { service, fail, stall } = await setup(50)
  fail(503)
  await expect(service.getCatalog()).rejects.toThrow('HTTP 503')
  fail(0); stall()
  await expect(service.registerDevice()).rejects.toThrow(/timeout/i)
})
