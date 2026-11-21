import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceFilesPanel } from '../../src/renderer/src/WorkspaceFilesPanel'
import { PageTabs, SegmentedControl } from '../../src/renderer/src/WorkspacePrimitives'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { changeUiLocale } from '../../src/renderer/src/i18n'
import { applyAppearanceTheme } from '../../src/renderer/src/theme'
import { installBundledUiFonts } from '../../src/renderer/src/fonts'
import type { DesktopApi } from '../../src/shared/contracts'
import type { WorkspaceDirectoryListing } from '../../src/shared/assistant-contracts'
import '../../src/renderer/src/styles.css'

type LayoutScenario = { name: string; git: boolean; theme: 'light' | 'dark'; sidebar: number }

const listDirectory = async (path: string): Promise<WorkspaceDirectoryListing> => ({
  path, truncated: false, entries: [
    ...(!path ? [{ name: 'documents', path: 'documents', type: 'directory' as const }] : []),
    ...Array.from({ length: 120 }, (_, index) => {
      const name = `file-${String(index + 1).padStart(3, '0')}-workspace-notes.${index === 0 ? 'toml' : 'md'}`
      return { name, path: path ? `${path}/${name}` : name, type: 'file' as const, modifiedAt: '2026-10-04T10:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z' }
    })
  ]
})
Object.defineProperty(window, 'goodbuddy', { value: {
  workspace: { manage: async (_projectId: string, action: { kind: string }) => {
    if (action.kind === 'branches') return { kind: 'branches', current: 'main', branches: [] }
    throw new Error(`Unexpected fixture action: ${action.kind}`)
  } }
} as unknown as DesktopApi })

function Fixture({ name, git, sidebar }: LayoutScenario): React.JSX.Element {
  const [preview, setPreview] = useState<string>()
  return <UiLocaleProvider initialPreference="en-US">
    <aside className="assistant-sidebar assistant-sidebar--open" data-files-scenario={name}
      style={{ width: sidebar, flexBasis: sidebar, height: '100vh' }}>
      <div className="assistant-sidebar__body">
        <section className="assistant-sidebar__section workspace-files__navigation" hidden={Boolean(preview)}>
          <WorkspaceFilesPanel projectId="files-layout" rootPath="/fixture/workspace"
            isRepository={git} changedFiles={[]}
            onListDirectory={listDirectory} onOpenFile={setPreview}
            onLoadDiff={async () => { throw new Error('Unused diff fixture') }} />
        </section>
        {preview && <section className="assistant-sidebar__section">
          <button id="return-to-files" onClick={() => setPreview(undefined)}>Return to Files</button>
          <p>{preview}</p>
        </section>}
      </div>
    </aside>
  </UiLocaleProvider>
}

function MotionFixture(): React.JSX.Element {
  const [value, setValue] = useState('files')
  return <div style={{ padding: 20 }}>
    <PageTabs ariaLabel="Motion tabs" idPrefix="motion" variant="segmented" value={value} onChange={setValue}
      tabs={[{ id: 'files', label: 'Files' }, { id: 'git', label: 'Git workspace' }]} />
    <SegmentedControl ariaLabel="Motion choices" value={value} onChange={setValue}
      options={[{ value: 'files', label: 'Files' }, { value: 'git', label: 'Git workspace' }]} />
  </div>
}

installBundledUiFonts()
void changeUiLocale('en-US').then(() => {
  const root = createRoot(document.getElementById('root')!)
  Object.assign(window, {
    showSegmentedMotion() { root.render(<MotionFixture />) },
    showFilesLayout(scenario: LayoutScenario) {
      applyAppearanceTheme(scenario.theme)
      root.render(<Fixture key={scenario.name} {...scenario} />)
    }
  })
})
