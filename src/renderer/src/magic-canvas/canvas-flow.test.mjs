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
  const editor = mountFlowText(layer, toolbar, initial, { onError });
  mounted.push(editor);
  return { editor, quill: Quill.find(layer.firstElementChild), onError };
}

describe('canvas flow limits', () => {
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
