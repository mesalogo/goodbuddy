import { defineConfig } from 'vitest/config'

// The SSH fixture bundles current Agent source with esbuild, which needs Node
// globals rather than the renderer suite's jsdom typed-array globals.
export default defineConfig({
  test: { environment: 'node', include: ['src/main/ipc.test.ts'], maxWorkers: 1 }
})
