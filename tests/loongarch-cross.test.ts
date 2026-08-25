import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface LoongArchInputBuilderModule {
  inputPaths: string[]
  parseArguments(arguments_: string[]): { output: string }
  verifyInputs(projectRoot?: string): void
}

const require = createRequire(import.meta.url)
const inputBuilder = require(
  '../build/loongarch-cross/prepare-input.cjs'
) as LoongArchInputBuilderModule
const previewScript = readFileSync(
  join(
    process.cwd(),
    'build',
    'loongarch-cross',
    'preview-deb.sh'
  ),
  'utf8'
)

let temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
  temporaryDirectories = []
})

describe('LoongArch cross-build input', () => {
  it('supports an explicit output path and rejects unknown arguments', () => {
    const output = join(tmpdir(), 'goodbuddy-loongarch-input.tgz')
    expect(
      inputBuilder.parseArguments(['--output', output]).output
    ).toBe(output)
    expect(() =>
      inputBuilder.parseArguments(['--unknown'])
    ).toThrow('未知参数')
    expect(() =>
      inputBuilder.parseArguments(['--output'])
    ).toThrow('--output 缺少值')
  })

  it('requires every architecture-neutral packaging input', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'goodbuddy-loongarch-input-test-')
    )
    temporaryDirectories.push(root)

    for (const relativePath of inputBuilder.inputPaths) {
      const absolutePath = join(root, relativePath)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, 'input')
    }

    expect(() => inputBuilder.verifyInputs(root)).not.toThrow()

    const missingPath = inputBuilder.inputPaths.at(-1)
    expect(missingPath).toBeDefined()
    rmSync(join(root, missingPath!), { force: true })
    expect(() => inputBuilder.verifyInputs(root)).toThrow(
      `龙芯交叉构建输入缺失：${missingPath}`
    )
  })
})

describe('LoongArch preview package contract', () => {
  it('keeps the preview isolated and verifies target native code', () => {
    expect(previewScript).toContain(
      'Package: goodbuddy-loongarch-preview'
    )
    expect(previewScript).toContain('Architecture: loong64')
    expect(previewScript).toContain(
      'goodbuddy-loongarch-preview'
    )
    expect(previewScript).toContain(
      '@koromix/koffi-linux-loong64'
    )
    expect(previewScript).toContain(
      'assert_loongarch_elf "${node_pty_binding}"'
    )
    expect(previewScript).toContain(
      'assert_loongarch_elf "${koffi_binding}"'
    )
    expect(previewScript).toContain('libpulse0')
    expect(previewScript).toContain('"bundledAgent": false')
    expect(previewScript).toContain(
      '"bundledRemoteRuntime": false'
    )
    expect(previewScript).toContain(
      '"bundledOpenCode": false'
    )
    expect(previewScript).toContain('"nativeCanvas": false')
    expect(previewScript).not.toContain('--no-sandbox')
  })
})
