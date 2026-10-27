import manifestJson from 'material-icon-theme/dist/material-icons.json'
import fallbackIconUrl from 'material-icon-theme/icons/file.svg?url'

type Associations = {
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
}

const manifest = manifestJson as Associations & {
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderExpanded: string
  light: Associations
}

// Keep SVG bytes out of the JS bundle. Vite packages local assets; rendering a
// row only loads its icon, without network services or per-file IPC.
const assets = import.meta.glob<string>(
  '../../../node_modules/material-icon-theme/icons/*.svg',
  { eager: true, query: '?url&no-inline', import: 'default' }
)

export function workspaceFileIconName(path: string, directory = false, expanded = false, light = false): string {
  const name = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.toLowerCase() ?? ''
  const lookup = (key: keyof Associations, value: string): string | undefined =>
    (light ? manifest.light[key][value] : undefined) ?? manifest[key][value]
  if (directory) {
    return lookup(expanded ? 'folderNamesExpanded' : 'folderNames', name) ??
      (expanded ? manifest.folderExpanded : manifest.folder)
  }
  const exact = lookup('fileNames', name)
  if (exact) return exact
  // Longest suffix first: foo.test.ts and foo.d.ts precede ordinary .ts.
  for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
    const icon = lookup('fileExtensions', name.slice(dot + 1))
    if (icon) return icon
  }
  return manifest.file
}

export function workspaceFileIconUrl(name: string): string {
  const filename = manifest.iconDefinitions[name]?.iconPath.split('/').at(-1)
  return assets[`../../../node_modules/material-icon-theme/icons/${filename}`] ?? fallbackIconUrl
}
