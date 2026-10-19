import type { CoreContent } from './model'

export interface CanvasController {
  content(): CoreContent
  flush(): Promise<CoreContent>
  activePage(): Promise<number>
  /** The element sized to the visible current page, used to overlay page-relative UI. */
  pageElement(): HTMLElement
  capturePages(options?: { firstPageOnly?: boolean; thumbnailWidth?: number; pageLimit?: number; pageStart?: number; includeImages?: boolean }): Promise<{ pageId: string; dataUrl: string; text?: string }[]>
  focus(): void
  setDisabled(value: boolean): void
  destroy(): Promise<void>
  hasContent(): boolean
}

export function mountCanvasNote(host: HTMLElement, initialContent: CoreContent, options: {
  disabled?: boolean
  signal?: AbortSignal
  onChange?(content: CoreContent): void
  onError?(message: string): void
  pickPdf?(): Promise<{ assetId: string; name: string } | null>
  readPdf?(reference: { assetId: string }): Promise<Uint8Array>
  onPdfText?(assetId: string, pageNumber: number, text: string): void
  savePdf?(bytes: Uint8Array, name: string): Promise<void>
}): CanvasController
