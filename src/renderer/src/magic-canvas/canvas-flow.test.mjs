/* global document, HTMLCanvasElement, XMLSerializer */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Quill from 'quill';
import { flowPlainText, mountFlowText, normalizeFlowContent } from './canvas-flow.mjs';

const mounted = [];
afterEach(() => {
  mounted.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('exports actual list labels, nested numbering, checkbox states and indentation', async () => {
  const rows = [['ordered', 0], ['ordered', 0], ['ordered', 1], ['ordered', 2], ['bullet', 0], ['checked', 0], ['unchecked', 0]];
  const ops = rows.flatMap(([list, indent]) => [{ insert: 'Body' }, { insert: '\n', attributes: { list, ...(indent ? { indent } : {}) } }]);
  ops.push({ insert: 'Reset\n' }, { insert: 'Body' }, { insert: '\n', attributes: { list: 'ordered' } });
  const { editor } = mount({ version: 1, ops });
  const sourceItems = [...document.querySelectorAll('.ql-editor li')];
  sourceItems.forEach((item) => { item.style.listStyleType = 'none'; });
  sourceItems[2].style.padding = '0 0 0 72px';
  sourceItems[3].style.padding = '0 0 0 120px';
  let clone;
  const serialize = XMLSerializer.prototype.serializeToString;
  vi.spyOn(XMLSerializer.prototype, 'serializeToString').mockImplementation(function (node) {
    clone = node.cloneNode(true);
    return serialize.call(this, node);
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
  vi.stubGlobal('Image', class {
    set src(value) { if (value) this.onload(); }
  });
  await editor.renderPage(0, 794, 1123);
  const items = [...clone.querySelectorAll('li')];
  expect(items.map((item) => item.firstChild.textContent)).toEqual(['1.', '2.', 'a.', 'i.', '\u2022', '\u2611', '\u2610', '1.']);
  expect(items[2].style.paddingLeft).toBe('72px');
  expect(items[3].style.paddingLeft).toBe('120px');
  expect(items.every((item) => item.style.listStyleType === 'none')).toBe(true);
  expect(clone.querySelector('.ql-ui')).toBeNull();
});

function mount(initial) {
  const layer = document.createElement('div');
  const toolbar = document.createElement('div');
  document.body.append(layer, toolbar);
  const onError = vi.fn();
  const onChange = vi.fn();
  const editor = mountFlowText(layer, toolbar, initial, { onError, onChange });
  mounted.push(editor);
  const quill = Quill.find(layer.firstElementChild);
  // jsdom has no Range geometry; actual selection scrolling runs in Electron.
  vi.spyOn(quill, 'scrollSelectionIntoView').mockImplementation(() => {});
  return { editor, quill, onError, onChange };
}

describe('canvas flow limits', () => {
  it('keeps normal accepted undo/redo and does not replace other Quill editors history modules', () => {
    const History = Quill.import('modules/history');
    const { editor, quill, onError } = mount({ version: 1, ops: [{ insert: 'x'.repeat(19995) + '\n' }] });
    quill.insertText(19995, 'HELLO', 'user');
    editor.undo();
    expect(editor.text()).toBe('x'.repeat(19995));
    editor.redo();
    expect(editor.text()).toBe('x'.repeat(19995) + 'HELLO');
    expect(onError).not.toHaveBeenCalled();
    expect(Quill.import('modules/history')).toBe(History);
    expect(quill.history.constructor).not.toBe(History);
  });

  it.each([false, true])('retains accepted undo and redo after overflow (cutoff: %s)', (cutoff) => {
    const { editor, quill, onError, onChange } = mount({ version: 1, ops: [{ insert: 'x'.repeat(19995) + '\n' }] });
    quill.setSelection(19995, 0, 'api');
    quill.insertText(19995, 'HELLO', 'user');
    quill.setSelection(20000, 0, 'api');
    if (cutoff) quill.history.cutoff();
    quill.insertText(20000, '!', 'user');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(quill.getSelection()).toEqual({ index: 20000, length: 0 });
    expect(quill.history.stack.undo).toHaveLength(1);
    editor.undo();
    expect(editor.text()).toBe('x'.repeat(19995));
    expect(editor.canRedo()).toBe(true);
    quill.setSelection(3, 4, 'api');
    quill.insertText(3, 'REJECTED', 'user');
    expect(quill.getSelection()).toEqual({ index: 3, length: 4 });
    expect(editor.text()).toBe('x'.repeat(19995));
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(true);
    editor.redo();
    expect(editor.text()).toBe('x'.repeat(19995) + 'HELLO');
  });

  it('preserves replacement selections and accepted formatting when rejecting an oversized paste', () => {
    const { editor, quill } = mount({ version: 1, ops: [{ insert: 'x'.repeat(20000) + '\n' }] });
    quill.formatText(0, 5, 'bold', true, 'user');
    const accepted = editor.content();
    quill.setSelection(10, 3, 'api');
    const Delta = Quill.import('delta');
    quill.updateContents(new Delta().retain(10).delete(3).insert('TOO LONG'), 'user');
    expect(editor.content()).toEqual(accepted);
    expect(quill.getSelection()).toEqual({ index: 10, length: 3 });
    editor.undo();
    expect(editor.content()).toEqual({ version: 1, ops: [{ insert: 'x'.repeat(20000) + '\n' }] });
  });

  it.each([0.25, 0.5, 2, 3])('measures logical columns and selection at %sx display scale', (scale) => {
    const { editor, quill } = mount({ version: 1, ops: [{ insert: 'Body\n' }] });
    editor.setLayout(640, 960, 1);
    vi.spyOn(quill.root, 'getBoundingClientRect').mockReturnValue({ left: 10, width: 640 * scale });
    vi.spyOn(quill.root.firstElementChild, 'getClientRects').mockReturnValue([{ left: 10 + 688 * 2 * scale }]);
    vi.spyOn(quill, 'getSelection').mockReturnValue({ index: 0, length: 0 });
    vi.spyOn(quill, 'getBounds').mockReturnValue({ left: 688 * scale });
    expect(editor.pageCount()).toBe(3);
    expect(editor.activePageIndex()).toBe(2);
  });
  it('round trips exactly 20,000 characters with a separate formatted terminal newline', () => {
    const content = { version: 1, ops: [{ insert: '中'.repeat(20000) }, { insert: '\n', attributes: { list: 'checked', indent: 2 } }] };
    expect(normalizeFlowContent(content)).toEqual(content);
    expect(flowPlainText(content)).toHaveLength(20000);
    expect(normalizeFlowContent({ version: 1, ops: [{ insert: 'x'.repeat(20000) }] }).ops[0].insert).toHaveLength(20000);
  });

  it('counts internal newlines but not page-break embeds or the single terminal newline', () => {
    const content = { version: 1, ops: [{ insert: 'x'.repeat(19999) + '\n' }, { insert: { canvasPageBreak: 'page-2' } }, { insert: '\n' }] };
    expect(normalizeFlowContent(content)).toEqual(content);
    expect(() => normalizeFlowContent({ version: 1, ops: [{ insert: 'x'.repeat(20000) + '\n\n' }] })).toThrow(/20,000/);
    expect(normalizeFlowContent({ version: 1, ops: [{ insert: '  \n' }] })).not.toBeNull();
  });

  it('rejects oversized initial documents and operation arrays instead of returning null', () => {
    const content = { version: 1, ops: [{ insert: 'x'.repeat(20001) + '\n' }] };
    expect(() => normalizeFlowContent(content)).toThrow(/20,000/);
    expect(() => mount(content)).toThrow(/20,000/);
    expect(() => normalizeFlowContent({ version: 1, ops: Array.from({ length: 5001 }, () => ({ insert: 'x' })) })).toThrow(/5,000/);
  });

  it('flush preserves the boundary, rolls back excess user input, and rejects oversized API edits', async () => {
    const { editor, quill, onError } = mount();
    quill.setText('中'.repeat(20000), 'user');
    expect(flowPlainText(await editor.flush())).toHaveLength(20000);
    quill.insertText(20000, 'x', 'user');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('20,000'));
    expect(flowPlainText(await editor.flush())).toHaveLength(20000);
    quill.setText('x'.repeat(20001), 'api');
    await expect(editor.flush()).rejects.toThrow(/20,000/);
    expect(quill.getText()).toHaveLength(20002);
  });
});

describe('canvas page-break removal', () => {
  it.each([{ list: 'unchecked' }, { list: 'checked' }, { header: 1 }, { blockquote: true }, {}])(
    'preserves existing paragraph terminators and formats: %j', (attributes) => {
      const { editor, quill } = mount({ version: 1, ops: [
        { insert: 'Task' }, { insert: '\n', attributes }, { insert: '\n' }
      ] });
      const original = editor.content();
      quill.setSelection(5, 0, 'api');
      expect(editor.insertPageBreak('page-2')).toBe(true);
      expect(editor.insertPageBreak('page-2')).toBe(false);
      expect(editor.removePageBreak('missing')).toBe(false);
      expect(editor.removePageBreak('page-2')).toBe(true);
      expect(editor.content()).toEqual(original);
      expect(editor.removePageBreak('page-2')).toBe(false);
    }
  );

  it('retains Quill paragraph splitting and both checklist formats when inserting within a line', () => {
    const { editor, quill } = mount({ version: 1, ops: [
      { insert: 'Task body' }, { insert: '\n', attributes: { list: 'unchecked' } }
    ] });
    quill.setSelection(4, 0, 'api');
    editor.insertPageBreak('page-2');
    editor.removePageBreak('page-2');
    expect(editor.content()).toEqual({ version: 1, ops: [
      { insert: 'Task' }, { insert: '\n', attributes: { list: 'unchecked' } },
      { insert: ' body' }, { insert: '\n', attributes: { list: 'unchecked' } }
    ] });
  });
});
