import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { McpSettingsSection } from './McpSettingsSection'
import i18n from './i18n'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('removes the redundant MCP title and places the custom action in content', async () => {
  const getSnapshot = vi.fn().mockResolvedValue({ mcpServers: [], skills: [] })
  vi.stubGlobal('goodbuddy', { capabilities: { getSnapshot } })
  render(<McpSettingsSection onOpenImageModelSettings={vi.fn()} />)
  await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce())
  expect(
    screen.queryByRole('heading', {
      name: i18n.t('integrations:mcp.title')
    })
  ).not.toBeInTheDocument()
  expect(screen.queryByText(i18n.t('integrations:mcp.description'))).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('integrations:mcp.tabs.custom') }))
  expect(screen.getByText(i18n.t('integrations:mcp.customNotice'))).toBeVisible()
  expect(
    screen.getByRole('button', {
      name: i18n.t('integrations:mcp.addServer')
    })
  ).toBeVisible()
})
