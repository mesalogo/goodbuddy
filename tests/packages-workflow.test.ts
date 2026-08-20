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

  it('passes the endpoint-derived region to every OSS upload', () => {
    expect(workflow).toContain(
      'https://oss-cn-beijing.aliyuncs.com'
    )
    expect(workflow).toContain('goodbuddy) ;;')
    expect(workflow).toContain(
      'oss_region="${endpoint_host#oss-}"'
    )
    expect(workflow).toContain(
      'echo "region=$oss_region" >> "$GITHUB_OUTPUT"'
    )
    expect(
      [...workflow.matchAll(/--region "\$OSS_REGION"/gu)]
    ).toHaveLength(2)
  })

  it('allows fully unsigned macOS builds but rejects partial credentials', () => {
    expect(workflow).toContain('id: macos-signing')
    expect(workflow).toContain(
      'if [[ "$configured" -eq 0 ]]; then'
    )
    expect(workflow).toContain(
      'if [[ "$configured" -ne "${#names[@]}" ]]; then'
    )
    expect(workflow).toContain(
      'Build unsigned macOS release packages'
    )
    expect(workflow).toContain('--skip-build --unsigned')
    expect(workflow).toContain(
      "steps.macos-signing.outputs.enabled == 'true'"
    )
    expect(workflow).toContain(
      "steps.macos-signing.outputs.enabled == 'false'"
    )
    expect(workflow).toContain(
      'Apple signing credentials are not configured'
    )
  })
})
