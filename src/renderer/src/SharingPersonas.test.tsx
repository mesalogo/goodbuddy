import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SharingPersonas } from './SharingPersonas'
import type { PersonaCatalog, PersonaDraft, SharingPersonasApi } from '../../shared/sharing-personas'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('publishes optional-knowledge configuration, chats and withdraws using the returned revision', async () => {
  const catalog: PersonaCatalog = { personas: [], canCreate: true, models: [{ id: 'model', alias: 'Test' }], sources: [], subjects: { members: [], groups: [] } }
  const api: SharingPersonasApi = {
    getPersonas: vi.fn(async () => structuredClone(catalog)),
    savePersona: vi.fn(async (draft: PersonaDraft) => { const persona = { ...draft, id: 'persona', revision: 1, ownerId: 'device:desktop', sourceDeviceId: 'desktop', sourceDeviceName: 'Desktop', origin: 'device' as const, execution: 'server' as const, canManage: true, canEdit: true, createdAt: 'today', updatedAt: 'today' }; catalog.personas = [persona]; return persona }),
    transitionPersona: vi.fn(async input => { const persona = catalog.personas[0]!; persona.status = 'revoked'; persona.revision = input.revision + 1; return persona }),
    chatPersona: vi.fn(async () => ({ answer: 'Hosted answer', model: 'Test', aiGenerated: true as const, sources: [] })),
    cancelPersonaChat: vi.fn(async () => undefined)
  }
  vi.stubGlobal('goodbuddy', { sharing: api })
  render(<SharingPersonas serverUrl="http://192.168.0.23:8088" deviceId="desktop" notify={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '创建共享分身' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '创建共享分身' }))
  fireEvent.change(screen.getByLabelText('分身名称'), { target: { value: 'Helper' } })
  fireEvent.change(screen.getByLabelText('角色与回答规则'), { target: { value: 'Be helpful' } })
  fireEvent.change(screen.getByLabelText('服务器执行模型'), { target: { value: 'model' } })
  fireEvent.change(screen.getByLabelText('发布状态'), { target: { value: 'published' } })
  fireEvent.click(screen.getByRole('button', { name: '保存分身配置' }))
  await screen.findByRole('button', { name: '与分身对话' })
  expect(api.savePersona).toHaveBeenCalledWith(expect.objectContaining({ name: 'Helper', sourceIds: [], status: 'published' }))
  fireEvent.click(screen.getByRole('button', { name: '与分身对话' }))
  fireEvent.change(screen.getByLabelText('向分身提问'), { target: { value: 'Hello' } })
  fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
  await screen.findByText('Hosted answer')
  fireEvent.click(screen.getByRole('button', { name: '撤回共享' }))
  fireEvent.click(screen.getByRole('button', { name: '确认撤回分身' }))
  await waitFor(() => expect(api.transitionPersona).toHaveBeenCalledWith({ id: 'persona', revision: 1, action: 'revoke' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '与分身对话' })).toBeDisabled())
})
