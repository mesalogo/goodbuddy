/* global HTMLCanvasElement, document, WheelEvent */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountCanvasNote } from './canvas-note.mjs';

vi.mock('fabric', () => ({
  FabricObject: {},
  Canvas: class {
    constructor(element) { this.upperCanvasEl = element; }
    on() {}
    getObjects() { return []; }
    toObject() { return { objects: [] }; }
    discardActiveObject() {}
    requestRenderAll() {}
    setDimensions() {}
    async loadFromJSON() {}
    async dispose() {}
  },
  FabricImage: class {}, IText: class {}, PencilBrush: class {}, StaticCanvas: class {}
}));
vi.mock('./canvas-flow.mjs', () => ({
  normalizeFlowContent: () => null,
  mountFlowText: (host) => {
    host.innerHTML = '<div contenteditable="true"><p>Body text</p></div>';
    return {
      setActive() {}, setLayout() {}, focus() {}, destroy() {},
      canUndo: () => false, canRedo: () => false, content: () => null,
      flush: async () => {}
    };
  }
}));

let editor;
let host;
let viewport;
let target;
beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}
  });
  host = document.createElement('div');
  document.body.append(host);
  editor = mountCanvasNote(host);
  await editor.flush();
  viewport = host.querySelector('.canvas-note-viewport');
  target = host.querySelector('.canvas-note-interaction-canvas');
  Object.defineProperties(viewport, {
    clientWidth: { value: 500, configurable: true },
    clientHeight: { value: 400, configurable: true },
    scrollWidth: { value: 1200, configurable: true },
    scrollHeight: { value: 1400, configurable: true }
  });
});
afterEach(async () => {
  await editor.destroy();
  host.remove();
  vi.restoreAllMocks();
});

function wheel(init = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

it.each(['drawing', 'flow', 'readonly'])('scrolls both axes over %s without changing content', (mode) => {
  if (mode === 'readonly') editor.setDisabled(true);
  else host.querySelector(`[data-tool="${mode === 'flow' ? 'flow-text' : 'pen'}"]`).click();
  if (mode === 'flow') target = host.querySelector('.canvas-flow-layer p');
  const content = editor.content();
  expect(wheel({ deltaX: 120 }).defaultPrevented).toBe(true);
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([120, 0]);
  wheel({ deltaX: -30, deltaY: 40 });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([90, 40]);
  wheel({ deltaY: 50, shiftKey: true });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([140, 40]);
  wheel({ deltaX: -60, shiftKey: true });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([80, 40]);
  wheel({ deltaY: -20 });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([80, 20]);
  expect(editor.content()).toEqual(content);
});

it('converts line and page wheel units on the destination axis', () => {
  wheel({ deltaX: 2, deltaY: 3, deltaMode: 1 });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([32, 48]);
  wheel({ deltaY: 1, deltaMode: 2, shiftKey: true });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([532, 48]);
  wheel({ deltaY: 1, deltaMode: 2 });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([532, 448]);
});

it('clamps at edges and only consumes events that can move the viewport', () => {
  expect(wheel({ deltaX: -100, deltaY: -100 }).defaultPrevented).toBe(false);
  expect(wheel({ deltaX: 2000, deltaY: 2000 }).defaultPrevented).toBe(true);
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([700, 1000]);
  expect(wheel({ deltaX: 100 }).defaultPrevented).toBe(false);
  expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(false);
  expect(wheel({ deltaY: 100, shiftKey: true }).defaultPrevented).toBe(false);
  expect(wheel({ deltaX: 100, deltaY: -20 }).defaultPrevented).toBe(true);
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([700, 980]);
  expect(wheel().defaultPrevented).toBe(false);
});

it('leaves unscrollable axes, Ctrl zoom and previously handled events alone', () => {
  Object.defineProperty(viewport, 'scrollWidth', { value: 500 });
  expect(wheel({ deltaX: 100 }).defaultPrevented).toBe(false);
  expect(wheel({ deltaY: 100, shiftKey: true }).defaultPrevented).toBe(false);
  expect(wheel({ deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
  target.addEventListener('wheel', event => event.preventDefault(), { once: true });
  wheel({ deltaY: 100 });
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
  Object.defineProperty(viewport, 'scrollHeight', { value: 400 });
  expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(false);
});

it('removes the wheel listener on destroy', async () => {
  await editor.destroy();
  expect(wheel({ deltaX: 100, deltaY: 100 }).defaultPrevented).toBe(false);
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
});
