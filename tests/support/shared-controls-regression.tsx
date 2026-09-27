import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { RuntimeCustomizationSection } from '../../src/renderer/src/RuntimeCustomizationSection'
import { DestructiveConfirmActions, PageTabs, SegmentedControl } from '../../src/renderer/src/WorkspacePrimitives'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { applyAppearanceTheme } from '../../src/renderer/src/theme'
import type { DesktopApi } from '../../src/shared/contracts'
import '../../src/renderer/src/styles.css'

Object.defineProperty(window, 'goodbuddy', { value: {
  runtimeCustomization: {
    getSettings: async () => ({ opencode: {}, continue: { defaultPresetId: 'preset', presets: [{
      id: 'preset', name: 'Fixture preset',
      rules: [{ id: 'rule', name: 'Fixture rule', content: 'Rule content', enabled: true }],
      prompts: [{ id: 'prompt', name: 'Fixture prompt', description: 'Prompt description', prompt: 'Prompt content' }]
    }] } }),
    getNativeSnapshot: async () => ({ provider: 'continue', available: true, inventoryStatus: 'available',
      agents: [], tools: [], commands: [], lsp: [], formatters: [], mcpServers: [], skills: [], rules: [], prompts: [], resources: [],
      context: { strategy: 'goodbuddy-summary', manualCompact: true, detail: 'Fixture' } })
  }
} as unknown as DesktopApi })

function Controls({ name }: { name: string }): React.JSX.Element {
  const [tab, setTab] = useState('first')
  const [confirming, setConfirming] = useState<string>()
  return <section data-controls={name} style={{ padding: 12 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {['primary-button', 'secondary-button', 'danger-solid', 'danger-button', 'danger-button danger-button--quiet', 'danger-ghost', 'icon-button', 'danger-ghost icon-button', 'icon-button icon-button--active'].map(className =>
        <button type="button" key={className} className={className} data-button={className}>{className.includes('icon-button') ? 'X' : className}</button>)}
    </div>
    <div className="field">
      <label>Text<input data-input="text" defaultValue="Fixture" /></label>
      <label>Choice<select data-input="select" defaultValue="one"><option value="one">One</option></select></label>
      <label>Content<textarea data-input="textarea" defaultValue="Fixture" /></label>
      <label className="toggle-row"><input data-input="switch" role="switch" type="checkbox" defaultChecked /><span>Switch</span></label>
      <label className="check-field"><input data-input="radio" type="radio" defaultChecked /><span>Radio</span></label>
      <label className="check-field"><input data-input="checkbox" type="checkbox" defaultChecked /><span>Checkbox</span></label>
    </div>
    <label className="assistant-sidebar__browser-address">Address<input data-input="address" defaultValue="example.test" /></label>
    <label className="custom-task-dialog__field">Dialog field<input data-input="dialog" defaultValue="Fixture" /></label>
    <PageTabs ariaLabel={`${name} tabs`} idPrefix={name} value={tab} onChange={setTab}
      tabs={[{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]} />
    <PageTabs ariaLabel={`${name} segmented tabs`} idPrefix={`${name}-segmented`} value={tab} onChange={setTab}
      variant="segmented" tabs={[{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]} />
    <SegmentedControl ariaLabel={`${name} segments`} value="first" onChange={() => {}}
      options={[{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }]} />
    {['conversation-actions', 'workspace-files__menu'].map(menu => <div key={menu} className={menu} style={{ position: 'static' }}>
      <button type="button" aria-label="Delete icon" className="danger-ghost icon-button" data-menu-ghost><Trash2 size={14} aria-hidden="true" /></button>
      <DestructiveConfirmActions confirming={confirming === menu} confirmLabel="Delete fixture" triggerLabel="Delete"
        onRequestConfirm={() => setConfirming(menu)} onCancel={() => setConfirming(undefined)} onConfirm={() => {}} />
    </div>)}
  </section>
}

function Fixture(): React.JSX.Element {
  return <>
    <div className="app-shell" style={{ display: 'block', overflow: 'auto' }}>
      <button id="theme-light" onClick={() => applyAppearanceTheme('light')}>Light</button>
      <button id="theme-dark" onClick={() => applyAppearanceTheme('dark')}>Dark</button>
      <div className="settings-panel" style={{ display: 'block', height: 'auto', maxHeight: 'none', width: '100%' }}>
        <Controls name="settings" />
        <RuntimeCustomizationSection provider="continue" />
      </div>
    </div>
    {createPortal(<div id="portal-controls" style={{ position: 'fixed', inset: 0, overflow: 'auto', display: 'none', background: 'var(--surface-raised)' }}>
      <Controls name="portal" />
    </div>, document.body)}
  </>
}

createRoot(document.getElementById('root')!).render(<UiLocaleProvider initialPreference="zh-CN"><Fixture /></UiLocaleProvider>)
