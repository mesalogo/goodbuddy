import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { McpSettingsSection } from './McpSettingsSection'
import i18n from './i18n'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('defaults Obsidian off and tests draft scope without saving or enabling it', async () => {
  const snapshot = { mcpServers: [], skills: [], obsidian: { vaultPath: '' } }
  const getSnapshot = vi.fn().mockResolvedValue(snapshot)
  const updateObsidianSettings = vi.fn(async (input) => ({ ...snapshot, obsidian: input }))
  const testObsidianConnection = vi.fn().mockResolvedValue({
    vaults: [{ id: 'work', name: 'Work', path: '/notes/work' }], toolCount: 24
  })
  const selectObsidianVault = vi.fn().mockResolvedValue('/notes/work')
  const setBuiltinMcpServerEnabled = vi.fn()
  vi.stubGlobal('goodbuddy', { capabilities: {
    getSnapshot, updateObsidianSettings, testObsidianConnection,
    selectObsidianVault, setBuiltinMcpServerEnabled
  } })
  render(<McpSettingsSection onOpenImageModelSettings={vi.fn()} />)
  const testButton = screen.getByRole('button', { name: i18n.t('integrations:mcp.obsidian.test') })
  await waitFor(() => expect(testButton).toBeEnabled())
  expect(screen.getByRole('switch', { name: i18n.t('integrations:mcp.builtin.enableAriaLabel', { name: 'Obsidian' }) })).not.toBeChecked()
  fireEvent.click(testButton)
  await waitFor(() => {
    expect(testObsidianConnection).toHaveBeenCalledWith({ vaultPath: '' })
    expect(screen.getByText('/notes/work')).toBeVisible()
    expect(testButton).toBeEnabled()
  })
  expect(updateObsidianSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('integrations:mcp.obsidian.select') }))
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: i18n.t('integrations:mcp.obsidian.path') })).toHaveValue('/notes/work')
    expect(testButton).toBeEnabled()
  })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('integrations:mcp.editor.save') }))
  await waitFor(() => {
    expect(updateObsidianSettings).toHaveBeenCalledWith({ vaultPath: '/notes/work' })
    expect(screen.getByText(i18n.t('integrations:mcp.obsidian.savedScope', { path: '/notes/work' }))).toBeVisible()
    expect(testButton).toBeEnabled()
  })
  fireEvent.change(screen.getByRole('combobox', { name: i18n.t('integrations:mcp.obsidian.scope') }), { target: { value: 'all' } })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('integrations:mcp.editor.save') }))
  await waitFor(() => {
    expect(updateObsidianSettings).toHaveBeenLastCalledWith({ vaultPath: '' })
    expect(testButton).toBeEnabled()
  })
  expect(setBuiltinMcpServerEnabled).not.toHaveBeenCalled()
})

it.each(['loaded', 'saved'] as const)('keeps a %s specified vault selected when its draft path is cleared', async (source) => {
  const snapshot = { mcpServers: [], skills: [], obsidian: { vaultPath: '/notes/original' } }
  const updateObsidianSettings = vi.fn(async (input) => ({ ...snapshot, obsidian: input }))
  const testObsidianConnection = vi.fn().mockResolvedValue({
    vaults: [{ id: 'work', name: 'Work', path: '/notes/discovered' }], toolCount: 24
  })
  vi.stubGlobal('goodbuddy', { capabilities: {
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    updateObsidianSettings, testObsidianConnection
  } })
  render(<McpSettingsSection onOpenImageModelSettings={vi.fn()} />)
  const input = await screen.findByRole('textbox', { name: i18n.t('integrations:mcp.obsidian.path') })
  const scope = screen.getByRole('combobox', { name: i18n.t('integrations:mcp.obsidian.scope') })
  const saveButton = screen.getByRole('button', { name: i18n.t('integrations:mcp.editor.save') })
  const testButton = screen.getByRole('button', { name: i18n.t('integrations:mcp.obsidian.test') })
  const savedPath = source === 'saved' ? '/notes/saved' : '/notes/original'
  if (source === 'saved') {
    fireEvent.change(input, { target: { value: savedPath } })
    fireEvent.click(saveButton)
    await waitFor(() => {
      expect(updateObsidianSettings).toHaveBeenCalledWith({ vaultPath: savedPath })
      expect(screen.getByText(i18n.t('integrations:mcp.obsidian.savedScope', { path: savedPath }))).toBeVisible()
      expect(saveButton).toBeEnabled()
    })
    updateObsidianSettings.mockClear()
  }
  fireEvent.click(testButton)
  await waitFor(() => {
    expect(screen.getByText('/notes/discovered')).toBeVisible()
    expect(testButton).toBeEnabled()
  })
  testObsidianConnection.mockClear()
  fireEvent.change(input, { target: { value: '' } })
  expect(scope).toHaveValue('folder')
  expect(input).toBeVisible()
  expect(input).toHaveValue('')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  for (const button of [saveButton, testButton]) {
    fireEvent.click(button)
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('integrations:mcp.obsidian.folderRequired'))
      expect(scope).toHaveValue('folder')
      expect(input).toBeVisible()
      expect(input).toHaveValue('')
      expect(screen.getByText(i18n.t('integrations:mcp.obsidian.savedScope', { path: savedPath }))).toBeVisible()
      expect(button).toBeEnabled()
    })
  }
  expect(updateObsidianSettings).not.toHaveBeenCalled()
  expect(testObsidianConnection).not.toHaveBeenCalled()
})

it('clears Obsidian connection results when changing scope', async () => {
  const testObsidianConnection = vi.fn().mockResolvedValue({
    vaults: [{ id: 'work', name: 'Work', path: '/notes/discovered' }], toolCount: 24
  })
  vi.stubGlobal('goodbuddy', { capabilities: {
    getSnapshot: vi.fn().mockResolvedValue({ mcpServers: [], skills: [], obsidian: { vaultPath: '/notes/work' } }),
    testObsidianConnection
  } })
  render(<McpSettingsSection onOpenImageModelSettings={vi.fn()} />)
  const testButton = screen.getByRole('button', { name: i18n.t('integrations:mcp.obsidian.test') })
  await waitFor(() => expect(testButton).toBeEnabled())
  fireEvent.click(testButton)
  await waitFor(() => {
    expect(screen.getByText('/notes/discovered')).toBeVisible()
    expect(testButton).toBeEnabled()
  })
  fireEvent.change(screen.getByRole('combobox', { name: i18n.t('integrations:mcp.obsidian.scope') }), { target: { value: 'all' } })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: i18n.t('integrations:mcp.obsidian.path') })).not.toBeInTheDocument()
})

it('preserves the Obsidian draft after failures and folder-picker cancellation', async () => {
  const selectObsidianVault = vi.fn().mockResolvedValue(null)
  const updateObsidianSettings = vi.fn().mockRejectedValue(new Error('Disk unavailable'))
  vi.stubGlobal('goodbuddy', { capabilities: {
    getSnapshot: vi.fn().mockResolvedValue({ mcpServers: [], skills: [], obsidian: { vaultPath: '/notes/original' } }),
    selectObsidianVault, updateObsidianSettings
  } })
  render(<McpSettingsSection onOpenImageModelSettings={vi.fn()} />)
  const input = await screen.findByRole('textbox', { name: i18n.t('integrations:mcp.obsidian.path') })
  fireEvent.change(input, { target: { value: '/notes/draft' } })
  const selectButton = screen.getByRole('button', { name: i18n.t('integrations:mcp.obsidian.select') })
  fireEvent.click(selectButton)
  await waitFor(() => {
    expect(selectObsidianVault).toHaveBeenCalledOnce()
    expect(selectButton).toBeEnabled()
    expect(input).toHaveValue('/notes/draft')
  })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('integrations:mcp.editor.save') }))
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent('Disk unavailable')
    expect(input).toHaveValue('/notes/draft')
    expect(selectButton).toBeEnabled()
  })
})

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
