import { availableParallelism } from 'node:os'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// Real Electron UI tests: each file starts an Electron instance, so they are the slowest phase.
const electronTests = ['tests/**/*.electron.test.ts']

// Process/socket tests that must not run in parallel (see BUILD.md).
const serialTests = [
  ...configDefaults.include.map((pattern) => `tests/${pattern}`),
  'src/main/agent/**/*runtime*.test.ts',
  'src/agent-daemon/private-endpoint.test.ts'
]

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test-setup.ts'],
    exclude: [
      'temp/**',
      '.agent-resources/**',
      'shareserver/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build-server/**',
      '**/.git/**'
    ],
    maxWorkers: Math.min(4, availableParallelism()),
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: serialTests,
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: serialTests,
          exclude: electronTests,
          maxWorkers: 1,
          // Keep process/socket tests separate from the parallel unit phase.
          sequence: { groupOrder: 1 }
        }
      },
      {
        extends: true,
        test: {
          name: 'electron',
          include: electronTests,
          maxWorkers: 1,
          sequence: { groupOrder: 2 }
        }
      }
    ],
    coverage: {
      reporter: ['text', 'html']
    }
  }
})
