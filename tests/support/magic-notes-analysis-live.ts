import { safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'

// Read an encrypted snapshot so even corrupt-settings recovery cannot touch user data.
export async function prepareLiveNotesAnalysis(directory: string) {
  const source = process.env.GB_NOTES_LIVE_SETTINGS!
  const original = readFileSync(source)
  const snapshot = join(directory, 'runtime-settings.snapshot.json')
  writeFileSync(snapshot, original)
  const store = new RuntimeSettingsStore(snapshot, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: () => { throw new Error('Live probe must not encrypt credentials') },
    decrypt: value => safeStorage.decryptString(value)
  }, {})
  const settings = await store.getResolvedSettings().finally(() => unlinkSync(snapshot))
  writeFileSync(join(directory, 'preflight.json'), JSON.stringify({
    realCallCount: 0, model: settings.modelName, protocol: settings.modelProtocol,
    supportsImageInput: settings.supportsImageInput,
    authentication: settings.modelAuthentication,
    credentialReadable: Boolean(settings.apiKey),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    defaultModelProfileId: settings.defaultModelProfileId,
    profiles: settings.modelProfiles.map(profile => ({ id: profile.id, model: profile.modelName,
      supportsImageInput: profile.supportsImageInput, credentialReadable: Boolean(profile.apiKey) }))
  }, null, 2))
  if (!settings.supportsImageInput || !settings.modelName ||
      (settings.modelAuthentication !== 'none' && !settings.apiKey)) {
    throw new Error('Persisted default model lacks vision support or readable credentials')
  }
  settings.workspacePath = directory
  const requests: { imageCount: number; images: string[]; text: string; toolCount: number; status?: number }[] = []
  const save = () => writeFileSync(join(directory, 'live-evidence.json'), JSON.stringify({
    model: settings.modelName, protocol: settings.modelProtocol,
    realCallCount: requests.length,
    originalSettingsUnchanged: readFileSync(source).equals(original), requests
  }, null, 2))
  const originalFetch = globalThis.fetch
  const pageCounts = process.env.GB_NOTES_LIVE_PAGES === '8' ? [8] : [1, 8]
  globalThis.fetch = async (input, init) => {
    if (requests.length >= pageCounts.length) throw new Error('Live probe request budget exhausted')
    const body = JSON.parse(String(init?.body))
    const images: string[] = []
    const texts: string[] = []
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const part = value as Record<string, unknown>
      let data: string | undefined
      if (part.type === 'input_image' && typeof part.image_url === 'string') data = part.image_url
      if (part.type === 'image_url') data = (part.image_url as { url?: string })?.url
      if (part.type === 'image' && (part.source as { type?: string })?.type === 'base64') {
        const source = part.source as { media_type: string; data: string }
        data = `data:${source.media_type};base64,${source.data}`
      }
      if (data) images.push(data)
      if (typeof part.text === 'string') texts.push(part.text)
      if (typeof part.content === 'string') texts.push(part.content)
      for (const child of Object.values(part)) {
        if (Array.isArray(child)) child.forEach(visit)
        else if (child && typeof child === 'object') visit(child)
      }
    }
    visit(body.input ?? body.messages)
    const expected = pageCounts[requests.length]
    if (images.length !== expected || (body.tools?.length ?? 0) !== 0) {
      throw new Error(`Unexpected outbound payload: ${images.length} images, ${body.tools?.length ?? 0} tools`)
    }
    const observation = { imageCount: images.length, images: images.map((data, index) => {
      const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
      const name = `request-${requests.length + 1}-page-${index + 1}.png`
      writeFileSync(join(directory, name), bytes)
      return `${name} sha256:${createHash('sha256').update(bytes).digest('hex')}`
    }), text: texts.join('\n'), toolCount: body.tools?.length ?? 0, status: undefined as number | undefined }
    requests.push(observation)
    save()
    const response = await originalFetch(input, init)
    observation.status = response.status
    save()
    return response
  }
  save()
  return { settings, save }
}
