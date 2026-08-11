import Quill from 'quill'
import { BlockEmbed } from 'quill/blots/block'

type EmbeddedFile = {
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

class LocalVideoBlot extends BlockEmbed {
  static blotName = 'localVideo'
  static className = 'magic-note-local-video'
  static tagName = 'video'

  static create(value: EmbeddedFile): HTMLElement {
    const node = super.create() as HTMLVideoElement
    node.controls = true
    node.preload = 'metadata'
    node.src = value.dataUrl
    node.dataset.name = value.name
    node.dataset.mimeType = value.mimeType
    node.dataset.size = String(value.size)
    node.setAttribute('aria-label', value.name)
    return node
  }

  static value(domNode: HTMLElement): EmbeddedFile {
    return {
      name: domNode.dataset.name ?? '',
      mimeType: domNode.dataset.mimeType ?? '',
      size: Number(domNode.dataset.size ?? 0),
      dataUrl: domNode.getAttribute('src') ?? ''
    }
  }
}

class AttachmentBlot extends BlockEmbed {
  static blotName = 'attachment'
  static className = 'magic-note-attachment'
  static tagName = 'a'

  static create(value: EmbeddedFile): HTMLElement {
    const node = super.create() as HTMLAnchorElement
    node.href = value.dataUrl
    node.download = value.name
    node.dataset.name = value.name
    node.dataset.mimeType = value.mimeType
    node.dataset.size = String(value.size)
    node.setAttribute('aria-label', value.name)
    node.setAttribute('contenteditable', 'false')
    node.textContent = value.name
    return node
  }

  static value(domNode: HTMLElement): EmbeddedFile {
    return {
      name: domNode.dataset.name ?? '',
      mimeType: domNode.dataset.mimeType ?? '',
      size: Number(domNode.dataset.size ?? 0),
      dataUrl: domNode.getAttribute('href') ?? ''
    }
  }
}

Quill.register(LocalVideoBlot)
Quill.register(AttachmentBlot)
