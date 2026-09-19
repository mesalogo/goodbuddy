import { expect, it, vi } from 'vitest';

it('loads the real canvas core without initializing PDF.js or requiring DOMMatrix', async () => {
  vi.stubGlobal('DOMMatrix', undefined);
  try {
    await expect(import('./canvas-note.mjs')).resolves.toHaveProperty('mountCanvasNote', expect.any(Function));
  } finally {
    vi.unstubAllGlobals();
  }
});
