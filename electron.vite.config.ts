import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@agentclientprotocol/sdk',
          '@deepseek-ai/cordis',
          '@deepseek-ai/dsh-agent',
          '@deepseek-ai/dsh-agent-loop',
          '@deepseek-ai/dsh-bash-local',
          '@deepseek-ai/dsh-credentials',
          '@deepseek-ai/dsh-fs-local',
          '@deepseek-ai/dsh-llm',
          '@deepseek-ai/dsh-llm-pi-ai',
          '@deepseek-ai/dsh-pwsh-local',
          '@deepseek-ai/dsh-sandbox',
          '@deepseek-ai/dsh-sandbox-policy',
          '@deepseek-ai/dsh-session',
          '@deepseek-ai/dsh-shell-env',
          '@deepseek-ai/dsh-skill',
          '@deepseek-ai/dsh-subprocess-local',
          '@deepseek-ai/dsh-system-prompt',
          '@deepseek-ai/dsh-token-meter',
          '@deepseek-ai/dsh-tool-bash',
          '@deepseek-ai/dsh-tool-fs',
          '@deepseek-ai/dsh-tool-pwsh',
          '@deepseek-ai/dsh-tool-skill',
          '@deepseek-ai/dsh-tools',
          '@deepseek-ai/dsh-user-approval',
          'yaml',
          'zod'
        ]
      })
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'wechat-sidecar': resolve(
            'src/main/channels/wechat-sidecar.ts'
          ),
          'deepseek-harness-host-bootstrap': resolve(
            'src/main/deepseek-harness-host-bootstrap.ts'
          )
        },
        external: [
          'node-pty',
          'koffi',
          /^@koromix\/koffi-/u
        ],
        output: {
          entryFileNames(chunk) {
            return chunk.name === 'deepseek-harness-host-bootstrap'
              ? 'deepseek-harness-host-bootstrap.js'
              : '[name].js'
          },
          chunkFileNames(chunk) {
            const moduleIds = chunk.moduleIds.join('\n')
            return moduleIds.includes('deepseek-harness') ||
              moduleIds.includes('deepseek-harness-utility')
              ? 'chunks/deepseek-harness-[name]-[hash].js'
              : 'chunks/[name]-[hash].js'
          },
          manualChunks(id) {
            if (
              id.includes('@deepseek-ai/dsh-llm') ||
              id.includes('@deepseek-ai/dsh-credentials') ||
              id.includes('@deepseek-ai/dsh-settings') ||
              id.includes('@deepseek-ai/dsh-timeout') ||
              id.includes('@deepseek-ai/dsh-token-meter') ||
              id.includes('@deepseek-ai/dsh-llm-pi-ai') ||
              id.includes('@mariozechner/pi-ai')
            ) {
              return 'deepseek-harness-llm'
            }
            return undefined
          }
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    worker: {
      format: 'es'
    },
    plugins: [react()]
  }
})
