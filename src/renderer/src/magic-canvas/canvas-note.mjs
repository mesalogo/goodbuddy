// Adapted from PeopleLib (MIT). See NOTICE.md.
/* global document, FileReader, DOMException, AbortController, clearTimeout, setTimeout, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, Element, Worker */
import {
  Canvas,
  FabricImage,
  FabricObject,
  IText,
  PencilBrush,
  StaticCanvas
} from 'fabric';
import { jsPDF as JsPdf } from 'jspdf';
import { mountFlowText, normalizeFlowContent } from './canvas-flow.mjs';

const VERSION = 2;
const MAX_PAGES = 50;
const HISTORY_LIMIT = 50;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_DATA_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128;
const DEFAULT_WIDTH = 794;
const DEFAULT_HEIGHT = 1123;
const MAX_DIMENSION = 3000;
const MAX_CANVAS_PIXELS = 24 * 1024 * 1024;
const SERIAL_PROPS = ['canvasKind'];
const COMMON_OBJECT_KEYS = [
  'type', 'version', 'canvasKind', 'originX', 'originY', 'left', 'top', 'width',
  'height', 'fill', 'stroke', 'strokeWidth', 'strokeDashArray', 'strokeLineCap',
  'strokeDashOffset', 'strokeLineJoin', 'strokeUniform', 'strokeMiterLimit',
  'scaleX', 'scaleY', 'angle', 'flipX', 'flipY', 'opacity', 'visible',
  'backgroundColor', 'fillRule', 'paintFirst', 'globalCompositeOperation',
  'skewX', 'skewY'
];
const OBJECT_KEYS_BY_KIND = {
  pen: ['path'],
  highlight: ['path'],
  rectangle: ['rx', 'ry'],
  text: [
    'fontSize', 'fontWeight', 'fontFamily', 'fontStyle', 'lineHeight', 'text',
    'charSpacing', 'textAlign', 'styles', 'pathStartOffset', 'pathSide',
    'pathAlign', 'underline', 'overline', 'linethrough', 'textBackgroundColor',
    'direction', 'textDecorationThickness', 'textDecorationColor'
  ],
  image: ['src', 'crossOrigin', 'cropX', 'cropY']
};
const TEMPLATE_NAMES = new Set(['blank', 'lined', 'grid', 'dots']);
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]);
const PAIR_BY_KIND = Object.freeze({
  pen: 'Path',
  highlight: 'Path',
  text: 'IText',
  image: 'Image',
  rectangle: 'Rect'
});
const ASSET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const IMAGE_DATA_RE = /^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;

FabricObject.customProperties = [
  ...new Set([...(FabricObject.customProperties || []), ...SERIAL_PROPS])
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const values = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(values);
  else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 256);
    }
  }
  values[6] = (values[6] & 0x0f) | 0x40;
  values[8] = (values[8] & 0x3f) | 0x80;
  const hex = Array.from(values, (value) => value.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join('')
  ].join('-');
}

function finiteDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_DIMENSION) return fallback;
  return Math.max(1, Math.round(number));
}

function fitDimensions(width, height) {
  let nextWidth = finiteDimension(width, DEFAULT_WIDTH);
  let nextHeight = finiteDimension(height, DEFAULT_HEIGHT);
  const pixels = nextWidth * nextHeight;
  if (pixels > MAX_CANVAS_PIXELS) {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    nextWidth = Math.max(1, Math.round(nextWidth * scale));
    nextHeight = Math.max(1, Math.round(nextHeight * scale));
  }
  return { width: nextWidth, height: nextHeight };
}

function isSafeImageDataUrl(value) {
  return typeof value === 'string'
    && value.length <= MAX_IMAGE_DATA_LENGTH
    && IMAGE_DATA_RE.test(value);
}

function hasUnsafeObjectValue(value, rootImage = false, depth = 0) {
  if (!value || typeof value !== 'object') return false;
  if (depth > 40) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => hasUnsafeObjectValue(entry, false, depth + 1));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'clipPath' && entry != null) return true;
    if ((key === 'src' || key === 'source') && entry != null) {
      if (!(rootImage && key === 'src' && isSafeImageDataUrl(entry))) return true;
    }
    if ((key === 'fill' || key === 'stroke') && entry && typeof entry === 'object') {
      return true;
    }
    if (entry && typeof entry === 'object' && hasUnsafeObjectValue(entry, false, depth + 1)) {
      return true;
    }
  }
  return false;
}

function normalizeObjects(value) {
  if (!Array.isArray(value)) return [];
  const objects = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const kind = candidate.canvasKind;
    if (PAIR_BY_KIND[kind] !== candidate.type) continue;
    if (kind === 'image' && !isSafeImageDataUrl(candidate.src)) continue;
    if (hasUnsafeObjectValue(candidate, kind === 'image')) continue;
    const clean = {};
    for (const key of [...COMMON_OBJECT_KEYS, ...OBJECT_KEYS_BY_KIND[kind]]) {
      if (Object.prototype.hasOwnProperty.call(candidate, key) && candidate[key] !== undefined) {
        clean[key] = cloneJson(candidate[key]);
      }
    }
    objects.push(clean);
  }
  return objects;
}

function normalizeBackground(value) {
  if (value?.type === 'template' && TEMPLATE_NAMES.has(value.template)) {
    return { type: 'template', template: value.template };
  }
  if (value?.type === 'pdf' && Number.isInteger(value.page) && value.page > 0) {
    const assetId = typeof value.assetId === 'string' && ASSET_ID_RE.test(value.assetId)
      ? value.assetId
      : null;
    if (assetId) {
      const background = { type: 'pdf', page: value.page };
      if (assetId) background.assetId = assetId;
      return background;
    }
  }
  return { type: 'template', template: 'blank' };
}

function normalizePage(value, usedIds) {
  const dimensions = fitDimensions(value?.width, value?.height);
  let id = typeof value?.id === 'string' && PAGE_ID_RE.test(value.id) ? value.id : makeId();
  while (usedIds.has(id)) id = makeId();
  usedIds.add(id);
  return {
    id,
    width: dimensions.width,
    height: dimensions.height,
    background: normalizeBackground(value?.background),
    objects: normalizeObjects(value?.objects),
    flowAuto: value?.flowAuto === true
  };
}

function normalizeContent(value) {
  const usedIds = new Set();
  const sourcePages = (value?.version === 1 || value?.version === VERSION)
    && Array.isArray(value.pages)
    ? value.pages.slice(0, MAX_PAGES)
    : [];
  const pages = sourcePages.map((page) => normalizePage(page, usedIds));
  if (!pages.length) {
    pages.push(normalizePage({
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      background: { type: 'template', template: 'blank' },
      objects: []
    }, usedIds));
  }
  const flow = value?.version === VERSION ? normalizeFlowContent(value.flow) : null;
  return { version: VERSION, pages, ...(flow ? { flow } : {}) };
}

function pageSnapshot(page) {
  return {
    width: page.width,
    height: page.height,
    background: cloneJson(page.background),
    objects: cloneJson(page.objects),
    flowAuto: page.flowAuto === true
  };
}

function snapshotString(page) {
  return JSON.stringify(pageSnapshot(page));
}

function makeRuntimePage(value) {
  const page = {
    id: value.id,
    width: value.width,
    height: value.height,
    background: cloneJson(value.background),
    objects: cloneJson(value.objects),
    flowAuto: value.flowAuto === true,
    history: [],
    historyIndex: 0
  };
  page.history = [snapshotString(page)];
  return page;
}

function applySnapshot(page, snapshot) {
  const dimensions = fitDimensions(snapshot?.width, snapshot?.height);
  page.width = dimensions.width;
  page.height = dimensions.height;
  page.background = normalizeBackground(snapshot?.background);
  page.objects = normalizeObjects(snapshot?.objects);
  page.flowAuto = snapshot?.flowAuto === true;
}

function rgba(hex, alpha) {
  const value = String(hex || '#ff4d4f').replace('#', '');
  const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return `rgba(255,77,79,${alpha})`;
  const number = Number.parseInt(full, 16);
  return `rgba(${number >> 16},${(number >> 8) & 255},${number & 255},${alpha})`;
}

function copyPdfBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new Error('PDF data is unavailable.');
}

function pdfReference(background) {
  if (background?.assetId && ASSET_ID_RE.test(background.assetId)) {
    return {
      key: `asset:${background.assetId}`,
      value: { assetId: background.assetId }
    };
  }
  throw new Error('The PDF background reference is invalid.');
}

function isCancellation(error) {
  return error?.name === 'AbortError'
    || error?.name === 'RenderingCancelledException'
    || error?.name === 'AbortException';
}

function drawTemplate(context, width, height, template) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.lineWidth = 1;

  if (template === 'lined') {
    context.strokeStyle = '#dbe4ee';
    for (let y = 40; y < height; y += 32) {
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
      context.stroke();
    }
  } else if (template === 'grid') {
    context.strokeStyle = '#e1e7ee';
    for (let x = 0; x < width; x += 32) {
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
    for (let y = 0; y < height; y += 32) {
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
      context.stroke();
    }
  } else if (template === 'dots') {
    context.fillStyle = '#cbd5df';
    for (let y = 20; y < height; y += 24) {
      for (let x = 20; x < width; x += 24) {
        context.beginPath();
        context.arc(x, y, 1.2, 0, Math.PI * 2);
        context.fill();
      }
    }
  }
  context.restore();
}

const BUTTON_ICONS = Object.freeze({
  'tool-select': '<path d="m5 3 13 9-6 1.5L9 19Z"/><path d="m13 14 4 6"/>',
  'tool-pen': '<path d="m4 20 4.5-1 10-10a2 2 0 0 0-3-3l-10 10Z"/><path d="m14 7 3 3M4 20l1.5-4"/>',
  'tool-highlight': '<path d="m7 15 8-11 4 3-8 11H7Z"/><path d="m13 7 4 3M4 20h16"/>',
  'tool-eraser': '<path d="m4 15 8-10 7 6-7 8H7Z"/><path d="m9 19 7-11M12 19h8"/>',
  'tool-text': '<path d="M5 5h14M12 5v14M8 19h8"/>',
  'tool-image': '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 4"/>',
  'tool-flow-text': '<path d="M4 5h16M8 5v14M5 19h6"/><path d="M14 11h6M14 15h6M14 19h6"/>',
  undo: '<path d="m9 7-5 5 5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
  'import-pdf': '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M12 10v7M9 14l3 3 3-3"/>',
  'export-pdf': '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M12 18v-7M9 14l3-3 3 3"/>',
  'previous-page': '<path d="m14 6-6 6 6 6"/>',
  'next-page': '<path d="m10 6 6 6-6 6"/>',
  'add-page': '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M9 14h6M12 11v6"/>',
  'delete-page': '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'
});

function makeButton(label, title, suffix) {
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('canvas-note-button', `canvas-note-${suffix}`);
  button.title = title;
  button.setAttribute('aria-label', title);
  const icon = BUTTON_ICONS[suffix];
  if (icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('toolbar-icon', 'canvas-note-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = icon;
    button.appendChild(svg);
  } else {
    button.textContent = label;
  }
  return button;
}

function makeOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function safeSuggestedName(value) {
  const original = String(value || 'GoodBuddy-笔记.pdf')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .trim()
    .slice(0, 180);
  const base = original.replace(/\.pdf$/i, '') || 'GoodBuddy-笔记';
  return `${base}-标注.pdf`;
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(new Error('The image could not be read.')), {
      once: true
    });
    reader.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
      once: true
    });
    reader.readAsDataURL(file);
  });
}

export function mountCanvasNote(host, initialContent, options = {}) {
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('mountCanvasNote requires a DOM host element.');
  }

  const normalized = normalizeContent(initialContent);
  let pages = normalized.pages.map(makeRuntimePage);
  let currentIndex = 0;
  let loadedPageId = null;
  let tool = 'select';
  let style = { color: '#ff4d4f', width: 3 };
  let restoring = false;
  let destroyed = false;
  let busy = false;
  let textTimer = 0;
  let deleteConfirmTimer = 0;
  let pendingDeletePageId = null;
  let operationQueue = Promise.resolve();
  let destroyPromise = null;
  let suggestedPdfName = 'GoodBuddy-笔记.pdf';
  let readOnly = Boolean(options.disabled);

  const pdfDocuments = new Map();
  const backgroundCache = new Map();
  const renderTasks = new Set();
  const uiAbort = new AbortController();

  const root = document.createElement('section');
  root.className = 'canvas-note-root';
  root.tabIndex = -1;

  const toolbar = document.createElement('div');
  toolbar.className = 'canvas-note-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '自由画布工具栏');

  const toolGroup = document.createElement('span');
  toolGroup.className = 'canvas-note-tool-group';
  toolGroup.setAttribute('role', 'group');
  toolGroup.setAttribute('aria-label', '画布工具');
  const toolButtons = new Map();
  const toolDefinitions = [
    ['select', '选择'],
    ['flow-text', '全局文本'],
    ['pen', '画笔'],
    ['highlight', '高亮'],
    ['eraser', '橡皮'],
    ['text', '文字'],
    ['image', '图片']
  ];
  for (const [name, label] of toolDefinitions) {
    const button = makeButton(label, label, `tool-${name}`);
    button.dataset.tool = name;
    toolButtons.set(name, button);
    toolGroup.appendChild(button);
  }

  const styleGroup = document.createElement('span');
  styleGroup.className = 'canvas-note-tool-group';
  styleGroup.setAttribute('role', 'group');
  styleGroup.setAttribute('aria-label', '画笔样式');
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = style.color;
  colorInput.className = 'canvas-note-color';
  colorInput.title = '颜色';
  colorInput.setAttribute('aria-label', '画笔颜色');
  styleGroup.appendChild(colorInput);

  const widthSelect = document.createElement('select');
  widthSelect.className = 'canvas-note-width';
  widthSelect.title = '粗细';
  widthSelect.setAttribute('aria-label', '画笔粗细');
  for (const width of [1, 2, 3, 5, 8, 12, 20]) {
    widthSelect.appendChild(makeOption(String(width), `${width}px`));
  }
  widthSelect.value = String(style.width);
  styleGroup.appendChild(widthSelect);

  const historyGroup = document.createElement('span');
  historyGroup.className = 'canvas-note-tool-group';
  historyGroup.setAttribute('role', 'group');
  historyGroup.setAttribute('aria-label', '历史操作');
  const undoButton = makeButton('撤销', '撤销', 'undo');
  const redoButton = makeButton('重做', '重做', 'redo');
  historyGroup.append(undoButton, redoButton);

  const documentGroup = document.createElement('span');
  documentGroup.className = 'canvas-note-tool-group';
  documentGroup.setAttribute('role', 'group');
  documentGroup.setAttribute('aria-label', '纸张与文件');
  const templateSelect = document.createElement('select');
  templateSelect.className = 'canvas-note-template';
  templateSelect.title = '纸张模板';
  templateSelect.setAttribute('aria-label', '纸张模板');
  templateSelect.append(
    makeOption('blank', '空白纸'),
    makeOption('lined', '横线纸'),
    makeOption('grid', '方格纸'),
    makeOption('dots', '点阵纸')
  );
  const pdfOption = makeOption('__pdf', 'PDF 底版');
  pdfOption.disabled = true;
  templateSelect.appendChild(pdfOption);
  documentGroup.appendChild(templateSelect);

  const importButton = makeButton('导入 PDF', '导入 PDF 作为底版', 'import-pdf');
  const exportButton = makeButton('导出 PDF', '导出画布笔记为 PDF', 'export-pdf');
  documentGroup.append(importButton, exportButton);

  const pageControls = document.createElement('span');
  pageControls.className = 'canvas-note-page-controls';
  pageControls.setAttribute('role', 'group');
  pageControls.setAttribute('aria-label', '页面操作');
  const previousButton = makeButton('上一页', '上一页', 'previous-page');
  const pageCounter = document.createElement('span');
  pageCounter.className = 'canvas-note-page-counter';
  pageCounter.setAttribute('aria-live', 'polite');
  const nextButton = makeButton('下一页', '下一页', 'next-page');
  const addPageButton = makeButton('加页', '添加页面', 'add-page');
  const deletePageButton = makeButton('删页', '删除当前页面', 'delete-page');
  pageControls.append(previousButton, pageCounter, nextButton, addPageButton, deletePageButton);
  toolbar.append(toolGroup, styleGroup, historyGroup, documentGroup, pageControls);

  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/jpeg,image/png,image/gif,image/webp';
  imageInput.className = 'canvas-note-image-input';
  imageInput.style.display = 'none';

  const viewport = document.createElement('div');
  viewport.className = 'canvas-note-viewport';
  viewport.tabIndex = 0;

  const flowToolbarHost = document.createElement('div');
  flowToolbarHost.className = 'canvas-flow-toolbar-host hidden';

  const pageShell = document.createElement('div');
  pageShell.className = 'canvas-note-page';
  pageShell.style.position = 'relative';

  const backgroundElement = document.createElement('canvas');
  backgroundElement.className = 'canvas-note-background';
  backgroundElement.setAttribute('aria-hidden', 'true');
  backgroundElement.style.position = 'absolute';
  backgroundElement.style.inset = '0';

  const annotationElement = document.createElement('canvas');
  annotationElement.className = 'canvas-note-fabric';

  const flowLayer = document.createElement('div');
  flowLayer.className = 'canvas-flow-layer';

  pageShell.append(backgroundElement, annotationElement, flowLayer);
  viewport.appendChild(pageShell);
  root.append(toolbar, flowToolbarHost, viewport, imageInput);
  host.textContent = '';
  host.appendChild(root);

  const fabricCanvas = new Canvas(annotationElement, {
    width: pages[0].width,
    height: pages[0].height,
    selection: true,
    preserveObjectStacking: true,
    enableRetinaScaling: true
  });
  const fabricContainer = annotationElement.parentElement;
  if (fabricContainer) {
    fabricContainer.classList.add('canvas-note-fabric-container');
    fabricContainer.style.position = 'absolute';
    fabricContainer.style.inset = '0';
  }
  if (fabricCanvas.upperCanvasEl) {
    fabricCanvas.upperCanvasEl.tabIndex = 0;
    fabricCanvas.upperCanvasEl.classList.add('canvas-note-interaction-canvas');
  }

  let flowOverflowReported = false;
  const flowEditor = mountFlowText(flowLayer, flowToolbarHost, normalized.flow, {
    onError(message) {
      reportError(message);
    },
    onChange() {
      emitChange();
    },
    onPageCount(count) {
      enqueue(() => syncFlowPages(count));
    },
    onActivePage(pageIndex) {
      if (tool !== 'flow-text'
        || !Number.isInteger(pageIndex)
        || pageIndex < 0
        || pageIndex >= pages.length
        || pageIndex === currentIndex) return;
      enqueue(() => switchPage(pageIndex));
    },
    onHistoryChange() {
      updateControls();
    }
  });
  flowEditor.setActive(false);

  function currentPage() {
    return pages[currentIndex];
  }

  function reportError(message) {
    if (destroyed || options.signal?.aborted) return;
    const text = String(message || '画布操作失败');
    try {
      options.onError?.(text);
    } catch {
      // Consumer callbacks must not break the editor.
    }
  }

  function clearDeleteConfirmation() {
    pendingDeletePageId = null;
    if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = 0;
    deletePageButton.classList.remove('canvas-note-delete-confirm');
    deletePageButton.title = '删除当前页面';
    deletePageButton.setAttribute('aria-label', '删除当前页面');
  }

  function armDeleteConfirmation(page) {
    pendingDeletePageId = page.id;
    deletePageButton.classList.add('canvas-note-delete-confirm');
    deletePageButton.title = '再次点击，删除本页底版、手写和自由文本';
    deletePageButton.setAttribute('aria-label', deletePageButton.title);
    if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = setTimeout(clearDeleteConfirmation, 5000);
  }

  function outputContent() {
    const flow = flowEditor.content();
    return {
      version: VERSION,
      pages: pages.map((page) => ({
        id: page.id,
        width: page.width,
        height: page.height,
        background: cloneJson(page.background),
        objects: cloneJson(page.objects),
        ...(page.flowAuto ? { flowAuto: true } : {})
      })),
      ...(flow ? { flow } : {})
    };
  }

  function emitChange() {
    if (destroyed || options.signal?.aborted || readOnly) return;
    try {
      options.onChange?.(cloneJson(outputContent()));
    } catch {
      // Consumer callbacks must not break the editor.
    }
  }

  function captureCurrentObjects() {
    if (destroyed || restoring || !pages.length || currentPage().id !== loadedPageId) return;
    const value = fabricCanvas.toObject(SERIAL_PROPS);
    currentPage().objects = normalizeObjects(value?.objects);
    if (currentPage().objects.length) currentPage().flowAuto = false;
  }

  function updateControls() {
    if (!pages.length) return;
    const page = currentPage();
    const flowMode = tool === 'flow-text';
    pageCounter.textContent = `${currentIndex + 1} / ${pages.length}`;
    previousButton.disabled = busy || currentIndex <= 0;
    nextButton.disabled = busy || currentIndex >= pages.length - 1;
    addPageButton.disabled = busy || pages.length >= MAX_PAGES;
    deletePageButton.disabled = busy || pages.length <= 1;
    undoButton.disabled = busy || (flowMode
      ? !flowEditor.canUndo()
      : page.historyIndex <= 0);
    redoButton.disabled = busy || (flowMode
      ? !flowEditor.canRedo()
      : page.historyIndex >= page.history.length - 1);
    importButton.disabled = busy;
    exportButton.disabled = busy;
    templateSelect.disabled = busy;
    colorInput.disabled = busy || flowMode;
    widthSelect.disabled = busy || flowMode;
    templateSelect.value = page.background.type === 'template'
      ? page.background.template
      : '__pdf';
    for (const [name, button] of toolButtons) {
      const active = name === tool;
      button.classList.toggle('canvas-note-active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = busy;
    }
    if (readOnly) {
      for (const control of toolbar.querySelectorAll('button, input, select')) {
        if (control !== previousButton && control !== nextButton && control !== exportButton) control.disabled = true;
      }
    }
  }

  function pushHistory(emit = true) {
    if (destroyed || restoring) return false;
    captureCurrentObjects();
    const page = currentPage();
    const value = snapshotString(page);
    if (page.history[page.historyIndex] === value) {
      updateControls();
      return false;
    }
    page.history = page.history.slice(0, page.historyIndex + 1);
    page.history.push(value);
    if (page.history.length > HISTORY_LIMIT) page.history.shift();
    page.historyIndex = page.history.length - 1;
    updateControls();
    if (emit) emitChange();
    return true;
  }

  function flushPendingText(emit = true) {
    if (!textTimer) return false;
    clearTimeout(textTimer);
    textTimer = 0;
    return pushHistory(emit);
  }

  function brushStyle() {
    if (!fabricCanvas.freeDrawingBrush) {
      fabricCanvas.freeDrawingBrush = new PencilBrush(fabricCanvas);
    }
    fabricCanvas.freeDrawingBrush.width = tool === 'highlight'
      ? Math.max(8, Number(style.width) * 4)
      : Math.max(1, Number(style.width));
    fabricCanvas.freeDrawingBrush.color = tool === 'highlight'
      ? rgba(style.color, 0.28)
      : style.color;
  }

  function applyMode() {
    if (destroyed) return;
    const flowing = !readOnly && tool === 'flow-text';
    const selecting = !readOnly && tool === 'select';
    const drawing = !readOnly && (tool === 'pen' || tool === 'highlight');
    fabricCanvas.isDrawingMode = drawing;
    fabricCanvas.selection = selecting;
    fabricCanvas.defaultCursor = flowing ? 'text' : (selecting ? 'default' : 'crosshair');
    fabricCanvas.hoverCursor = tool === 'eraser'
      ? 'not-allowed'
      : (selecting ? 'move' : 'crosshair');
    for (const object of fabricCanvas.getObjects()) {
      object.selectable = selecting;
      object.evented = selecting || (!readOnly && tool === 'eraser');
    }
    if (!selecting) fabricCanvas.discardActiveObject();
    if (drawing) brushStyle();
    flowEditor.setActive(flowing);
    if (fabricContainer) {
      fabricContainer.style.pointerEvents = flowing || busy || readOnly ? 'none' : 'auto';
    }
    flowLayer.style.pointerEvents = flowing && !busy ? 'auto' : 'none';
    fabricCanvas.requestRenderAll();
    updateControls();
  }

  function setTool(nextTool) {
    if (!toolButtons.has(nextTool) || destroyed) return;
    flushPendingText();
    if (nextTool !== tool) clearDeleteConfirmation();
    tool = nextTool;
    applyMode();
    if (tool === 'flow-text') flowEditor.focus();
  }

  function setPageDimensions(page) {
    pageShell.style.width = `${page.width}px`;
    pageShell.style.height = `${page.height}px`;
    backgroundElement.width = page.width;
    backgroundElement.height = page.height;
    fabricCanvas.setDimensions({ width: page.width, height: page.height });
    if (fabricContainer) {
      fabricContainer.style.width = `${page.width}px`;
      fabricContainer.style.height = `${page.height}px`;
    }
    const writableWidth = Math.max(
      240,
      Math.min(...pages.map((item) => item.width)) - 128
    );
    const writableHeight = Math.max(
      240,
      Math.min(...pages.map((item) => item.height)) - 144
    );
    flowLayer.style.top = `${Math.max(0, Math.round((page.height - writableHeight) / 2))}px`;
    flowEditor.setLayout(writableWidth, writableHeight, currentIndex);
  }

  async function getPdfDocument(background, suppliedBytes = null) {
    const reference = pdfReference(background);
    const existing = pdfDocuments.get(reference.key);
    if (existing) return existing.promise;

    const entry = { task: null, document: null, promise: null, worker: null, port: null };
    entry.promise = (async () => {
      let source = suppliedBytes;
      if (source == null) {
        if (typeof options.readPdf !== 'function') {
          throw new Error('PDF 底版不可用');
        }
        source = await options.readPdf(reference.value);
      }
      if (destroyed) throw new DOMException('Destroyed', 'AbortError');
      const [pdfjs, { default: pdfWorkerUrl }, { CanvasPdfBinaryDataFactory }] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        import('./pdf-assets.mjs')
      ]);
      if (destroyed || options.signal?.aborted) throw new DOMException('Destroyed', 'AbortError');
      const data = copyPdfBytes(source);
      // 显式模块 Worker 避免 file:// 下 PDF.js 改用被应用 CSP 拦截的 blob Worker。
      entry.port = new Worker(pdfWorkerUrl, { type: 'module' });
      entry.worker = new pdfjs.PDFWorker({ port: entry.port });
      entry.task = pdfjs.getDocument({
        BinaryDataFactory: CanvasPdfBinaryDataFactory,
        useWorkerFetch: false,
        isEvalSupported: false,
        enableXfa: false,
        data,
        worker: entry.worker
      });
      entry.document = await entry.task.promise;
      return entry.document;
    })().catch(async (error) => {
      pdfDocuments.delete(reference.key);
      try {
        await entry.task?.destroy();
      } catch {
        // Ignore cleanup failures while propagating the load error.
      } finally {
        entry.worker?.destroy();
        entry.port?.terminate();
      }
      throw error;
    });
    pdfDocuments.set(reference.key, entry);
    return entry.promise;
  }

  async function renderPdfBackground(background, width, height) {
    const reference = pdfReference(background);
    const dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
    const cacheKey = `${reference.key}:${background.page}:${width}x${height}:${dpr}`;
    const existing = backgroundCache.get(cacheKey);
    if (existing) return existing;

    const promise = (async () => {
      const documentProxy = await getPdfDocument(background);
      if (background.page > documentProxy.numPages) {
        throw new Error(`PDF 第 ${background.page} 页不可用`);
      }
      const pdfPage = await documentProxy.getPage(background.page);
      let renderTask = null;
      try {
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        let scale = Math.max(width / baseViewport.width, height / baseViewport.height) * dpr;
        const estimate = baseViewport.width * baseViewport.height * scale * scale;
        if (estimate > MAX_CANVAS_PIXELS) {
          scale *= Math.sqrt(MAX_CANVAS_PIXELS / estimate);
        }
        const renderViewport = pdfPage.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.className = 'canvas-note-cached-background';
        canvas.width = Math.max(1, Math.floor(renderViewport.width));
        canvas.height = Math.max(1, Math.floor(renderViewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas rendering is unavailable.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = pdfPage.render({
          canvasContext: context,
          viewport: renderViewport,
          transform: null
        });
        renderTasks.add(renderTask);
        let timeout = 0;
        try {
          await Promise.race([
            renderTask.promise,
            new Promise((_, reject) => {
              timeout = setTimeout(() => {
                try { renderTask.cancel(); } catch { /* ignore */ }
                reject(new Error('PDF 底版渲染超时'));
              }, 10000);
            })
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        return canvas;
      } finally {
        if (renderTask) renderTasks.delete(renderTask);
        try {
          pdfPage.cleanup();
        } catch {
          // PDF.js may already have cleaned the page.
        }
      }
    })().catch((error) => {
      backgroundCache.delete(cacheKey);
      throw error;
    });
    backgroundCache.set(cacheKey, promise);
    return promise;
  }

  async function paintPageBackground(target, page) {
    target.width = page.width;
    target.height = page.height;
    const context = target.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas rendering is unavailable.');
    const template = page.background.type === 'template' ? page.background.template : 'blank';
    drawTemplate(context, page.width, page.height, template);
    if (page.background.type !== 'pdf') return;
    const rendered = await renderPdfBackground(
      page.background,
      page.width,
      page.height
    );
    if (destroyed) throw new DOMException('Destroyed', 'AbortError');
    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(rendered, 0, 0, page.width, page.height);
    context.restore();
  }

  async function paintVisibleBackground() {
    try {
      await paintPageBackground(backgroundElement, currentPage());
    } catch (error) {
      if (destroyed || isCancellation(error)) return;
      const context = backgroundElement.getContext('2d', { alpha: false });
      if (context) {
        drawTemplate(
          context,
          currentPage().width,
          currentPage().height,
          'blank'
        );
      }
      reportError(error?.message || 'PDF 底版渲染失败');
    }
  }

  async function loadCurrentPage() {
    if (destroyed) return;
    const page = currentPage();
    restoring = true;
    loadedPageId = null;
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = 0;
    }
    fabricCanvas.discardActiveObject();
    setPageDimensions(page);
    try {
      await fabricCanvas.loadFromJSON({ objects: cloneJson(page.objects) }, undefined, { signal: uiAbort.signal });
    } catch {
      if (destroyed || options.signal?.aborted) return;
      fabricCanvas.remove(...fabricCanvas.getObjects());
      reportError('部分画布对象无法恢复');
    } finally {
      restoring = false;
    }
    if (destroyed || options.signal?.aborted) return;
    loadedPageId = page.id;
    applyMode();
    await paintVisibleBackground();
    updateControls();
  }

  async function switchPage(nextIndex) {
    if (
      destroyed
      || !Number.isInteger(nextIndex)
      || nextIndex < 0
      || nextIndex >= pages.length
      || nextIndex === currentIndex
    ) {
      return;
    }
    flushPendingText();
    captureCurrentObjects();
    clearDeleteConfirmation();
    await flowEditor.flush();
    currentIndex = nextIndex;
    await loadCurrentPage();
  }

  async function undo() {
    flushPendingText();
    if (tool === 'flow-text') {
      flowEditor.undo();
      updateControls();
      emitChange();
      return;
    }
    const page = currentPage();
    if (page.historyIndex <= 0) return;
    page.historyIndex -= 1;
    applySnapshot(page, JSON.parse(page.history[page.historyIndex]));
    await loadCurrentPage();
    emitChange();
  }

  async function redo() {
    flushPendingText();
    if (tool === 'flow-text') {
      flowEditor.redo();
      updateControls();
      emitChange();
      return;
    }
    const page = currentPage();
    if (page.historyIndex >= page.history.length - 1) return;
    page.historyIndex += 1;
    applySnapshot(page, JSON.parse(page.history[page.historyIndex]));
    await loadCurrentPage();
    emitChange();
  }

  function applyStyleToSelection() {
    const active = fabricCanvas.getActiveObjects();
    let changed = false;
    for (const object of active) {
      let objectChanged = false;
      if (object.canvasKind === 'text') {
        object.set({ fill: style.color });
        objectChanged = true;
      } else if (object.canvasKind === 'highlight') {
        object.set({
          stroke: rgba(style.color, 0.28),
          strokeWidth: Math.max(8, Number(style.width) * 4)
        });
        objectChanged = true;
      } else if (object.canvasKind === 'pen' || object.canvasKind === 'rectangle') {
        object.set({
          stroke: style.color,
          strokeWidth: Math.max(1, Number(style.width))
        });
        objectChanged = true;
      }
      if (objectChanged) {
        object.setCoords();
        changed = true;
      }
    }
    if (changed) {
      fabricCanvas.requestRenderAll();
      pushHistory();
    }
  }

  function addText(event) {
    const point = fabricCanvas.getScenePoint(event);
    const object = new IText('输入文字', {
      left: point.x,
      top: point.y,
      originX: 'left',
      originY: 'top',
      fill: style.color,
      fontFamily: 'sans-serif',
      fontSize: 18,
      selectable: true,
      evented: true,
      canvasKind: 'text'
    });
    fabricCanvas.add(object);
    fabricCanvas.setActiveObject(object);
    object.enterEditing();
    object.selectAll();
    fabricCanvas.requestRenderAll();
    pushHistory();
  }

  function eraseObject(target) {
    if (!target) return;
    fabricCanvas.remove(target);
    fabricCanvas.discardActiveObject();
    pushHistory();
  }

  async function addImageFile(file) {
    if (!file) return;
    if (!IMAGE_MIME_TYPES.has(file.type)) {
      throw new Error('请选择 JPEG、PNG、GIF 或 WebP 图片');
    }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      throw new Error('单张图片不能超过 2 MB');
    }
    const dataUrl = await readFileDataUrl(file);
    if (!isSafeImageDataUrl(dataUrl)) {
      throw new Error('选择的图片数据无效');
    }
    const image = await FabricImage.fromURL(dataUrl);
    if (destroyed) return;
    const page = currentPage();
    const imageWidth = Math.max(1, Number(image.width) || 1);
    const imageHeight = Math.max(1, Number(image.height) || 1);
    const scale = Math.min(
      1,
      (page.width * 0.6) / imageWidth,
      (page.height * 0.6) / imageHeight
    );
    image.set({
      left: (page.width - imageWidth * scale) / 2,
      top: (page.height - imageHeight * scale) / 2,
      originX: 'left',
      originY: 'top',
      scaleX: scale,
      scaleY: scale,
      selectable: true,
      evented: true,
      canvasKind: 'image'
    });
    fabricCanvas.add(image);
    tool = 'select';
    applyMode();
    fabricCanvas.setActiveObject(image);
    fabricCanvas.requestRenderAll();
    pushHistory();
  }

  function blankRuntimePage(template = 'blank', flowAuto = false) {
    return makeRuntimePage({
      id: makeId(),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      background: { type: 'template', template },
      objects: [],
      flowAuto
    });
  }

  async function syncFlowPages(requiredCount) {
    if (destroyed) return;
    flushPendingText();
    captureCurrentObjects();
    const requested = Math.max(1, Math.round(Number(requiredCount) || 1));
    const target = Math.min(MAX_PAGES, requested);
    let changed = false;
    while (pages.length < target) {
      const previous = pages[pages.length - 1];
      const template = previous?.background?.type === 'template'
        ? previous.background.template
        : 'blank';
      pages.push(blankRuntimePage(template, true));
      changed = true;
    }
    for (let index = pages.length - 1; index >= 0 && pages.length > target; index -= 1) {
      const page = pages[index];
      if (!page.flowAuto || page.objects.length || page.background.type !== 'template') continue;
      pages.splice(index, 1);
      if (currentIndex > index) currentIndex -= 1;
      else if (currentIndex === index) currentIndex = Math.max(0, index - 1);
      changed = true;
    }
    if (requested > MAX_PAGES && !flowOverflowReported) {
      flowOverflowReported = true;
      reportError(`全局文本最多支持 ${MAX_PAGES} 页，请删减正文`);
    } else if (requested <= MAX_PAGES) {
      flowOverflowReported = false;
    }
    if (!changed) return;
    currentIndex = Math.min(currentIndex, pages.length - 1);
    // Pagination can remove the loaded page; finish restoration in the same queue as flush.
    if (currentPage().id !== loadedPageId) await loadCurrentPage();
    else setPageDimensions(currentPage());
    updateControls();
    emitChange();
  }

  async function addPage() {
    if (pages.length >= MAX_PAGES) return;
    flushPendingText();
    captureCurrentObjects();
    clearDeleteConfirmation();
    const flowDocument = tool === 'flow-text' || !!flowEditor.content();
    const insertionAfter = flowDocument
      ? Math.min(pages.length - 1, flowEditor.activePageIndex())
      : currentIndex;
    const sourcePage = pages[insertionAfter] || currentPage();
    const page = blankRuntimePage(
      sourcePage.background.type === 'template'
        ? sourcePage.background.template
        : 'blank'
    );
    pages.splice(insertionAfter + 1, 0, page);
    currentIndex = insertionAfter + 1;
    if (flowDocument) {
      flowEditor.insertPageBreak(page.id);
      await flowEditor.flush();
      const insertedIndex = pages.findIndex((candidate) => candidate.id === page.id);
      if (insertedIndex >= 0) currentIndex = insertedIndex;
    }
    await loadCurrentPage();
    emitChange();
    if (flowDocument) {
      const insertedPageId = page.id;
      enqueue(async () => {
        const index = pages.findIndex((candidate) => candidate.id === insertedPageId);
        if (index < 0 || index === currentIndex) return;
        currentIndex = index;
        await loadCurrentPage();
      });
    }
  }

  async function deletePage() {
    if (pages.length <= 1) return;
    flushPendingText();
    captureCurrentObjects();
    const page = currentPage();
    const destructive = page.objects.length > 0 || page.background.type === 'pdf';
    if (destructive && pendingDeletePageId !== page.id) {
      armDeleteConfirmation(page);
      reportError('当前页包含底版或画布对象，再次点击删除按钮可确认删除；全局正文会重新排版');
      return;
    }
    clearDeleteConfirmation();
    flowEditor.removePageBreak(page.id);
    pages.splice(currentIndex, 1);
    currentIndex = Math.min(currentIndex, pages.length - 1);
    await loadCurrentPage();
    emitChange();
  }

  async function setTemplate(template) {
    if (!TEMPLATE_NAMES.has(template)) return;
    flushPendingText();
    captureCurrentObjects();
    currentPage().background = { type: 'template', template };
    pushHistory();
    await paintVisibleBackground();
  }

  function isPristinePlaceholder() {
    if (pages.length !== 1) return false;
    captureCurrentObjects();
    const page = pages[0];
    return page.objects.length === 0
      && page.background.type === 'template'
      && page.background.template === 'blank';
  }

  async function importPdf() {
    if (typeof options.pickPdf !== 'function' || typeof options.readPdf !== 'function') {
      throw new Error('PDF 导入功能不可用');
    }
    let picked;
    try {
      picked = await options.pickPdf();
    } catch (error) {
      if (isCancellation(error)) return;
      throw error;
    }
    if (!picked) return;
    if (typeof picked.assetId !== 'string' || !ASSET_ID_RE.test(picked.assetId)) {
      throw new Error('选择的 PDF 底版已失效');
    }
    const background = { type: 'pdf', page: 1, assetId: picked.assetId };
    const bytes = await options.readPdf({ assetId: picked.assetId });
    const documentProxy = await getPdfDocument(background, bytes);
    if (destroyed) throw new DOMException('Destroyed', 'AbortError');
    if (documentProxy.numPages > MAX_PAGES) {
      throw new Error(`PDF 最多支持 ${MAX_PAGES} 页`);
    }
    const replacePlaceholder = isPristinePlaceholder();
    if (!replacePlaceholder && pages.length + documentProxy.numPages > MAX_PAGES) {
      throw new Error(`每条画布笔记最多支持 ${MAX_PAGES} 页`);
    }

    const imported = [];
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      if (destroyed) throw new DOMException('Destroyed', 'AbortError');
      const pdfPage = await documentProxy.getPage(pageNumber);
      const viewportValue = pdfPage.getViewport({ scale: 96 / 72 });
      const dimensions = fitDimensions(viewportValue.width, viewportValue.height);
      const textContent = await pdfPage.getTextContent();
      options.onPdfText?.(picked.assetId, pageNumber, textContent.items.map((item) => item.str ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim());
      imported.push(makeRuntimePage({
        id: makeId(),
        width: dimensions.width,
        height: dimensions.height,
        background: {
          type: 'pdf',
          page: pageNumber,
          assetId: picked.assetId
        },
        objects: []
      }));
    }

    flushPendingText();
    captureCurrentObjects();
    if (replacePlaceholder) {
      pages = imported;
      currentIndex = 0;
    } else {
      const insertionIndex = currentIndex + 1;
      pages.splice(insertionIndex, 0, ...imported);
      currentIndex = insertionIndex;
    }
    suggestedPdfName = safeSuggestedName(picked.name);
    await loadCurrentPage();
    emitChange();
  }

  async function exportPdf() {
    if (typeof options.savePdf !== 'function') {
      throw new Error('PDF 导出功能不可用');
    }
    flushPendingText();
    captureCurrentObjects();
    await flowEditor.flush();
    await syncFlowPages(flowEditor.pageCount());

    let pdf = null;
    for (let index = 0; index < pages.length; index += 1) {
      if (destroyed) throw new DOMException('Destroyed', 'AbortError');
      const page = pages[index];
      const orientation = page.width > page.height ? 'landscape' : 'portrait';
      if (!pdf) {
        pdf = new JsPdf({
          orientation,
          unit: 'px',
          format: [page.width, page.height],
          hotfixes: ['px_scaling'],
          compress: true
        });
      } else {
        pdf.addPage([page.width, page.height], orientation);
      }

      const composite = document.createElement('canvas');
      composite.className = 'canvas-note-export-page';
      await paintPageBackground(composite, page);
      const context = composite.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas rendering is unavailable.');
      const textLayer = await flowEditor.renderPage(index, page.width, page.height);
      context.drawImage(textLayer, 0, 0, page.width, page.height);

      const objectElement = document.createElement('canvas');
      objectElement.className = 'canvas-note-export-objects';
      const objectCanvas = new StaticCanvas(objectElement, {
        width: page.width,
        height: page.height,
        enableRetinaScaling: false,
        renderOnAddRemove: false
      });
      try {
        await objectCanvas.loadFromJSON({ objects: cloneJson(page.objects) });
        objectCanvas.renderAll();
        context.drawImage(objectCanvas.lowerCanvasEl, 0, 0, page.width, page.height);
      } finally {
        await objectCanvas.dispose();
      }
      pdf.addImage(composite, 'PNG', 0, 0, page.width, page.height, undefined, 'FAST');
    }
    if (destroyed) throw new DOMException('Destroyed', 'AbortError');
    const bytes = new Uint8Array(pdf.output('arraybuffer'));
    await options.savePdf(bytes, suggestedPdfName);
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    flowEditor.setBusy(busy);
    if (busy) fabricCanvas.getActiveObject()?.exitEditing?.();
    if (fabricContainer) {
      fabricContainer.style.pointerEvents = busy || readOnly || tool === 'flow-text' ? 'none' : 'auto';
    }
    flowLayer.style.pointerEvents = busy || readOnly || tool !== 'flow-text' ? 'none' : 'auto';
    updateControls();
  }

  function enqueue(action) {
    operationQueue = operationQueue
      .then(async () => {
        if (destroyed) return;
        return action();
      })
      .catch((error) => {
        if (!destroyed && !isCancellation(error)) {
          reportError(error?.message || '画布操作失败');
        }
      });
    return operationQueue;
  }

  function enqueueBusy(action) {
    if (busy) return operationQueue;
    setBusy(true);
    return enqueue(async () => {
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  }

  fabricCanvas.on('mouse:down', (event) => {
    if (destroyed || restoring || busy || readOnly) return;
    if (tool === 'text' && !event.target) addText(event.e);
    else if (tool === 'eraser') eraseObject(event.target);
  });
  fabricCanvas.on('path:created', (event) => {
    if (destroyed || restoring || !event.path) return;
    event.path.set({
      canvasKind: tool === 'highlight' ? 'highlight' : 'pen',
      selectable: false,
      evented: false
    });
    pushHistory();
  });
  fabricCanvas.on('object:modified', () => {
    if (!destroyed && !restoring) pushHistory();
  });
  fabricCanvas.on('text:changed', () => {
    if (destroyed || restoring) return;
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      textTimer = 0;
      pushHistory();
    }, 300);
  });
  fabricCanvas.on('text:editing:exited', () => {
    if (destroyed || restoring) return;
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = 0;
    }
    pushHistory();
  });

  for (const [name, button] of toolButtons) {
    button.addEventListener('click', () => {
      if (name === 'image') {
        setTool('select');
        imageInput.value = '';
        imageInput.click();
      } else {
        setTool(name);
      }
    }, { signal: uiAbort.signal });
  }
  colorInput.addEventListener('input', () => {
    style = { ...style, color: colorInput.value };
    if (fabricCanvas.isDrawingMode) brushStyle();
    applyStyleToSelection();
  }, { signal: uiAbort.signal });
  widthSelect.addEventListener('change', () => {
    style = { ...style, width: Math.max(1, Number(widthSelect.value) || 1) };
    if (fabricCanvas.isDrawingMode) brushStyle();
    applyStyleToSelection();
  }, { signal: uiAbort.signal });
  undoButton.addEventListener('click', () => enqueueBusy(undo), { signal: uiAbort.signal });
  redoButton.addEventListener('click', () => enqueueBusy(redo), { signal: uiAbort.signal });
  templateSelect.addEventListener('change', () => {
    const template = templateSelect.value;
    enqueueBusy(() => setTemplate(template));
  }, { signal: uiAbort.signal });
  importButton.addEventListener('click', () => enqueueBusy(importPdf), {
    signal: uiAbort.signal
  });
  exportButton.addEventListener('click', () => enqueueBusy(exportPdf), {
    signal: uiAbort.signal
  });
  previousButton.addEventListener('click', () => {
    enqueueBusy(() => switchPage(currentIndex - 1));
  }, { signal: uiAbort.signal });
  nextButton.addEventListener('click', () => {
    enqueueBusy(() => switchPage(currentIndex + 1));
  }, { signal: uiAbort.signal });
  addPageButton.addEventListener('click', () => enqueueBusy(addPage), { signal: uiAbort.signal });
  deletePageButton.addEventListener('click', () => enqueueBusy(deletePage), {
    signal: uiAbort.signal
  });
  viewport.addEventListener('wheel', (event) => {
    if (event.defaultPrevented || event.ctrlKey) return;
    // Some drivers already map Shift to deltaX; only remap a vertical-only wheel.
    const horizontal = event.shiftKey && event.deltaX === 0;
    const dx = horizontal ? event.deltaY : event.deltaX;
    const dy = horizontal ? 0 : event.deltaY;
    const unitX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
    const unitY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    const left = viewport.scrollLeft;
    const top = viewport.scrollTop;
    viewport.scrollLeft = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, left + dx * unitX));
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, top + dy * unitY));
    // Leave boundary/no-overflow events available for normal ancestor scrolling.
    if (viewport.scrollLeft !== left || viewport.scrollTop !== top) event.preventDefault();
  }, { passive: false, signal: uiAbort.signal });
  imageInput.addEventListener('change', () => {
    const file = imageInput.files?.[0] || null;
    imageInput.value = '';
    if (file) enqueueBusy(() => addImageFile(file));
  }, { signal: uiAbort.signal });
  root.addEventListener('keydown', (event) => {
    if (destroyed || busy || readOnly) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLSelectElement
      || target instanceof HTMLTextAreaElement
      || target instanceof Element && target.closest('.canvas-flow-layer')
    ) {
      return;
    }
    const active = fabricCanvas.getActiveObject();
    if (active?.isEditing) return;
    const shortcut = event.ctrlKey || event.metaKey;
    if (shortcut && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      enqueueBusy(event.shiftKey ? redo : undo);
    } else if (shortcut && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      enqueueBusy(redo);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      const selected = fabricCanvas.getActiveObjects();
      if (!selected.length) return;
      event.preventDefault();
      for (const object of selected) fabricCanvas.remove(object);
      fabricCanvas.discardActiveObject();
      pushHistory();
    }
  }, { signal: uiAbort.signal });

  applyMode();
  operationQueue = loadCurrentPage();

  return {
    setDisabled(value) {
      readOnly = Boolean(value);
      fabricCanvas.discardActiveObject();
      applyMode();
    },
    async capturePages({ firstPageOnly = false, thumbnailWidth } = {}) {
      await operationQueue;
      flushPendingText();
      captureCurrentObjects();
      await flowEditor.flush();
      await operationQueue;
      const capture = operationQueue.then(async () => {
        if (destroyed || options.signal?.aborted) throw new DOMException('Destroyed', 'AbortError');
        setBusy(true);
        try {
          const result = [];
          for (let index = 0; index < (firstPageOnly ? Math.min(1, pages.length) : pages.length); index += 1) {
            if (destroyed || options.signal?.aborted) throw new DOMException('Destroyed', 'AbortError');
            const page = pages[index];
            const composite = document.createElement('canvas');
            await paintPageBackground(composite, page);
            const context = composite.getContext('2d');
            context.drawImage(await flowEditor.renderPage(index, page.width, page.height), 0, 0);
            const objectCanvas = new StaticCanvas(document.createElement('canvas'), {
              width: page.width, height: page.height, enableRetinaScaling: false, renderOnAddRemove: false
            });
            try {
              await objectCanvas.loadFromJSON({ objects: cloneJson(page.objects) }, undefined, { signal: uiAbort.signal });
              if (destroyed) throw new DOMException('Destroyed', 'AbortError');
              objectCanvas.renderAll();
              context.drawImage(objectCanvas.lowerCanvasEl, 0, 0);
              let output = composite;
              if (thumbnailWidth) {
                output = document.createElement('canvas');
                output.width = thumbnailWidth;
                output.height = Math.round(page.height * thumbnailWidth / page.width);
                output.getContext('2d').drawImage(composite, 0, 0, output.width, output.height);
              }
              result.push({ pageId: page.id, dataUrl: output.toDataURL('image/png') });
            } finally {
              await objectCanvas.dispose();
            }
          }
          return result;
        } finally {
          if (!destroyed) setBusy(false);
        }
      });
      operationQueue = capture.then(() => {}, () => {});
      return capture;
    },
    content() {
      if (!destroyed) {
        flushPendingText();
        captureCurrentObjects();
      }
      return cloneJson(outputContent());
    },
    hasContent() {
      if (!destroyed) {
        flushPendingText();
        captureCurrentObjects();
      }
      if (flowEditor.hasContent()) return true;
      return pages.length > 1 || pages.some((page) => {
        return page.objects.length > 0
          || page.background.type === 'pdf'
          || (
            page.background.type === 'template'
            && page.background.template !== 'blank'
          );
      });
    },
    focus() {
      if (destroyed) return;
      if (tool === 'flow-text') {
        flowEditor.focus();
        return;
      }
      const target = fabricCanvas.upperCanvasEl || viewport || root;
      target.focus();
    },
    destroy() {
      if (destroyPromise) return destroyPromise;
      flushPendingText();
      captureCurrentObjects();
      destroyed = true;
      uiAbort.abort();
      clearDeleteConfirmation();
      flowEditor.destroy();
      for (const task of renderTasks) {
        try {
          task.cancel();
        } catch {
          // Rendering may already have completed.
        }
      }
      root.remove();
      destroyPromise = (async () => {
        const pdfCleanup = Promise.allSettled(Array.from(pdfDocuments.values(), async (entry) => {
          try { await entry.task?.destroy(); }
          finally { entry.worker?.destroy(); entry.port?.terminate(); }
        }));
        try {
          await operationQueue;
        } catch {
          // The queue reports its own operation failures.
        }
        await Promise.allSettled(Array.from(backgroundCache.values()));
        await pdfCleanup;
        try {
          await fabricCanvas.dispose();
        } catch {
          // Fabric may already be disposed after a failed initialization.
        }
        backgroundCache.clear();
        pdfDocuments.clear();
        renderTasks.clear();
      })();
      return destroyPromise;
    },
    async flush() {
      await operationQueue;
      if (!destroyed) {
        flushPendingText();
        captureCurrentObjects();
        await flowEditor.flush();
        await operationQueue;
        captureCurrentObjects();
      }
      return cloneJson(outputContent());
    }
  };
}
