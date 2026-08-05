import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  browserProfileIdSchema,
  browserProfileNameSchema
} from '../../shared/capability-contracts'

const MAX_PROFILES = 32
const MAX_REFERENCES = 64
const MAX_STORE_BYTES = 256 * 1024

const boundedPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => isAbsolute(value), 'Browser executable path must be absolute')
  .refine(
    (value) => resolve(value) === value,
    'Browser executable path must be normalized'
  )

export const browserExecutableMetadataSchema = z
  .object({
    executablePath: boundedPathSchema,
    displayName: browserProfileNameSchema,
    source: z.literal('user-selected')
  })
  .strict()

export const browserProfileReferenceSchema = z
  .object({
    kind: z.enum(['capability', 'automation']),
    id: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/u)
  })
  .strict()

export const browserProfileSchema = z
  .object({
    id: browserProfileIdSchema,
    name: browserProfileNameSchema,
    mode: z.literal('managed-isolated'),
    browser: browserExecutableMetadataSchema.optional(),
    references: z.array(browserProfileReferenceSchema).max(MAX_REFERENCES)
  })
  .strict()

export const browserProfileStateSchema = z
  .object({
    version: z.literal(2),
    profiles: z.array(browserProfileSchema).max(MAX_PROFILES),
    defaultProfileId: browserProfileIdSchema.nullable()
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>()
    for (const [index, profile] of state.profiles.entries()) {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index, 'id'],
          message: 'Browser profile IDs must be unique'
        })
      }
      ids.add(profile.id)
    }
    if (state.defaultProfileId && !ids.has(state.defaultProfileId)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultProfileId'],
        message: 'Default browser profile must exist'
      })
    }
  })

const version1ProfileSchema = z
  .object({
    id: browserProfileIdSchema,
    name: browserProfileNameSchema,
    browser: browserExecutableMetadataSchema.optional()
  })
  .strict()

const version1StateSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(version1ProfileSchema).max(MAX_PROFILES),
    defaultProfileId: browserProfileIdSchema.nullable().optional()
  })
  .strict()

export type BrowserExecutableMetadata = z.infer<
  typeof browserExecutableMetadataSchema
>
export type BrowserProfileReference = z.infer<
  typeof browserProfileReferenceSchema
>
export type BrowserProfile = z.infer<typeof browserProfileSchema>
export type BrowserProfileState = z.infer<typeof browserProfileStateSchema>

const emptyState = (): BrowserProfileState => ({
  version: 2,
  profiles: [],
  defaultProfileId: null
})

function migrateState(
  value: unknown
): { state: BrowserProfileState; migrated: boolean } {
  const version = z
    .object({ version: z.union([z.literal(1), z.literal(2)]) })
    .passthrough()
    .parse(value).version
  if (version === 2) {
    return {
      state: browserProfileStateSchema.parse(value),
      migrated: false
    }
  }
  const legacy = version1StateSchema.parse(value)
  return {
    state: browserProfileStateSchema.parse({
      version: 2,
      profiles: legacy.profiles.map((profile) => ({
        ...profile,
        mode: 'managed-isolated',
        references: []
      })),
      defaultProfileId:
        legacy.defaultProfileId ?? legacy.profiles[0]?.id ?? null
    }),
    migrated: true
  }
}

export interface BrowserProfileStore {
  load(): Promise<unknown | undefined>
  save(state: BrowserProfileState): Promise<void>
}

export class MemoryBrowserProfileStore implements BrowserProfileStore {
  private value: unknown

  constructor(initialValue?: unknown) {
    this.value = initialValue
  }

  async load(): Promise<unknown | undefined> {
    return structuredClone(this.value)
  }

  async save(state: BrowserProfileState): Promise<void> {
    this.value = structuredClone(state)
  }
}

export class FileBrowserProfileStore implements BrowserProfileStore {
  private readonly fileName = 'browser-profiles.json'

  constructor(private readonly ownedRoot: string) {
    if (!isAbsolute(ownedRoot)) {
      throw new Error('Browser profile storage root must be absolute')
    }
  }

  private async prepareRoot(): Promise<{ root: string; filePath: string }> {
    await mkdir(this.ownedRoot, { recursive: true, mode: 0o700 })
    const rootDetails = await lstat(this.ownedRoot)
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      throw new Error('Browser profile storage root must be a real directory')
    }
    const root = await realpath(this.ownedRoot)
    const filePath = join(root, this.fileName)
    const fromRoot = relative(root, filePath)
    if (
      fromRoot.startsWith('..') ||
      isAbsolute(fromRoot) ||
      fromRoot === ''
    ) {
      throw new Error('Browser profile storage path escapes its owned root')
    }
    return { root, filePath }
  }

  async load(): Promise<unknown | undefined> {
    const { filePath } = await this.prepareRoot()
    try {
      const details = await lstat(filePath)
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error('Browser profile storage file must be a regular file')
      }
      if (details.size > MAX_STORE_BYTES) {
        throw new Error('Browser profile storage file is too large')
      }
      return JSON.parse(await readFile(filePath, 'utf8')) as unknown
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    }
  }

  async save(state: BrowserProfileState): Promise<void> {
    const { root, filePath } = await this.prepareRoot()
    try {
      const targetDetails = await lstat(filePath)
      if (targetDetails.isSymbolicLink() || !targetDetails.isFile()) {
        throw new Error('Browser profile storage file must be a regular file')
      }
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        throw error
      }
    }

    const temporaryPath = join(root, `.${this.fileName}.${randomUUID()}.tmp`)
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(browserProfileStateSchema.parse(state), null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      await rename(temporaryPath, filePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
}

export class BrowserProfileService {
  private state?: BrowserProfileState
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(private readonly store: BrowserProfileStore) {}

  private async getState(): Promise<BrowserProfileState> {
    if (!this.state) {
      const loaded = await this.store.load()
      const result =
        loaded === undefined
          ? { state: emptyState(), migrated: false }
          : migrateState(loaded)
      if (result.migrated) {
        await this.store.save(result.state)
      }
      this.state = result.state
    }
    return this.state
  }

  private async update(
    operation: (state: BrowserProfileState) => BrowserProfileState
  ): Promise<BrowserProfileState> {
    let result: BrowserProfileState | undefined
    const queued = this.updateQueue.then(async () => {
      const next = browserProfileStateSchema.parse(
        operation(structuredClone(await this.getState()))
      )
      await this.store.save(next)
      this.state = next
      result = next
    })
    this.updateQueue = queued.catch(() => undefined)
    await queued
    if (!result) {
      throw new Error('Browser profile update failed')
    }
    return structuredClone(result)
  }

  async getSnapshot(): Promise<BrowserProfileState> {
    return structuredClone(await this.getState())
  }

  async createProfile(name: string): Promise<BrowserProfileState> {
    const parsedName = browserProfileNameSchema.parse(name)
    return this.update((state) => {
      if (state.profiles.length >= MAX_PROFILES) {
        throw new Error('Browser profile limit reached')
      }
      const profile: BrowserProfile = {
        id: randomUUID(),
        name: parsedName,
        mode: 'managed-isolated',
        references: []
      }
      state.profiles.push(profile)
      state.defaultProfileId ??= profile.id
      return state
    })
  }

  async renameProfile(
    profileId: string,
    name: string
  ): Promise<BrowserProfileState> {
    const id = browserProfileIdSchema.parse(profileId)
    const parsedName = browserProfileNameSchema.parse(name)
    return this.update((state) => {
      const profile = state.profiles.find((candidate) => candidate.id === id)
      if (!profile) {
        throw new Error('Browser profile not found')
      }
      profile.name = parsedName
      return state
    })
  }

  async selectBrowser(
    profileId: string,
    browser?: BrowserExecutableMetadata
  ): Promise<BrowserProfileState> {
    const id = browserProfileIdSchema.parse(profileId)
    const parsedBrowser = browserExecutableMetadataSchema
      .optional()
      .parse(browser)
    return this.update((state) => {
      const profile = state.profiles.find((candidate) => candidate.id === id)
      if (!profile) {
        throw new Error('Browser profile not found')
      }
      profile.browser = parsedBrowser
      return state
    })
  }

  async setDefaultProfile(profileId: string): Promise<BrowserProfileState> {
    const id = browserProfileIdSchema.parse(profileId)
    return this.update((state) => {
      if (!state.profiles.some((profile) => profile.id === id)) {
        throw new Error('Browser profile not found')
      }
      state.defaultProfileId = id
      return state
    })
  }

  async addReference(
    profileId: string,
    reference: BrowserProfileReference
  ): Promise<BrowserProfileState> {
    const id = browserProfileIdSchema.parse(profileId)
    const parsedReference = browserProfileReferenceSchema.parse(reference)
    return this.update((state) => {
      const profile = state.profiles.find((candidate) => candidate.id === id)
      if (!profile) {
        throw new Error('Browser profile not found')
      }
      if (
        !profile.references.some(
          (candidate) =>
            candidate.kind === parsedReference.kind &&
            candidate.id === parsedReference.id
        )
      ) {
        profile.references.push(parsedReference)
      }
      return state
    })
  }

  async removeReference(
    profileId: string,
    reference: BrowserProfileReference
  ): Promise<BrowserProfileState> {
    const id = browserProfileIdSchema.parse(profileId)
    const parsedReference = browserProfileReferenceSchema.parse(reference)
    return this.update((state) => {
      const profile = state.profiles.find((candidate) => candidate.id === id)
      if (!profile) {
        throw new Error('Browser profile not found')
      }
      profile.references = profile.references.filter(
        (candidate) =>
          candidate.kind !== parsedReference.kind ||
          candidate.id !== parsedReference.id
      )
      return state
    })
  }

  async deleteProfile(profileId: string): Promise<BrowserProfileState> {
    const id = browserProfileIdSchema.parse(profileId)
    return this.update((state) => {
      const profile = state.profiles.find((candidate) => candidate.id === id)
      if (!profile) {
        throw new Error('Browser profile not found')
      }
      if (profile.references.length > 0) {
        throw new Error('Referenced browser profiles cannot be deleted')
      }
      state.profiles = state.profiles.filter(
        (candidate) => candidate.id !== id
      )
      if (state.defaultProfileId === id) {
        state.defaultProfileId = state.profiles[0]?.id ?? null
      }
      return state
    })
  }
}
