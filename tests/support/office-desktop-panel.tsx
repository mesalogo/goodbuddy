import React, { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { OfficePanel } from '../../src/renderer/src/OfficePanel'
import { officeStore } from '../../src/renderer/src/office-store'
function Probe(): React.JSX.Element {
  const request = useSyncExternalStore(officeStore.subscribe, officeStore.getOpenRequest)
  const [other, setOther] = useState(false)
  return <>
    <button onClick={() => setOther(value => !value)}>切换标签</button>
    <button onClick={() => { if (request) void officeStore.close(request.instanceId) }}>关闭文档</button>
    <button onClick={() => officeStore.requestOpen({ kind: 'workspace', projectId: '10000000-0000-4000-8000-000000000001', path: 'source.docx' }, 'source.docx')}>编辑文件引用</button>
    {other && <textarea aria-label="其他标签的输入" />}
    <div hidden={other} style={{ flex: 1, minHeight: 0 }}>
      <OfficePanel instanceId={request?.instanceId ?? '10000000-0000-4000-8000-000000000099'} conversationId="10000000-0000-4000-8000-000000000010" />
    </div>
  </>
}
createRoot(document.getElementById('root')!).render(<Probe />)
