import { createRoot } from 'react-dom/client'
import { ChatMessageRow } from '../../src/renderer/src/ChatTimeline'
import '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'

const noop = (): void => undefined
const done = async (): Promise<void> => undefined
const name = 'b4307bf0-b49d-4242-a8ec-cb64d487-long-original-filename.pdf'

Object.defineProperty(window, 'goodbuddy', { value: {
  documentParsing: { getSnapshot: async () => ({ settings: { ocrProvider: 'paddleocr-vl' } }) }
} })

createRoot(document.getElementById('root')!).render(
  <div style={{ width: '100%', maxWidth: 820, padding: 16, margin: 'auto' }}>
    <ChatMessageRow artifactById={new Map()} canRetry={false} conversationId="conversation"
      greeting={false} locale="zh-CN" onArticleRef={noop} onCopyMessage={async () => true}
      onDownloadImage={noop} onOpenCitationContext={done} onOpenCitationSource={done}
      onOpenImage={noop} onRespondApproval={done} onRespondQuestion={done} onRetry={noop}
      message={{ id: 'message', role: 'user', content: '', state: 'complete', createdAt: 0,
        attachments: [{ id: 'asset', resourceId: 'asset', resultId: 'result', name,
          kind: 'text', size: 1024, preview: 'Saved document', completeness: 'complete' }] }} />
  </div>
)
