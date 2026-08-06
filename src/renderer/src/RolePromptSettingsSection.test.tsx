import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantExpert } from '../../shared/assistant-contracts'
import type { DesktopApi } from '../../shared/contracts'
import { RolePromptSettingsSection } from './RolePromptSettingsSection'

const defaultModelProfileId =
  '00000000-0000-4000-8000-000000000501'
const alternateModelProfileId =
  '00000000-0000-4000-8000-000000000502'
const removedModelProfileId =
  '00000000-0000-4000-8000-000000000503'

const baseExpert: AssistantExpert = {
  id: '00000000-0000-4000-8000-000000000511',
  name: '研究专家',
  description: '分析资料',
  systemInstructions: 'Separate evidence from assumptions.',
  routingKeywords: ['研究'],
  enabled: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function installExpertsApi(expert: AssistantExpert) {
  const update = vi.fn<DesktopApi['experts']['update']>(
    async (expertId, input) => ({
      ...expert,
      ...input,
      id: expertId,
      modelProfileId: input.modelProfileId,
      routingKeywords: input.routingKeywords ?? [],
      updatedAt: '2026-08-02T00:00:00.000Z'
    })
  )
  Object.defineProperty(window, 'goodbuddy', {
    configurable: true,
    value: {
      experts: {
        list: vi.fn(async () => [expert]),
        create: vi.fn(),
        update,
        remove: vi.fn()
      }
    } as unknown as DesktopApi
  })
  return { update }
}

describe('RolePromptSettingsSection model connections', () => {
  it('selects an expert connection without exposing connection secrets', async () => {
    const expert = {
      ...baseExpert,
      modelProfileId: alternateModelProfileId
    }
    const { update } = installExpertsApi(expert)
    const profiles = [
      {
        id: defaultModelProfileId,
        name: '默认模型',
        apiKey: 'must-not-appear'
      },
      {
        id: alternateModelProfileId,
        name: '研究模型',
        apiKey: 'another-secret'
      }
    ]

    render(
      <RolePromptSettingsSection
        defaultModelProfileId={defaultModelProfileId}
        modelProfiles={profiles}
        onChanged={vi.fn()}
      />
    )

    const selector = await screen.findByLabelText('角色模型连接')
    expect(selector).toHaveValue(alternateModelProfileId)
    expect(
      screen.getByRole('option', {
        name: '继承默认模型（默认模型）'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/综合模式和专家团队始终继承默认模型/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/must-not-appear|another-secret/)
    ).not.toBeInTheDocument()

    fireEvent.change(selector, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expert.id, {
        name: expert.name,
        description: expert.description,
        systemInstructions: expert.systemInstructions,
        routingKeywords: expert.routingKeywords
      })
    )

    fireEvent.change(selector, {
      target: { value: alternateModelProfileId }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }))
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(
        expert.id,
        expect.objectContaining({
          modelProfileId: alternateModelProfileId
        })
      )
    )
  })

  it('shows the default fallback when a saved connection was removed', async () => {
    installExpertsApi({
      ...baseExpert,
      modelProfileId: removedModelProfileId
    })

    render(
      <RolePromptSettingsSection
        defaultModelProfileId={defaultModelProfileId}
        modelProfiles={[
          { id: defaultModelProfileId, name: '默认模型' }
        ]}
        onChanged={vi.fn()}
      />
    )

    expect(
      await screen.findByText(
        /指定的模型连接已失效，运行时将回退到默认模型“默认模型”/
      )
    ).toBeInTheDocument()
    expect(screen.getByLabelText('角色模型连接')).toHaveValue(
      removedModelProfileId
    )
  })
})
