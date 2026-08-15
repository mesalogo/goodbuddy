import { open } from 'node:fs/promises'
import {
  releaseNotesAcknowledgeSchema,
  releaseNotesFileSchema,
  type ReleaseNote,
  type ReleaseNotesSnapshot
} from '../shared/release-notes-contracts'
import type { ApplicationSettingsStore } from './application-settings-store'
import { compareStrictSemVer } from './version-checker'

const maximumReleaseNotesBytes = 128 * 1024

export class ReleaseNotesService {
  private releases?: ReleaseNote[]
  private releaseLoad?: Promise<ReleaseNote[]>

  constructor(
    private readonly dependencies: {
      currentVersion: string
      filePath: string
      settingsStore: ApplicationSettingsStore
    }
  ) {}

  private async loadReleases(): Promise<ReleaseNote[]> {
    if (this.releases) {
      return this.releases
    }
    if (!this.releaseLoad) {
      this.releaseLoad = this.readReleases().finally(() => {
        this.releaseLoad = undefined
      })
    }
    return this.releaseLoad
  }

  private async readReleases(): Promise<ReleaseNote[]> {
    const handle = await open(this.dependencies.filePath, 'r')
    try {
      const buffer = Buffer.alloc(maximumReleaseNotesBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maximumReleaseNotesBytes) {
        throw new Error('Release notes exceed the size limit')
      }
      const parsed = releaseNotesFileSchema.parse(
        JSON.parse(buffer.toString('utf8', 0, bytesRead)) as unknown
      )
      this.releases = [...parsed.releases].sort((left, right) =>
        compareStrictSemVer(right.version, left.version)
      )
      return this.releases
    } finally {
      await handle.close()
    }
  }

  async getPending(): Promise<ReleaseNotesSnapshot> {
    const releases = await this.loadReleases()
    const currentVersion = this.dependencies.currentVersion
    const lastSeenVersion =
      await this.dependencies.settingsStore.getLastSeenReleaseNotesVersion()
    const pending = releases.filter((release) => {
      const comparedWithCurrent = compareStrictSemVer(
        release.version,
        currentVersion
      )
      if (comparedWithCurrent > 0) {
        return false
      }
      return lastSeenVersion
        ? compareStrictSemVer(release.version, lastSeenVersion) > 0
        : comparedWithCurrent === 0
    })
    return {
      currentVersion,
      releases: pending
    }
  }

  async acknowledge(input: unknown): Promise<void> {
    const { version } = releaseNotesAcknowledgeSchema.parse(input)
    if (version !== this.dependencies.currentVersion) {
      throw new Error('Only the current release notes can be acknowledged')
    }
    const releases = await this.loadReleases()
    if (!releases.some((release) => release.version === version)) {
      throw new Error('Current release notes are unavailable')
    }
    await this.dependencies.settingsStore.setLastSeenReleaseNotesVersion(
      version
    )
  }
}
