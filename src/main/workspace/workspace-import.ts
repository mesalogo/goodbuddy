import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { WorkspaceAccess } from './workspace-access'

// Keep binary transfers below the Agent control-frame bound, including base64 overhead.
export async function importWorkspaceFiles(workspace: WorkspaceAccess, directory: string, paths: readonly string[]): Promise<{
  imported: string[]
  failed: { name: string; error: string }[]
}> {
  const result = { imported: [] as string[], failed: [] as { name: string; error: string }[] }
  for (const source of paths) {
    const name = basename(source)
    const path = [directory, name].filter(Boolean).join('/')
    let created = false
    try {
      const file = await open(source, 'r')
      try {
        if (!(await file.stat()).isFile()) throw new Error('Source is not a regular file')
        await workspace.manage({ kind: 'createFile', path })
        created = true
        const buffer = Buffer.alloc(256 * 1024)
        let offset = 0
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          if (!bytesRead) break
          await workspace.manage({ kind: 'importFile', path, offset, data: buffer.subarray(0, bytesRead).toString('base64') })
          offset += bytesRead
        }
        result.imported.push(path)
      } finally { await file.close() }
    } catch (reason) {
      let error = reason instanceof Error ? reason.message : String(reason)
      if (created) {
        try { await workspace.manage({ kind: 'delete', path }) }
        catch (cleanup) { error += `; partial file: ${path}: ${String(cleanup)}` }
      }
      result.failed.push({ name, error })
    }
  }
  return result
}
