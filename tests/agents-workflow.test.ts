import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowPath = join(
  process.cwd(),
  '.github',
  'workflows',
  'agents.yml'
)
const workflow = readFileSync(workflowPath, 'utf8')
const ciBundleSource = readFileSync(
  join(process.cwd(), 'build', 'agent-ci-bundle.cjs'),
  'utf8'
)
const parsedWorkflow = parse(workflow) as {
  jobs: Record<
    string,
    {
      needs?: string | string[]
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

type AgentCiBundleModule = {
  parseArguments(argv: string[]): {
    arch: 'x64' | 'arm64'
    nodeArchive: string
    opencodeArchive: string
    outputDirectory: string
    archive: string
  }
}

const require = createRequire(import.meta.url)
const agentCiBundle = require(
  '../build/agent-ci-bundle.cjs'
) as AgentCiBundleModule

function serializedJob(name: string): string {
  return JSON.stringify(parsedWorkflow.jobs[name])
}

function jobScripts(name: string): string {
  return (
    parsedWorkflow.jobs[name]?.steps
      ?.map((step) => step.run ?? '')
      .join('\n') ?? ''
  )
}

describe('GoodBuddy Agents workflow', () => {
  it('uses valid YAML, bounded permissions, and pinned action majors', () => {
    expect(() => parse(workflow)).not.toThrow()
    expect(workflow).toContain('name: GoodBuddy Agents')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('push:')
    expect(workflow).toContain('workflow_dispatch:')

    const references = [
      ...workflow.matchAll(
        /uses:\s+(actions\/(?:checkout|setup-node|cache)@v\d+)/gu
      )
    ].map((match) => match[1])
    expect(new Set(references)).toEqual(
      new Set([
        'actions/checkout@v7',
        'actions/setup-node@v7',
        'actions/cache@v6'
      ])
    )
    expect(workflow).not.toContain('permissions: write')
    expect(workflow).not.toContain('actions/upload-artifact')
    expect(workflow).not.toContain("- 'AGENTS.md'")
    expect(workflow.match(/'src\/shared\/\*\*'/gu)).toHaveLength(2)
  })

  it('builds Linux and Darwin arm64 targets on native runners', () => {
    expect(
      parsedWorkflow.jobs.build?.strategy?.matrix?.include
    ).toEqual([
        {
          platform: 'linux',
          arch: 'x64',
          runner: 'ubuntu-24.04'
        },
        {
          platform: 'linux',
          arch: 'arm64',
          runner: 'ubuntu-24.04-arm'
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          runner: 'macos-15'
        }
      ])
    expect(parsedWorkflow.jobs.build?.needs).toBe('validate')
    expect(serializedJob('build')).toContain(
      '"runs-on":"${{ matrix.runner }}"'
    )
    expect(jobScripts('build')).toContain(
      'src/agent-daemon/model-bridge.test.ts'
    )
    expect(jobScripts('build')).toContain(
      'src/agent-daemon/lifecycle.test.ts'
    )
    expect(jobScripts('validate')).not.toContain(
      'src/agent-daemon/model-bridge.test.ts'
    )
    expect(jobScripts('validate')).not.toContain(
      'src/agent-daemon/lifecycle.test.ts'
    )
  })

  it('resolves and verifies the locked official Node runtime', () => {
    const scripts = jobScripts('build')
    expect(scripts).toContain(
      "require('./build/agent-ci-bundle.cjs').readCiLocks("
    )
    expect(scripts).toContain("url.protocol !== 'https:'")
    expect(scripts).toContain("url.hostname !== 'nodejs.org'")
    expect(scripts).toContain(
      "curl --proto '=https' --tlsv1.2"
    )
    expect(scripts).toContain('--max-filesize 104857600')
    expect(scripts).toContain('Node runtime archive integrity mismatch')
    expect(scripts).not.toContain('sha256sum')
    expect(serializedJob('build')).toContain('actions/cache@v6')
  })

  it('resolves and verifies the locked official OpenCode Runtime', () => {
    const scripts = jobScripts('build')
    expect(scripts).toContain(
      "require('./build/agent-ci-bundle.cjs').readCiLocks("
    )
    expect(scripts).toContain(
      '--registry https://registry.npmjs.org/'
    )
    expect(scripts).toContain('--ignore-scripts')
    expect(scripts).toContain(
      'OpenCode Runtime archive integrity mismatch'
    )
    expect(serializedJob('build')).toContain('actions/cache@v6')
  })

  it('uses only ephemeral test signing and publishes no package', () => {
    const build = serializedJob('build')
    expect(build).toContain(
      'node build/agent-ci-bundle.cjs'
    )
    expect(build).toContain(
      'deterministic archive comparison passed'
    )
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain(
      'GOODBUDDY_SIGNING_PRIVATE_KEY'
    )
    expect(ciBundleSource).toContain(
      "generateKeyPairSync('ed25519')"
    )
    expect(ciBundleSource).toContain(
      "environment: 'test'"
    )
    expect(ciBundleSource).toContain('testSigningIdentity')
    expect(ciBundleSource).toContain(
      'Agent CI archives are not deterministic'
    )
    expect(ciBundleSource).toContain('assembleAgentPackage')
    expect(ciBundleSource).toContain('buildRuntimeBundle')
    expect(ciBundleSource).toContain('archive: second.archive')
    expect(ciBundleSource).not.toContain(
      'second.package.archive'
    )
    expect(build).toContain('.gbagent')
    expect(ciBundleSource).not.toContain(
      'readTrustedKeyRegistry'
    )
    expect(ciBundleSource).not.toContain('writeFileSync')
  })

  it('parses only explicit bounded CI build arguments', () => {
    expect(
      agentCiBundle.parseArguments([
        '--arch',
        'arm64',
        '--node-archive',
        'node.tar.gz',
        '--opencode-archive',
        'opencode.tgz',
        '--output-directory',
        'bundle',
        '--archive',
        'goodbuddy-agent-1.0.0-linux-arm64.gbagent'
      ])
    ).toMatchObject({ arch: 'arm64' })
    expect(() =>
      agentCiBundle.parseArguments([
        '--arch',
        'x64',
        '--node-archive',
        'node.tar.gz',
        '--opencode-archive',
        'opencode.tgz',
        '--output-directory',
        'bundle',
        '--archive',
        'goodbuddy-agent-1.0.0-linux-x64.gbagent',
        '--private-key',
        'secret'
      ])
    ).toThrow('Unknown Agent CI bundle argument')
  })

  it('includes Darwin in production packaging while retaining native target checks', () => {
    expect(serializedJob('build')).toContain("matrix.platform == 'linux'")
    expect(jobScripts('build')).toContain('src/agent-daemon/darwin-process-identity.test.ts')
    const release = readFileSync(
      join(process.cwd(), '.github/workflows/agent-release.yml'), 'utf8'
    )
    expect(release).toContain('macos-15')
    expect(release).toContain('AGENT_PLATFORM')
    for (const target of ['darwin', 'win32']) {
      expect(() => agentCiBundle.parseArguments([
        '--platform', target, '--arch', 'x64'
      ])).toThrow('Unsupported Agent build target')
    }
    expect(agentCiBundle.parseArguments([
      '--platform', 'darwin', '--arch', 'arm64',
      '--node-archive', 'node.tar.gz',
      '--opencode-archive', 'opencode.tgz',
      '--output-directory', 'bundle',
      '--archive', 'goodbuddy-agent-1.0.0-darwin-arm64.gbagent'
    ])).toMatchObject({ platform: 'darwin', arch: 'arm64' })
  })
})
