import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

type ProjectPackage = {
  dependencies?: Record<string, string>
}

const projectPackage = JSON.parse(
  readFileSync(resolve('package.json'), 'utf8')
) as ProjectPackage

function requireDependencyVersion(
  dependencies: Record<string, string> | undefined,
  name: string
): string {
  const version = dependencies?.[name]
  if (!version) {
    throw new Error(`Missing ${name} dependency version`)
  }
  return version
}

const deepSeekHarnessLlmVersion = requireDependencyVersion(
  projectPackage.dependencies,
  '@deepseek-ai/dsh-llm'
)

export function serializeDeepSeekHarnessBundleManifest(
  version: string
): string {
  return `${JSON.stringify(
    {
      name: '@deepseek-ai/dsh-llm',
      version,
      private: true,
      type: 'module'
    },
    null,
    2
  )}\n`
}

function deepSeekHarnessBundleManifestPlugin(): Plugin {
  return {
    name: 'deepseek-harness-bundle-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'package.json',
        source: serializeDeepSeekHarnessBundleManifest(
          deepSeekHarnessLlmVersion
        )
      })
    }
  }
}

export function sanitizeRendererModuleId(
  id: string,
  projectRoot = resolve('.')
): string {
  const normalized = id.replaceAll('\\', '/')
  const normalizedRoot = resolve(projectRoot).replaceAll('\\', '/')
  if (normalized.startsWith('\0')) {
    const virtualId = normalized.slice(1)
    if (virtualId.startsWith(`${normalizedRoot}/`)) {
      return `virtual:${virtualId.slice(normalizedRoot.length + 1)}`
    }
    const virtualNodeModulesIndex =
      virtualId.lastIndexOf('/node_modules/')
    if (virtualNodeModulesIndex >= 0) {
      return `virtual:node_modules/${virtualId.slice(
        virtualNodeModulesIndex + '/node_modules/'.length
      )}`
    }
    if (
      virtualId.startsWith('/') ||
      /[A-Za-z]:\//u.test(virtualId) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(virtualId) ||
      virtualId.includes('/Users/') ||
      virtualId.includes('/home/')
    ) {
      throw new Error(`Renderer virtual module leaks a path: ${id}`)
    }
    return `virtual:${virtualId}`
  }
  if (
    normalized === normalizedRoot ||
    normalized.startsWith(`${normalizedRoot}/`)
  ) {
    return normalized.slice(normalizedRoot.length + 1)
  }
  const nodeModulesMarker = '/node_modules/'
  const nodeModulesIndex = normalized.lastIndexOf(nodeModulesMarker)
  if (nodeModulesIndex >= 0) {
    return `node_modules/${normalized.slice(
      nodeModulesIndex + nodeModulesMarker.length
    )}`
  }
  if (
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//u.test(normalized) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized) &&
    !normalized.startsWith('../')
  ) {
    return normalized
  }
  throw new Error(`Renderer module is outside the project: ${id}`)
}

function rendererBundleModuleManifestPlugin(): Plugin {
  const projectRoot = resolve('.')
  return {
    name: 'renderer-bundle-module-manifest',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((item) => item.type === 'chunk')
        .map((chunk) => [
          chunk.fileName,
          Object.keys(chunk.modules).map((id) =>
            sanitizeRendererModuleId(id, projectRoot)
          )
        ])
      this.emitFile({
        type: 'asset',
        fileName: '.vite/module-manifest.json',
        source: `${JSON.stringify(Object.fromEntries(chunks), null, 2)}\n`
      })
    }
  }
}

export function stableMainEntryFileName(chunk: {
  readonly name: string
}): string {
  return [
    'deepseek-harness-host-bootstrap',
    'embedding-inference-bootstrap'
  ].includes(chunk.name)
    ? `${chunk.name}.js`
    : '[name].js'
}

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
      }),
      deepSeekHarnessBundleManifestPlugin()
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
          ),
          'embedding-inference-bootstrap': resolve(
            'src/main/embedding-inference-bootstrap.ts'
          )
        },
        external: [
          'node-pty',
          'koffi',
          /^@koromix\/koffi-/u
        ],
        output: {
          entryFileNames(chunk) {
            return stableMainEntryFileName(chunk)
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
    build: {
      manifest: true
    },
    plugins: [react(), rendererBundleModuleManifestPlugin()]
  }
})
