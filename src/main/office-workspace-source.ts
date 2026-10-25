import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorkspaceAccess } from './workspace/workspace-access'

export type OfficeFileSource = {
  path: string
  readOnly?: boolean
  commit?: (localPath: string, expectedDigest: string, digest: string) => Promise<void>
  dispose?: () => Promise<void>
}

export async function prepareOfficeWorkspaceSource(workspace: WorkspaceAccess, path: string, stagingRoot: string): Promise<OfficeFileSource> {
  const maximumBytes = 20 * 1024 * 1024
  let directory: string | undefined
  try {
    const metadata = await workspace.stat({ path })
    if (metadata.type !== 'file' || metadata.size > maximumBytes) throw new Error('请选择不超过 20 MiB 的 DOCX')
    await mkdir(stagingRoot, { recursive: true })
    directory = await mkdtemp(join(stagingRoot, 'document-'))
    const localPath = join(directory, basename(path))
    const file = await open(localPath, 'wx')
    try {
      let offset = 0
      while (offset < metadata.size) {
        const part = await workspace.readText({ path, encoding: 'base64', offsetBytes: offset, maximumBytes: 256 * 1024, allowTruncated: true })
        if (part.size !== metadata.size || part.bytesRead < 1) throw new Error('读取期间源文件发生变化，请重新打开')
        await file.writeFile(Buffer.from(part.content, 'base64'))
        offset += part.bytesRead
      }
    } finally { await file.close() }
    return {
      path: localPath,
      async commit(savedPath, expectedDigest, digest) {
        const staged = posix.join(posix.dirname(path), `.goodbuddy-office-${randomUUID()}.docx`)
        let created = false
        try {
          await workspace.manage({ kind: 'createFile', path: staged })
          created = true
          const saved = await open(savedPath, 'r')
          try {
            const buffer = Buffer.alloc(256 * 1024)
            let offset = 0
            for (;;) {
              const { bytesRead } = await saved.read(buffer, 0, buffer.length, offset)
              if (!bytesRead) break
              await workspace.manage({ kind: 'importFile', path: staged, offset, data: buffer.subarray(0, bytesRead).toString('base64') })
              offset += bytesRead
            }
          } finally { await saved.close() }
          await workspace.manage({ kind: 'replaceFile', path: staged, destination: path, expectedDigest, digest, maximumBytes })
          created = false
        } finally {
          if (created) await workspace.manage({ kind: 'delete', path: staged })
        }
      },
      async dispose() {
        try { await workspace.dispose() }
        finally { await rm(directory!, { recursive: true, force: true }) }
      }
    }
  } catch (error) {
    await workspace.dispose()
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
}
