import { expect, it, vi } from 'vitest'
import { createSharingPersonasStore } from './sharing-personas-store'
import type { PersonaAnswer, SharingPersonasApi } from '../../shared/sharing-personas'

it('cancels the actual IPC operation and discards its late answer', async () => {
  let resolve!: (answer: PersonaAnswer) => void
  const api = { chatPersona: vi.fn(() => new Promise<PersonaAnswer>(done => { resolve = done })), cancelPersonaChat: vi.fn(async () => undefined) } as unknown as SharingPersonasApi
  const store = createSharingPersonasStore(api)
  const pending = store.chat('persona', 'Hello')
  await vi.waitFor(() => expect(api.chatPersona).toHaveBeenCalledOnce())
  await store.cancel()
  expect(api.cancelPersonaChat).toHaveBeenCalledWith(expect.any(String))
  resolve({ answer: 'Late answer', model: 'test', aiGenerated: true, sources: [] })
  await pending
  expect(store.getState()).toMatchObject({ asking: false, answer: undefined })
})

it('does not overwrite a newer catalog with an older refresh', async () => {
  const empty = { personas: [], canCreate: true, models: [], sources: [], subjects: { members: [], groups: [] } }
  let resolve!: (catalog: typeof empty) => void
  const api = { getPersonas: vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce({ ...empty, canCreate: false }) } as unknown as SharingPersonasApi
  const store = createSharingPersonasStore(api)
  const first = store.load(); await store.load(); resolve(empty); await first
  expect(store.getState().catalog?.canCreate).toBe(false)
})
