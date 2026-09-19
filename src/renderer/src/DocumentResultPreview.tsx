import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'
import type { DocumentResult } from '../../shared/document-result-contracts'
import type { ContextAttachment } from '../../shared/contracts'
import type { ConversationListSnapshot } from '../../shared/assistant-contracts'
import { PageTabs } from './WorkspacePrimitives'
import { DocumentConversationContext } from './DocumentConversationContext'

function ResultImage({ resultId, image, onLocate, label }: {
  resultId: string; image: DocumentResult['images'][number]; onLocate?: () => void; label?: string
}): React.JSX.Element {
  const conversationContext = useContext(DocumentConversationContext)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const element = useRef<HTMLDivElement>(null)
  const location = label ?? image.locator ?? `第 ${image.pageNumber} 页图片`
  useEffect(() => {
    let active = true
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void window.goodbuddy.documentParsing!.readResultImage(resultId, image.id, true).then(
        (value) => { if (active) { setUrl(value); setError('') } },
        (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '图片读取失败') }
      )
    })
    if (element.current) observer.observe(element.current)
    return () => { active = false; observer.disconnect() }
  }, [resultId, image.id, retry])
  return <div ref={element} className="document-result-image">
    {url ? <button type="button" className="message-image-button" aria-label={`查看大图：${location}`} onClick={(event) => {
      const trigger = event.currentTarget
      void window.goodbuddy.documentParsing!.readResultImage(resultId, image.id).then((original) => conversationContext?.openImage(original, location, trigger),
        (reason: unknown) => setError(reason instanceof Error ? reason.message : '原图读取失败'))
    }}>
      <img src={url} alt={location} loading="lazy" />
    </button> : <p role="status">{error || '正在读取图片'}</p>}
    {error && <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重试读取图片</button>}
    <small>{image.width} × {image.height} · {image.mimeType} · {(image.size / 1024).toFixed(1)} KiB</small>
    {onLocate && <button type="button" className="secondary-button" onClick={onLocate}>{location} · 查看正文位置</button>}
  </div>
}

function SectionContent({ content, result, onImage }: {
  content: string; result: DocumentResult; onImage: (id: string) => void
}): React.JSX.Element {
  const pieces = useMemo(() => content.split(/(<table\b[\s\S]*?<\/table>)/giu), [content])
  const images = useMemo(() => new Map(result.images.map((image) => [image.id, image])), [result.images])
  return <div className="markdown-body">{pieces.map((piece, index) => /^<table\b/iu.test(piece)
    ? <div key={index} className="document-result-table" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(piece, {
      ALLOWED_TAGS: ['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'p', 'br', 'strong', 'em', 'sup', 'sub'],
      ALLOWED_ATTR: ['rowspan', 'colspan']
    }) }} />
    : <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} skipHtml
      urlTransform={(url) => url.startsWith('asset:') && images.has(url.slice(6)) ? url : ''}
      components={{ p: ({ children }) => <div>{children}</div>, img: ({ src }) => {
        const id = typeof src === 'string' ? src.slice(6) : ''
        const image = images.get(id)
        return image ? <><ResultImage resultId={result.id} image={image} /><button type="button" className="secondary-button" onClick={() => onImage(id)}>第 {image.pageNumber} 页图片 · 在图片中查看</button></> : <span>图片资源不可用</span>
      } }}>{piece.replace(/<\/?(?:div|p|span|h[1-6])\b[^>]*>/giu, '\n').replace(/<br\s*\/?\s*>/giu, '\n\n')}</ReactMarkdown>)}</div>
}

export function DocumentResultPreview({ resultId, allowAddImages = false, conversationId }: { resultId: string; allowAddImages?: boolean; conversationId?: string }): React.JSX.Element {
  const conversationContext = useContext(DocumentConversationContext)
  const [result, setResult] = useState<DocumentResult>()
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})
  const [retry, setRetry] = useState(0)
  const [tab, setTab] = useState<'text' | 'images' | 'details'>('text')
  const prefix = useId()
  const [conversations, setConversations] = useState<ConversationListSnapshot[]>([])
  const [target, setTarget] = useState(conversationId ?? conversationContext?.activeId ?? '')
  const [draft, setDraft] = useState<ContextAttachment[]>([])
  const [selection, setSelection] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const attached = useMemo(() => new Set(draft.filter((item) => item.provenance?.resultId === resultId).map((item) => item.provenance!.imageId)), [draft, resultId])
  const imageSections = useMemo(() => {
    const byPage = new Map<number, number>(), byLocator = new Map<string, number>()
    result?.sections.forEach((section, index) => {
      byLocator.set(section.locator, index)
      for (const page of section.sourcePages ?? (section.pageNumber ? [section.pageNumber] : [])) if (!byPage.has(page)) byPage.set(page, index)
    })
    return new Map(result?.images.map((image) => [image.id, image.locator ? byLocator.get(image.locator) ?? byPage.get(image.pageNumber) ?? 0 : byPage.get(image.pageNumber) ?? 0]))
  }, [result])
  useEffect(() => {
    if (!allowAddImages) return
    let active = true
    void Promise.all([window.goodbuddy.conversations.listSummaries(), window.goodbuddy.projects.list()]).then(([value, projects]) => {
      if (active) {
        setConversations(value.filter((item) => !item.remote))
        setProjectNames(Object.fromEntries(projects.map((project) => [project.id, project.name])))
      }
    }).catch((reason: unknown) => { if (active) setAddError(reason instanceof Error ? reason.message : '会话读取失败') })
    return () => { active = false }
  }, [allowAddImages])
  useEffect(() => {
    if (!allowAddImages || !target) return
    let active = true
    void window.goodbuddy.context.getDraft(target).then((value) => { if (active) setDraft(value) })
      .catch((reason: unknown) => { if (active) setAddError(reason instanceof Error ? reason.message : '草稿读取失败') })
    const unsubscribe = window.goodbuddy.context.onDraftChanged((conversationId, items) => {
      if (conversationId === target) setDraft(items)
    })
    return () => { active = false; unsubscribe() }
  }, [allowAddImages, target])
  const focusTarget = useRef<string | undefined>(undefined)
  useEffect(() => {
    let active = true
    void window.goodbuddy.documentParsing!.getResult(resultId).then(
      (value) => { if (active) { setResult(value); setError('') } },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '解析结果读取失败') }
    )
    return () => { active = false }
  }, [resultId, retry])
  useEffect(() => {
    if (!focusTarget.current) return
    const target = document.getElementById(focusTarget.current)
    target?.scrollIntoView({ block: 'nearest' })
    target?.focus()
    focusTarget.current = undefined
  }, [tab])
  if (error) return <div role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重新读取</button></div>
  if (!result) return <p role="status">正在读取解析结果</p>
  return <div className="document-result-preview">
    <div className="document-result-actions"><strong>{({ complete: '解析完成', partial: '部分解析', 'images-only': '仅图片，无可发送正文' })[result.completeness]}</strong>
      <button type="button" className="secondary-button" onClick={() => {
        setActionError('')
        void window.goodbuddy.documentParsing!.openResultOriginal(result.id).catch((reason: unknown) => setActionError(reason instanceof Error ? reason.message : '原文件不可用'))
      }}>打开原文件</button></div>
    {actionError && <p role="alert">{actionError}</p>}
    <PageTabs ariaLabel="解析结果" idPrefix={prefix} variant="segmented" value={tab} onChange={setTab}
      tabs={[{ id: 'text', label: '正文' }, { id: 'images', label: `图片（${result.images.length}）` }, { id: 'details', label: '详情' }]} />
    <section className="document-result-panel" role="tabpanel" id={`${prefix}-panel-${tab}`} aria-labelledby={`${prefix}-tab-${tab}`}>
      {tab === 'text' && result.sections.map((section, index) => <article key={index}>
        <h3 tabIndex={-1} id={`${prefix}-section-${index}`}>{section.locator}</h3>
        <SectionContent content={section.content} result={result} onImage={(id) => {
          focusTarget.current = `${prefix}-image-${id}`; setTab('images')
        }} />
      </article>)}
      {tab === 'images' && <><p>已保存 {result.images.length} 张 · 未保存 {result.missingImages.length} 张</p>
        {!result.images.length && <p>此结果没有提取图片；原生解析器可能只提取文字。</p>}
        <div className="document-result-images">{result.images.map((image, index) => <article key={image.id}>
          <h3 tabIndex={-1} id={`${prefix}-image-${image.id}`}>{image.locator ?? `${result.sourceFormat === '.pptx' ? '幻灯片' : '页'} ${image.pageNumber} · 图片 ${index + 1}`}</h3>
          <ResultImage resultId={result.id} image={image} label={image.locator ?? `${result.sourceFormat === '.pptx' ? '幻灯片' : '页'} ${image.pageNumber} · 图片 ${index + 1}`} onLocate={() => { focusTarget.current = `${prefix}-section-${imageSections.get(image.id) ?? 0}`; setTab('text') }} />
          {allowAddImages && (attached.has(image.id) ? <span>已在此会话草稿 <button type="button" className="secondary-button" disabled={adding} onClick={() => {
            const existing = draft.find((item) => item.provenance?.resultId === resultId && item.provenance.imageId === image.id)!
            const next = draft.filter((item) => item.id !== existing.id)
            setAdding(true)
            void window.goodbuddy.context.saveDraft(target, next.map((item) => item.id)).then(async () => {
              await window.goodbuddy.context.remove(existing.id); setDraft(next)
            }).catch((reason: unknown) => setAddError(reason instanceof Error ? reason.message : '移除失败')).finally(() => setAdding(false))
          }}>从草稿移除</button></span> : <label>
            <input type="checkbox" checked={selection.includes(image.id)} disabled={adding}
              onChange={(event) => setSelection((current) => event.target.checked ? [...current, image.id] : current.filter((id) => id !== image.id))} />
            选择 {result.fileName} 第 {image.pageNumber} 页图片
          </label>)}
        </article>)}{result.missingImages.map((image, index) => <article className="settings-warning" key={`missing-${index}`}>
          <h3>第 {image.pageNumber} 页图片未保存</h3><p>{image.reason}</p>
        </article>)}</div></>}
      {tab === 'details' && <>
        <dl><dt>解析时间</dt><dd>{new Date(result.parsedAt).toLocaleString()}</dd>
          <dt>耗时</dt><dd>{(result.durationMs / 1000).toFixed(1)} 秒</dd>
          <dt>置信度</dt><dd>{result.sections.some((section) => section.confidence !== undefined) ? result.sections.map((section) => `${section.locator}: ${section.confidence ?? '未提供'}`).join('；') : '未提供'}</dd>
          <dt>跨页整理</dt><dd>{result.restructure ? result.restructure.changed ? '返回变化；请核对来源映射警告' : '未观察到变化' : '未请求'}</dd></dl>
        <p>以下为解析时保存的配置。省略的高级项使用服务默认，实际值未提供。</p>
        <pre>{JSON.stringify(result.settings, null, 2)}</pre>
      </>}
      {result.warnings.length > 0 && <div className="settings-warning"><strong>解析警告</strong><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    </section>
    {allowAddImages && <div className="document-result-actions">
      <label className="field"><span>添加到会话草稿</span><select value={target} disabled={adding} onChange={(event) => { setTarget(event.target.value); setDraft([]) }}>
        <option value="">选择会话后添加</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.projectId ? projectNames[conversation.projectId] ?? '项目不可用' : '未绑定项目'} · {conversation.title}</option>)}
      </select></label>
      <span>待添加 {selection.filter((id) => !attached.has(id)).length} 张 · 已在草稿 {attached.size} 张</span>
      <button type="button" className="primary-button" disabled={adding || !target || !selection.some((id) => !attached.has(id))}
        onClick={() => {
          setAdding(true); setAddError('')
          void window.goodbuddy.context.addResultImages(target, resultId, selection.filter((id) => !attached.has(id))).then((value) => {
            setDraft(value); setSelection([])
            conversationContext?.notify(`图片已添加到会话草稿：${conversations.find((item) => item.id === target)?.title ?? target}`)
          }, (reason: unknown) => setAddError(reason instanceof Error ? reason.message : '添加图片失败')).finally(() => setAdding(false))
        }}>{adding ? '正在添加' : '添加所选图片'}</button>
      {conversationContext && <button type="button" className="secondary-button" disabled={adding} onClick={() => {
        setAdding(true); setAddError('')
        void conversationContext.create().then((conversation) => {
          setConversations((current) => current.some((item) => item.id === conversation.id) ? current : [...current, { ...conversation, updatedAt: Date.now(), messages: [] }])
          setTarget(conversation.id); setDraft([])
        }).catch((reason: unknown) => setAddError(reason instanceof Error ? reason.message : '创建会话失败')).finally(() => setAdding(false))
      }}>新建目标会话</button>}
      {conversationContext && target && attached.size > 0 && <button type="button" className="secondary-button" onClick={() => conversationContext.navigate(target)}>前往会话</button>}
      {addError && <p role="alert">{addError}</p>}
    </div>}
  </div>
}
