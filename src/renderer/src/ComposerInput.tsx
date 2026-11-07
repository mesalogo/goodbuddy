import { useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject, type TextareaHTMLAttributes } from 'react'
import { Library } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChannelIcon } from './ChannelIcon'
import { referenceDraftParts, referenceDraftText, referenceToken, type ExternalDocumentReference } from './external-references'
import { composerInputValue, composerSelection, readComposerDom, setComposerSelection, type ComposerInputElement } from './composer-input-dom'

type Snapshot = { value: string; start: number; end: number }
type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'onSelect' | 'onPaste' | 'onKeyDown' | 'onBlur' | 'value' | 'ref'> & {
  value: string
  conversationId?: string
  references: readonly ExternalDocumentReference[]
  inputRef: RefObject<ComposerInputElement | null>
  onValueChange: (value: string, input: ComposerInputElement) => void
  onInputSelection: (input: ComposerInputElement) => void
  onPaste: (event: ClipboardEvent<ComposerInputElement>) => void
  onKeyDown: (event: KeyboardEvent<ComposerInputElement>) => void
  onBlur?: () => void
}

/** Plain textarea until the first reference is picked; thereafter an atomic inline editor. */
export function ComposerInput({ value, conversationId, references, inputRef, onValueChange, onInputSelection, onPaste, onKeyDown, ...attributes }: Props): React.JSX.Element {
  const { t } = useTranslation('app')
  const palette = useRef<HTMLSpanElement>(null)
  const composing = useRef(false)
  const historyConversation = useRef(conversationId)
  const history = useRef<{ items: Snapshot[]; index: number; typingAt: number }>({ items: [{ value, start: value.length, end: value.length }], index: 0, typingAt: 0 })
  const rich = references.length > 0

  const remember = (next: Snapshot, typing = false): void => {
    const state = history.current
    if (state.items[state.index]?.value === next.value) return
    const now = Date.now()
    const merge = typing && state.typingAt > now - 500 && state.index > 0 && state.index === state.items.length - 1
    state.items.splice(merge ? state.index : state.index + 1)
    state.items.push(next)
    state.index = state.items.length - 1
    state.typingAt = typing ? now : 0
  }

  useLayoutEffect(() => {
    const element = inputRef.current
    if (!element) return
    if (historyConversation.current !== conversationId) {
      historyConversation.current = conversationId
      composing.current = false
      history.current = { items: [{ value, start: value.length, end: value.length }], index: 0, typingAt: 0 }
    }
    if (composing.current) return
    if (!value && !references.length) history.current = { items: [{ value: '', start: 0, end: 0 }], index: 0, typingAt: 0 }
    const current = history.current.items[history.current.index]!
    if (current.value !== value) {
      // External edits include inserting a reference at the current mention, voice input and draft replacement.
      let suffix = 0
      while (suffix < current.value.length && suffix < value.length && current.value.at(-1 - suffix) === value.at(-1 - suffix)) suffix++
      remember({ value, start: value.length - suffix, end: value.length - suffix })
    }
    if (!(element instanceof HTMLDivElement) || readComposerDom(element) === value) return
    const focused = document.activeElement === element
    const fragment = document.createDocumentFragment()
    for (const part of referenceDraftParts(value, references)) {
      if (typeof part === 'string') {
        part.split('\n').forEach((line, index) => {
          if (index) fragment.append(document.createElement('br'))
          fragment.append(document.createTextNode(line))
        })
        continue
      }
      const chip = document.createElement('span')
      chip.className = 'composer-inline-reference'
      chip.setAttribute('contenteditable', 'false')
      chip.setAttribute('role', 'group')
      chip.setAttribute('aria-label', `${t(`composer.references.providers.${part.provider}`)}: ${part.title}`)
      chip.dataset.referenceToken = referenceToken(part)
      chip.title = `${t(`composer.references.providers.${part.provider}`)} · ${part.libraryName ?? ''} ${part.path ?? part.url ?? part.title}`.trim()
      const icon = palette.current?.querySelector(`[data-reference-icon="${part.provider}"] svg`)
      if (icon) chip.append(icon.cloneNode(true))
      const label = document.createElement('span')
      label.textContent = part.title
      chip.append(label)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.dataset.removeReference = referenceToken(part)
      remove.setAttribute('aria-label', t('composer.references.remove', { name: part.title }))
      remove.textContent = '×'
      chip.append(remove)
      fragment.append(chip)
    }
    // Chromium needs a final placeholder BR to keep the caret on an empty trailing line.
    if (value.endsWith('\n')) {
      const tail = document.createElement('br')
      tail.setAttribute('data-composer-tail', '')
      fragment.append(tail)
    }
    // An empty text node also provides a caret position after a trailing atomic reference.
    fragment.append(document.createTextNode(''))
    element.replaceChildren(fragment)
    if (focused) {
      const snapshot = history.current.items[history.current.index]!
      setComposerSelection(element, snapshot.start, snapshot.end)
    }
  }, [value, conversationId, references, inputRef, t])

  const notify = (element: ComposerInputElement, typing = false): void => {
    const next = composerInputValue(element)
    const selection = composerSelection(element)
    remember({ value: next, ...selection }, typing)
    onValueChange(next, element)
  }
  const replace = (text: string, start?: number, end?: number): void => {
    const element = inputRef.current
    if (!element) return
    const selection = composerSelection(element)
    const from = start ?? selection.start, to = end ?? selection.end
    Object.assign(history.current.items[history.current.index]!, selection)
    const old = composerInputValue(element)
    const next = old.slice(0, from) + text + old.slice(to)
    remember({ value: next, start: from + text.length, end: from + text.length })
    element.focus()
    onValueChange(next, element)
  }
  const keys = (event: KeyboardEvent<ComposerInputElement>): void => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (rich && (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      event.preventDefault()
      const state = history.current
      const nextIndex = state.index + (event.shiftKey || event.key.toLowerCase() === 'y' ? 1 : -1)
      const next = state.items[nextIndex]
      if (next) {
        state.index = nextIndex
        state.typingAt = 0
        onValueChange(next.value, event.currentTarget)
      }
      return
    }
    onKeyDown(event)
    if (event.defaultPrevented || !rich) return
    if (event.key === 'Enter') { event.preventDefault(); replace('\n'); return }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const selection = composerSelection(event.currentTarget)
      if (selection.start !== selection.end) return
      const text = composerInputValue(event.currentTarget)
      for (const reference of references) {
        const token = referenceToken(reference), start = text.indexOf(token)
        if (start < 0) continue
        if ((event.key === 'Backspace' && selection.start === start + token.length) || (event.key === 'Delete' && selection.start === start)) {
          event.preventDefault(); replace('', start, start + token.length); return
        }
      }
    }
  }
  const clipboard = (event: ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
    const { start, end } = composerSelection(event.currentTarget)
    if (start === end) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', referenceDraftText(readComposerDom(event.currentTarget).slice(start, end), references))
    if (cut) replace('')
  }
  const beforeInput = (): void => {
    const element = inputRef.current
    if (element) Object.assign(history.current.items[history.current.index]!, composerSelection(element))
  }
  const { rows, placeholder, onBlur, ...common } = attributes
  return <>
    {rich ? <div
      {...common as React.HTMLAttributes<HTMLDivElement>}
      className="composer-inline-input"
      contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
      data-placeholder={placeholder}
      ref={element => { inputRef.current = element }}
      onBlur={onBlur}
      onBeforeInput={beforeInput}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={event => { composing.current = false; notify(event.currentTarget) }}
      onInput={event => { if (!composing.current) notify(event.currentTarget, (event.nativeEvent as InputEvent).inputType === 'insertText') }}
      onSelect={event => onInputSelection(event.currentTarget)}
      onKeyDown={keys}
      onPaste={event => { onPaste(event); if (!event.defaultPrevented) { event.preventDefault(); replace(event.clipboardData.getData('text/plain').replace(/\r\n?/gu, '\n')) } }}
      onDrop={event => { if (!event.dataTransfer.files.length) { event.preventDefault(); replace(event.dataTransfer.getData('text/plain')) } }}
      onCopy={event => clipboard(event, false)} onCut={event => clipboard(event, true)}
      onMouseDown={event => { if ((event.target as HTMLElement).closest('[data-remove-reference]')) event.preventDefault() }}
      onClick={event => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-reference]')
        const token = button?.dataset.removeReference
        if (!token) return
        const start = readComposerDom(event.currentTarget).indexOf(token)
        if (start >= 0) replace('', start, start + token.length)
      }}
    /> : <textarea {...common} rows={rows} placeholder={placeholder} value={value}
      ref={element => { inputRef.current = element }} onBlur={onBlur}
      onBeforeInput={beforeInput}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={event => { composing.current = false; notify(event.currentTarget) }}
      onChange={event => notify(event.currentTarget, true)}
      onSelect={event => onInputSelection(event.currentTarget)} onKeyDown={keys} onPaste={onPaste}
    />}
    <span hidden aria-hidden="true" ref={palette}>
      <span data-reference-icon="local"><Library size={14} /></span>
      <span data-reference-icon="wecom"><ChannelIcon channel="wecom" size={14} /></span>
      <span data-reference-icon="feishu"><ChannelIcon channel="feishu" size={14} /></span>
    </span>
  </>
}
