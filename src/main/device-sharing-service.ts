import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { z } from 'zod'
import {
  sharingDeviceSchema, sharingIdSchema, sharingPublicationDraftSchema, sharingPublicationSchema,
  sharingSettingsInputSchema, sharingSettingsSchema,
  type SharingCatalog, type SharingSettings
} from '../shared/device-sharing-contracts'
import { assertSupportedSettingsVersion, isMissingFileError, writeJsonFileAtomically } from './settings-file-utils'

const storedSchema = sharingSettingsSchema.extend({ version: z.literal(1) }).strict()

export class DeviceSharingService {
  private settings?: Promise<SharingSettings>
  private updateQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string, private readonly appVersion: string, private readonly timeoutMs = 10_000) {}

  getSettings(): Promise<SharingSettings> {
    if (!this.settings) {
      this.settings = (async () => {
        try {
          const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
          assertSupportedSettingsVersion(value, 1, version => `Unsupported sharing settings version: ${version}`)
          const stored = storedSchema.parse(value)
          return { deviceId: stored.deviceId, name: stored.name, serverUrl: stored.serverUrl }
        } catch (error) {
          // Never silently replace a saved device identity on a read/parse failure.
          if (!isMissingFileError(error)) throw error
          const settings = { deviceId: randomUUID(), name: hostname(), serverUrl: 'http://127.0.0.1:8787' }
          await writeJsonFileAtomically(this.filePath, { ...settings, version: 1 })
          return settings
        }
      })().catch(error => { this.settings = undefined; throw error })
    }
    return this.settings
  }

  saveSettings(input: unknown): Promise<SharingSettings> {
    const operation = this.updateQueue.then(async () => {
      const patch = sharingSettingsInputSchema.parse(input)
      const current = await this.getSettings()
      const next = { ...current, ...patch, serverUrl: patch.serverUrl.replace(/\/+$/, '') }
      await writeJsonFileAtomically(this.filePath, { ...next, version: 1 })
      this.settings = Promise.resolve(next)
      return next
    })
    this.updateQueue = operation.catch(() => undefined)
    return operation
  }

  private credential(settings: SharingSettings, create = false): Promise<string | undefined> {
    const operation = this.updateQueue.then(async () => {
      const path = `${this.filePath}.credentials`
      let credentials: Record<string, string>
      try { credentials = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).parse(JSON.parse(await readFile(path, 'utf8'))) }
      catch (error) { if (!isMissingFileError(error)) throw error; credentials = {} }
      const key = settings.serverUrl.replace(/\/+$/, '')
      if (!credentials[key] && create) {
        credentials[key] = randomBytes(32).toString('hex')
        // Persist before enrollment: retries/restarts retain the same device proof.
        await writeJsonFileAtomically(path, credentials)
      }
      return credentials[key]
    })
    this.updateQueue = operation.catch(() => undefined)
    return operation
  }

  private async request<T>(settings: SharingSettings, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const credential = await this.credential(settings, path === 'devices/register')
    if (!credential) throw new Error('请先注册此设备。')
    const response = await fetch(`${settings.serverUrl.replace(/\/+$/, '')}/api/v1/device-sharing/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'X-Device-Id': settings.deviceId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { message?: string } | null
      throw new Error(`Sharing HTTP ${response.status}: ${error?.message ?? (response.status === 404 ? '请升级 ShareServer，以支持设备注册策略。' : response.statusText)}`)
    }
    return schema.parse(await response.json())
  }

  async registerDevice() {
    const settings = await this.getSettings()
    return this.request(settings, 'devices/register', sharingDeviceSchema, {
      id: settings.deviceId, name: settings.name, platform: process.platform, appVersion: this.appVersion
    })
  }

  async getCatalog(): Promise<SharingCatalog> {
    const settings = await this.getSettings()
    if (!await this.credential(settings)) return { devices: [], publications: [], registrationStatus: 'unregistered' }
    const identity = await this.request(settings, 'status', sharingDeviceSchema)
    if (identity.registrationStatus !== 'approved') return { devices: [], publications: [], registrationStatus: identity.registrationStatus ?? 'unregistered' }
    const [devices, publications] = await Promise.all([
      this.request(settings, 'devices', z.object({ devices: z.array(sharingDeviceSchema) })),
      this.request(settings, 'publications', z.object({ publications: z.array(sharingPublicationSchema) }))
    ])
    return { ...devices, ...publications, registrationStatus: identity.registrationStatus }
  }

  async publish(input: unknown) {
    const draft = sharingPublicationDraftSchema.parse(input)
    const settings = await this.getSettings()
    return this.request(settings, 'publications', sharingPublicationSchema, {
      ...draft, id: randomUUID(), deviceId: settings.deviceId,
      permissions: draft.kind === 'knowledge' ? draft.permissions : { search: false, read: false, download: false }
    })
  }

  async revoke(input: unknown) {
    const id = sharingIdSchema.parse(input)
    const settings = await this.getSettings()
    const { publications } = await this.request(settings,
      `publications?deviceId=${encodeURIComponent(settings.deviceId)}`,
      z.object({ publications: z.array(sharingPublicationSchema) }))
    if (!publications.some(item => item.id === id && item.deviceId === settings.deviceId)) {
      throw new Error('Publication does not belong to this device ID')
    }
    return this.request(settings, `publications/${encodeURIComponent(id)}/revoke`, sharingPublicationSchema, {})
  }
}
