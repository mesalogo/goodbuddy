import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
  join(process.cwd(), '.github', 'workflows', 'packages.yml'),
  'utf8'
)

describe('packages workflow', () => {
  it('uses valid YAML and Node.js 24 GitHub Actions', () => {
    expect(() => parse(workflow)).not.toThrow()

    const references = [
      ...workflow.matchAll(
        /uses:\s+(actions\/(?:checkout|setup-node|cache|upload-artifact|download-artifact)@v\d+)/gu
      )
    ].map((match) => match[1])

    expect(new Set(references)).toEqual(
      new Set([
        'actions/checkout@v7',
        'actions/setup-node@v7',
        'actions/cache@v6',
        'actions/upload-artifact@v7',
        'actions/download-artifact@v8'
      ])
    )
  })
})
