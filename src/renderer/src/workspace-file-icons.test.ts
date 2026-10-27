import { describe, expect, it } from 'vitest'
import manifest from 'material-icon-theme/dist/material-icons.json'
import { workspaceFileIconName, workspaceFileIconUrl } from './workspace-file-icons'

describe('workspace file icons', () => {
  it('resolves names, compound extensions and cross-platform paths', () => {
    expect(workspaceFileIconName('src/package.json')).toBe('nodejs')
    expect(workspaceFileIconName('C:\\project\\APP.TSX')).toBe('react_ts')
    expect(workspaceFileIconName('types/window.d.ts')).toBe(manifest.fileExtensions['d.ts'])
    expect(workspaceFileIconName('.gitignore')).toBe('git')
    expect(workspaceFileIconName('report.pdf')).toBe('pdf')
    expect(workspaceFileIconName('report.docx')).toBe('word')
    expect(workspaceFileIconName('unknown.extension-not-recognized')).toBe('file')
    expect(workspaceFileIconName('LICENSE')).toBe(manifest.fileNames['license'])
  })

  it('uses named and generic folders with distinct expanded icons', () => {
    expect(workspaceFileIconName('src', true)).toBe(manifest.folderNames.src)
    expect(workspaceFileIconName('src', true, true)).toBe(manifest.folderNamesExpanded.src)
    expect(workspaceFileIconName('my-unrecognized-folder', true)).toBe('folder')
    expect(workspaceFileIconName('my-unrecognized-folder', true, true)).toBe('folder-open')
    expect(workspaceFileIconName('config.toml', false, false, true)).toBe('toml_light')
  })

  it('packages every icon referenced by file and folder associations, including light variants', () => {
    const names = new Set(['file', 'folder', 'folder-open'])
    for (const theme of [manifest, manifest.light]) {
      for (const key of ['fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded'] as const) {
        Object.values(theme[key]).forEach((name) => names.add(name))
      }
    }
    const definitions: Record<string, { iconPath: string }> = manifest.iconDefinitions
    for (const name of names) {
      const filename = definitions[name]?.iconPath.split('/').at(-1)
      expect(filename, name).toBeTruthy()
      expect(workspaceFileIconUrl(name), name).toContain(`/${filename}`)
    }
  })
})
