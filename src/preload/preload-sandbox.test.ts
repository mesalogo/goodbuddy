import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('sandboxed preload', () => {
  it('does not import Node built-ins unavailable in Electron sandbox', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/\bfrom\s+['"]node:/u)
    expect(source).not.toMatch(/\brequire\(\s*['"]node:/u)
  })

  it('does not load runtime schema libraries in the Electron sandbox', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/\b\w+Schema\b/u)
    expect(source).not.toMatch(/\bfrom\s+['"]zod['"]/u)
  })

  it('exposes only explicit computer capability and managed profile IPC methods', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('setComputerCapabilityEnabled:')
    expect(source).toContain('diagnoseComputerCapability:')
    expect(source).toContain('createBrowserProfile:')
    expect(source).toContain('renameBrowserProfile:')
    expect(source).toContain('setDefaultBrowserProfile:')
    expect(source).toContain('removeBrowserProfile:')
    expect(source).not.toMatch(
      /(?:setComputerCapability|BrowserProfile).{0,80}(?:executablePath|command|env|args)/su
    )
  })

  it('exposes model ZIP dialogs without renderer-controlled paths', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('importArchive: (modelId: string)')
    expect(source).toContain('exportArchive: (modelId: string)')
    expect(source).toContain('importOcrModelArchive: (modelId: string)')
    expect(source).toContain('exportOcrModelArchive: (modelId: string)')
    expect(source).not.toContain('importLocalDirectory:')
    expect(source).not.toContain('importOcrModel:')
  })

  it('exposes a removable attachment parsing progress listener', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('onFileSelectionProgress:')
    expect(source).toContain('contextFileSelectionProgress')
    expect(source).toContain('ipcRenderer.removeListener(')
  })

  it('exposes only bounded release-note actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('releaseNotes: {')
    expect(source).toContain('getPending:')
    expect(source).toContain('acknowledge: async (version: string)')
    expect(source).toContain('ipcChannels.releaseNotesGetPending')
    expect(source).toContain('ipcChannels.releaseNotesAcknowledge')
  })

  it('exposes bounded knowledge task actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('cancelTask: (taskId: string)')
    expect(source).toContain('retryTask: async (taskId: string)')
    expect(source).toContain('ipcChannels.knowledgeTaskCancel')
    expect(source).toContain('ipcChannels.knowledgeTaskRetry')
  })
})
