import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { platformToolCard } from './platform-tool-card'
import { ChatTimeline } from './ChatTimeline'
import i18n from './i18n'

afterEach(() => { cleanup() })

describe('platformToolCard', () => {
  it('describes Feishu writes with title and link, whatever the runtime prefix', () => {
    expect(platformToolCard({
      name: 'goodbuddy_feishu_doc', state: 'completed',
      input: JSON.stringify({ action: 'append', doc_token: 'd1' }),
      output: JSON.stringify({ document_id: 'd1', title: '发布流程', url: 'https://www.feishu.cn/docx/d1' })
    })).toEqual({ provider: 'feishu', object: 'doc', write: true, action: 'append', title: '发布流程', url: 'https://www.feishu.cn/docx/d1' })
    expect(platformToolCard({ name: 'feishu_wiki', state: 'completed', input: JSON.stringify({ action: 'nodes' }), output: JSON.stringify({ items: [1, 2, 3] }) }))
      .toEqual({ provider: 'feishu', object: 'wiki', write: false, action: 'nodes', count: 3 })
  })

  it('reads the WeCom command from wecom_cli args and finds links in plain output', () => {
    expect(platformToolCard({
      name: 'wecom_cli', state: 'completed',
      input: JSON.stringify({ args: ['todo', 'create', '--json', '{"title":"交周报"}'] }),
      output: '{"errcode":0} 见 https://doc.weixin.qq.com/doc/abc'
    })).toEqual({ provider: 'wecom', object: 'todo', write: true, action: 'create', url: 'https://doc.weixin.qq.com/doc/abc' })
    expect(platformToolCard({ name: 'wecom_cli', state: 'completed', input: JSON.stringify({ args: ['doc', 'search', '--json', '{}'] }), output: JSON.stringify({ docs: [{}, {}] }) }))
      .toMatchObject({ object: 'doc', write: false, count: 2 })
  })

  it('skips guides, other tools and unfinished calls', () => {
    expect(platformToolCard({ name: 'wecom_guide', state: 'completed' })).toBeUndefined()
    expect(platformToolCard({ name: 'knowledge_search', state: 'completed' })).toBeUndefined()
    expect(platformToolCard({ name: 'feishu_doc', state: 'running', input: '{"action":"append"}' })).toBeUndefined()
    expect(platformToolCard({ name: 'myfeishu_doc', state: 'completed' })).toBeUndefined()
  })
})

describe('platform tool card in the timeline', () => {
  it('shows the write card with the version-history hint and the original link', async () => {
    await i18n.changeLanguage('zh-CN')
    const tool = { callId: 't1', name: 'feishu_doc', state: 'completed' as const, summary: '', input: '{"action":"append"}',
      output: '{"title":"发布流程","url":"https://www.feishu.cn/docx/d1"}' }
    const noop = vi.fn()
    render(<ChatTimeline
      artifactById={new Map()} conversationId="c1" hiddenMessageCount={0} isUnusedConversation={false}
      locale="zh-CN" messageStartIndex={0} totalMessageCount={1}
      onArticleRef={noop} onCopyMessage={vi.fn(async () => true)} onDownloadImage={noop}
      onOpenCitationContext={vi.fn(async () => undefined)} onOpenCitationSource={vi.fn(async () => undefined)}
      onOpenImage={noop} onRespondQuestion={vi.fn(async () => undefined)} onRetry={noop} onRevealEarlier={noop}
      messages={[{ id: 'm1', role: 'assistant', content: '', createdAt: 1, state: 'complete', tools: [tool],
        blocks: [{ id: 'b1', type: 'tool', tool }] }]}
    />)
    expect(await screen.findByText('已写入飞书文档 · append')).toBeInTheDocument()
    expect(screen.getByText(/可在飞书文档的历史版本中恢复/u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开原文' })).toHaveAttribute('href', 'https://www.feishu.cn/docx/d1')
  })
})
