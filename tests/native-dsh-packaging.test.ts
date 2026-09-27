import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher')

it('copies DS dependencies and nested assets through the actual builder matcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-dsh-packaging-'))
  const config = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const resource = config.build.extraResources.find((entry: { to: string }) => entry.to.startsWith('runtimes/dsh'))
  const files = ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh/node_modules/example/index.js', '@deepseek-ai/dsh-web/dist/index.html']
  try {
    for (const file of files) {
      const source = join(root, '.runtime-resources/dsh-x64/node_modules', file)
      mkdirSync(dirname(source), { recursive: true })
      writeFileSync(source, file)
    }
    const destination = join(root, 'output/resources')
    const matchers = getFileMatchers({ extraResources: [resource] }, 'extraResources', destination, {
      defaultSrc: root,
      globalOutDir: join(root, 'output'),
      customBuildOptions: {},
      macroExpander: (value: string) => value.replaceAll('${arch}', 'x64')
    })
    await copyFiles(matchers)
    for (const file of files) {
      expect(readFileSync(join(destination, 'runtimes/dsh/node_modules', file), 'utf8')).toBe(file)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
