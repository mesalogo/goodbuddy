// @vitest-environment node

import { createRequire } from 'node:module'
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type InstallerCheckModule = {
  maximumInstallerBytes: number
  verifyControlPlanePackageInstaller(
    filePath: string
  ): { size: number; sha256: string }
}

const require = createRequire(import.meta.url)
const installerCheck = require(
  '../build/check-control-plane-package-installer.cjs'
) as InstallerCheckModule

describe('control-plane package installer build check', () => {
  it('accepts one bounded standalone Node module', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-installer-check-'))
    try {
      const file = join(root, 'installer.mjs')
      writeFileSync(
        file,
        'import { createHash } from "node:crypto"\n' +
          'void createHash("sha256")\n'
      )

      expect(
        installerCheck.verifyControlPlanePackageInstaller(file)
      ).toMatchObject({
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects relative chunks and oversized output', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-installer-check-'))
    try {
      const relative = join(root, 'relative.mjs')
      writeFileSync(relative, 'import "./chunk.js"\n')
      expect(() =>
        installerCheck.verifyControlPlanePackageInstaller(relative)
      ).toThrow('standalone')

      const oversized = join(root, 'oversized.mjs')
      writeFileSync(
        oversized,
        Buffer.alloc(installerCheck.maximumInstallerBytes + 1)
      )
      expect(() =>
        installerCheck.verifyControlPlanePackageInstaller(oversized)
      ).toThrow('transfer limit')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
