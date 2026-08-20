// @vitest-environment node

import { createRequire } from 'node:module'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

type ManifestItem = {
  file: string
  src?: string
  name?: string
  isEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
}

type Manifest = Record<string, ManifestItem>

type Analysis = {
  keys: {
    initial: string
    knowledge: string
    graph: string
    activity: string
    magicNotes: string
    settings: string
    g6: string[]
  }
  sections: Record<
    string,
    {
      raw: number
      gzip: number
      rootRaw: number
      rootGzip: number
      closureKeys: Set<string>
      incrementalKeys: Set<string>
      files: string[]
    }
  >
}

type RendererBundleChecker = {
  analyzeRendererManifest: (
    manifest: Manifest,
    readAsset: (file: string) => Buffer,
    moduleManifest: Record<string, string[]>
  ) => Analysis
  checkBudgets: (
    analysis: Analysis,
    budgets: Record<string, { raw: number; gzip: number }>
  ) => void
  checkRendererBundle: (root: string) => Analysis
  collectSynchronousClosure: (
    manifest: Manifest,
    root: string
  ) => Set<string>
  assertSafeModuleManifest: (
    moduleManifest: Record<string, string[]>
  ) => void
}

const require = createRequire(import.meta.url)
const checker = require(
  '../build/check-renderer-bundle.cjs'
) as RendererBundleChecker

function createManifest(
  overrides: Partial<Manifest> = {}
): Manifest {
  return {
    'src/main.tsx': {
      file: 'assets/main.js',
      src: 'src/main.tsx',
      isEntry: true,
      imports: ['_shared.js'],
      dynamicImports: [
        'src/KnowledgeWorkspace.tsx',
        'src/ActivityPanel.tsx'
      ]
    },
    '_shared.js': {
      file: 'assets/shared.js'
    },
    'src/KnowledgeWorkspace.tsx': {
      file: 'assets/KnowledgeWorkspace.js',
      src: 'src/KnowledgeWorkspace.tsx',
      imports: ['_shared.js'],
      dynamicImports: ['src/KnowledgeGraphChart.tsx']
    },
    'src/KnowledgeGraphChart.tsx': {
      file: 'assets/KnowledgeGraphChart.js',
      src: 'src/KnowledgeGraphChart.tsx',
      imports: ['_shared.js', '_g6.js']
    },
    '_g6.js': {
      file: 'assets/knowledge-graph-g6.js',
      name: 'knowledge-graph-g6'
    },
    'src/ActivityPanel.tsx': {
      file: 'assets/ActivityPanel.js',
      src: 'src/ActivityPanel.tsx',
      imports: ['_shared.js']
    },
    'src/MagicNotesWorkspace.tsx': {
      file: 'assets/MagicNotesWorkspace.js',
      src: 'src/MagicNotesWorkspace.tsx',
      imports: ['_shared.js'],
      css: ['assets/MagicNotesWorkspace.css']
    },
    'src/SettingsPanel.tsx': {
      file: 'assets/SettingsPanel.js',
      src: 'src/SettingsPanel.tsx',
      imports: ['_shared.js']
    },
    ...overrides
  }
}

const readAsset = (file: string): Buffer =>
  Buffer.from(file.repeat(4), 'utf8')

const moduleManifest = {
  'assets/KnowledgeGraphChart.js': [
    'src/KnowledgeGraphChart.tsx',
    'node_modules/@antv/g6/esm/index.js'
  ]
}

function writeBundleFixture(
  root: string,
  manifest: Manifest
): string {
  const rendererRoot = join(root, 'out', 'renderer')
  const viteRoot = join(rendererRoot, '.vite')
  mkdirSync(viteRoot, { recursive: true })
  writeFileSync(
    join(viteRoot, 'manifest.json'),
    JSON.stringify(manifest)
  )
  const moduleManifestPath = join(viteRoot, 'module-manifest.json')
  writeFileSync(
    moduleManifestPath,
    JSON.stringify(moduleManifest)
  )
  const files = new Set(
    Object.values(manifest).flatMap((item) => [
      item.file,
      ...(item.css ?? [])
    ])
  )
  for (const file of files) {
    const assetPath = join(rendererRoot, file)
    mkdirSync(dirname(assetPath), { recursive: true })
    writeFileSync(assetPath, file)
  }
  return moduleManifestPath
}

describe('renderer bundle manifest checker', () => {
  it('traverses only synchronous manifest imports', () => {
    const closure = checker.collectSynchronousClosure(
      createManifest(),
      'src/main.tsx'
    )

    expect([...closure].sort()).toEqual([
      '_shared.js',
      'src/main.tsx'
    ])
  })

  it('reports dynamic roots without recounting the initial closure', () => {
    const analysis = checker.analyzeRendererManifest(
      createManifest(),
      readAsset,
      moduleManifest
    )

    expect(analysis.sections.knowledge!.incrementalKeys).toEqual(
      new Set(['src/KnowledgeWorkspace.tsx'])
    )
    expect(analysis.sections.graph!.incrementalKeys).toEqual(
      new Set(['src/KnowledgeGraphChart.tsx', '_g6.js'])
    )
    expect(analysis.sections.activity!.incrementalKeys).toEqual(
      new Set(['src/ActivityPanel.tsx'])
    )
    expect(analysis.sections.magicNotes!.files).toContain(
      'assets/MagicNotesWorkspace.css'
    )
    expect(analysis.sections.magicNotes!.raw).toBe(
      Buffer.byteLength(
        'assets/MagicNotesWorkspace.js'.repeat(4) +
          'assets/MagicNotesWorkspace.css'.repeat(4)
      )
    )
    expect(analysis.sections.initial!.raw).toBeGreaterThan(0)
    expect(analysis.sections.initial!.gzip).toBeGreaterThan(0)
    const g6Keys: string[] = analysis.keys.g6
    expect(g6Keys).toEqual(['src/KnowledgeGraphChart.tsx'])
  })

  it('reads and gzips each shared asset once per analysis', () => {
    const reads = new Map<string, number>()
    const analysis = checker.analyzeRendererManifest(
      createManifest(),
      (file) => {
        reads.set(file, (reads.get(file) ?? 0) + 1)
        return readAsset(file)
      },
      moduleManifest
    )

    const reportedFiles = new Set(
      Object.values(analysis.sections).flatMap(
        (section) => section.files
      )
    )
    expect([...reads.keys()].sort()).toEqual(
      [...reportedFiles].sort()
    )
    expect([...reads.values()].every((count) => count === 1)).toBe(true)
  })

  it('rejects graph code in the Knowledge shell synchronous closure', () => {
    const manifest = createManifest({
      'src/KnowledgeWorkspace.tsx': {
        file: 'assets/KnowledgeWorkspace.js',
        src: 'src/KnowledgeWorkspace.tsx',
        imports: ['_shared.js', 'src/KnowledgeGraphChart.tsx']
      }
    })

    expect(() =>
      checker.analyzeRendererManifest(manifest, readAsset, moduleManifest)
    ).toThrow(/Knowledge shell.*KnowledgeGraphChart/u)
  })

  it('rejects Activity in the synchronous initial closure', () => {
    const manifest = createManifest({
      'src/main.tsx': {
        file: 'assets/main.js',
        src: 'src/main.tsx',
        isEntry: true,
        imports: ['_shared.js', 'src/ActivityPanel.tsx']
      }
    })

    expect(() =>
      checker.analyzeRendererManifest(
        manifest,
        readAsset,
        moduleManifest
      )
    ).toThrow(/renderer entry.*ActivityPanel/u)
  })

  it('enforces raw and gzip budgets', () => {
    const analysis = checker.analyzeRendererManifest(
      createManifest(),
      readAsset,
      moduleManifest
    )

    expect(() =>
      checker.checkBudgets(analysis, {
        initial: { raw: 1, gzip: Number.MAX_SAFE_INTEGER }
      })
    ).toThrow(/initial raw/u)
  })

  it('deduplicates aliased output files across manifest keys', () => {
    const manifest = createManifest({
      'src/main.tsx': {
        file: 'assets/main.js',
        src: 'src/main.tsx',
        isEntry: true,
        imports: ['_shared.js', '_shared-alias.js']
      },
      '_shared-alias.js': {
        file: 'assets/shared.js'
      }
    })
    const analysis = checker.analyzeRendererManifest(
      manifest,
      readAsset,
      moduleManifest
    )

    expect(analysis.sections.initial!.files).toEqual([
      'assets/main.js',
      'assets/shared.js'
    ])
    expect(analysis.sections.initial!.raw).toBe(
      Buffer.byteLength(
        'assets/main.js'.repeat(4) +
          'assets/shared.js'.repeat(4)
      )
    )
  })

  it('rejects absolute paths in the build-only module manifest', () => {
    expect(() =>
      checker.assertSafeModuleManifest({
        'assets/main.js': ['C:/Users/example/project/src/main.tsx']
      })
    ).toThrow(/Unsafe renderer module manifest path/u)
    expect(() =>
      checker.assertSafeModuleManifest({
        'assets/main.js': ['file:///home/example/project/src/main.tsx']
      })
    ).toThrow(/Unsafe renderer module manifest path/u)
  })

  it('removes the build-only manifest only after a successful check', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-bundle-'))
    try {
      const moduleManifestPath = writeBundleFixture(
        root,
        createManifest()
      )

      checker.checkRendererBundle(root)

      expect(existsSync(moduleManifestPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retains the build-only manifest after a failed check', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-bundle-'))
    try {
      const manifest = createManifest({
        'src/main.tsx': {
          file: 'assets/main.js',
          src: 'src/main.tsx',
          isEntry: true,
          imports: ['src/ActivityPanel.tsx']
        }
      })
      const moduleManifestPath = writeBundleFixture(root, manifest)

      expect(() => checker.checkRendererBundle(root)).toThrow(
        /renderer entry.*ActivityPanel/u
      )
      expect(existsSync(moduleManifestPath)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
