import {
  mkdtemp,
  open,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readBoundedFile } from './workspace-file-access'

type ReadMethod = (
  this: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
) => Promise<{ bytesRead: number; buffer: Buffer }>

describe('workspace file access', () => {
  it('continues reading after a short file-handle read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-short-read-'))
    const path = join(directory, 'short-read.txt')
    const content = Buffer.from('hello')
    await writeFile(path, content)
    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe) as {
      read: ReadMethod
    }
    const originalRead = prototype.read
    await probe.close()
    const read = vi
      .spyOn(prototype, 'read')
      .mockImplementation(function (
        this: Awaited<ReturnType<typeof open>>,
        buffer,
        offset,
        length,
        position
      ) {
        return originalRead.call(
          this,
          buffer,
          offset,
          Math.min(length, position === 0 ? 2 : 3),
          position
        )
      })

    try {
      await expect(
        readBoundedFile(path, 5, 'too large')
      ).resolves.toEqual(content)
      expect(read).toHaveBeenCalledTimes(3)
    } finally {
      read.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
