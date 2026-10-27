import React, { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { OfficePanel } from '../../src/renderer/src/OfficePanel'
import { officeStore } from '../../src/renderer/src/office-store'
function Probe(): React.JSX.Element {
  const request = useSyncExternalStore(officeStore.subscribe, officeStore.getOpenRequest)
  return <>
    <button onClick={() => officeStore.requestOpen({ kind: 'workspace', projectId: '10000000-0000-4000-8000-000000000001', path: 'source.docx' }, 'source.docx')}>编辑文件引用</button>
    <OfficePanel instanceId={request?.instanceId ?? '10000000-0000-4000-8000-000000000099'} conversationId="10000000-0000-4000-8000-000000000010" />
  </>
}
createRoot(document.getElementById('root')!).render(<Probe />)
