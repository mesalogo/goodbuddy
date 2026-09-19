// Adapted from PeopleLib (MIT). See NOTICE.md.
/* global document, TextEncoder, btoa, Image, cancelAnimationFrame, requestAnimationFrame, XMLSerializer, getComputedStyle */
import Quill from 'quill';
let pageBreakRegistered = false;
const FLOW_VERSION = 1;
const MAX_OPS = 5000;
const MAX_TEXT = 20000;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const INLINE_FORMATS = ['bold', 'italic', 'underline', 'strike', 'code'];
const BLOCK_FORMATS = ['header', 'blockquote', 'code-block', 'list', 'indent'];
const FLOW_FORMATS = [...INLINE_FORMATS, ...BLOCK_FORMATS, 'canvasPageBreak'];

class FlowHistory extends Quill.import('modules/history') {
  record(delta, oldDelta) {
    try {
      normalizeFlowContent({ version: FLOW_VERSION, ops: oldDelta.compose(delta).ops });
    } catch {
      // Reject before History merges the edit or clears accepted redo entries.
      this.rejectedRange = this.currentRange;
      return;
    }
    super.record(delta, oldDelta);
  }
}

// Keep the custom History module local to canvas editors.
class FlowQuill extends Quill {
  static imports = { ...Quill.imports, 'modules/history': FlowHistory };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedAttributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of INLINE_FORMATS) {
    if (value[key] === true) result[key] = true;
  }
  if (value.header === 1 || value.header === 2) result.header = value.header;
  if (value.blockquote === true) result.blockquote = true;
  if (value['code-block'] === true || value['code-block'] === 'plain') {
    result['code-block'] = 'plain';
  }
  if (['ordered', 'bullet', 'checked', 'unchecked'].includes(value.list)) result.list = value.list;
  if (Number.isInteger(value.indent) && value.indent >= 1 && value.indent <= 8) result.indent = value.indent;
  return Object.keys(result).length ? result : null;
}

export function normalizeFlowContent(value) {
  if (!value || value.version !== FLOW_VERSION || !Array.isArray(value.ops)) return null;
  if (value.ops.length > MAX_OPS) throw new RangeError(`全局文本最多支持 ${MAX_OPS.toLocaleString()} 个格式片段`);
  const ops = [];
  const pageIds = new Set();
  let textLength = 0;
  for (const raw of value.ops) {
    if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'insert')) continue;
    if (typeof raw.insert === 'string') {
      textLength += raw.insert.length;
      if (!raw.insert) continue;
      const attributes = normalizedAttributes(raw.attributes);
      ops.push({
        insert: raw.insert,
        ...(attributes ? { attributes } : {})
      });
      continue;
    }
    const pageId = raw.insert && typeof raw.insert === 'object'
      ? String(raw.insert.canvasPageBreak || '')
      : '';
    if (!PAGE_ID_RE.test(pageId) || pageIds.has(pageId)) continue;
    pageIds.add(pageId);
    ops.push({ insert: { canvasPageBreak: pageId } });
  }
  // Quill 的最后一个换行是文档终止符，不计入正文；内部换行仍计数。
  const lastInsert = ops.at(-1)?.insert;
  if (typeof lastInsert === 'string' && lastInsert.endsWith('\n')) textLength -= 1;
  if (textLength > MAX_TEXT) throw new RangeError(`全局文本最多支持 ${MAX_TEXT.toLocaleString()} 个字符（不含末尾换行）`);
  return textLength > 0 || ops.some((op) => typeof op.insert === 'object')
    ? { version: FLOW_VERSION, ops } : null;
}

export function flowPlainText(value) {
  const flow = normalizeFlowContent(value);
  if (!flow) return '';
  return flow.ops
    .filter((op) => typeof op.insert === 'string')
    .map((op) => op.insert)
    .join('')
    .replace(/\n$/, '');
}

function registerPageBreak(Quill) {
  if (pageBreakRegistered) return;
  const BlockEmbed = Quill.import('blots/block/embed');
  class CanvasPageBreak extends BlockEmbed {
    static create(value) {
      const node = super.create();
      const pageId = String(value || '');
      if (PAGE_ID_RE.test(pageId)) node.dataset.pageId = pageId;
      node.setAttribute('aria-hidden', 'true');
      return node;
    }

    static value(node) {
      return String(node?.dataset?.pageId || '');
    }
  }
  CanvasPageBreak.blotName = 'canvasPageBreak';
  CanvasPageBreak.tagName = 'div';
  CanvasPageBreak.className = 'canvas-flow-page-break';
  Quill.register(CanvasPageBreak, true);
  pageBreakRegistered = true;
}

function makeFormatButton(name, title, value = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ql-${name}`;
  if (value != null) button.value = value;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

function createToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'canvas-flow-toolbar ql-toolbar ql-snow';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '全局文本格式');
  const formats = document.createElement('span');
  formats.className = 'ql-formats';
  const header = document.createElement('select');
  header.className = 'ql-header';
  header.title = '段落样式';
  [
    ['', '正文'],
    ['1', '一级标题'],
    ['2', '二级标题']
  ].forEach(([value, label], index) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = index === 0;
    header.appendChild(option);
  });
  formats.append(
    header,
    makeFormatButton('bold', '加粗'),
    makeFormatButton('italic', '斜体'),
    makeFormatButton('underline', '下划线'),
    makeFormatButton('strike', '删除线'),
    makeFormatButton('blockquote', '引用'),
    makeFormatButton('code-block', '代码块'),
    makeFormatButton('list', '有序列表', 'ordered'),
    makeFormatButton('list', '无序列表', 'bullet'),
    makeFormatButton('list', '待办清单', 'check')
  );
  toolbar.appendChild(formats);
  return toolbar;
}

function dataUrl(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('全局文本导出失败'));
    image.src = url;
  });
}

export function mountFlowText(layerHost, toolbarHost, initialContent, options = {}) {
  const initial = normalizeFlowContent(initialContent);
  registerPageBreak(Quill);
  layerHost.textContent = '';
  toolbarHost.textContent = '';

  const toolbar = createToolbar();
  const editorHost = document.createElement('div');
  editorHost.className = 'canvas-flow-quill';
  layerHost.appendChild(editorHost);
  toolbarHost.appendChild(toolbar);

  const quill = new FlowQuill(editorHost, {
    theme: 'snow',
    placeholder: '输入正文，内容超过纸张后会自动分页',
    formats: FLOW_FORMATS,
    modules: {
      toolbar,
      history: {
        delay: 700,
        maxStack: 100,
        userOnly: true
      }
    }
  });
  const surface = quill.root;
  surface.classList.add('canvas-flow-surface');
  surface.setAttribute('aria-label', '画布全局文本');
  surface.setAttribute('aria-multiline', 'true');

  if (initial) quill.setContents(initial.ops, 'silent');
  quill.history.clear();

  let destroyed = false;
  let active = false;
  let frame = 0;
  let secondFrame = 0;
  let measuredPages = 1;
  let suppressUserFollowSelection = false;
  let layout = { width: 640, height: 960, gap: 48, pageIndex: 0 };
  let pendingResolvers = [];

  function content() {
    return normalizeFlowContent({
      version: FLOW_VERSION,
      ops: quill.getContents().ops
    });
  }

  function resolvePending() {
    const resolvers = pendingResolvers;
    pendingResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

  function pageCount() {
    const rootRect = surface.getBoundingClientRect();
    const scale = rootRect.width / layout.width || 1;
    const span = layout.width + layout.gap;
    let maxColumn = 0;
    for (const child of surface.children) {
      for (const rect of child.getClientRects()) {
        const relativeLeft = (rect.left - rootRect.left) / scale;
        maxColumn = Math.max(maxColumn, Math.max(0, Math.round(relativeLeft / span)));
      }
    }
    const scrollColumns = Math.max(1, Math.ceil(
      (Math.max(layout.width, surface.scrollWidth) + layout.gap) / span
    ));
    return Math.max(1, maxColumn + 1, scrollColumns);
  }

  function measure() {
    if (destroyed) return;
    const next = pageCount();
    if (next !== measuredPages) {
      measuredPages = next;
      options.onPageCount?.(next);
    }
    options.onHistoryChange?.();
    resolvePending();
  }

  function selectionPage() {
    const range = quill.getSelection();
    if (!range) return layout.pageIndex;
    const index = Math.min(Math.max(0, range.index), Math.max(0, quill.getLength() - 1));
    const bounds = quill.getBounds(index, Math.max(0, range.length));
    const scale = surface.getBoundingClientRect().width / layout.width || 1;
    const span = layout.width + layout.gap;
    return Math.max(0, layout.pageIndex + Math.round((Number(bounds?.left) || 0) / scale / span));
  }

  function followSelection() {
    if (!active || destroyed) return;
    options.onActivePage?.(selectionPage());
  }

  function scheduleLayout() {
    if (destroyed) return Promise.resolve();
    const promise = new Promise((resolve) => pendingResolvers.push(resolve));
    if (frame) cancelAnimationFrame(frame);
    if (secondFrame) cancelAnimationFrame(secondFrame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      secondFrame = requestAnimationFrame(() => {
        secondFrame = 0;
        measure();
      });
    });
    return promise;
  }

  function applyLayout() {
    const container = surface.parentElement;
    const span = layout.width + layout.gap;
    layerHost.style.width = `${layout.width}px`;
    layerHost.style.height = `${layout.height}px`;
    if (container) {
      container.style.width = `${layout.width}px`;
      container.style.height = `${layout.height}px`;
    }
    surface.style.width = `${layout.width}px`;
    surface.style.height = `${layout.height}px`;
    surface.style.columnWidth = `${layout.width}px`;
    surface.style.columnGap = `${layout.gap}px`;
    surface.style.transform = `translateX(${-layout.pageIndex * span}px)`;
    scheduleLayout();
  }

  function findPageBreak(pageId) {
    const target = String(pageId || '');
    let index = 0;
    for (const op of quill.getContents().ops) {
      if (op.insert && typeof op.insert === 'object'
        && op.insert.canvasPageBreak === target) return index;
      index += typeof op.insert === 'string' ? op.insert.length : 1;
    }
    return -1;
  }

  quill.on('text-change', (delta, oldDelta, source) => {
    if (source === 'user') {
      try {
        content();
      } catch (error) {
        const history = quill.history;
        const range = history.rejectedRange;
        history.ignoreChange = true;
        try {
          quill.updateContents(delta.invert(oldDelta), 'silent');
        } finally {
          history.ignoreChange = false;
        }
        if (range) quill.setSelection(range, 'silent');
        history.currentRange = range;
        history.rejectedRange = null;
        suppressUserFollowSelection = false;
        options.onError?.(error.message);
        scheduleLayout();
        return;
      }
    }
    const layoutPromise = scheduleLayout();
    options.onHistoryChange?.();
    if (source === 'user') {
      const follow = !suppressUserFollowSelection;
      suppressUserFollowSelection = false;
      options.onChange?.(content(), delta, oldDelta);
      if (follow) layoutPromise.then(followSelection);
    }
  });
  quill.on('selection-change', (range, oldRange, source) => {
    if (source === 'user' && range) requestAnimationFrame(followSelection);
  });

  return {
    pageCount,
    content,
    text: () => flowPlainText(content()),
    hasContent: () => !!flowPlainText(content()).trim(),
    pageBreakIds() {
      const ids = [];
      for (const op of content()?.ops || []) {
        if (op.insert && typeof op.insert === 'object' && op.insert.canvasPageBreak) {
          ids.push(op.insert.canvasPageBreak);
        }
      }
      return ids;
    },
    activePageIndex: selectionPage,
    insertPageBreak(pageId) {
      const id = String(pageId || '');
      if (!PAGE_ID_RE.test(id) || findPageBreak(id) >= 0) return false;
      const range = quill.getSelection();
      const index = range
        ? Math.min(quill.getLength() - 1, range.index + range.length)
        : Math.max(0, quill.getLength() - 1);
      suppressUserFollowSelection = true;
      quill.insertEmbed(index, 'canvasPageBreak', id, 'user');
      quill.setSelection(index + 1, 0, 'silent');
      scheduleLayout();
      return true;
    },
    removePageBreak(pageId) {
      const index = findPageBreak(pageId);
      if (index < 0) return false;
      suppressUserFollowSelection = true;
      quill.deleteText(index, 1, 'user');
      scheduleLayout();
      return true;
    },
    setActive(nextActive) {
      active = Boolean(nextActive);
      toolbarHost.classList.toggle('hidden', !active);
      layerHost.classList.toggle('canvas-flow-active', active);
      quill.enable(active);
    },
    setBusy(value) {
      quill.enable(active && !value);
    },
    setLayout(width, height, pageIndex) {
      layout = {
        width: Math.max(240, Math.round(Number(width) || 640)),
        height: Math.max(240, Math.round(Number(height) || 960)),
        gap: 48,
        pageIndex: Math.max(0, Math.round(Number(pageIndex) || 0))
      };
      applyLayout();
    },
    setPageIndex(pageIndex) {
      layout.pageIndex = Math.max(0, Math.round(Number(pageIndex) || 0));
      applyLayout();
    },
    focus() {
      if (!active) return;
      quill.focus();
    },
    undo() {
      quill.history.undo();
      scheduleLayout();
    },
    redo() {
      quill.history.redo();
      scheduleLayout();
    },
    canUndo: () => (quill.history.stack?.undo?.length || 0) > 0,
    canRedo: () => (quill.history.stack?.redo?.length || 0) > 0,
    async flush() {
      await scheduleLayout();
      return cloneJson(content());
    },
    async renderPage(pageIndex, pageWidth, pageHeight) {
      const canvas = document.createElement('canvas');
      canvas.width = pageWidth;
      canvas.height = pageHeight;
      if (!flowPlainText(content()).trim()) return canvas;
      const clone = surface.cloneNode(true);
      const originals = [surface, ...surface.querySelectorAll('*')];
      const copies = [clone, ...clone.querySelectorAll('*')];
      const properties = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
        'text-decoration', 'text-align', 'white-space', 'word-break', 'overflow-wrap',
        'padding', 'margin', 'border', 'background-color', 'color', 'column-fill', 'break-after',
        'position', 'list-style-type'];
      originals.forEach((node, index) => {
        const computed = getComputedStyle(node);
        properties.forEach((property) => copies[index].style.setProperty(property, computed.getPropertyValue(property)));
      });
      clone.removeAttribute('contenteditable');
      clone.classList.remove('ql-blank');
      clone.querySelectorAll('.ql-ui, .ql-cursor').forEach((node) => node.remove());
      const counters = Array(9).fill(0);
      for (const node of clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li[data-list]')) {
        if (node.tagName !== 'LI') {
          counters.fill(0);
          continue;
        }
        const depth = Number(node.className.match(/\bql-indent-([1-8])\b/)?.[1] || 0);
        counters.fill(0, depth + 1);
        let label = { bullet: '\u2022', checked: '\u2611', unchecked: '\u2610' }[node.dataset.list];
        if (node.dataset.list === 'ordered') {
          let number = ++counters[depth];
          label = '';
          if (depth % 3 === 1) {
            while (number > 0) {
              number -= 1;
              label = String.fromCharCode(97 + number % 26) + label;
              number = Math.floor(number / 26);
            }
          } else if (depth % 3 === 2) {
            for (const [value, roman] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) {
              while (number >= value) { label += roman; number -= value; }
            }
          } else label = String(number);
          label += '.';
        }
        const marker = document.createElement('span');
        marker.textContent = label || '';
        marker.style.cssText = 'position:absolute;display:inline-block;margin-left:-1.5em;width:1.2em;text-align:right;white-space:nowrap';
        node.prepend(marker);
      }
      clone.style.position = 'relative';
      clone.style.margin = '0';
      clone.style.padding = '0';
      clone.style.overflow = 'visible';
      clone.style.color = '#111827';
      clone.style.background = 'transparent';
      clone.style.transform = `translateX(${-Math.max(0, pageIndex) * (layout.width + layout.gap)}px)`;
      const x = Math.max(0, Math.round((pageWidth - layout.width) / 2));
      const y = Math.max(0, Math.round((pageHeight - layout.height) / 2));
      const serialized = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth}" height="${pageHeight}"><foreignObject x="${x}" y="${y}" width="${layout.width}" height="${layout.height}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${layout.width}px;height:${layout.height}px;overflow:hidden;font-family:'Microsoft YaHei','Segoe UI',sans-serif;font-size:16px;line-height:1.7;color:#111827">${serialized}</div></foreignObject></svg>`;
      const image = await imageFromUrl(dataUrl(svg));
      canvas.getContext('2d')?.drawImage(image, 0, 0, pageWidth, pageHeight);
      return canvas;
    },
    destroy() {
      destroyed = true;
      quill.disable();
      quill.off('text-change');
      quill.off('selection-change');
      quill.scroll.observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      resolvePending();
      toolbarHost.textContent = '';
      layerHost.textContent = '';
    }
  };
}
