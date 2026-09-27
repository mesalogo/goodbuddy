import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DocumentsView } from '../../src/renderer/src/knowledge-workspace/DocumentsView'
import { KnowledgeTasksView, type KnowledgeTaskContext } from '../../src/renderer/src/knowledge-workspace/KnowledgeTasksView'
import type { KnowledgeLibrary, KnowledgeTaskItem } from '../../src/renderer/src/knowledge-workspace/types'
import { defaultKnowledgeOntologySettings } from '../../src/shared/knowledge-ontology'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'

const noop = (): void => undefined
const library: KnowledgeLibrary = { id: 'library', name: 'Knowledge library', storageMode: 'managed',
  graphEnabled: false, graphStrategy: 'hybrid', sourceCount: 2, documentCount: 2, indexedDocumentCount: 2,
  ontologySettings: defaultKnowledgeOntologySettings, updatedAt: '2026-09-27T00:00:00Z' }
const sources = [1, 2].map((index) => ({ id: `source-${index}`, libraryId: library.id, name: 'Guide', kind: 'url' as const,
  location: `https://example.com/guide?edition=${index}`, status: 'ready' as const, documentCount: 1 }))
const documents = sources.map((source, index) => ({ id: `document-${index}`, sourceId: source.id, libraryId: library.id,
  name: 'Guide', path: source.location, resultId: 'saved-result', status: 'ready' as const, indexProgress: 100, chunkCount: 12, size: 2048 }))
const task: KnowledgeTaskItem = { id: 'batch', libraryId: library.id, sourceId: sources[0]!.id, documentName: 'Guide import',
  scope: 'source', kind: 'source-sync', stage: 'finalizing', status: 'succeeded', progress: 100,
  attempt: 1, canCancel: false, canRetry: false, createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z' }
const tasks = [task, { ...task, id: 'stage', parentTaskId: task.id, documentName: 'Parsing stage', scope: 'document' as const, kind: 'parsing' as const }]

Object.defineProperty(window, 'goodbuddy', { value: {
  documentParsing: { getResult: async () => ({ id: 'saved-result', fileName: 'Guide', completeness: 'complete', images: [], missingImages: [], warnings: [],
    sections: [{ locator: 'Page 1', content: 'Saved readable content.' }], settings: {}, parsedAt: '2026-09-27T00:00:00Z', durationMs: 100 }) },
  conversations: { listSummaries: async () => [] }, projects: { list: async () => [] }
} })

function Fixture(): React.JSX.Element {
  const [context, setContext] = useState<KnowledgeTaskContext>()
  return <div className="knowledge-page workspace-panel-scroll" style={{ height: '100vh', padding: 24 }}>
    {context ? <><button className="secondary-button" onClick={() => setContext(undefined)}>Documents</button>
      <KnowledgeTasksView context={context} tasks={tasks} onClearContext={() => setContext({})} onCancelTask={noop} onRetryTask={noop} /></>
      : <DocumentsView library={library} documents={documents} sources={sources} tasks={tasks}
        onViewTasks={setContext} onImportDirectory={noop} onImportFiles={noop} onImportUrl={noop}
        onOpenDocumentSource={noop} onPauseSource={noop} onManageChunks={noop} onRemoveSource={noop}
        onRebuildDocument={noop} onRetrySource={noop} onSyncSource={noop} />}
  </div>
}

void i18n.changeLanguage('zh-CN').then(() => createRoot(document.getElementById('root')!).render(<Fixture />))
