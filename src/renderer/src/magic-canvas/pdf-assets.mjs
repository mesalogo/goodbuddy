/* global fetch, atob */
const urls = import.meta.glob('../../../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
  query: '?url', import: 'default', eager: true
});
const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };

export class CanvasPdfBinaryDataFactory {
  async fetch({ kind, filename }) {
    const url = urls[`../../../../node_modules/pdfjs-dist/${directories[kind]}/${filename}`];
    if (!url) throw new Error(`PDF 资源不可用：${filename}`);
    if (url.startsWith('data:')) {
      const binary = atob(url.slice(url.indexOf(',') + 1));
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PDF 资源加载失败：${filename}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
