import {
  agentBootstrapProbeResultSchema,
  canonicalRemotePathSchema,
  type AgentBootstrapIncompatibleReason,
  type AgentBootstrapProbeResult
} from '../../shared/ssh-host-contracts'
import { sha256DigestSchema } from '../../shared/agent-protocol/contracts'

const INSTALLATION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u
const AGENT_BOOTSTRAP_PROBE_MARKER =
  'GOODBUDDY_AGENT_BOOTSTRAP_PROBE_V1'
const MAX_PROBE_FIELD_LENGTH = 4_096
const MAX_LINUX_UID = 4_294_967_294

export const AGENT_BOOTSTRAP_PROBE_COMMAND = [
  `printf '${AGENT_BOOTSTRAP_PROBE_MARKER}\\n'`,
  `if home=$(cd "$HOME" 2>/dev/null && pwd -P); then printf 'home=%s\\n' "$home"; else printf 'home=unknown\\n'; fi`,
  `if uid=$(id -u 2>/dev/null); then printf 'uid=%s\\n' "$uid"; else uid=unknown; printf 'uid=unknown\\n'; fi`,
  `if os=$(uname -s 2>/dev/null); then printf 'os=%s\\n' "$os"; else printf 'os=unknown\\n'; fi`,
  `if arch=$(uname -m 2>/dev/null); then printf 'arch=%s\\n' "$arch"; else printf 'arch=unknown\\n'; fi`,
  `printf 'shell=%s\\n' "\${SHELL:-unknown}"`,
  `if [ -r /proc/self/stat ] && [ -r "/proc/$$/stat" ]; then printf 'procfs=ready\\n'; else printf 'procfs=unavailable\\n'; fi`
].join('; ')

const lifecycleActions = [
  'bootstrap',
  'health',
  'status',
  'retire',
  'stop'
] as const
const runtimeArchitectures = ['x64', 'arm64'] as const
const RUNTIME_ID = 'opencode' as const

declare const verifiedInstallationIdBrand: unique symbol

export type VerifiedAgentInstallationId = string & {
  readonly [verifiedInstallationIdBrand]: true
}

export type AgentLifecycleAction = (typeof lifecycleActions)[number]
export type AgentRuntimeArchitecture =
  (typeof runtimeArchitectures)[number]

export type AgentRuntimeActivationAction = {
  kind: 'runtime-activate'
  runtimeId: typeof RUNTIME_ID
  bundleDigest: string
  architecture: AgentRuntimeArchitecture
}

export type FixedAgentSshAction =
  | { kind: 'attach' }
  | { kind: 'doctor' }
  | { kind: 'lifecycle'; action: AgentLifecycleAction }
  | AgentRuntimeActivationAction

export type FixedAgentCliArgv = readonly string[]

const probeFields = [
  'home',
  'uid',
  'os',
  'arch',
  'shell',
  'procfs'
] as const

function incompatible(
  reason: AgentBootstrapIncompatibleReason
): AgentBootstrapProbeResult {
  return agentBootstrapProbeResultSchema.parse({
    ready: false,
    reason
  })
}

function isSafeProbeField(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PROBE_FIELD_LENGTH &&
    !/[\p{Cc}\p{Cs}\u2028\u2029\ufffd]/u.test(value)
  )
}

function parseLinuxUid(value: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    return undefined
  }
  const uid = Number(value)
  return Number.isSafeInteger(uid) && uid <= MAX_LINUX_UID
    ? uid
    : undefined
}

export function parseAgentBootstrapProbeOutput(
  stdout: string
): AgentBootstrapProbeResult {
  if (
    !stdout.endsWith('\n') ||
    stdout.length > 16 * 1024 ||
    stdout.includes('\r') ||
    stdout.includes('\0')
  ) {
    throw new Error('Agent 启动探针返回了无效结果')
  }
  const lines = stdout.slice(0, -1).split('\n')
  if (
    lines.length !== probeFields.length + 1 ||
    lines[0] !== AGENT_BOOTSTRAP_PROBE_MARKER
  ) {
    throw new Error('Agent 启动探针返回了无效结果')
  }
  const values = new Map<string, string>()
  for (const [index, field] of probeFields.entries()) {
    const prefix = `${field}=`
    const line = lines[index + 1]
    if (!line?.startsWith(prefix)) {
      throw new Error('Agent 启动探针返回了无效结果')
    }
    const value = line.slice(prefix.length)
    if (!isSafeProbeField(value)) {
      throw new Error('Agent 启动探针返回了无效结果')
    }
    values.set(field, value)
  }

  const os = values.get('os')
  if (os !== 'Linux') {
    return incompatible('non-linux')
  }
  const rawArchitecture = values.get('arch')
  const architecture =
    rawArchitecture === 'x86_64'
      ? 'x64'
      : rawArchitecture === 'aarch64'
        ? 'arm64'
        : undefined
  if (!architecture) {
    return incompatible('unsupported-architecture')
  }

  const home = values.get('home') ?? ''
  if (home === 'unknown') {
    return incompatible('home-directory-unavailable')
  }
  if (!canonicalRemotePathSchema.safeParse(home).success) {
    throw new Error('Agent 启动探针返回了无效路径')
  }
  const rawUid = values.get('uid')
  if (rawUid === 'unknown') {
    return incompatible('uid-unavailable')
  }
  const uid = parseLinuxUid(rawUid ?? '')
  if (uid === undefined) {
    throw new Error('Agent 启动探针返回了无效 UID')
  }
  const shell = values.get('shell') ?? ''
  if (shell === 'unknown') {
    return incompatible('shell-unavailable')
  }
  if (!canonicalRemotePathSchema.safeParse(shell).success) {
    throw new Error('Agent 启动探针返回了无效路径')
  }
  const procfs = values.get('procfs')
  if (procfs !== 'ready' && procfs !== 'unavailable') {
    throw new Error('Agent 启动探针返回了无效结果')
  }
  if (procfs === 'unavailable') {
    return incompatible('procfs-unavailable')
  }
  return agentBootstrapProbeResultSchema.parse({
    ready: true,
    platform: 'linux',
    architecture,
    canonicalHomeDirectory: home,
    uid,
    shell,
    procfs: 'ready'
  })
}

export function verifyAgentInstallationId(
  value: string
): VerifiedAgentInstallationId {
  if (
    value.length > 128 ||
    !INSTALLATION_ID_PATTERN.test(value)
  ) {
    throw new Error('GoodBuddy Agent installation ID 无效')
  }
  return value as VerifiedAgentInstallationId
}

export function buildFixedAgentCliArgv(
  installationId: VerifiedAgentInstallationId,
  action: FixedAgentSshAction
): FixedAgentCliArgv {
  const verifiedInstallationId =
    verifyAgentInstallationId(installationId)
  const installationOption = [
    '--installation-id',
    verifiedInstallationId
  ] as const
  switch (action.kind) {
    case 'attach':
      return ['attach-or-bootstrap', ...installationOption]
    case 'doctor':
      return ['doctor', ...installationOption]
    case 'lifecycle':
      if (!lifecycleActions.includes(action.action)) {
        throw new Error('GoodBuddy Agent lifecycle action 无效')
      }
      return [action.action, ...installationOption]
    case 'runtime-activate': {
      if (action.runtimeId !== RUNTIME_ID) {
        throw new Error('GoodBuddy Agent Runtime ID 无效')
      }
      if (!sha256DigestSchema.safeParse(action.bundleDigest).success) {
        throw new Error('GoodBuddy Agent Runtime bundle digest 无效')
      }
      if (!runtimeArchitectures.includes(action.architecture)) {
        throw new Error('GoodBuddy Agent Runtime architecture 无效')
      }
      return [
        'runtime',
        'activate',
        ...installationOption,
        '--runtime-id',
        action.runtimeId,
        '--bundle-digest',
        action.bundleDigest,
        '--architecture',
        action.architecture
      ]
    }
  }
}

export function buildFixedAgentSshCommand(
  installationId: VerifiedAgentInstallationId,
  action: FixedAgentSshAction
): string {
  const verifiedInstallationId =
    verifyAgentInstallationId(installationId)
  const argv = buildFixedAgentCliArgv(verifiedInstallationId, action)
  const executable =
    `"$HOME/.goodbuddy/agent/installations/${verifiedInstallationId}` +
    '/goodbuddy-agent"'
  return `exec ${executable} ${argv.join(' ')}`
}
