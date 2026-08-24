import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
  join(process.cwd(), '.github', 'workflows', 'packages.yml'),
  'utf8'
)
const runtimeLock = JSON.parse(
  readFileSync(
    join(process.cwd(), 'agent-runtime-lock.json'),
    'utf8'
  )
) as {
  node: {
    version: string
    source: string
    targets: Record<
      string,
      {
        archive: string
        sha256: string
      }
    >
  }
}
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

function jobSteps(
  name: string
): NonNullable<
  (typeof parsedWorkflow.jobs)[string]['steps']
> {
  return parsedWorkflow.jobs[name]?.steps ?? []
}

function jobNeeds(name: string): string[] {
  const needs = parsedWorkflow.jobs[name]?.needs
  return needs === undefined
    ? []
    : Array.isArray(needs)
      ? needs
      : [needs]
}

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
    const setupNodeVersions = Object.values(parsedWorkflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses === 'actions/setup-node@v7')
      .map((step) => step.with?.['node-version'])

    expect(setupNodeVersions.length).toBeGreaterThanOrEqual(4)
    expect(new Set(setupNodeVersions)).toEqual(
      new Set([runtimeLock.node.version])
    )
  })

  it('builds signed Agent bundles natively before the release package matrix', () => {
    const runtimeJob = serializedJob('agent-runtime')
    const signingJob = serializedJob('agent-signing')
    const signingMatrix =
      parsedWorkflow.jobs['agent-signing']?.strategy?.matrix
        ?.include ?? []
    const packageDownload = jobSteps('package').find(
      (step) =>
        step.uses === 'actions/download-artifact@v8' &&
        step.with?.pattern !== undefined
    )

    expect(signingMatrix).toContainEqual(
      expect.objectContaining({
        arch: 'arm64',
        runner: 'ubuntu-24.04-arm'
      })
    )
    expect(signingJob).toContain(
      'GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY'
    )
    expect(signingJob).toContain(
      'Preflight production Agent signing registry'
    )
    expect(signingJob).toContain(
      'node build/agent-bundle.cjs preflight'
    )
    for (const target of Object.values(runtimeLock.node.targets)) {
      expect(runtimeJob).toContain(target.archive)
    }
    expect(packageDownload?.with?.pattern).toBe(
      'goodbuddy-agent-linux-*'
    )
    const packageScripts = jobScripts('package')
    for (const targetName of Object.keys(runtimeLock.node.targets)) {
      expect(packageScripts).toContain(
        `--archive dist/agent-downloads/goodbuddy-agent-${targetName}.tar`
      )
    }
    expect(jobNeeds('package')).toEqual(
      expect.arrayContaining(['validate', 'agent-signing'])
    )
  })

  it('imports Agent artifacts before invoking the explicit release packager', () => {
    const scripts = jobScripts('package')
    const importIndex = scripts.indexOf(
      'node build/agent-bundle.cjs import'
    )
    const releaseIndex = scripts.indexOf(
      'npm run release:package'
    )

    expect(importIndex).toBeGreaterThanOrEqual(0)
    expect(releaseIndex).toBeGreaterThan(importIndex)
    expect(scripts).not.toContain('npm run dist')
    expect(scripts).not.toContain('npm run portable')
  })

  it('authorizes signing only for protected-main commits and matching immutable version tags', () => {
    const authorization = serializedJob(
      'authorize-agent-signing'
    )
    const policy = jobScripts('authorize-agent-signing')

    expect(authorization).toContain(
      "github.ref == 'refs/heads/main'"
    )
    expect(policy).toContain(
      'git merge-base --is-ancestor'
    )
    expect(policy).toContain(
      "require('./package.json').version"
    )
    expect(policy).toContain(
      'GITHUB_EVENT_PATH).created'
    )
    expect(policy).toContain(
      'GITHUB_EVENT_PATH).forced'
    )
    expect(policy).toContain(
      'GITHUB_EVENT_PATH).deleted'
    )
    expect(policy).toContain(
      'test "$GITHUB_REF" = "refs/tags/$expected"'
    )
    expect(policy).toContain(
      'git cat-file -t "refs/tags/$GITHUB_REF_NAME"'
    )
    expect(policy).toContain(
      'refs/tags/$GITHUB_REF_NAME^{commit}'
    )
    expect(policy).toContain(
      'test "$GITHUB_REF" = "refs/heads/main"'
    )
    expect(policy).toContain(
      'test "$GITHUB_SHA" = "$(git rev-parse refs/remotes/origin/main)"'
    )
    expect(policy).toContain(
      'echo "authorized=true" >> "$GITHUB_OUTPUT"'
    )
  })

  it('gates the only Agent private-key step behind the protected signing environment', () => {
    const signing = serializedJob('agent-signing')

    expect(signing).toContain('"name":"agent-signing"')
    expect(signing).toContain(
      '"authorize-agent-signing"'
    )
    expect(signing).toContain(
      "needs.authorize-agent-signing.outputs.authorized == 'true'"
    )
    expect(signing).toContain(
      '${{ secrets.GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY }}'
    )
    expect(signing.indexOf('Preflight production Agent signing registry'))
      .toBeLessThan(
        signing.indexOf(
          '${{ secrets.GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY }}'
        )
      )
    expect(signing).not.toContain('"cache"')
    expect(signing).not.toContain('actions/cache')
    expect(
      workflow.match(
        /\$\{\{\s*secrets\.GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY\s*\}\}/gu
      )
    ).toHaveLength(1)
  })

  it('keeps production signing inputs out of arbitrary-ref jobs', () => {
    for (const name of [
      'validate',
      'authorize-agent-signing',
      'agent-runtime'
    ]) {
      expect(serializedJob(name)).not.toContain('secrets.')
      expect(serializedJob(name)).not.toContain(
        'GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY'
      )
    }

    expect(serializedJob('validate')).not.toContain(
      'GOODBUDDY_AGENT_SIGNING_KEY_ID'
    )
    expect(serializedJob('authorize-agent-signing')).not.toContain(
      'GOODBUDDY_AGENT_SIGNING_KEY_ID'
    )
  })

  it('preserves unsigned validation while rejecting arbitrary refs from release jobs', () => {
    const validation = serializedJob('validate')
    const authorization = serializedJob(
      'authorize-agent-signing'
    )

    expect(validation).toContain('npm test')
    expect(validation).toContain('npm run typecheck')
    expect(validation).toContain('npm run lint')
    expect(validation).toContain('npm run build:bundle')
    expect(authorization).toContain(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'"
    )
    expect(authorization).not.toContain(
      "github.event_name == 'workflow_dispatch' || github.ref_type == 'tag'"
    )
    expect(serializedJob('package')).toContain(
      "needs.authorize-agent-signing.outputs.authorized == 'true'"
    )
  })

  it('acquires every locked Agent runtime securely on cold runners', () => {
    const runtimeJob = serializedJob('agent-runtime')
    const runtimeScripts = jobScripts('agent-runtime')
    const signingJob = serializedJob('agent-signing')
    const runtimeUses = jobSteps('agent-runtime')
      .map((step) => step.uses)
      .filter((value) => value !== undefined)
    const runtimeUpload = jobSteps('agent-runtime').find(
      (step) =>
        step.uses === 'actions/upload-artifact@v7'
    )

    for (const target of Object.values(runtimeLock.node.targets)) {
      expect(runtimeJob).toContain(
        new URL(target.archive, runtimeLock.node.source).toString()
      )
      expect(runtimeJob).toContain(target.sha256)
    }
    expect(runtimeScripts).toContain(
      "curl --proto '=https' --tlsv1.2"
    )
    expect(runtimeScripts).toContain('--max-filesize 104857600')
    expect(runtimeScripts).toContain('sha256sum --check --strict -')
    expect(runtimeUses).toEqual(
      expect.arrayContaining([
        'actions/cache/restore@v6',
        'actions/cache/save@v6'
      ])
    )
    expect(runtimeUpload?.with?.name).toBe(
      'goodbuddy-agent-node-${{ matrix.arch }}'
    )
    expect(runtimeJob).toContain(
      'steps.node-runtime-cache.outputs.cache-hit != \'true\''
    )
    expect(runtimeJob).not.toContain('fail-on-cache-miss: true')
    expect(jobNeeds('agent-signing')).toEqual(
      expect.arrayContaining(['validate', 'agent-runtime'])
    )
    expect(signingJob).toContain('agent-runtime')
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
