import {
  useEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import Quill, { type Delta, type EmitterSource } from 'quill'
import 'quill/dist/quill.snow.css'
import { Paperclip } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import './magic-note-embeds'
import {
  MAGIC_NOTE_MAX_ATTACHMENTS,
  MAGIC_NOTE_MAX_ATTACHMENT_BYTES,
  MAGIC_NOTE_MAX_IMAGES,
  MAGIC_NOTE_MAX_IMAGE_BYTES,
  MAGIC_NOTE_MAX_TOTAL_EMBED_BYTES,
  MAGIC_NOTE_MAX_TOTAL_IMAGE_BYTES,
  MAGIC_NOTE_MAX_VIDEOS,
  MAGIC_NOTE_MAX_VIDEO_BYTES,
  MAGIC_NOTE_VIDEO_TYPES,
  magicNoteDataBytes,
  type MagicNoteRichContent
} from '../../shared/magic-notes-contracts'
import { readFileAsDataUrl } from './file-data-url'

const supportedImageTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
])
const supportedVideoTypes = new Set<string>(MAGIC_NOTE_VIDEO_TYPES)

export type MagicNoteEditorProps = {
  initialContent?: MagicNoteRichContent
  ariaDescribedBy?: string
  ariaInvalid?: boolean
  ariaLabel: string
  onChange: (content: MagicNoteRichContent) => void
  onError: (message: string) => void
  onParagraphCommit?: (content: MagicNoteRichContent) => void
}

function safeEmbeddedFileName(file: File): string {
  const fallback = file.type.startsWith('video/')
    ? 'video'
    : file.type.startsWith('image/')
      ? 'image'
      : 'attachment'
  return (
    [...file.name]
      .map((character) => {
        const code = character.charCodeAt(0)
        return code < 32 ||
          code === 127 ||
          /[<>:"/\\|?*]/u.test(character)
          ? '_'
          : character
      })
      .join('')
      .trim()
      .slice(0, 255) || fallback
  )
}

function embeddedMimeType(file: File): string {
  const normalized = file.type.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
    normalized
  )
    ? normalized
    : 'application/octet-stream'
}

function embeddedData(content: MagicNoteRichContent): string[] {
  return content.ops.flatMap((operation) => {
    if (typeof operation.insert === 'string') {
      return []
    }
    if ('image' in operation.insert) {
      return [operation.insert.image]
    }
    if ('localVideo' in operation.insert) {
      return [operation.insert.localVideo.dataUrl]
    }
    return [operation.insert.attachment.dataUrl]
  })
}

function richContentFromQuill(quill: Quill): MagicNoteRichContent {
  return {
    version: 1,
    ops: quill.getContents().ops as MagicNoteRichContent['ops']
  }
}

export function MagicNoteEditor({
  initialContent,
  ariaDescribedBy,
  ariaInvalid = false,
  ariaLabel,
  onChange,
  onError,
  onParagraphCommit
}: MagicNoteEditorProps): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const quillRef = useRef<Quill | null>(null)
  const onChangeRef = useRef(onChange)
  const onErrorRef = useRef(onError)
  const onParagraphCommitRef = useRef(onParagraphCommit)
  const translateRef = useRef(t)
  const initialPlaceholderRef = useRef(t('editor.placeholder'))

  useEffect(() => {
    onChangeRef.current = onChange
    onErrorRef.current = onError
    onParagraphCommitRef.current = onParagraphCommit
    translateRef.current = t
  }, [onChange, onError, onParagraphCommit, t])

  const insertFiles = async (
    files: File[],
    imagesOnly = false
  ): Promise<void> => {
    const quill = quillRef.current
    if (!quill || files.length === 0) {
      return
    }
    const content = richContentFromQuill(quill)
    const imageCount = content.ops.filter(
      (operation) =>
        typeof operation.insert === 'object' &&
        'image' in operation.insert
    ).length
    const videoCount = content.ops.filter(
      (operation) =>
        typeof operation.insert === 'object' &&
        'localVideo' in operation.insert
    ).length
    const attachmentCount = content.ops.filter(
      (operation) =>
        typeof operation.insert === 'object' &&
        'attachment' in operation.insert
    ).length
    const classified = files.map((file) => {
      const mimeType = embeddedMimeType(file)
      const kind =
        supportedImageTypes.has(mimeType)
          ? 'image'
          : supportedVideoTypes.has(mimeType)
            ? 'localVideo'
            : 'attachment'
      return { file, kind, mimeType }
    })
    if (
      imagesOnly &&
      classified.some(({ kind }) => kind !== 'image')
    ) {
      onErrorRef.current(translateRef.current('editor.unsupportedImage'))
      return
    }
    const addedImageCount = classified.filter(
      ({ kind }) => kind === 'image'
    ).length
    const addedVideoCount = classified.filter(
      ({ kind }) => kind === 'localVideo'
    ).length
    const addedAttachmentCount = classified.filter(
      ({ kind }) => kind === 'attachment'
    ).length
    if (imageCount + addedImageCount > MAGIC_NOTE_MAX_IMAGES) {
      onErrorRef.current(
        translateRef.current('editor.maxImages', {
          count: MAGIC_NOTE_MAX_IMAGES
        })
      )
      return
    }
    if (videoCount + addedVideoCount > MAGIC_NOTE_MAX_VIDEOS) {
      onErrorRef.current(
        translateRef.current('editor.maxVideos', {
          count: MAGIC_NOTE_MAX_VIDEOS
        })
      )
      return
    }
    if (
      attachmentCount + addedAttachmentCount >
      MAGIC_NOTE_MAX_ATTACHMENTS
    ) {
      onErrorRef.current(
        translateRef.current('editor.maxAttachments', {
          count: MAGIC_NOTE_MAX_ATTACHMENTS
        })
      )
      return
    }
    if (
      classified.some(
        ({ file, kind }) =>
          file.size <= 0 ||
          (kind === 'image' && file.size > MAGIC_NOTE_MAX_IMAGE_BYTES) ||
          (kind === 'localVideo' &&
            file.size > MAGIC_NOTE_MAX_VIDEO_BYTES) ||
          (kind === 'attachment' &&
            file.size > MAGIC_NOTE_MAX_ATTACHMENT_BYTES)
      )
    ) {
      onErrorRef.current(
        translateRef.current('editor.unsupportedFile')
      )
      return
    }
    const currentData = embeddedData(content)
    const currentImageBytes = content.ops.reduce((total, operation) => {
      if (
        typeof operation.insert !== 'object' ||
        !('image' in operation.insert)
      ) {
        return total
      }
      return total + magicNoteDataBytes(operation.insert.image)
    }, 0)
    if (
      currentImageBytes +
        classified
          .filter(({ kind }) => kind === 'image')
          .reduce((total, { file }) => total + file.size, 0) >
      MAGIC_NOTE_MAX_TOTAL_IMAGE_BYTES
    ) {
      onErrorRef.current(translateRef.current('editor.totalImageSize'))
      return
    }
    if (
      currentData.reduce(
        (total, dataUrl) => total + magicNoteDataBytes(dataUrl),
        0
      ) +
        files.reduce((total, file) => total + file.size, 0) >
      MAGIC_NOTE_MAX_TOTAL_EMBED_BYTES
    ) {
      onErrorRef.current(translateRef.current('editor.totalEmbedSize'))
      return
    }
    try {
      const embeds = await Promise.all(
        classified.map(async ({ file, kind, mimeType }) => ({
          kind,
          file: {
            name: safeEmbeddedFileName(file),
            mimeType,
            size: file.size,
            dataUrl: await readFileAsDataUrl(file, mimeType)
          }
        }))
      )
      let index = quill.getSelection(true)?.index ?? quill.getLength() - 1
      for (const embed of embeds) {
        if (embed.kind === 'image') {
          quill.insertEmbed(index, 'image', embed.file.dataUrl, 'user')
        } else {
          quill.insertEmbed(index, embed.kind, embed.file, 'user')
        }
        quill.insertText(index + 1, '\n', 'user')
        index += 2
      }
      quill.setSelection(index, 0, 'silent')
    } catch {
      onErrorRef.current(translateRef.current('editor.fileReadFailed'))
    }
  }

  const filesFromClipboard = (
    event: ReactClipboardEvent<HTMLDivElement>
  ): File[] =>
    [...event.clipboardData.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

  const filesFromDrop = (
    event: ReactDragEvent<HTMLDivElement>
  ): File[] => [...event.dataTransfer.files]

  useEffect(() => {
    const toolbar = toolbarRef.current
    const editor = editorRef.current
    if (!toolbar || !editor) {
      return
    }
    const quill = new Quill(editor, {
      theme: 'snow',
      placeholder: initialPlaceholderRef.current,
      formats: [
        'header',
        'size',
        'color',
        'bold',
        'italic',
        'underline',
        'strike',
        'blockquote',
        'code-block',
        'code',
        'list',
        'indent',
        'align',
        'image',
        'localVideo',
        'attachment'
      ],
      modules: {
        toolbar: {
          container: toolbar,
          handlers: {
            image: () => imageInputRef.current?.click()
          }
        },
        history: {
          delay: 500,
          maxStack: 100,
          userOnly: true
        }
      }
    })
    toolbar.querySelectorAll('select').forEach((select) => {
      select.removeAttribute('aria-label')
      select.setAttribute('aria-hidden', 'true')
      select.tabIndex = -1
    })
    quillRef.current = quill
    if (initialContent) {
      quill.setContents(initialContent.ops, 'silent')
    }
    const emitChange = (): MagicNoteRichContent => {
      const content = richContentFromQuill(quill)
      onChangeRef.current(content)
      return content
    }
    const handleChange = (
      delta: Delta,
      _oldContent: Delta,
      source: EmitterSource
    ): void => {
      const content = emitChange()
      if (
        source === 'user' &&
        delta.ops.some(
          (operation) =>
            typeof operation.insert === 'string' &&
            operation.insert.includes('\n')
        )
      ) {
        onParagraphCommitRef.current?.(content)
      }
    }
    quill.on('text-change', handleChange)
    emitChange()
    return () => {
      quill.off('text-change', handleChange)
      quillRef.current = null
    }
  }, [initialContent])

  useEffect(() => {
    quillRef.current?.root.setAttribute(
      'data-placeholder',
      t('editor.placeholder')
    )
  }, [t])

  useEffect(() => {
    const root = quillRef.current?.root
    if (!root) {
      return
    }
    root.setAttribute('aria-label', ariaLabel)
    if (ariaDescribedBy) {
      root.setAttribute('aria-describedby', ariaDescribedBy)
    } else {
      root.removeAttribute('aria-describedby')
    }
    if (ariaInvalid) {
      root.setAttribute('aria-invalid', 'true')
    } else {
      root.removeAttribute('aria-invalid')
    }
  }, [ariaDescribedBy, ariaInvalid, ariaLabel])

  return (
    <div
      className="magic-note-editor"
      onDragOverCapture={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDropCapture={(event) => {
        const files = filesFromDrop(event)
        if (files.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          void insertFiles(files)
        }
      }}
      onPasteCapture={(event) => {
        const files = filesFromClipboard(event)
        if (files.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          void insertFiles(files)
        }
      }}
    >
      <div
        ref={toolbarRef}
        aria-label={t('editor.toolbarLabel')}
        className="magic-note-editor__toolbar"
        role="toolbar"
      >
        <span className="ql-formats">
          <select
            aria-label={t('editor.paragraphStyle')}
            className="ql-header"
            defaultValue=""
          >
            <option value="1">{t('editor.heading1')}</option>
            <option value="2">{t('editor.heading2')}</option>
            <option value="3">{t('editor.heading3')}</option>
            <option value="">{t('editor.body')}</option>
          </select>
          <select
            aria-label={t('editor.fontSize')}
            className="ql-size"
            defaultValue=""
          >
            <option value="small">{t('editor.fontSizeSmall')}</option>
            <option value="">{t('editor.fontSizeNormal')}</option>
            <option value="large">{t('editor.fontSizeLarge')}</option>
            <option value="huge">{t('editor.fontSizeHuge')}</option>
          </select>
        </span>
        <span className="ql-formats">
          <select
            aria-label={t('editor.textColor')}
            className="ql-color"
            defaultValue=""
          />
          <button
            aria-label={t('editor.bold')}
            className="ql-bold"
            type="button"
          />
          <button
            aria-label={t('editor.italic')}
            className="ql-italic"
            type="button"
          />
          <button
            aria-label={t('editor.underline')}
            className="ql-underline"
            type="button"
          />
          <button
            aria-label={t('editor.strike')}
            className="ql-strike"
            type="button"
          />
        </span>
        <span className="ql-formats">
          <button
            aria-label={t('editor.todoList')}
            className="ql-list"
            type="button"
            value="check"
          />
          <button
            aria-label={t('editor.bulletList')}
            className="ql-list"
            type="button"
            value="bullet"
          />
          <button
            aria-label={t('editor.numberedList')}
            className="ql-list"
            type="button"
            value="ordered"
          />
        </span>
        <span className="ql-formats">
          <button
            aria-label={t('editor.blockquote')}
            className="ql-blockquote"
            type="button"
          />
          <button
            aria-label={t('editor.codeBlock')}
            className="ql-code-block"
            type="button"
          />
          <button
            aria-label={t('editor.insertImage')}
            className="ql-image"
            type="button"
          />
          <button
            aria-label={t('editor.uploadAttachment')}
            className="magic-note-editor__attachment-button"
            type="button"
            onClick={() => attachmentInputRef.current?.click()}
          >
            <Paperclip aria-hidden="true" size={16} />
          </button>
        </span>
        <span className="ql-formats">
          <button
            aria-label={t('editor.undo')}
            type="button"
            onClick={() => quillRef.current?.history.undo()}
          >
            ↶
          </button>
          <button
            aria-label={t('editor.redo')}
            type="button"
            onClick={() => quillRef.current?.history.redo()}
          >
            ↷
          </button>
        </span>
      </div>
      <div ref={editorRef} className="magic-note-editor__content" />
      <input
        ref={imageInputRef}
        hidden
        multiple
        accept="image/jpeg,image/png,image/gif,image/webp"
        type="file"
        onChange={(event) => {
          const files = event.target.files
            ? [...event.target.files]
            : []
          event.target.value = ''
          void insertFiles(files, true)
        }}
      />
      <input
        ref={attachmentInputRef}
        hidden
        multiple
        type="file"
        onChange={(event) => {
          const files = event.target.files
            ? [...event.target.files]
            : []
          event.target.value = ''
          void insertFiles(files)
        }}
      />
    </div>
  )
}
