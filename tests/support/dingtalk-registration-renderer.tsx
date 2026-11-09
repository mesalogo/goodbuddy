import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChannelApplicationSettings } from '../../src/renderer/src/ChannelApplicationSettings'
import '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'

createRoot(document.getElementById('root')!).render(<ChannelApplicationSettings
  channel="dingtalk"
  onUpdateProject={async () => { throw new Error('Not used') }}
  projectList={[{ id: '00000000-0000-4000-8000-000000000001', name: '钉钉', description: '', rootPath: 'D:/fixture',
    kind: 'channel', channel: 'dingtalk', status: 'active', executionSpace: { kind: 'local', rootPath: 'D:/fixture' },
    runtimeSelection: { provider: 'model' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]}
/>)
