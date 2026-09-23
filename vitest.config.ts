import { availableParallelism } from 'node:os'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

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
          maxWorkers: 1,
          // Keep process/socket tests separate from the parallel unit phase.
          sequence: { groupOrder: 1 }
        }
      }
    ],
    coverage: {
      reporter: ['text', 'html']
    }
  }
})
