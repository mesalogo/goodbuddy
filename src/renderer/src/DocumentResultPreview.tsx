import { memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
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
  const { t } = useTranslation('settings')
  const conversationContext = useContext(DocumentConversationContext)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const element = useRef<HTMLDivElement>(null)
  const location = label ?? image.locator ?? t('documentParsing.result.imageOnPage', { page: image.pageNumber })
  useEffect(() => {
    let active = true
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void window.goodbuddy.documentParsing!.readResultImage(resultId, image.id, true).then(
        (value) => { if (active) { setUrl(value); setError('') } },
        (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : i18n.t('settings:documentParsing.result.imageLoadFailed')) }
      )
    })
    if (element.current) observer.observe(element.current)
    return () => { active = false; observer.disconnect() }
  }, [resultId, image.id, retry])
  return <div ref={element} className="document-result-image">
    {url ? <button type="button" className="message-image-button" aria-label={t('documentParsing.result.viewLargeImage', { location })} onClick={(event) => {
      const trigger = event.currentTarget
      void window.goodbuddy.documentParsing!.readResultImage(resultId, image.id).then((original) => conversationContext?.openImage(original, location, trigger),
        (reason: unknown) => setError(reason instanceof Error ? reason.message : t('documentParsing.result.originalLoadFailed')))
    }}>
      <img src={url} alt={location} loading="lazy" />
    </button> : <p role="status">{error || t('documentParsing.result.loadingImage')}</p>}
    {error && <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>{t('documentParsing.result.retryImage')}</button>}
    <small>{image.width} × {image.height} · {image.mimeType} · {(image.size / 1024).toFixed(1)} KiB</small>
    {onLocate && <button type="button" className="secondary-button" onClick={onLocate}>{t('documentParsing.result.locateInText', { location })}</button>}
  </div>
}

const SectionContent = memo(function SectionContent({ content, result, onImage }: {
  content: string; result: DocumentResult; onImage: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
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
        return image ? <><ResultImage resultId={result.id} image={image} /><button type="button" className="secondary-button" onClick={() => onImage(id)}>{t('documentParsing.result.viewInImagesTab', { page: image.pageNumber })}</button></> : <span>{t('documentParsing.result.imageUnavailable')}</span>
      } }}>{piece.replace(/<\/?(?:div|p|span|h[1-6])\b[^>]*>/giu, '\n').replace(/<br\s*\/?\s*>/giu, '\n\n')}</ReactMarkdown>)}</div>
})

export function DocumentResultPreview({ resultId, allowAddImages = false, conversationId, showOpenOriginal = true, imageActionsInImagesTab = false }: { resultId: string; allowAddImages?: boolean; conversationId?: string; showOpenOriginal?: boolean; imageActionsInImagesTab?: boolean }): React.JSX.Element {
  const { t } = useTranslation('settings')
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
    }).catch((reason: unknown) => { if (active) setAddError(reason instanceof Error ? reason.message : i18n.t('settings:documentParsing.result.conversationsLoadFailed')) })
    return () => { active = false }
  }, [allowAddImages])
  useEffect(() => {
    if (!allowAddImages || !target) return
    let active = true
    void window.goodbuddy.context.getDraft(target).then((value) => { if (active) setDraft(value) })
      .catch((reason: unknown) => { if (active) setAddError(reason instanceof Error ? reason.message : i18n.t('settings:documentParsing.result.draftLoadFailed')) })
    const unsubscribe = window.goodbuddy.context.onDraftChanged((conversationId, items) => {
      if (conversationId === target) setDraft(items)
    })
    return () => { active = false; unsubscribe() }
  }, [allowAddImages, target])
  const focusTarget = useRef<string | undefined>(undefined)
  const showImage = useCallback((id: string) => {
    focusTarget.current = `${prefix}-image-${id}`
    setTab('images')
  }, [prefix])
  useEffect(() => {
    let active = true
    void window.goodbuddy.documentParsing!.getResult(resultId).then(
      (value) => { if (active) { setResult(value); setError('') } },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : i18n.t('settings:documentParsing.result.loadFailed')) }
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
  if (error) return <div role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>{t('documentParsing.result.reload')}</button></div>
  if (!result) return <p role="status">{t('documentParsing.result.loading')}</p>
  return <div className="document-result-preview">
    <div className="document-result-actions"><strong>{t(`documentParsing.result.completeness.${result.completeness}`)}</strong>
      {showOpenOriginal && <button type="button" className="secondary-button" onClick={() => {
        setActionError('')
        void window.goodbuddy.documentParsing!.openResultOriginal(result.id).catch((reason: unknown) => setActionError(reason instanceof Error ? reason.message : t('documentParsing.result.originalUnavailable')))
      }}>{t('documentParsing.result.openOriginal')}</button>}</div>
    {actionError && <p role="alert">{actionError}</p>}
    <PageTabs ariaLabel={t('documentParsing.result.tabsLabel')} idPrefix={prefix} variant="segmented" value={tab} onChange={setTab}
      tabs={[{ id: 'text', label: t('documentParsing.result.textTab') }, { id: 'images', label: t('documentParsing.result.imagesTab', { total: result.images.length }) }, { id: 'details', label: t('documentParsing.result.detailsTab') }]} />
    <section className="document-result-panel" role="tabpanel" id={`${prefix}-panel-${tab}`} aria-labelledby={`${prefix}-tab-${tab}`}>
      {tab === 'text' && result.sections.map((section, index) => <article key={index}>
        <h3 tabIndex={-1} id={`${prefix}-section-${index}`}>{section.locator}</h3>
        <SectionContent content={section.content} result={result} onImage={showImage} />
      </article>)}
      {tab === 'images' && <><p>{t('documentParsing.result.imageCounts', { saved: result.images.length, missing: result.missingImages.length })}</p>
        {!result.images.length && <p>{t('documentParsing.result.noImages')}</p>}
        <div className="document-result-images">{result.images.map((image, index) => <article key={image.id}>
          <h3 tabIndex={-1} id={`${prefix}-image-${image.id}`}>{image.locator ?? t(result.sourceFormat === '.pptx' ? 'documentParsing.result.slideImageTitle' : 'documentParsing.result.pageImageTitle', { page: image.pageNumber, index: index + 1 })}</h3>
          <ResultImage resultId={result.id} image={image} label={image.locator ?? t(result.sourceFormat === '.pptx' ? 'documentParsing.result.slideImageTitle' : 'documentParsing.result.pageImageTitle', { page: image.pageNumber, index: index + 1 })} onLocate={() => { focusTarget.current = `${prefix}-section-${imageSections.get(image.id) ?? 0}`; setTab('text') }} />
          {allowAddImages && (attached.has(image.id) ? <span>{t('documentParsing.result.inDraft')} <button type="button" className="secondary-button" disabled={adding} onClick={() => {
            const existing = draft.find((item) => item.provenance?.resultId === resultId && item.provenance.imageId === image.id)!
            const next = draft.filter((item) => item.id !== existing.id)
            setAdding(true)
            void window.goodbuddy.context.saveDraft(target, next.map((item) => item.id)).then(async () => {
              await window.goodbuddy.context.remove(existing.id); setDraft(next)
            }).catch((reason: unknown) => setAddError(reason instanceof Error ? reason.message : t('documentParsing.result.removeFailed'))).finally(() => setAdding(false))
          }}>{t('documentParsing.result.removeFromDraft')}</button></span> : <label>
            <input type="checkbox" checked={selection.includes(image.id)} disabled={adding}
              onChange={(event) => setSelection((current) => event.target.checked ? [...current, image.id] : current.filter((id) => id !== image.id))} />
            {t('documentParsing.result.selectImage', { file: result.fileName, page: image.pageNumber })}
          </label>)}
        </article>)}{result.missingImages.map((image, index) => <article className="settings-warning" key={`missing-${index}`}>
          <h3>{t('documentParsing.result.imageNotSaved', { page: image.pageNumber })}</h3><p>{image.reason}</p>
        </article>)}</div></>}
      {tab === 'details' && <>
        <dl><dt>{t('documentParsing.result.parsedAt')}</dt><dd>{new Date(result.parsedAt).toLocaleString()}</dd>
          <dt>{t('documentParsing.result.duration')}</dt><dd>{t('documentParsing.result.seconds', { value: (result.durationMs / 1000).toFixed(1) })}</dd>
          <dt>{t('documentParsing.result.confidence')}</dt><dd>{result.sections.some((section) => section.confidence !== undefined) ? result.sections.map((section) => t('documentParsing.result.confidenceItem', { locator: section.locator, value: section.confidence ?? t('documentParsing.result.notProvided') })).join(t('documentParsing.result.itemSeparator')) : t('documentParsing.result.notProvided')}</dd>
          <dt>{t('documentParsing.result.restructure')}</dt><dd>{result.restructure ? result.restructure.changed ? t('documentParsing.result.restructureChanged') : t('documentParsing.result.restructureUnchanged') : t('documentParsing.result.restructureNotRequested')}</dd></dl>
        <p>{t('documentParsing.result.savedSettingsNote')}</p>
        <pre>{JSON.stringify(result.settings, null, 2)}</pre>
      </>}
      {result.warnings.length > 0 && <div className="settings-warning"><strong>{t('documentParsing.result.parseWarnings')}</strong><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    </section>
    {allowAddImages && (!imageActionsInImagesTab || tab === 'images') && <div className="document-result-actions">
      <label className="field"><span>{t('documentParsing.result.addToDraft')}</span><select value={target} disabled={adding} onChange={(event) => { setTarget(event.target.value); setDraft([]) }}>
        <option value="">{t('documentParsing.result.selectConversation')}</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.projectId ? projectNames[conversation.projectId] ?? t('documentParsing.result.projectUnavailable') : t('documentParsing.result.noProject')} · {conversation.title}</option>)}
      </select></label>
      <span>{t('documentParsing.result.selectionSummary', { pending: selection.filter((id) => !attached.has(id)).length, attached: attached.size })}</span>
      <button type="button" className="primary-button" disabled={adding || !target || !selection.some((id) => !attached.has(id))}
        onClick={() => {
          setAdding(true); setAddError('')
          void window.goodbuddy.context.addResultImages(target, resultId, selection.filter((id) => !attached.has(id))).then((value) => {
            setDraft(value); setSelection([])
            conversationContext?.notify(t('documentParsing.result.imagesAdded', { title: conversations.find((item) => item.id === target)?.title ?? target }))
          }, (reason: unknown) => setAddError(reason instanceof Error ? reason.message : t('documentParsing.result.addImagesFailed'))).finally(() => setAdding(false))
        }}>{adding ? t('documentParsing.result.adding') : t('documentParsing.result.addSelected')}</button>
      {conversationContext && <button type="button" className="secondary-button" disabled={adding} onClick={() => {
        setAdding(true); setAddError('')
        void conversationContext.create().then((conversation) => {
          setConversations((current) => current.some((item) => item.id === conversation.id) ? current : [...current, { ...conversation, updatedAt: Date.now(), messages: [] }])
          setTarget(conversation.id); setDraft([])
        }).catch((reason: unknown) => setAddError(reason instanceof Error ? reason.message : t('documentParsing.result.createConversationFailed'))).finally(() => setAdding(false))
      }}>{t('documentParsing.result.newTargetConversation')}</button>}
      {conversationContext && target && attached.size > 0 && <button type="button" className="secondary-button" onClick={() => conversationContext.navigate(target)}>{t('documentParsing.result.goToConversation')}</button>}
      {addError && <p role="alert">{addError}</p>}
    </div>}
  </div>
}
