import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('file entry Office dispatch', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear() })
  it('retains a file reference without uploading when no server is configured', async () => {
    const open = vi.fn()
    window.goodbuddy = { office: { open } } as unknown as typeof window.goodbuddy
    const { officeStore } = await import('./office-store')
    const source = { kind: 'workspace' as const, projectId: 'project', path: 'result.docx' }
    officeStore.requestOpen(source, 'result.docx')
    expect(officeStore.get(officeStore.getOpenRequest()!.instanceId).source).toEqual(source)
    expect(open).not.toHaveBeenCalled()
  })
  it('automatically opens through the configured server and deduplicates an in-flight file', async () => {
    localStorage.setItem('goodbuddy.office.serverUrl', 'http://192.168.0.23:8088')
    let complete!: (value: null) => void
    const open = vi.fn(() => new Promise<null>(resolve => { complete = resolve }))
    window.goodbuddy = { office: { open } } as unknown as typeof window.goodbuddy
    const { officeStore } = await import('./office-store')
    const source = { kind: 'workspace' as const, projectId: 'project', path: 'result.docx' }
    officeStore.requestOpen(source, 'result.docx')
    const id = officeStore.getOpenRequest()!.instanceId
    officeStore.requestOpen(source, 'result.docx')
    expect(officeStore.getOpenRequest()!.instanceId).toBe(id)
    expect(open).toHaveBeenCalledExactlyOnceWith({ instanceId: id, source, serverUrl: 'http://192.168.0.23:8088' })
    complete(null)
    await vi.waitFor(() => expect(officeStore.get(id).busy).toBe(false))
  })
  it('keeps the original source for retry when the service rejects Office editing', async () => {
    localStorage.setItem('goodbuddy.office.serverUrl', 'http://192.168.0.23:8088')
    const open = vi.fn().mockRejectedValue(new Error('Office 未启用'))
    window.goodbuddy = { office: { open } } as unknown as typeof window.goodbuddy
    const { officeStore } = await import('./office-store')
    const source = { kind: 'attachment' as const, resourceId: 'resource' }
    officeStore.requestOpen(source, 'report.docx')
    const id = officeStore.getOpenRequest()!.instanceId
    await vi.waitFor(() => expect(officeStore.get(id).error).toContain('Office 未启用'))
    expect(officeStore.get(id).source).toEqual(source)
    expect(officeStore.get(id).session).toBeUndefined()
  })
})
