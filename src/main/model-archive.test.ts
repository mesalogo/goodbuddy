import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportModelArchive,
  extractModelArchive
} from './model-archive'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-model-archive-')
  )
  temporaryDirectories.push(directory)
  return directory
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('model archive', () => {
  it('exports and extracts only declared verified model files', async () => {
    const directory = await temporaryDirectory()
    const source = join(directory, 'source')
    const extracted = join(directory, 'extracted')
    const archive = join(directory, 'model.zip')
    await Promise.all([mkdir(source), mkdir(extracted)])
    const model = Buffer.from('verified model bytes')
    const tokens = Buffer.from('verified tokens')
    await Promise.all([
      writeFile(join(source, 'model.onnx'), model),
      writeFile(join(source, 'tokens.txt'), tokens),
      writeFile(join(source, 'ignored.txt'), 'not exported'),
      writeFile(archive, 'archive selected for replacement')
    ])

    await exportModelArchive({
      destinationPath: archive,
      sourceDirectory: source,
      descriptor: {
        kind: 'speech',
        modelId: 'test-model',
        displayName: 'Test model',
        files: [
          {
            name: 'model.onnx',
            role: 'model',
            size: model.byteLength,
            sha256: sha256(model)
          },
          {
            name: 'tokens.txt',
            role: 'tokens',
            size: tokens.byteLength,
            sha256: sha256(tokens)
          }
        ]
      }
    })

    await expect(
      extractModelArchive({
        archivePath: archive,
        destinationDirectory: extracted,
        expectedKind: 'speech',
        expectedModelId: 'test-model',
        expectedFiles: [
          { name: 'model.onnx', role: 'model' },
          { name: 'tokens.txt', role: 'tokens' }
        ],
        maximumArchiveBytes: 1024 * 1024,
        maximumFileBytes: 1024,
        maximumTotalBytes: 2048
      })
    ).resolves.toMatchObject({
      kind: 'speech',
      modelId: 'test-model'
    })
    await expect(readFile(join(extracted, 'model.onnx'))).resolves.toEqual(
      model
    )
    await expect(readFile(join(extracted, 'tokens.txt'))).resolves.toEqual(
      tokens
    )
  })

  it('preserves an existing archive when source verification fails', async () => {
    const directory = await temporaryDirectory()
    const source = join(directory, 'source')
    const archive = join(directory, 'model.zip')
    await mkdir(source)
    const model = Buffer.from('changed model')
    await Promise.all([
      writeFile(join(source, 'model.onnx'), model),
      writeFile(archive, 'existing archive')
    ])

    await expect(
      exportModelArchive({
        destinationPath: archive,
        sourceDirectory: source,
        descriptor: {
          kind: 'speech',
          modelId: 'test-model',
          displayName: 'Test model',
          files: [
            {
              name: 'model.onnx',
              role: 'model',
              size: model.byteLength,
              sha256: 'a'.repeat(64)
            }
          ]
        }
      })
    ).rejects.toThrow('模型文件校验失败')
    await expect(readFile(archive, 'utf8')).resolves.toBe(
      'existing archive'
    )
  })

  it('rejects path traversal and undeclared archive entries', async () => {
    const directory = await temporaryDirectory()
    const archive = join(directory, 'unsafe.zip')
    const extracted = join(directory, 'extracted')
    await mkdir(extracted)
    await writeFile(
      archive,
      zipSync({
        '../model.onnx': Buffer.from('unsafe')
      })
    )

    await expect(
      extractModelArchive({
        archivePath: archive,
        destinationDirectory: extracted,
        expectedKind: 'speech',
        expectedModelId: 'test-model',
        expectedFiles: [{ name: 'model.onnx', role: 'model' }],
        maximumArchiveBytes: 1024 * 1024,
        maximumFileBytes: 1024,
        maximumTotalBytes: 1024
      })
    ).rejects.toThrow()
  })

  it('rejects an archive whose manifest model ID does not match', async () => {
    const directory = await temporaryDirectory()
    const archive = join(directory, 'mismatch.zip')
    const extracted = join(directory, 'extracted')
    await mkdir(extracted)
    const model = Buffer.from('model')
    await writeFile(
      archive,
      zipSync({
        'goodbuddy-model.json': Buffer.from(
          JSON.stringify({
            format: 'goodbuddy-model-archive',
            version: 1,
            kind: 'speech',
            modelId: 'other-model',
            displayName: 'Other model',
            exportedAt: '2026-08-11T00:00:00.000Z',
            files: [
              {
                name: 'model.onnx',
                role: 'model',
                size: model.byteLength,
                sha256: sha256(model)
              }
            ]
          })
        ),
        'model.onnx': model
      })
    )

    await expect(
      extractModelArchive({
        archivePath: archive,
        destinationDirectory: extracted,
        expectedKind: 'speech',
        expectedModelId: 'test-model',
        expectedFiles: [{ name: 'model.onnx', role: 'model' }],
        maximumArchiveBytes: 1024 * 1024,
        maximumFileBytes: 1024,
        maximumTotalBytes: 1024
      })
    ).rejects.toThrow('模型 ID 不匹配')
  })
})
