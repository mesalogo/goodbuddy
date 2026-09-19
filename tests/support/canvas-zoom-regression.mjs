/* global window, document, getComputedStyle, requestAnimationFrame, Image */
import Quill from 'quill';
import { jsPDF as JsPdf } from 'jspdf';
import { mountCanvasNote } from '../../src/renderer/src/magic-canvas/canvas-note.mjs';

const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export async function setupZoom(scale) {
  await window.editor?.destroy();
  document.querySelector('#outer').style.display = 'none';
  const layout = document.querySelector('#layout');
  layout.style.cssText = 'width:900px;height:650px;overflow:auto';
  layout.innerHTML = '<div class="magic-canvas-editor"></div>';
  const host = layout.firstElementChild;
  const errors = [];
  let changes = 0;
  const pdf = new JsPdf({ unit: 'px', format: [794, 1123], hotfixes: ['px_scaling'] });
  pdf.setFillColor(255, 0, 0);
  pdf.rect(30, 30, 100, 40, 'F');
  const bytes = new Uint8Array(pdf.output('arraybuffer'));
  const editor = mountCanvasNote(host, { version: 2, pages: [{
    id: 'pdf-page', width: 794, height: 1123,
    background: { type: 'pdf', assetId: 'pdf-zoom', page: 1 },
    objects: [{ type: 'Rect', canvasKind: 'rectangle', left: 160, top: 100,
      width: 80, height: 60, fill: '#0000ff', strokeWidth: 1, originX: 'left', originY: 'top' }]
  }], flow: { version: 1, ops: [{ insert: 'Flow zoom body\n'.repeat(55) }] } }, {
    readPdf: async () => bytes, onError: message => errors.push(message), onChange: () => changes++
  });
  window.editor = editor;
  await editor.flush();
  const click = suffix => host.querySelector(`.canvas-note-${suffix}`).click();
  const setScale = value => {
    click('zoom-reset');
    for (let i = 0; i < Math.abs(value - 1) * 4; i++) click(value < 1 ? 'zoom-out' : 'zoom-in');
  };
  setScale(scale);
  const tool = name => host.querySelector(`[data-tool="${name}"]`).click();
  tool('pen');
  window.zoomFixture = {
    tool,
    async flowPoint() {
      click('next-page');
      await editor.flush();
      tool('flow-text');
      layout.scrollTop = 0;
      const layer = host.querySelector('.canvas-flow-layer').getBoundingClientRect();
      const surface = host.querySelector('.canvas-flow-surface');
      const rect = [...surface.children].flatMap(child => [...child.getClientRects()])
        .find(rect => rect.left >= layer.left - 1 && rect.left < layer.right && rect.top >= layer.top && rect.top < layer.top + 50);
      return { x: Math.round(rect.left + 8 * scale), y: Math.round(rect.top + 10 * scale) };
    },
    point(x, y) {
      const rect = host.querySelector('.upper-canvas').getBoundingClientRect();
      return { x: Math.round(rect.left + x * scale), y: Math.round(rect.top + y * scale) };
    },
    async verify() {
      tool('select');
      setScale(1);
      const before = JSON.stringify(await editor.flush());
      const captures = await editor.capturePages();
      changes = 0;
      setScale(scale);
      await editor.flush();
      const scaled = await editor.capturePages();
      const image = new Image();
      image.src = scaled[0].dataUrl;
      await image.decode();
      const background = host.querySelector('.canvas-note-background');
      const pixel = background.getContext('2d').getImageData(40, 40, 1, 1).data;
      const paper = background.getContext('2d').getImageData(200, 40, 1, 1).data;
      const viewport = host.querySelector('.canvas-note-viewport');
      const pageHeight = host.querySelector('.canvas-note-page').getBoundingClientRect().height;
      const maxY = viewport.scrollHeight - viewport.clientHeight;
      click('next-page');
      await editor.flush();
      const retainedZoom = host.querySelector('.canvas-note-zoom-reset').textContent === `${scale * 100}%`;
      tool('flow-text');
      const quill = Quill.find(host.querySelector('.canvas-flow-quill'));
      quill.setSelection(quill.getLength() - 2, 0, 'user');
      await settle();
      await editor.flush();
      const followedPage = host.querySelector('.canvas-note-page-counter').textContent;
      click('previous-page');
      await editor.flush();
      return { errors, changes, sameContent: JSON.stringify(editor.content()) === before,
        samePng: JSON.stringify(captures) === JSON.stringify(scaled), pngSize: [image.width, image.height],
        pdfInk: pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10 && paper[0] > 240,
        pageHeight, maxY,
        pageCount: editor.content().pages.length, retainedZoom, followedPage };
    },
    async verifyLayout() {
      await editor.destroy();
      host.classList.add('magic-canvas-content');
      document.documentElement.dataset.theme = 'dark';
      const viewer = mountCanvasNote(host, { version: 2, pages: [
        { id: 'portrait', width: 794, height: 1123, objects: [] },
        { id: 'landscape', width: 1123, height: 794, objects: [] }
      ] }, { disabled: true, onChange: () => changes++, onError: message => errors.push(message) });
      window.editor = viewer;
      const before = JSON.stringify(await viewer.flush());
      changes = 0;
      click('zoom-fit');
      const states = [];
      for (const width of [900, 360, 600]) {
        layout.style.width = `${width}px`;
        await settle();
        for (let page = 0; page < 2; page++) {
          if (page) click('next-page');
          else click('previous-page');
          await viewer.flush();
          await settle();
          const viewport = host.querySelector('.canvas-note-viewport');
          const css = getComputedStyle(viewport);
          const rect = host.querySelector('.canvas-note-page').getBoundingClientRect();
          const logical = viewer.content().pages[page];
          const controls = host.querySelector('.canvas-note-zoom-controls');
          states.push({ pageWidth: rect.width, pageHeight: rect.height, logicalHeight: logical.height,
            scale: rect.width / logical.width,
            available: viewport.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
            maxX: viewport.scrollWidth - viewport.clientWidth, maxY: viewport.scrollHeight - viewport.clientHeight,
            outerX: layout.scrollWidth - layout.clientWidth,
            enabled: !host.querySelector('.canvas-note-zoom-in').disabled,
            visible: controls.getBoundingClientRect().width > 0 && controls.getBoundingClientRect().right <= layout.getBoundingClientRect().right });
        }
      }
      const sameContent = JSON.stringify(await viewer.flush()) === before;
      layout.style.width = '360px';
      await settle();
      window.zoomFixture.resizeCheck = async () => {
        await settle();
        const viewport = host.querySelector('.canvas-note-viewport');
        const css = getComputedStyle(viewport);
        const available = viewport.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
        return Math.abs(host.querySelector('.canvas-note-page').getBoundingClientRect().width - available) < 1
          && JSON.stringify(await viewer.flush()) === before && changes === 0;
      };
      return { errors, states, changes, sameContent };
    }
  };
}
