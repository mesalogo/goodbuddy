import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface NpmInvocationModule {
  npmInvocation(
    projectDir: string,
    environment?: NodeJS.ProcessEnv
  ): {
    command: string
    prefixArgs: string[]
  }
}

const require = createRequire(import.meta.url)
const { npmInvocation } = require(
  '../build/npm-invocation.cjs'
) as NpmInvocationModule

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'goodbuddy-npm-invocation-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('npm invocation', () => {
  it('uses npm_execpath when the package manager provides it', () => {
    expect(
      npmInvocation(directory, { npm_execpath: 'provided-npm-cli.js' })
    ).toEqual({
      command: process.execPath,
      prefixArgs: ['provided-npm-cli.js']
    })
  })

  it('uses the project npm CLI when npm_execpath is absent', () => {
    const npmCli = join(
      directory,
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    )
    mkdirSync(join(directory, 'node_modules', 'npm', 'bin'), {
      recursive: true
    })
    writeFileSync(npmCli, '')

    expect(npmInvocation(directory, {})).toEqual({
      command: process.execPath,
      prefixArgs: [npmCli]
    })
  })
})
