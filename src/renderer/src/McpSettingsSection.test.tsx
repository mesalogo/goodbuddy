import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { McpSettingsSection } from './McpSettingsSection'
import i18n from './i18n'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('moves the MCP introduction to title help and retains the custom server notice', async () => {
  const getSnapshot = vi.fn().mockResolvedValue({ mcpServers: [], skills: [] })
  vi.stubGlobal('goodbuddy', { capabilities: { getSnapshot } })
  render(<McpSettingsSection onOpenImageModelSettings={vi.fn()} />)
  await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce())
  expect(screen.getByRole('heading', { name: i18n.t('integrations:mcp.title') }).closest('header')?.querySelector('p')).toBeNull()
  expect(screen.queryByText(i18n.t('integrations:mcp.description'))).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('integrations:mcp.title') }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(i18n.t('integrations:mcp.description'))
  expect(screen.getByRole('tooltip').querySelector('button')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: i18n.t('integrations:mcp.tabs.custom') }))
  expect(screen.getByText(i18n.t('integrations:mcp.customNotice'))).toBeVisible()
})
