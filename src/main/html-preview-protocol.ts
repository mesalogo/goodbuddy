import { protocol } from 'electron'

/** Serves the supplied preview only; no files, credentials or application APIs. */
export function registerHtmlPreviewProtocol(): void {
  protocol.handle('goodbuddy-html', (request) => {
    const url = new URL(request.url)
    const html = url.searchParams.get('html')
    if (url.hostname !== 'preview' || url.pathname !== '/' || html === null) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    })
  })
}
