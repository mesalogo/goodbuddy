import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher')
const { prepareNativeDshResources } = require('../build/native-dsh-resources.cjs')

it('copies DS dependencies and nested assets through the actual builder matcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-dsh-packaging-'))
  const config = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const resource = config.build.extraResources.find((entry: { to: string }) => entry.to.startsWith('runtimes/dsh'))
  const files = [
    '@deepseek-ai/dsh/lib/bin.js',
    '@deepseek-ai/dsh/node_modules/example/index.js',
    '@deepseek-ai/dsh-web/dist/index.html',
    '@deepseek-ai/dsh-web/config.yml',
    '@deepseek-ai/dsh-web/LICENSE',
    'native/addon.node',
    'native/helper.exe',
    'native/helper.dll',
    'assets/data.map'
  ]
  const excluded = [
    '@deepseek-ai/dsh/lib/bin.js.map',
    '@deepseek-ai/dsh/node_modules/example/index.d.ts',
    'example/index.d.mts',
    'example/index.d.cts',
    'example/index.d.ts.map',
    'example/index.mjs.map',
    'example/index.cjs.map',
    'native/helper.pdb'
  ]
  try {
    for (const file of [...files, ...excluded]) {
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
    for (const file of excluded) {
      expect(existsSync(join(destination, 'runtimes/dsh/node_modules', file)), file).toBe(false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('keeps npm CLI symlinks inside the relocated DS bundle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-dsh-symlinks-'))
  const write = (file: string, value: unknown): void => {
    const target = join(root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(value))
  }
  try {
    write('node_modules/@deepseek-ai/dsh/package.json', { name: '@deepseek-ai/dsh', dependencies: {
      child: '1.0.0', sharp: '1.0.0', '@koromix/koffi-linux-x64': '1.0.0'
    } })
    write('node_modules/@deepseek-ai/dsh/node_modules/child/package.json', { name: 'child', version: '1.0.0' })
    write('node_modules/@deepseek-ai/dsh/node_modules/child/bin.js', 'fixture')
    const sourceBin = join(root, 'node_modules/@deepseek-ai/dsh/node_modules/.bin')
    mkdirSync(sourceBin, { recursive: true })
    symlinkSync('../child/bin.js', join(sourceBin, 'child'))
    write('node_modules/sharp/package.json', { optionalDependencies: {
      '@img/sharp-linux-x64': '1.0.0', '@img/sharp-libvips-linux-x64': '1.0.0'
    } })
    write('node_modules/sharp/node_modules/@img/sharp-linux-x64/package.json', { version: '1.0.0' })
    write('node_modules/sharp/node_modules/@img/sharp-libvips-linux-x64/package.json', { version: '1.0.0' })
    write('node_modules/@koromix/koffi-linux-x64/package.json', { version: '1.0.0' })
    write('node_modules/koffi/package.json', { version: '1.0.0' })
    write('package-lock.json', { packages: {} })
    const unexpectedDownload = (): never => { throw new Error('Fixture must not download native packages') }
    await prepareNativeDshResources(root, 'linux', 'x64', unexpectedDownload, unexpectedDownload)
    const link = 'node_modules/@deepseek-ai/dsh/node_modules/.bin/child'
    expect(readlinkSync(join(root, '.runtime-resources/dsh-x64', link))).toBe('../child/bin.js')
    const config = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    const resource = config.build.extraResources.find((entry: { to: string }) => entry.to.startsWith('runtimes/dsh'))
    const destination = join(root, 'output/resources')
    await copyFiles(getFileMatchers({ extraResources: [resource] }, 'extraResources', destination, {
      defaultSrc: root, globalOutDir: join(root, 'output'), customBuildOptions: {},
      macroExpander: (value: string) => value.replaceAll('${arch}', 'x64')
    }))
    // No original installation or staging directory may be needed after shipping.
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    rmSync(join(root, '.runtime-resources'), { recursive: true, force: true })
    const packagedLink = join(destination, 'runtimes/dsh', link)
    expect(readlinkSync(packagedLink)).toBe('../child/bin.js')
    expect(readFileSync(packagedLink, 'utf8')).toBe(JSON.stringify('fixture'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
