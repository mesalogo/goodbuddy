import { describe, expect, it } from 'vitest'
import {
  artifactDownloadSourceSchema,
  defaultLocalToolEnvironmentSettings,
  localToolCandidateSchema,
  localToolEnvironmentSettingsSchema,
  localToolPythonOperationSchema,
  localToolRuntimeSelectionSchema
} from './local-tool-environment-contracts'

describe('local tool environment contracts', () => {
  it('accepts managed defaults and both download sources', () => {
    expect(
      localToolEnvironmentSettingsSchema.parse(
        defaultLocalToolEnvironmentSettings
      )
    ).toEqual(defaultLocalToolEnvironmentSettings)
    expect(artifactDownloadSourceSchema.parse('oss')).toBe('oss')
  })

  it('accepts cross-platform absolute custom executable paths', () => {
    for (const executablePath of [
      '/usr/local/bin/node',
      'C:\\Program Files\\nodejs\\node.exe',
      '\\\\server\\tools\\python.exe'
    ]) {
      expect(
        localToolRuntimeSelectionSchema.parse({
          source: 'custom',
          executablePath
        })
      ).toEqual({ source: 'custom', executablePath })
    }
  })

  it('strictly rejects relative, unbounded, and mismatched selections', () => {
    for (const input of [
      { source: 'custom', executablePath: 'bin/node' },
      { source: 'custom', executablePath: '/bin/node ' },
      { source: 'custom', executablePath: `/${'x'.repeat(4_096)}` },
      { source: 'custom' },
      { source: 'managed', executablePath: '/bin/node' },
      { source: 'automatic' }
    ]) {
      expect(localToolRuntimeSelectionSchema.safeParse(input).success).toBe(
        false
      )
    }
  })

  it('strictly rejects incomplete and unknown settings', () => {
    expect(
      localToolEnvironmentSettingsSchema.safeParse({
        ...defaultLocalToolEnvironmentSettings,
        extra: true
      }).success
    ).toBe(false)
    expect(
      localToolEnvironmentSettingsSchema.safeParse({
        node: { source: 'managed' },
        python: { source: 'managed' }
      }).success
    ).toBe(false)
    expect(artifactDownloadSourceSchema.safeParse('mirror').success).toBe(false)
  })

  it('requires validated candidate version and architecture metadata', () => {
    expect(
      localToolCandidateSchema.parse({
        kind: 'node',
        executablePath: 'C:\\Tools\\node.exe',
        version: '22.14.0',
        architecture: 'x64'
      })
    ).toEqual({
      kind: 'node',
      executablePath: 'C:\\Tools\\node.exe',
      version: '22.14.0',
      architecture: 'x64'
    })
    expect(
      localToolCandidateSchema.safeParse({
        kind: 'python',
        executablePath: '/usr/bin/python3'
      }).success
    ).toBe(false)
  })

  it('freezes the download source into Python operation snapshots', () => {
    expect(
      localToolPythonOperationSchema.parse({
        source: 'oss',
        phase: 'downloading',
        receivedBytes: 10,
        totalBytes: 100
      })
    ).toEqual({
      source: 'oss',
      phase: 'downloading',
      receivedBytes: 10,
      totalBytes: 100
    })
    expect(
      localToolPythonOperationSchema.safeParse({
        phase: 'validating'
      }).success
    ).toBe(false)
  })
})
