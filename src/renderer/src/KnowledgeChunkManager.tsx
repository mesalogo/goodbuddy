import {
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type {
  KnowledgeChunkPage as SharedKnowledgeChunkPage,
  KnowledgeChunkRole as SharedKnowledgeChunkRole,
  KnowledgeChunkUpdateInput,
  KnowledgeManagedChunk as SharedKnowledgeManagedChunk
} from '../../shared/knowledge-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { DestructiveConfirmActions } from './WorkspacePrimitives'

export type KnowledgeChunkRole = SharedKnowledgeChunkRole
export type KnowledgeManagedChunk = SharedKnowledgeManagedChunk
export type KnowledgeChunkPage = SharedKnowledgeChunkPage
export type KnowledgeChunkUpdate = Pick<
  KnowledgeChunkUpdateInput,
  'content' | 'enabled'
>

export type KnowledgeChunkManagerProps = {
  documentId: string
  documentName: string
  page: KnowledgeChunkPage
  query?: string
  selectedChunkId?: string
  loading?: boolean
  error?: string
  savingChunkId?: string
  deletingChunkId?: string
  rebuilding?: boolean
  maxChunkCharacters?: number
  onList: (request: {
    documentId: string
    page: number
    pageSize: number
    query: string
  }) => void | Promise<void>
  onSelectChunk?: (chunkId: string) => void
  onUpdateChunk: (
    chunkId: string,
    update: KnowledgeChunkUpdate
  ) => void | Promise<void>
  onDeleteChunk: (chunkId: string) => void | Promise<void>
  onRebuildDocument: (documentId: string) => void | Promise<void>
  onClose: () => void
}

export function KnowledgeChunkManager({
  deletingChunkId,
  documentId,
  documentName,
  error,
  loading = false,
  maxChunkCharacters = 48_000,
  onClose,
  onDeleteChunk,
  onList,
  onRebuildDocument,
  onSelectChunk,
  onUpdateChunk,
  page,
  query = '',
  rebuilding = false,
  savingChunkId,
  selectedChunkId
}: KnowledgeChunkManagerProps): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [searchDraft, setSearchDraft] = useState(query)
  const [internalSelectedId, setInternalSelectedId] = useState(
    selectedChunkId ?? page.items[0]?.id
  )
  const [contentDrafts, setContentDrafts] = useState<Record<string, string>>({})
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const contentErrorId = useId()

  const requestedSelectedId = selectedChunkId ?? internalSelectedId
  const selectedChunk =
    page.items.find((chunk) => chunk.id === requestedSelectedId) ??
    page.items[0]
  const effectiveSelectedId = selectedChunk?.id
  const draftContent = selectedChunk
    ? (contentDrafts[selectedChunk.id] ?? selectedChunk.content)
    : ''
  const isSavingSelected = savingChunkId === selectedChunk?.id
  const totalPages = Math.max(1, Math.ceil(page.totalItems / page.pageSize))

  useEffect(() => {
    return activateModalFocus(() => searchRef.current)
  }, [])

  const contentError = useMemo(() => {
    if (!selectedChunk) {
      return undefined
    }
    if (draftContent.trim().length === 0) {
      return t('chunks.validation.contentRequired')
    }
    if (draftContent.length > maxChunkCharacters) {
      return t('chunks.validation.contentTooLong', {
        count: maxChunkCharacters
      })
    }
    return undefined
  }, [draftContent, maxChunkCharacters, selectedChunk, t])

  const selectChunk = (chunkId: string): void => {
    setInternalSelectedId(chunkId)
    onSelectChunk?.(chunkId)
  }

  const list = (nextPage: number, nextQuery = searchDraft.trim()): void => {
    void onList({
      documentId,
      page: nextPage,
      pageSize: page.pageSize,
      query: nextQuery
    })
  }

  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    list(1)
  }

  const updateEnabled = (chunk: KnowledgeManagedChunk, enabled: boolean): void => {
    void onUpdateChunk(chunk.id, { enabled })
  }

  const saveContent = (): void => {
    if (!selectedChunk || contentError || isSavingSelected) {
      return
    }
    void onUpdateChunk(selectedChunk.id, { content: draftContent })
  }

  const deleteChunk = (chunkId: string): void => {
    void Promise.resolve(onDeleteChunk(chunkId)).then(
      () => setConfirmingDeleteId(undefined),
      () => undefined
    )
  }

  return createPortal(
    <div className="knowledge-dialog-backdrop">
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="knowledge-dialog knowledge-chunk-manager"
        onKeyDown={(event) => {
          if (event.defaultPrevented) {
            return
          }
          if (
            event.key === 'Escape' &&
            !savingChunkId &&
            !deletingChunkId &&
            !rebuilding
          ) {
            event.preventDefault()
            onClose()
            return
          }
          trapTabFocus(event, dialogRef.current)
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="knowledge-dialog__header">
          <div>
            <span className="knowledge-dialog__eyebrow">{documentName}</span>
            <h2 id={titleId}>{t('chunks.title')}</h2>
            <p id={descriptionId}>{t('chunks.description')}</p>
          </div>
          <button
            aria-label={t('chunks.close')}
            className="icon-button"
            disabled={Boolean(savingChunkId || deletingChunkId || rebuilding)}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="knowledge-chunk-manager__warning" role="note">
          <FilePenLine aria-hidden="true" size={18} />
          <p>
            <strong>{t('chunks.syncWarningTitle')}</strong>{' '}
            {t('chunks.syncWarning')}
          </p>
        </div>

        <div className="knowledge-dialog__content knowledge-chunk-manager__content">
          <aside
            aria-label={t('chunks.listAriaLabel')}
            className="knowledge-chunk-manager__list"
          >
            <form className="knowledge-chunk-search" onSubmit={submitSearch}>
              <label className="field">
                <span>{t('chunks.search.label')}</span>
                <span className="knowledge-input-with-icon">
                  <Search aria-hidden="true" size={15} />
                  <input
                    onChange={(event) =>
                      setSearchDraft(event.currentTarget.value)
                    }
                    placeholder={t('chunks.search.placeholder')}
                    ref={searchRef}
                    type="search"
                    value={searchDraft}
                  />
                </span>
              </label>
              <button className="secondary-button" type="submit">
                {t('chunks.search.action')}
              </button>
            </form>

            {error && (
              <div className="knowledge-operation-state knowledge-operation-state--error" role="alert">
                <div>
                  <strong>{t('chunks.loadErrorTitle')}</strong>
                  <p>{error}</p>
                </div>
              </div>
            )}
            {loading ? (
              <div className="knowledge-zero-state" role="status">
                <strong>{t('chunks.loadingTitle')}</strong>
                <p>{t('chunks.loadingDescription')}</p>
              </div>
            ) : page.items.length === 0 ? (
              <div className="knowledge-zero-state" role="status">
                <strong>{t('chunks.zeroTitle')}</strong>
                <p>{t('chunks.zeroDescription')}</p>
              </div>
            ) : (
              <ul>
                {page.items.map((chunk) => {
                  const saving = savingChunkId === chunk.id
                  return (
                    <li
                      className={
                        chunk.id === effectiveSelectedId
                          ? 'knowledge-chunk-list-item knowledge-chunk-list-item--selected'
                          : 'knowledge-chunk-list-item'
                      }
                      key={chunk.id}
                    >
                      <button
                        aria-current={
                          chunk.id === effectiveSelectedId
                            ? 'true'
                            : undefined
                        }
                        className="knowledge-chunk-list-item__select"
                        onClick={() => selectChunk(chunk.id)}
                        type="button"
                      >
                        <span>
                          {t('chunks.ordinal', { count: chunk.ordinal })}
                          {chunk.heading
                            ? t('chunks.headingSeparator', {
                                heading: chunk.heading
                              })
                            : ''}
                        </span>
                        <small>
                          {t(`chunks.roles.${chunk.role}`)}
                          {chunk.parentChunkId
                            ? t('chunks.parentMetadata', {
                                parentId: chunk.parentChunkId
                              })
                            : ''}
                        </small>
                        <small>
                          {chunk.locator ?? t('chunks.unknownLocator')} ·{' '}
                          {t('chunks.characterCount', {
                            count: chunk.characterCount
                          })}
                        </small>
                      </button>
                      <label className="toggle-row knowledge-chunk-list-item__switch">
                        <span>{t('chunks.enabled')}</span>
                        <input
                          aria-label={t('chunks.enabledAriaLabel', {
                            count: chunk.ordinal
                          })}
                          checked={chunk.enabled}
                          disabled={saving}
                          onChange={(event) =>
                            updateEnabled(chunk, event.currentTarget.checked)
                          }
                          role="switch"
                          type="checkbox"
                        />
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}

            <nav
              aria-label={t('chunks.pagination.ariaLabel')}
              className="knowledge-pagination"
            >
              <button
                aria-label={t('chunks.pagination.previous')}
                className="icon-button"
                disabled={loading || page.page <= 1}
                onClick={() => list(page.page - 1)}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={16} />
              </button>
              <span>
                {t('chunks.pagination.summary', {
                  page: page.page,
                  total: totalPages,
                  count: page.totalItems
                })}
              </span>
              <button
                aria-label={t('chunks.pagination.next')}
                className="icon-button"
                disabled={loading || page.page >= totalPages}
                onClick={() => list(page.page + 1)}
                type="button"
              >
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            </nav>
          </aside>

          <section
            aria-labelledby={`${titleId}-editor`}
            className="knowledge-chunk-manager__editor"
          >
            {selectedChunk ? (
              <>
                <div className="knowledge-workbench-section__heading">
                  <div>
                    <h3 id={`${titleId}-editor`}>
                      {t('chunks.editor.title', {
                        count: selectedChunk.ordinal
                      })}
                    </h3>
                    <p>
                      {t('chunks.editor.metadata', {
                        role: t(`chunks.roles.${selectedChunk.role}`),
                        locator:
                          selectedChunk.locator ?? t('chunks.unknownLocator')
                      })}
                    </p>
                  </div>
                  {selectedChunk.manuallyEdited && (
                    <span className="knowledge-status-badge">
                      {t('chunks.editor.manuallyEdited')}
                    </span>
                  )}
                </div>

                {selectedChunk.parentChunkId && (
                  <dl className="knowledge-chunk-parent">
                    <div>
                      <dt>{t('chunks.editor.role')}</dt>
                      <dd>{t(`chunks.roles.${selectedChunk.role}`)}</dd>
                    </div>
                    <div>
                      <dt>{t('chunks.editor.parent')}</dt>
                      <dd>{selectedChunk.parentChunkId}</dd>
                    </div>
                  </dl>
                )}

                <label className="field knowledge-chunk-editor-field">
                  <span>{t('chunks.editor.content')}</span>
                  <textarea
                    aria-describedby={contentError ? contentErrorId : undefined}
                    aria-invalid={Boolean(contentError)}
                    disabled={isSavingSelected}
                    onChange={(event) => {
                      const nextContent = event.currentTarget.value
                      const chunkId = selectedChunk.id
                      setContentDrafts((current) => ({
                        ...current,
                        [chunkId]: nextContent
                      }))
                    }}
                    rows={16}
                    value={draftContent}
                  />
                  <small>
                    {t('chunks.editor.count', {
                      count: draftContent.length,
                      max: maxChunkCharacters
                    })}
                  </small>
                </label>
                {contentError && (
                  <p className="knowledge-inline-error" id={contentErrorId}>
                    {contentError}
                  </p>
                )}

                <footer className="knowledge-chunk-manager__editor-actions">
                  <DestructiveConfirmActions
                    confirmAriaLabel={t('chunks.delete.confirmAriaLabel', {
                      count: selectedChunk.ordinal
                    })}
                    confirmLabel={
                      deletingChunkId === selectedChunk.id
                        ? t('chunks.delete.deleting')
                        : t('chunks.delete.confirm')
                    }
                    confirming={confirmingDeleteId === selectedChunk.id}
                    disabled={deletingChunkId === selectedChunk.id}
                    icon={<Trash2 size={14} />}
                    message={t('chunks.delete.message', {
                      count: selectedChunk.ordinal
                    })}
                    onCancel={() => setConfirmingDeleteId(undefined)}
                    onConfirm={() => deleteChunk(selectedChunk.id)}
                    onRequestConfirm={() =>
                      setConfirmingDeleteId(selectedChunk.id)
                    }
                    triggerAriaLabel={t('chunks.delete.triggerAriaLabel', {
                      count: selectedChunk.ordinal
                    })}
                    triggerLabel={t('chunks.delete.trigger')}
                  />
                  <button
                    className="primary-button"
                    disabled={
                      Boolean(contentError) ||
                      isSavingSelected ||
                      draftContent === selectedChunk.content
                    }
                    onClick={saveContent}
                    type="button"
                  >
                    {isSavingSelected
                      ? t('chunks.editor.saving')
                      : t('chunks.editor.save')}
                  </button>
                </footer>
              </>
            ) : (
              <div className="knowledge-zero-state">
                <strong>{t('chunks.editor.noSelectionTitle')}</strong>
                <p>{t('chunks.editor.noSelectionDescription')}</p>
              </div>
            )}
          </section>
        </div>

        <footer className="knowledge-dialog__footer">
          <button
            className="secondary-button"
            disabled={rebuilding}
            onClick={() => void onRebuildDocument(documentId)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={15} />
            {rebuilding
              ? t('chunks.rebuild.running')
              : t('chunks.rebuild.action')}
          </button>
          <span>{t('chunks.rebuild.description')}</span>
        </footer>
      </section>
    </div>,
    document.body
  )
}
