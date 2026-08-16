import { describe, expect, it } from 'vitest'
import {
  runtimeExtensionActionSchema,
  runtimeExtensionCatalogEntrySchema,
  runtimeExtensionMarketplaceSnapshotSchema
} from './runtime-extension-contracts'

const catalogEntry = {
  id: 'web-research',
  package: {
    name: '@goodbuddy/dsh-web-research',
    version: '1.2.3'
  },
  displayName: 'Web research',
  description: 'Researches public web pages.',
  repository: 'https://example.com/goodbuddy/web-research',
  license: 'MIT'
}

describe('runtime extension contracts', () => {
  it('accepts the minimal catalog metadata', () => {
    expect(runtimeExtensionCatalogEntrySchema.parse(catalogEntry)).toEqual(
      catalogEntry
    )
  })

  it('requires exact semantic versions', () => {
    expect(
      runtimeExtensionActionSchema.safeParse({
        type: 'install',
        extensionId: catalogEntry.id,
        package: { ...catalogEntry.package, version: '^1.2.3' }
      }).success
    ).toBe(false)
  })

  it('rejects removed policy fields and rollback actions', () => {
    expect(
      runtimeExtensionCatalogEntrySchema.safeParse({
        ...catalogEntry,
        permissions: []
      }).success
    ).toBe(false)
    expect(
      runtimeExtensionActionSchema.safeParse({
        type: 'rollback',
        extensionId: catalogEntry.id
      }).success
    ).toBe(false)
  })

  it('models snapshots with JSON-like configuration', () => {
    const snapshot = {
      marketplaceEnabled: true,
      catalog: [catalogEntry],
      installed: [
        {
          id: catalogEntry.id,
          package: catalogEntry.package,
          installedAt: '2026-08-16T00:00:00.000Z',
          enabled: true,
          integrity: `sha512-${Buffer.from('digest').toString(
            'base64'
          )}`,
          configuration: {
            resultLimit: 10,
            filters: { domains: ['example.com'], exact: true },
            optional: null
          }
        }
      ]
    }

    expect(
      runtimeExtensionMarketplaceSnapshotSchema.parse(snapshot)
    ).toEqual(snapshot)
    expect(
      runtimeExtensionMarketplaceSnapshotSchema.safeParse({
        ...snapshot,
        installed: [
          {
            ...snapshot.installed[0],
            entrypoint:
              'C:\\Users\\tester\\runtime-extensions\\extensions\\web-research\\dist\\index.js'
          }
        ]
      }).success
    ).toBe(false)
    expect(
      runtimeExtensionMarketplaceSnapshotSchema.safeParse({
        ...snapshot,
        warnings: []
      }).success
    ).toBe(false)
  })

  it('supports only the explicit marketplace switch action', () => {
    expect(
      runtimeExtensionActionSchema.parse({
        type: 'set-marketplace-enabled',
        enabled: true
      })
    ).toEqual({
      type: 'set-marketplace-enabled',
      enabled: true
    })
    expect(
      runtimeExtensionActionSchema.safeParse({
        type: 'set-marketplace-enabled',
        enabled: true,
        extensionId: 'unexpected'
      }).success
    ).toBe(false)
  })

  it('bounds configuration size, depth, and collection width', () => {
    let deeplyNested: Record<string, unknown> = {}
    for (let depth = 0; depth < 18; depth += 1) {
      deeplyNested = { nested: deeplyNested }
    }
    const action = {
      type: 'configure',
      extensionId: catalogEntry.id
    }

    expect(
      runtimeExtensionActionSchema.safeParse({
        ...action,
        configuration: { value: 'x'.repeat(65 * 1_024) }
      }).success
    ).toBe(false)
    expect(
      runtimeExtensionActionSchema.safeParse({
        ...action,
        configuration: deeplyNested
      }).success
    ).toBe(false)
    expect(
      runtimeExtensionActionSchema.safeParse({
        ...action,
        configuration: {
          values: Array.from({ length: 257 }, () => true)
        }
      }).success
    ).toBe(false)
  })
})
