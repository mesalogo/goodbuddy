/* global document, AbortController, requestAnimationFrame, cancelAnimationFrame */
// Keep one live editor, and rasterize only the pages near the scroll viewport.
// Page coordinates and the serialized document never depend on the view mode.
export function mountContinuousPages(viewport, activeElement, { render, activate, onError }) {
  const stack = document.createElement('div');
  stack.className = 'canvas-note-page-stack';
  const slots = new Map();
  let pages = [], current = 0, zoom = 1, enabled = false, destroyed = false;
  let positions = [], frame = 0, rendering = false, revision = 0;
  const abort = new AbortController();

  function schedule() {
    if (!enabled || destroyed || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; layout(); });
  }

  async function paint() {
    if (rendering || destroyed) return;
    rendering = true;
    try {
      for (const [id, slot] of slots) {
        if (!enabled || destroyed) break;
        if (id === pages[current]?.id || slot.painted === revision) continue;
        const pageIndex = pages.findIndex(page => page.id === id);
        if (pageIndex < 0) continue;
        const version = revision;
        slot.painted = version;
        try {
          const image = await render(pages[pageIndex], pageIndex, zoom);
          if (!destroyed && enabled && version === revision && slots.get(id) === slot && id !== pages[current]?.id) {
            slot.element.replaceChildren(image);
          }
        } catch (error) {
          if (!destroyed && enabled && version === revision) onError(error);
        }
      }
    } finally {
      rendering = false;
      if (enabled && !destroyed && [...slots].some(([id, slot]) => id !== pages[current]?.id && slot.painted !== revision)) schedule();
    }
  }

  function layout() {
    if (!enabled || destroyed) return;
    let top = 0, width = 0;
    positions = pages.map(page => {
      const position = top;
      top += page.height * zoom + 16;
      width = Math.max(width, page.width * zoom);
      return position;
    });
    stack.style.height = `${Math.max(0, top - 16)}px`;
    stack.style.width = `${width}px`;
    const low = viewport.scrollTop - viewport.clientHeight;
    const high = viewport.scrollTop + viewport.clientHeight * 2;
    const wanted = new Set();
    pages.forEach((page, index) => {
      if (index !== current && (positions[index] + page.height * zoom < low || positions[index] > high)) return;
      wanted.add(page.id);
      let slot = slots.get(page.id);
      if (!slot) {
        const element = document.createElement('div');
        element.className = 'canvas-note-continuous-page';
        element.dataset.pageId = page.id;
        element.textContent = `第 ${index + 1} 页 · 加载中…`;
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        const select = () => {
          const next = pages.findIndex(item => item.id === page.id);
          if (next >= 0 && next !== current) activate(next);
        };
        element.onclick = select;
        element.onkeydown = event => {
          if (event.target !== element || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault(); select();
        };
        slot = { element, painted: -1 };
        slots.set(page.id, slot);
        stack.append(element);
      }
      slot.element.setAttribute('aria-label', `第 ${index + 1} 页，点击阅读或编辑`);
      slot.element.style.top = `${positions[index]}px`;
      slot.element.style.width = `${page.width * zoom}px`;
      slot.element.style.height = `${page.height * zoom}px`;
      slot.element.classList.toggle('canvas-note-current-page', index === current);
      if (index === current) {
        slot.element.removeAttribute('role');
        slot.element.tabIndex = -1;
        if (activeElement.parentElement !== slot.element) slot.element.replaceChildren(activeElement);
      } else {
        slot.element.setAttribute('role', 'button');
        slot.element.tabIndex = 0;
      }
    });
    for (const [id, slot] of slots) {
      if (!wanted.has(id)) { slot.element.remove(); slots.delete(id); }
    }
    void paint();
  }

  viewport.addEventListener('scroll', schedule, { passive: true, signal: abort.signal });
  return {
    update(nextPages, nextCurrent, nextZoom, invalidate = false) {
      if (pages !== nextPages || current !== nextCurrent || zoom !== nextZoom || invalidate) {
        revision++;
      }
      pages = nextPages; current = nextCurrent; zoom = nextZoom;
      if (enabled) layout();
    },
    setEnabled(value) {
      enabled = value;
      revision++;
      viewport.classList.toggle('canvas-note-continuous', enabled);
      if (enabled) {
        viewport.append(stack);
        layout();
        viewport.scrollTop = positions[current] || 0;
        schedule();
      } else {
        viewport.append(activeElement);
        stack.remove();
        for (const slot of slots.values()) slot.element.remove();
        slots.clear();
      }
    },
    reveal() {
      if (!enabled) return;
      layout();
      const top = positions[current] || 0;
      const bottom = top + pages[current].height * zoom;
      if (bottom <= viewport.scrollTop || top >= viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top;
    },
    destroy() {
      destroyed = true;
      abort.abort();
      if (frame) cancelAnimationFrame(frame);
      slots.clear();
      stack.remove();
    }
  };
}
