import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceFilesPanel } from '../../src/renderer/src/WorkspaceFilesPanel'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { changeUiLocale } from '../../src/renderer/src/i18n'
import { applyAppearanceTheme } from '../../src/renderer/src/theme'
import { installBundledUiFonts } from '../../src/renderer/src/fonts'
import type { DesktopApi } from '../../src/shared/contracts'
import type { WorkspaceDirectoryListing } from '../../src/shared/assistant-contracts'
import '../../src/renderer/src/styles.css'

const query = new URLSearchParams(location.search)
const listDirectory = async (path: string): Promise<WorkspaceDirectoryListing> => ({
  path, truncated: false, entries: [
    ...(!path ? [{ name: 'documents', path: 'documents', type: 'directory' as const }] : []),
    ...Array.from({ length: 120 }, (_, index) => {
      const name = `file-${String(index + 1).padStart(3, '0')}-workspace-notes.md`
      return { name, path: path ? `${path}/${name}` : name, type: 'file' as const }
    })
  ]
})
Object.defineProperty(window, 'goodbuddy', { value: {
  workspace: { manage: async (_projectId: string, action: { kind: string }) => {
    if (action.kind === 'branches') return { kind: 'branches', current: 'main', branches: [] }
    throw new Error(`Unexpected fixture action: ${action.kind}`)
  } }
} as unknown as DesktopApi })

function Fixture(): React.JSX.Element {
  const [preview, setPreview] = useState<string>()
  return <UiLocaleProvider initialPreference="en-US">
    <aside className="assistant-sidebar assistant-sidebar--open"
      style={{ width: Number(query.get('sidebar')), flexBasis: Number(query.get('sidebar')), height: '100vh' }}>
      <div className="assistant-sidebar__body">
        <section className="assistant-sidebar__section workspace-files__navigation" hidden={Boolean(preview)}>
          <WorkspaceFilesPanel projectId="files-layout" rootPath="/fixture/workspace"
            isRepository={query.get('git') === 'true'} changedFiles={[]}
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

installBundledUiFonts()
applyAppearanceTheme(query.get('theme') === 'dark' ? 'dark' : 'light')
void changeUiLocale('en-US').then(() => createRoot(document.getElementById('root')!).render(<Fixture />))
