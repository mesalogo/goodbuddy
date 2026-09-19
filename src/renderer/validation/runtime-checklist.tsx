import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '../src/i18n'
import '../src/styles.css'
import { RuntimeChecklistStrip } from '../src/RuntimeChecklistStrip'
import { ConversationTaskStrip } from '../src/ConversationTaskStrip'
import type { Message } from '../src/ChatTimeline'

const original: Message = {
  id: 'original', role: 'assistant', content: '', createdAt: 1, state: 'streaming',
  runtimeChecklist: { source: 'opencode', items: Array.from({ length: 80 }, (_, index) => ({
    content: `${index + 1}. ${index === 1 ? '正在核对当前项目中的修改与既有任务，同时保留用户未提交的工作' : index === 79 ? 'LAST ITEM' : '检查生产组件布局、当前请求归属及历史状态'} ${index === 3 ? 'long_unbroken_path_'.repeat(35) : ''}`,
    status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : index === 4 ? 'cancelled' : 'pending',
    priority: index % 3 === 0 ? 'high' : index % 3 === 1 ? 'medium' : 'low'
  })) }
}
const next: Message = { id: 'next', role: 'assistant', content: '', createdAt: 2, state: 'streaming' }
const task = {
  id: 'task', title: '核对项目与构建验证', instructions: '保留用户修改', origin: 'schedule' as const,
  status: 'idle' as const, createdAt: '2026-09-18T00:00:00Z'
}

function Harness() {
  const [scenario, setScenario] = useState('live')
  const [runs, setRuns] = useState(0)
  const [update, setUpdate] = useState(0)
  const [theme, setTheme] = useState('light')
  const messages = scenario === 'stale' ? [{ ...original, state: 'complete' as const }, next]
    : scenario === 'next' ? [original, next]
    : scenario === 'cleared' ? [original, { ...next, runtimeChecklist: { source: 'opencode' as const, items: [] } }]
    : scenario === 'history' || scenario === 'remote' ? [{ ...original, state: 'error' as const, status: '已取消' }]
    : [{ ...original, runtimeChecklist: { ...original.runtimeChecklist!, items: original.runtimeChecklist!.items.map((item, index) => index === 2 && update ? { ...item, content: `更新 ${update}`, status: 'completed' as const } : item) } }]
  Object.assign(window, { checklistHarness: {
    scenario: (value: string) => flushSync(() => setScenario(value)),
    update: () => flushSync(() => setUpdate(value => value + 1)),
    theme: (value: string) => {
      document.documentElement.dataset.theme = value
      document.documentElement.style.colorScheme = value
      flushSync(() => setTheme(value))
    },
    runs
  } })
  return <div data-theme={theme} style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--surface-raised)', color: 'var(--text-primary)' }}>
    <header style={{ flex: '0 0 auto', padding: '8px 16px', background: 'var(--surface-subtle)' }}>Renderer component harness · {scenario} · {theme}</header>
    <main style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="chat-history-pane" style={{ flex: '1 1 auto', height: 'auto' }}>
        <div className="conversation-context-strips">
          {scenario !== 'remote' && <ConversationTaskStrip locale="zh-CN" tasks={[task]} schedules={[{
            id: 'schedule', taskId: 'task', title: task.title, instructions: task.instructions, enabled: true,
            recurrence: 'daily', nextRunAt: '2026-09-19T08:00:00Z', createdAt: task.createdAt, updatedAt: task.createdAt
          }]} onSelectTask={() => undefined} onRunSchedule={async () => { setRuns(value => value + 1) }} onRemoveSchedule={async () => undefined} onSetScheduleEnabled={async () => undefined} />}
          <RuntimeChecklistStrip messages={messages} activeMessageId={scenario === 'next' ? 'next' : scenario === 'stale' ? 'original' : undefined} />
        </div>
        <section className="chat"><div style={{ padding: '16px' }}>对话正文仍应可见。此页仅复用 renderer 组件，未连接 Main、IPC 或模型。</div></section>
      </div>
      <footer style={{ flex: '0 0 auto', padding: '16px', borderTop: '1px solid var(--border-default)' }}>
        <label>消息输入 <input aria-label="消息输入" placeholder="输入区保持可见" style={{ width: '100%', minWidth: 0 }} /></label>
      </footer>
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Harness />)
