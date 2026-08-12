import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultDocumentParsingSettings,
  DocumentParsingSettingsStore
} from './document-parsing-settings-store'

const temporaryDirectories: string[] = []

async function createStore(): Promise<{
  directory: string
  filePath: string
  store: DocumentParsingSettingsStore
}> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-document-parsing-settings-')
  )
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'document-parsing-settings.json')
  return {
    directory,
    filePath,
    store: new DocumentParsingSettingsStore(filePath)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('DocumentParsingSettingsStore', () => {
  it('returns local-first defaults without creating a file', async () => {
    const { directory, store } = await createStore()

    await expect(store.get()).resolves.toEqual(
      defaultDocumentParsingSettings
    )
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('persists a complete versioned settings document', async () => {
    const { filePath, store } = await createStore()
    const settings = {
      ...defaultDocumentParsingSettings,
      chatWorkflow: 'fast-text' as const,
      maximumPages: 42
    }

    await expect(store.update(settings)).resolves.toEqual(settings)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 3,
      ...settings
    })
    await expect(
      new DocumentParsingSettingsStore(filePath).get()
    ).resolves.toEqual(settings)
  })

  it('migrates version 2 OCR switches into scenario modes', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        chatWorkflow: 'auto',
        knowledgeWorkflow: 'complete-index',
        pdfOcrMode: 'always',
        ocrProvider: 'local',
        localOcrEnabled: true,
        localOcrModelId: 'pp-ocrv6-small',
        maximumPages: 42,
        ocrConcurrency: 4,
        pageTimeoutSeconds: 90
      }),
      'utf8'
    )

    await expect(store.get()).resolves.toEqual({
      chatWorkflow: 'high-fidelity',
      knowledgeWorkflow: 'high-fidelity',
      localOcrModelId: 'pp-ocrv6-small',
      maximumPages: 42,
      pageTimeoutSeconds: 90
    })
  })

  it('migrates version 1 cloud settings into local scenario modes', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        chatWorkflow: 'auto',
        knowledgeWorkflow: 'complete-index',
        pdfOcrMode: 'auto',
        localOcrEnabled: false,
        localOcrModelId: 'pp-ocrv6-tiny',
        maximumPages: 100,
        ocrConcurrency: 1,
        pageTimeoutSeconds: 60,
        chatCloudPermission: 'always',
        knowledgeCloudPermission: 'never'
      }),
      'utf8'
    )

    await expect(store.get()).resolves.toEqual({
      ...defaultDocumentParsingSettings,
      chatWorkflow: 'fast-text',
      knowledgeWorkflow: 'fast-index'
    })
  })

  it('rejects incomplete or out-of-range settings', async () => {
    const { directory, store } = await createStore()

    await expect(store.update({})).rejects.toThrow()
    await expect(
      store.update({
        ...defaultDocumentParsingSettings,
        maximumPages: 0
      })
    ).rejects.toThrow()
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('isolates corrupt settings and restores defaults', async () => {
    const { directory, filePath, store } = await createStore()
    await writeFile(filePath, '{not-json', 'utf8')

    await expect(store.get()).resolves.toEqual(
      defaultDocumentParsingSettings
    )
    const entries = await readdir(directory)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(
      /^document-parsing-settings\.json\.corrupt-\d+-[a-f0-9]{12}$/u
    )
  })
})
