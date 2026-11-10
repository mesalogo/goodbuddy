/* global document, Event */
import { expect, it, vi } from 'vitest';
import { mountContinuousPages } from './continuous-pages.mjs';

it('keeps distant pages unmounted, rejects an offscreen render, and preserves the live editor', async () => {
  const viewport = document.createElement('div');
  const active = document.createElement('div');
  active.dataset.editor = 'live';
  viewport.append(active);
  document.body.append(viewport);
  Object.defineProperty(viewport, 'clientHeight', { value: 300 });
  const pages = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), width: 200, height: 400 }));
  let finish;
  const stale = document.createElement('canvas');
  stale.dataset.stale = 'true';
  const render = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementation(async () => document.createElement('canvas'));
  const activate = vi.fn();
  const view = mountContinuousPages(viewport, active, { render, activate, onError: error => { throw error; } });
  try {
    view.update(pages, 0, 1);
    view.setEnabled(true);
    expect(viewport.querySelectorAll('.canvas-note-continuous-page').length).toBeLessThan(6);
    viewport.scrollTop = 999 * 416;
    viewport.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(viewport.querySelector('[data-page-id="999"]')).not.toBeNull());
    finish(stale);
    await vi.waitFor(() => expect(viewport.querySelector('[data-page-id="999"] canvas')).not.toBeNull());
    expect(viewport.querySelector('[data-stale]')).toBeNull();
    expect(viewport.querySelector('[data-editor]')).toBe(active);
    viewport.querySelector('[data-page-id="999"]').click();
    expect(activate).toHaveBeenCalledWith(999);
    view.update(pages, 999, 1);
    expect(viewport.querySelector('[data-page-id="999"] [data-editor]')).toBe(active);
    view.setEnabled(false);
    expect(active.parentElement).toBe(viewport);
    expect(viewport.querySelector('.canvas-note-page-stack')).toBeNull();
  } finally { view.destroy(); viewport.remove(); }
});
