import { describe, expect, it } from 'vitest'
import {
  AGENT_BOOTSTRAP_PROBE_COMMAND,
  buildFixedAgentCliArgv,
  buildFixedAgentSshCommand,
  parseAgentBootstrapProbeOutput,
  verifyAgentInstallationId
} from './ssh-agent-command'

function bootstrapOutput(
  overrides: Partial<Record<string, string>> = {}
): string {
  const values = {
    home: '/home/builder',
    uid: '1001',
    os: 'Linux',
    arch: 'x86_64',
    shell: '/bin/bash',
    procfs: 'ready',
    ...overrides
  }
  return [
    'GOODBUDDY_AGENT_BOOTSTRAP_PROBE_V1',
    ...Object.entries(values).map(
      ([key, value]) => `${key}=${value}`
    ),
    ''
  ].join('\n')
}

describe('fixed Agent SSH commands', () => {
  it('uses one exact, fixed, non-mutating bootstrap probe command', () => {
    expect(AGENT_BOOTSTRAP_PROBE_COMMAND).toBe(
      `printf 'GOODBUDDY_AGENT_BOOTSTRAP_PROBE_V1\\n'; ` +
        `if home=$(cd "$HOME" 2>/dev/null && pwd -P); then printf 'home=%s\\n' "$home"; else printf 'home=unknown\\n'; fi; ` +
        `if uid=$(id -u 2>/dev/null); then printf 'uid=%s\\n' "$uid"; else uid=unknown; printf 'uid=unknown\\n'; fi; ` +
        `if os=$(uname -s 2>/dev/null); then printf 'os=%s\\n' "$os"; else printf 'os=unknown\\n'; fi; ` +
        `if arch=$(uname -m 2>/dev/null); then printf 'arch=%s\\n' "$arch"; else printf 'arch=unknown\\n'; fi; ` +
        `printf 'shell=%s\\n' "\${SHELL:-unknown}"; ` +
        `if [ -r /proc/self/stat ] && [ -r "/proc/$$/stat" ]; then printf 'procfs=ready\\n'; else printf 'procfs=unavailable\\n'; fi`
    )
    expect(AGENT_BOOTSTRAP_PROBE_COMMAND).not.toMatch(
      /\b(?:sudo|env|printenv|set|export|install|mkdir|touch|rm)\b/u
    )
    expect(AGENT_BOOTSTRAP_PROBE_COMMAND).not.toMatch(
      /\b(?:systemctl|loginctl)\b|Linger/u
    )
  })

  it('builds only fixed commands from a separately verified installation ID', () => {
    const installationId = verifyAgentInstallationId(
      'agent_2026-08-20_abcdef012345'
    )

    expect(
      buildFixedAgentSshCommand(installationId, { kind: 'attach' })
    ).toBe(
      'exec "$HOME/.goodbuddy/agent/installations/' +
        'agent_2026-08-20_abcdef012345/goodbuddy-agent" ' +
        'attach-or-bootstrap --installation-id ' +
        'agent_2026-08-20_abcdef012345'
    )
    expect(
      buildFixedAgentSshCommand(installationId, { kind: 'doctor' })
    ).toContain(
      '/goodbuddy-agent" doctor --installation-id ' +
      'agent_2026-08-20_abcdef012345'
    )
    expect(
      buildFixedAgentSshCommand(installationId, {
        kind: 'lifecycle',
        action: 'bootstrap'
      })
    ).toContain(
      '/goodbuddy-agent" bootstrap --installation-id ' +
      'agent_2026-08-20_abcdef012345'
    )
    expect(
      buildFixedAgentCliArgv(installationId, {
        kind: 'lifecycle',
        action: 'bootstrap'
      })
    ).toEqual([
      'bootstrap',
      '--installation-id',
      'agent_2026-08-20_abcdef012345'
    ])
    expect(
      buildFixedAgentSshCommand(installationId, {
        kind: 'lifecycle',
        action: 'health'
      })
    ).toContain(
      '/goodbuddy-agent" health --installation-id ' +
        'agent_2026-08-20_abcdef012345'
    )
  })

  it('rejects shell syntax and path traversal in installation IDs', () => {
    for (const value of [
      '../current',
      'agent/latest',
      'agent; shutdown',
      '$(whoami)',
      'agent.v1',
      '',
      'a'.repeat(129)
    ]) {
      expect(() => verifyAgentInstallationId(value)).toThrow(
        'installation ID 无效'
      )
    }
  })

  it('builds a closed digest-addressed OpenCode activation command', () => {
    const installationId = verifyAgentInstallationId('agent-v1')
    const bundleDigest = `sha256:${'a'.repeat(64)}`

    expect(
      buildFixedAgentCliArgv(installationId, {
        kind: 'runtime-activate',
        runtimeId: 'opencode',
        bundleDigest,
        architecture: 'arm64'
      })
    ).toEqual([
      'runtime',
      'activate',
      '--installation-id',
      'agent-v1',
      '--runtime-id',
      'opencode',
      '--bundle-digest',
      bundleDigest,
      '--architecture',
      'arm64'
    ])
    expect(
      buildFixedAgentSshCommand(installationId, {
        kind: 'runtime-activate',
        runtimeId: 'opencode',
        bundleDigest,
        architecture: 'arm64'
      })
    ).toBe(
      'exec "$HOME/.goodbuddy/agent/installations/agent-v1/' +
        'goodbuddy-agent" runtime activate --installation-id agent-v1 ' +
        `--runtime-id opencode --bundle-digest ${bundleDigest} ` +
        '--architecture arm64'
    )
  })

  it('rejects unchecked Runtime activation argv before command construction', () => {
    const installationId = verifyAgentInstallationId('agent-v1')
    const valid = {
      kind: 'runtime-activate',
      runtimeId: 'opencode',
      bundleDigest: `sha256:${'a'.repeat(64)}`,
      architecture: 'x64'
    } as const

    for (const action of [
      { ...valid, runtimeId: 'opencode; id' },
      { ...valid, bundleDigest: `sha256:${'a'.repeat(63)};id` },
      { ...valid, architecture: 'x64;id' }
    ]) {
      expect(() =>
        buildFixedAgentSshCommand(
          installationId,
          action as never
        )
      ).toThrow(/Runtime/iu)
    }
  })

  it('fails closed if an untyped caller supplies an unknown lifecycle action', () => {
    const installationId = verifyAgentInstallationId('agent-v1')

    expect(() =>
      buildFixedAgentSshCommand(installationId, {
        kind: 'lifecycle',
        action: 'arbitrary command'
      } as never)
    ).toThrow('lifecycle action 无效')
    expect(() =>
      buildFixedAgentSshCommand(
        '../unverified' as typeof installationId,
        { kind: 'attach' }
      )
    ).toThrow('installation ID 无效')
  })

  it('parses supported Linux x64 and arm64 bootstrap results', () => {
    expect(parseAgentBootstrapProbeOutput(bootstrapOutput())).toEqual({
      ready: true,
      platform: 'linux',
      architecture: 'x64',
      canonicalHomeDirectory: '/home/builder',
      uid: 1_001,
      shell: '/bin/bash',
      procfs: 'ready'
    })
    expect(
      parseAgentBootstrapProbeOutput(
        bootstrapOutput({ arch: 'aarch64' })
      )
    ).toMatchObject({
      ready: true,
      architecture: 'arm64'
    })
  })

  it('returns explicit incompatible bootstrap reasons', () => {
    const cases: Array<
      [Partial<Record<string, string>>, string]
    > = [
      [{ os: 'Darwin' }, 'non-linux'],
      [{ arch: 'riscv64' }, 'unsupported-architecture'],
      [{ home: 'unknown' }, 'home-directory-unavailable'],
      [{ uid: 'unknown' }, 'uid-unavailable'],
      [{ shell: 'unknown' }, 'shell-unavailable'],
      [{ procfs: 'unavailable' }, 'procfs-unavailable']
    ]
    for (const [overrides, reason] of cases) {
      expect(
        parseAgentBootstrapProbeOutput(bootstrapOutput(overrides))
      ).toEqual({ ready: false, reason })
    }
  })

  it('rejects malformed, reordered, incomplete, and unsafe output', () => {
    const valid = bootstrapOutput()
    for (const output of [
      valid.slice(0, -1),
      valid.replace('home=', 'uid='),
      valid.replace('home=/home/builder', 'home=relative/path'),
      valid.replace('/home/builder', '/home/../root'),
      valid.replace('/bin/bash', '/bin/ba\u0000sh'),
      valid.replace('/bin/bash', '/bin/ba\u0085sh'),
      bootstrapOutput({ uid: '1001x' }),
      bootstrapOutput({ procfs: 'maybe' }),
      valid.replace('uid=1001', 'uid=1001\nuid=1001'),
      `noise\n${valid}`,
      valid.replace('\n', '\r\n'),
      'x'.repeat(16 * 1024 + 1)
    ]) {
      expect(() =>
        parseAgentBootstrapProbeOutput(output)
      ).toThrow('无效')
    }
  })
})
