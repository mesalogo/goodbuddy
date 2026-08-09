import {
  useEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import Quill from 'quill'
import 'quill/dist/quill.snow.css'
import {
  MAGIC_NOTE_MAX_IMAGES,
  MAGIC_NOTE_MAX_IMAGE_BYTES,
  MAGIC_NOTE_MAX_TOTAL_IMAGE_BYTES,
  magicNoteImageDataBytes,
  type MagicNoteRichContent
} from '../../shared/magic-notes-contracts'

const supportedImageTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
])

export type MagicNoteEditorProps = {
  initialContent?: MagicNoteRichContent
  ariaDescribedBy?: string
  ariaInvalid?: boolean
  ariaLabel: string
  onChange: (content: MagicNoteRichContent) => void
  onError: (message: string) => void
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('图片读取失败'))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
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
  onError
}: MagicNoteEditorProps): React.JSX.Element {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const quillRef = useRef<Quill | null>(null)
  const onChangeRef = useRef(onChange)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onChangeRef.current = onChange
    onErrorRef.current = onError
  }, [onChange, onError])

  const insertImages = async (files: File[]): Promise<void> => {
    const quill = quillRef.current
    if (!quill || files.length === 0) {
      return
    }
    const currentImageData = quill
      .getContents()
      .ops.filter(
        (operation) =>
          typeof operation.insert === 'object' &&
          operation.insert !== null &&
          'image' in operation.insert
      )
      .map((operation) => {
        const insert = operation.insert as { image?: unknown }
        return typeof insert.image === 'string' ? insert.image : ''
      })
      .filter(Boolean)
    if (currentImageData.length + files.length > MAGIC_NOTE_MAX_IMAGES) {
      onErrorRef.current(
        `每条记录最多包含 ${MAGIC_NOTE_MAX_IMAGES} 张图片`
      )
      return
    }
    if (
      files.some(
        (file) =>
          !supportedImageTypes.has(file.type) ||
          file.size <= 0 ||
          file.size > MAGIC_NOTE_MAX_IMAGE_BYTES
      )
    ) {
      onErrorRef.current(
        '只支持小于 2 MB 的 JPEG、PNG、GIF 或 WebP 图片'
      )
      return
    }
    const currentImageBytes = currentImageData.reduce((total, dataUrl) => {
      return total + magicNoteImageDataBytes(dataUrl)
    }, 0)
    if (
      currentImageBytes +
        files.reduce((total, file) => total + file.size, 0) >
      MAGIC_NOTE_MAX_TOTAL_IMAGE_BYTES
    ) {
      onErrorRef.current('本次添加的图片总大小不能超过 8 MB')
      return
    }
    try {
      const dataUrls = await Promise.all(files.map(readFileAsDataUrl))
      let index = quill.getSelection(true)?.index ?? quill.getLength() - 1
      for (const dataUrl of dataUrls) {
        quill.insertEmbed(index, 'image', dataUrl, 'user')
        quill.insertText(index + 1, '\n', 'user')
        index += 2
      }
      quill.setSelection(index, 0, 'silent')
    } catch (error) {
      onErrorRef.current(
        error instanceof Error ? error.message : '图片读取失败'
      )
    }
  }

  useEffect(() => {
    const toolbar = toolbarRef.current
    const editor = editorRef.current
    if (!toolbar || !editor) {
      return
    }
    const quill = new Quill(editor, {
      theme: 'snow',
      placeholder: '记录想法、会议内容或待办线索…',
      formats: [
        'header',
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
        'image'
      ],
      modules: {
        toolbar: {
          container: toolbar,
          handlers: {
            image: () => inputRef.current?.click()
          }
        },
        history: {
          delay: 500,
          maxStack: 100,
          userOnly: true
        }
      }
    })
    quillRef.current = quill
    if (initialContent) {
      quill.setContents(initialContent.ops, 'silent')
    }
    const handleChange = (): void => {
      onChangeRef.current(richContentFromQuill(quill))
    }
    quill.on('text-change', handleChange)
    handleChange()
    return () => {
      quill.off('text-change', handleChange)
      quillRef.current = null
    }
  }, [initialContent])

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

  const imageFilesFromClipboard = (
    event: ReactClipboardEvent<HTMLDivElement>
  ): File[] =>
    [...event.clipboardData.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

  const imageFilesFromDrop = (
    event: ReactDragEvent<HTMLDivElement>
  ): File[] => [...event.dataTransfer.files]

  return (
    <div
      className="magic-note-editor"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        const files = imageFilesFromDrop(event)
        if (files.length > 0) {
          event.preventDefault()
          void insertImages(files)
        }
      }}
      onPaste={(event) => {
        const files = imageFilesFromClipboard(event)
        if (files.length > 0) {
          event.preventDefault()
          void insertImages(files)
        }
      }}
    >
      <div ref={toolbarRef} className="magic-note-editor__toolbar">
        <select aria-label="段落样式" className="ql-header" defaultValue="">
          <option value="1">标题 1</option>
          <option value="2">标题 2</option>
          <option value="3">标题 3</option>
          <option value="">正文</option>
        </select>
        <button aria-label="粗体" className="ql-bold" type="button" />
        <button aria-label="斜体" className="ql-italic" type="button" />
        <button aria-label="下划线" className="ql-underline" type="button" />
        <button aria-label="删除线" className="ql-strike" type="button" />
        <button
          aria-label="待办清单"
          className="ql-list"
          type="button"
          value="check"
        />
        <button
          aria-label="项目符号列表"
          className="ql-list"
          type="button"
          value="bullet"
        />
        <button
          aria-label="编号列表"
          className="ql-list"
          type="button"
          value="ordered"
        />
        <button aria-label="引用" className="ql-blockquote" type="button" />
        <button aria-label="代码块" className="ql-code-block" type="button" />
        <button aria-label="插入本地图片" className="ql-image" type="button" />
        <button
          aria-label="撤销"
          type="button"
          onClick={() => quillRef.current?.history.undo()}
        >
          ↶
        </button>
        <button
          aria-label="重做"
          type="button"
          onClick={() => quillRef.current?.history.redo()}
        >
          ↷
        </button>
      </div>
      <div ref={editorRef} className="magic-note-editor__content" />
      <input
        ref={inputRef}
        hidden
        multiple
        accept="image/jpeg,image/png,image/gif,image/webp"
        type="file"
        onChange={(event) => {
          const files = event.target.files
            ? [...event.target.files]
            : []
          event.target.value = ''
          void insertImages(files)
        }}
      />
    </div>
  )
}
