import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi, KnowledgeLibrary, KnowledgeSnapshot } from '../../shared/contracts'
import type { ExternalKnowledgeInstanceSummary, ExternalKnowledgeCatalogPage } from '../../shared/external-knowledge-contracts'
import { ExternalBindingForm, ExternalInstanceManager, ExternalLibraryDetail, externalProviderDefaults } from './ExternalKnowledge'
import i18n from './i18n'

const instance: ExternalKnowledgeInstanceSummary = { id: 'instance-1', name: 'Company knowledge', provider: 'dify', baseUrl: 'https://knowledge.example', enabled: true, credentialStatus: 'configured', probeStatus: 'healthy', bindingCount: 0 }
const library: KnowledgeLibrary = { id: 'external-1', name: 'Handbook', description: '', storageMode: 'managed', graphEnabled: false, graphStrategy: 'model', sourceCount: 0, documentCount: 0, indexedDocumentCount: 0, external: { knowledgeBaseId: 'external-1', instanceId: instance.id, provider: 'dify', remoteKnowledgeBaseId: 'remote-1', remoteName: 'Handbook', commonConfig: { resultLimit: 6, requestTimeoutMs: 15000, maxSnippetCharacters: 4000 }, providerConfig: externalProviderDefaults('dify'), lastVerifiedAt: '2026-09-12' } }
const snapshot: KnowledgeSnapshot = { libraries: [library], sources: [], documents: [], graphNodes: [], graphRelations: [], evidence: [] }
const bridge = {
  externalCatalogList: vi.fn(async (): Promise<ExternalKnowledgeCatalogPage> => ({ items: [{ id: 'remote-1', name: 'Handbook' }], hasMore: false })),
  externalCatalogGet: vi.fn(async () => ({ id: 'remote-1', name: 'Handbook' })),
  externalRetrievalTest: vi.fn(async () => ({ results: [], durationMs: 10 })),
  externalBindingsCreate: vi.fn(async () => snapshot),
  externalBindingsUpdate: vi.fn(async () => snapshot),
  externalInstancesSave: vi.fn(async () => instance),
  externalInstancesTest: vi.fn(async () => instance),
  externalInstancesDelete: vi.fn(async () => undefined),
  deleteLibrary: vi.fn<(id: string) => Promise<KnowledgeSnapshot>>(async () => snapshot)
}
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en-US')
  window.goodbuddy = { knowledge: bridge } as unknown as DesktopApi
})
afterEach(() => { cleanup(); void i18n.changeLanguage('zh-CN') })
function selectInstance(index = 0): void {
  fireEvent.click(screen.getByRole('button', { name: 'External instance' }))
  fireEvent.click(screen.getAllByRole('menuitemradio')[index]!)
}

describe('external knowledge workflows', () => {
  it('navigates the rich instance menu, skips disabled items and restores focus', async () => {
    render(<ExternalBindingForm provider="dify" instances={[instance, { ...instance, id: 'disabled', name: 'Disabled service', enabled: false }, { ...instance, id: 'other', name: 'Other service' }]} libraries={[]} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'External instance' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = screen.getByRole('menu')
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /Company knowledge/ })).toHaveFocus())
    expect(screen.getByRole('menuitemradio', { name: /Disabled service/ })).toBeDisabled()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitemradio', { name: /Other service/ })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(screen.getByRole('menuitemradio', { name: /Company knowledge/ })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Other service/ }))
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: /Other service/ })).toHaveFocus())
    expect(screen.getByRole('menuitemradio', { name: /Other service/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('offers clear search and manual entry for distinct empty catalog states', async () => {
    bridge.externalCatalogList.mockResolvedValueOnce({ items: [], hasMore: false }).mockResolvedValueOnce({ items: [], hasMore: false })
    render(<ExternalBindingForm provider="dify" instances={[instance]} libraries={[]} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    selectInstance()
    expect((await screen.findByText('No accessible libraries in this instance')).closest('.empty-state')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search remote libraries'), { target: { value: 'missing' } })
    expect((await screen.findByText('No matching results')).closest('.empty-state')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByLabelText('Search remote libraries')).toHaveValue('')
    await screen.findByRole('button', { name: /Handbook/ })
  })

  it('can dismiss an instance menu when every instance is disabled', () => {
    render(<ExternalBindingForm provider="dify" instances={[{ ...instance, enabled: false }]} libraries={[]} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'External instance' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitemradio')).toBeDisabled()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('labels saving separately from testing and formats verification timestamps', async () => {
    let finish!: (value: KnowledgeSnapshot) => void
    bridge.externalBindingsUpdate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<ExternalLibraryDetail library={library} instances={[instance]} libraries={[library]} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} onUseInChat={vi.fn()} />)
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-09-12')
    expect(document.querySelector('time')).not.toHaveTextContent('2026-09-12')
    fireEvent.click(screen.getByRole('tab', { name: 'Retrieval settings' }))
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save retrieval settings' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save retrieval settings' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Test retrieval' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Testing…' })).not.toBeInTheDocument()
    await act(async () => finish(snapshot))
  })

  it('keeps external tabs and filters from shrinking in the scrolling workspace', () => {
    const css = readFileSync('src/renderer/src/external-knowledge.css', 'utf8')
    expect(css).toMatch(/\.external-knowledge > \.page-tabs\s*\{[^}]*flex: 0 0 auto/)
    expect(css).toMatch(/\.external-knowledge__filters\s*\{[^}]*flex: 0 0 auto/)
    expect(css).toMatch(/\.external-knowledge-modal__surface\s*\{[^}]*width: min\(560px, 100%\)/)
    expect(css).toMatch(/\.external-knowledge__footer\s*\{[^}]*position: sticky/)
    expect(css).toMatch(/\.external-knowledge \.external-knowledge\s*\{[^}]*overflow: visible/)
    expect(css).not.toMatch(/\.external-knowledge__catalog\s*\{[^}]*overflow: auto/)
    expect(css).toContain(".external-knowledge__target:hover:not(:disabled):not([aria-pressed='true'])")
    expect(css).toMatch(/\.external-knowledge__fieldset :is\(input, select, textarea, summary\)\s*\{[^}]*scroll-margin-block:/)
  })

  it('uses shared fields in the portal with one create credential and an adjacent visibility button', async () => {
    const view = render(<ExternalInstanceManager instances={[]} libraries={[]} onClose={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add instance' }))
    const dialog = screen.getByRole('dialog', { name: 'Add instance' })
    expect(view.container).not.toContainElement(dialog)
    expect(screen.getByLabelText('Name').closest('label')).toHaveClass('field')
    expect(screen.getByLabelText('Provider').closest('label')).toHaveClass('field')
    expect(screen.queryByLabelText('Saved credential')).not.toBeInTheDocument()
    const key = screen.getByLabelText('API Key')
    expect(key).toHaveAttribute('type', 'password')
    const reveal = screen.getByRole('button', { name: 'Show credential' })
    expect(key.parentElement).toContainElement(reveal)
    fireEvent.click(reveal)
    expect(key).toHaveAttribute('type', 'text')
    fireEvent.click(screen.getByRole('button', { name: 'Hide credential' }))
    expect(key).toHaveAttribute('type', 'password')
    const enabled = screen.getByRole('switch')
    expect(enabled.previousElementSibling).toHaveTextContent('Enable instance')
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'https://knowledge.example' } })
    expect(screen.queryByText(/without transport encryption/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'http://knowledge.example' } })
    expect(screen.getByLabelText('Service URL')).toHaveAccessibleDescription('This HTTP address sends credentials and queries without transport encryption.')
    expect(screen.getByText('How to test the connection').closest('details')).not.toHaveAttribute('open')
  })

  it('blocks duplicate manual IDs before sending a retrieval request', async () => {
    render(<ExternalBindingForm provider="dify" instances={[instance]} libraries={[library]} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    selectInstance()
    fireEvent.click(screen.getByRole('button', { name: 'Enter library ID manually' }))
    fireEvent.change(screen.getByLabelText('Remote library ID'), { target: { value: ' remote-1 ' } })
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Already added')
    expect(screen.getByRole('button', { name: 'Test retrieval' })).toBeDisabled()
    expect(bridge.externalRetrievalTest).not.toHaveBeenCalled()
  })

  it('discards earlier success when a retest fails or the instance changes', async () => {
    const props = { provider: 'dify' as const, instances: [instance], libraries: [], onCancel: vi.fn(), onChanged: vi.fn(), notify: vi.fn(), onManage: vi.fn() }
    const view = render(<ExternalBindingForm {...props} />)
    selectInstance()
    fireEvent.click(await screen.findByRole('button', { name: /Handbook/ }))
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add library' })).toBeEnabled())
    bridge.externalRetrievalTest.mockRejectedValueOnce(new Error('Remote timeout'))
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Remote timeout')
    expect(screen.getByRole('button', { name: 'Add library' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add library' })).toBeEnabled())
    view.rerender(<ExternalBindingForm {...props} instances={[{ ...instance, baseUrl: 'https://other.example' }]} />)
    expect(screen.getByRole('button', { name: 'Add library' })).toBeDisabled()
  })

  it('rebinds a manual target without retaining the previous remote name', async () => {
    bridge.externalCatalogGet.mockRejectedValueOnce(new Error('No detail endpoint')).mockRejectedValueOnce(new Error('No detail endpoint'))
    render(<ExternalBindingForm provider="dify" instances={[instance]} libraries={[library]} library={library} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enter library ID manually' }))
    fireEvent.change(screen.getByLabelText('Remote library ID'), { target: { value: 'new-target' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New target name' } })
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await screen.findByText(/Retrieval succeeded with 0 snippets/)
    expect(screen.getByRole('button', { name: 'Save retrieval settings' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save retrieval settings' }))
    await waitFor(() => expect(bridge.externalBindingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseId: library.id, remoteKnowledgeBaseId: 'new-target', remoteName: 'New target name' })))
  })

  it('allows disabling saved RAGFlow capabilities that are no longer available', async () => {
    const ragLibrary = { ...library, external: { ...library.external!, provider: 'ragflow' as const, providerConfig: { provider: 'ragflow' as const, similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, knnTopK: 1024, useKg: true, includeKnowledgeCompilation: true } } }
    render(<ExternalBindingForm provider="ragflow" instances={[{ ...instance, provider: 'ragflow' }]} libraries={[ragLibrary]} library={ragLibrary} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Graph retrieval' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Include Knowledge Compilation' }))
    expect(screen.getByRole('switch', { name: 'Graph retrieval' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Graph retrieval' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await waitFor(() => expect(bridge.externalRetrievalTest).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: expect.objectContaining({ useKg: false, includeKnowledgeCompilation: false }) })))
  })

  it('clears incomplete hidden Dify reranking fields when reranking is disabled', async () => {
    render(<ExternalBindingForm provider="dify" instances={[instance]} libraries={[library]} library={library} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Use dataset defaults' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Rerank' }))
    fireEvent.change(screen.getByLabelText('Reranking provider'), { target: { value: 'provider' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Rerank' }))
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    expect(screen.getByRole('button', { name: 'Test retrieval' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await waitFor(() => expect(bridge.externalRetrievalTest).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: expect.objectContaining({ retrievalModel: expect.objectContaining({ reranking_enable: false, reranking_model: undefined }) }) })))
  })

  it('requires explicit credential clearing and retains the saved credential by default', async () => {
    render(<ExternalInstanceManager instances={[instance]} libraries={[library]} onClose={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Saved credential')).toHaveValue('keep')
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Saved credential'), { target: { value: 'replace' } })
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Saved credential'), { target: { value: 'clear' } })
    expect(screen.getByRole('button', { name: 'Save instance' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save instance' }))
    await waitFor(() => expect(bridge.externalInstancesSave).toHaveBeenCalledWith(expect.objectContaining({ id: instance.id, credential: { action: 'clear' } })))
  })

  it('accepts the FastGPT API token range and restores defaults only in the draft', async () => {
    const fastLibrary = { ...library, external: { ...library.external!, provider: 'fastgpt' as const, providerConfig: externalProviderDefaults('fastgpt') } }
    render(<ExternalBindingForm provider="fastgpt" instances={[{ ...instance, provider: 'fastgpt' }]} libraries={[fastLibrary]} library={fastLibrary} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Token limit'), { target: { value: '30000' } })
    expect(screen.getByLabelText('Token limit')).toBeValid()
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await screen.findByText(/Retrieval succeeded with 0 snippets/)
    expect(bridge.externalRetrievalTest).toHaveBeenCalledWith(expect.objectContaining({ providerConfig: expect.objectContaining({ tokenLimit: 30000 }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    expect(screen.getByLabelText('Token limit')).toHaveValue(5000)
    expect(screen.getByRole('button', { name: 'Save retrieval settings' })).toBeDisabled()
    expect(bridge.externalBindingsUpdate).not.toHaveBeenCalled()
    expect(bridge.externalInstancesSave).not.toHaveBeenCalled()
    expect(screen.getByText(/Settings are saved only in GoodBuddy/)).toBeInTheDocument()
  })

  it('refreshes completed removals after a later binding deletion fails', async () => {
    const onChanged = vi.fn()
    bridge.deleteLibrary.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('Binding removal failed'))
    render(<ExternalInstanceManager instances={[{ ...instance, bindingCount: 2 }]} libraries={[library, { ...library, id: 'external-2', name: 'Second binding' }]} onClose={vi.fn()} onChanged={onChanged} notify={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Delete instance “Company knowledge”?')
    expect(screen.getByRole('button', { name: 'Delete instance and local bindings' })).toHaveClass('danger-button')
    expect(screen.getByText('Handbook')).toBeInTheDocument()
    expect(screen.getByText('Second binding')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Cancel' }).find(button => button.textContent === 'Cancel')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Delete instance and local bindings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Binding removal failed')
    expect(onChanged).toHaveBeenCalledOnce()
    expect(bridge.externalInstancesDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete instance and local bindings' })).toBeEnabled()
  })

  it('prevents retrieval through disabled instances', () => {
    render(<ExternalLibraryDetail library={library} libraries={[library]} instances={[{ ...instance, enabled: false }]} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} onUseInChat={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Test retrieval' }))
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'query' } })
    expect(screen.getByRole('button', { name: 'Test retrieval' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Instance disabled')
  })

  it.each(['dify', 'fastgpt', 'ragflow'] as const)('creates a %s binding after a zero-result retrieval', async provider => {
    const onChanged = vi.fn()
    render(<ExternalBindingForm provider={provider} instances={[{ ...instance, provider }]} libraries={[]} onCancel={vi.fn()} onChanged={onChanged} notify={vi.fn()} onManage={vi.fn()} />)
    for (const control of document.querySelectorAll('input:not([type="checkbox"]), select, textarea')) {
      expect(control.closest('label')).toHaveClass('field')
    }
    for (const toggle of screen.getAllByRole('switch')) {
      expect(toggle.previousElementSibling?.tagName).toBe('SPAN')
      expect(toggle.closest('label')).toHaveClass('toggle-row')
    }
    selectInstance()
    fireEvent.click(await screen.findByRole('button', { name: /Handbook/ }))
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'network policy' } })
    expect(screen.getByRole('button', { name: 'Add library' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add library' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Add library' }))
    await waitFor(() => expect(bridge.externalBindingsCreate).toHaveBeenCalledWith(expect.objectContaining({ instanceId: instance.id, remoteKnowledgeBaseId: 'remote-1', testQuery: 'network policy', providerConfig: expect.objectContaining({ provider }) })))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(snapshot, library.id))
  })

  it('retains a manual target and query after retrieval fails', async () => {
    bridge.externalRetrievalTest.mockRejectedValueOnce(new Error('Authentication failed'))
    render(<ExternalBindingForm provider="dify" instances={[instance]} libraries={[]} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    selectInstance()
    fireEvent.click(screen.getByRole('button', { name: 'Enter library ID manually' }))
    fireEvent.change(screen.getByLabelText('Remote library ID'), { target: { value: 'manual-id' } })
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'keep this query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication failed')
    expect(screen.getByLabelText('Remote library ID')).toHaveValue('manual-id')
    expect(screen.getByLabelText('Test query')).toHaveValue('keep this query')
  })

  it('ignores an old catalog when the instance changes', async () => {
    let resolve!: (page: ExternalKnowledgeCatalogPage) => void
    bridge.externalCatalogList.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    render(<ExternalBindingForm provider="dify" instances={[instance, { ...instance, id: 'instance-2' }]} libraries={[]} onCancel={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} />)
    selectInstance()
    await waitFor(() => expect(bridge.externalCatalogList).toHaveBeenCalledOnce())
    selectInstance(1)
    await screen.findByRole('button', { name: /Handbook/ })
    await act(async () => resolve({ items: [{ id: 'old', name: 'Stale catalog' }], hasMore: false }))
    expect(screen.queryByText('Stale catalog')).not.toBeInTheDocument()
  })

  it('tests saved configuration without exposing save or target editing in the test tab', async () => {
    render(<ExternalLibraryDetail library={library} libraries={[library]} instances={[instance]} onChanged={vi.fn()} notify={vi.fn()} onManage={vi.fn()} onUseInChat={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Test retrieval' }))
    expect(screen.queryByRole('button', { name: 'Save retrieval settings' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('External instance')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Test query'), { target: { value: 'saved config query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test retrieval' }))
    await screen.findByText(/Retrieval succeeded with 0 snippets/)
    expect(bridge.externalBindingsUpdate).not.toHaveBeenCalled()
    expect(bridge.externalRetrievalTest).toHaveBeenCalledWith(expect.objectContaining({ commonConfig: library.external!.commonConfig, providerConfig: library.external!.providerConfig }))
  })

  it('saves an instance without an all-address consent gate and preserves failed drafts', async () => {
    bridge.externalInstancesSave.mockRejectedValueOnce(new Error('Save failed'))
    render(<ExternalInstanceManager instances={[]} libraries={[]} onClose={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add instance' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Company' } })
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'https://knowledge.example' } })
    fireEvent.change(screen.getAllByLabelText('API Key').find(element => element.tagName === 'INPUT')!, { target: { value: 'test-key' } })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save instance' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save instance' })).toBeEnabled())
    expect(screen.getByLabelText('Service URL')).toHaveValue('https://knowledge.example')
  })
})
