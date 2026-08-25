import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
  join(
    process.cwd(),
    '.github',
    'workflows',
    'agent-release.yml'
  ),
  'utf8'
)
const desktopWorkflow = readFileSync(
  join(process.cwd(), '.github', 'workflows', 'packages.yml'),
  'utf8'
)
const parsed = parse(workflow) as {
  jobs: Record<
    string,
    {
      needs?: string | string[]
      environment?: { name?: string }
      strategy?: {
        matrix?: {
          include?: Array<Record<string, unknown>>
        }
      }
      steps?: Array<{
        name?: string
        run?: string
        uses?: string
        with?: Record<string, unknown>
      }>
    }
  >
}

function serializedJob(name: string): string {
  return JSON.stringify(parsed.jobs[name])
}

function scripts(name: string): string {
  return (
    parsed.jobs[name]?.steps
      ?.map((step) => step.run ?? '')
      .join('\n') ?? ''
  )
}

describe('independent Agent release workflow', () => {
  it('uses a separate immutable agent-v tag and never enters desktop packaging', () => {
    expect(() => parse(workflow)).not.toThrow()
    expect(workflow).toContain("- 'agent-v*'")
    expect(workflow).not.toContain('workflow_dispatch:')
    expect(scripts('authorize')).toContain(
      "require('./agent-runtime-lock.json').agentVersion"
    )
    expect(scripts('authorize')).toContain(
      'git cat-file -t "refs/tags/$GITHUB_REF_NAME"'
    )
    expect(scripts('authorize')).toContain(
      'git merge-base --is-ancestor'
    )
    expect(workflow).not.toContain('release:package')
    expect(desktopWorkflow).not.toContain(
      'agent-release.yml'
    )
  })

  it('builds native x64 and arm64 compound packages in the protected signing environment', () => {
    expect(
      parsed.jobs.build?.strategy?.matrix?.include
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          arch: 'x64',
          runner: 'ubuntu-24.04'
        }),
        expect.objectContaining({
          arch: 'arm64',
          runner: 'ubuntu-24.04-arm'
        })
      ])
    )
    expect(parsed.jobs.build?.environment?.name).toBe(
      'agent-signing'
    )
    const build = serializedJob('build')
    const buildScripts = scripts('build')
    expect(buildScripts).toContain(
      'node build/agent-package.cjs build'
    )
    expect(buildScripts).toContain(
      '--registry https://registry.npmjs.org/'
    )
    expect(buildScripts).toContain('--ignore-scripts')
    expect(build).toContain(
      'GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY'
    )
    expect(workflow).not.toContain(
      'GOODBUDDY_REMOTE_RUNTIME_SIGNING_'
    )
    expect(buildScripts).toContain('.gbagent')
  })

  it('signs and verifies one cumulative dual-architecture catalog', () => {
    expect(parsed.jobs.catalog?.environment?.name).toBe(
      'agent-signing'
    )
    const catalog = scripts('catalog')
    expect(catalog).toContain(
      'node build/agent-catalog.cjs create'
    )
    expect(catalog).toContain('--x64-package')
    expect(catalog).toContain('--arm64-package')
    expect(catalog).toContain(
      '--previous-catalog dist/agent-release/previous.json'
    )
    expect(catalog).toContain(
      'node build/agent-catalog.cjs verify'
    )
  })

  it('publishes immutable OSS objects and updates the signed latest pointer last', () => {
    expect(parsed.jobs.publish?.environment?.name).toBe(
      'aliyun-oss-release'
    )
    const publish = scripts('publish')
    const immutable = workflow.indexOf(
      '- name: Upload immutable Agent release to OSS'
    )
    const github = workflow.indexOf(
      '- name: Publish non-Latest GitHub Agent release'
    )
    const latest = workflow.indexOf(
      '- name: Point OSS Agent catalog to published release'
    )
    expect(immutable).toBeGreaterThanOrEqual(0)
    expect(github).toBeGreaterThan(immutable)
    expect(latest).toBeGreaterThan(github)
    expect(serializedJob('publish')).toContain(
      'aliyun/configure-aliyun-credentials-action@v1'
    )
    expect(publish).toContain('--region "$OSS_REGION"')
    expect(publish).toContain(
      '$root/$name" --output "$RUNNER_TEMP/immutable-$name"'
    )
  })

  it('publishes a normal Agent release without changing desktop Latest', () => {
    const publish = scripts('publish')
    expect(publish).toContain('--latest=false')
    expect(publish).toContain(
      'repos/mesalogo/goodbuddy/releases/latest'
    )
    expect(publish).toContain(
      'test "$(gh api repos/mesalogo/goodbuddy/releases/latest --jq .tag_name)" != "$tag"'
    )
    expect(publish).not.toContain('--latest\n')
    expect(publish).not.toContain('agent-releases/latest.sig')
    expect(publish).toContain(
      'catalog: `v${version}/agent-catalog.json`'
    )
    expect(workflow).not.toContain('prerelease: true')
  })

  it('keeps private keys out of authorization and public publication jobs', () => {
    expect(serializedJob('authorize')).not.toContain('secrets.')
    expect(serializedJob('publish')).not.toContain(
      'GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY'
    )
  })
})
