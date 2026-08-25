import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
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

function jobScripts(name: string): string {
  return (
    parsed.jobs[name]?.steps
      ?.map((step) => step.run ?? '')
      .join('\n') ?? ''
  )
}

function jobNeeds(name: string): string[] {
  const needs = parsed.jobs[name]?.needs
  return needs === undefined
    ? []
    : Array.isArray(needs)
      ? needs
      : [needs]
}

describe('desktop packages workflow', () => {
  it('uses valid YAML, pinned action majors, and only desktop release jobs', () => {
    expect(() => parse(workflow)).not.toThrow()
    expect(Object.keys(parsed.jobs)).toEqual([
      'validate',
      'authorize-release',
      'package',
      'release'
    ])
    const actionReferences = [
      ...workflow.matchAll(
        /uses:\s+((?:actions\/(?:checkout|setup-node|cache|upload-artifact|download-artifact)|aliyun\/configure-aliyun-credentials-action)@v\d+)/gu
      )
    ].map((match) => match[1])
    expect(new Set(actionReferences)).toEqual(
      new Set([
        'actions/checkout@v7',
        'actions/setup-node@v7',
        'actions/cache@v6',
        'actions/upload-artifact@v7',
        'actions/download-artifact@v8',
        'aliyun/configure-aliyun-credentials-action@v1'
      ])
    )
    expect(workflow).not.toContain('agent-signing:')
    expect(workflow).not.toContain('remote-runtime-signing:')
    expect(workflow).not.toContain(
      'GOODBUDDY_SIGNING_PRIVATE_KEY'
    )
  })

  it('packages all six desktop targets without remote component dependencies', () => {
    expect(
      parsed.jobs.package?.strategy?.matrix?.include
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'windows',
          arch: 'x64',
          runner: 'windows-2025'
        }),
        expect.objectContaining({
          platform: 'windows',
          arch: 'arm64',
          runner: 'windows-2025'
        }),
        expect.objectContaining({
          platform: 'macos',
          arch: 'x64',
          runner: 'macos-15-intel'
        }),
        expect.objectContaining({
          platform: 'macos',
          arch: 'arm64',
          runner: 'macos-15'
        }),
        expect.objectContaining({
          platform: 'linux',
          arch: 'x64',
          runner: 'ubuntu-24.04'
        }),
        expect.objectContaining({
          platform: 'linux',
          arch: 'arm64',
          runner: 'ubuntu-24.04-arm'
        })
      ])
    )
    expect(jobNeeds('package')).toEqual([
      'validate',
      'authorize-release'
    ])
    const scripts = jobScripts('package')
    expect(scripts).toContain('npm run release:package')
    expect(scripts).not.toContain('agent-bundle.cjs import')
    expect(scripts).not.toContain(
      'remote-runtime-bundle.cjs import'
    )
    expect(serializedJob('package')).not.toContain(
      'goodbuddy-agent-linux-'
    )
    expect(serializedJob('package')).not.toContain(
      'goodbuddy-opencode-linux-'
    )
  })

  it('keeps desktop authorization tied to protected main and v tags', () => {
    const authorization = serializedJob('authorize-release')
    const policy = jobScripts('authorize-release')
    expect(authorization).toContain(
      "github.ref == 'refs/heads/main'"
    )
    expect(policy).toContain('git merge-base --is-ancestor')
    expect(policy).toContain(
      "require('./package.json').version"
    )
    expect(policy).toContain(
      'test "$GITHUB_REF" = "refs/tags/$expected"'
    )
    expect(policy).toContain(
      'refs/tags/$GITHUB_REF_NAME^{commit}'
    )
    expect(policy).toContain(
      'echo "authorized=true" >> "$GITHUB_OUTPUT"'
    )
    expect(serializedJob('package')).toContain(
      "needs.authorize-release.outputs.authorized == 'true'"
    )
  })

  it('installs RPM tooling and invokes the explicit native packager', () => {
    const packageJob = serializedJob('package')
    const scripts = jobScripts('package')
    expect(packageJob).toContain('Install RPM packaging tools')
    expect(packageJob).toContain(
      "matrix.platform == 'linux'"
    )
    expect(scripts).toContain(
      'sudo apt-get install --no-install-recommends --yes rpm'
    )
    expect(scripts).toContain('rpmbuild --version')
    expect(scripts).toContain(
      '--platform ${{ matrix.platform }} --arch ${{ matrix.arch }}'
    )
  })

  it('publishes only aggregated desktop assets through the existing OSS contract', () => {
    expect(jobNeeds('release')).toEqual([
      'authorize-release',
      'package'
    ])
    expect(parsed.jobs.release?.environment?.name).toBe(
      'aliyun-oss-release'
    )
    const release = serializedJob('release')
    const scripts = jobScripts('release')
    expect(release).toContain(
      'aliyun/configure-aliyun-credentials-action@v1'
    )
    expect(scripts).toContain(
      'node build/aggregate-release.cjs'
    )
    expect(scripts).toContain(
      'node build/create-site-release.cjs'
    )
    expect(scripts).toContain(
      'node build/verify-site-release.cjs'
    )
    expect(scripts).toContain(
      'oss://${OSS_BUCKET}/releases/${GITHUB_REF_NAME}'
    )
    expect(scripts).toContain(
      'oss://${OSS_BUCKET}/releases/latest.json'
    )
  })

  it('retains macOS signed and explicit unsigned release modes', () => {
    const scripts = jobScripts('package')
    expect(scripts).toContain('--skip-build --unsigned')
    expect(serializedJob('package')).toContain(
      '"CSC_LINK":"${{ runner.temp }}/goodbuddy-developer-id.p12"'
    )
    expect(scripts).toContain('xcrun stapler validate')
    expect(scripts).toContain('spctl --assess')
  })
})
