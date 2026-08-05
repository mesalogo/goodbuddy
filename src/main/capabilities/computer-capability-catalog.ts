import {
  computerCapabilityIdSchema,
  type ComputerCapabilityId
} from '../../shared/capability-contracts'

export const computerCapabilityIds = computerCapabilityIdSchema.options
export type { ComputerCapabilityId }
export type ComputerCapabilityPlatform = 'win32' | 'darwin' | 'linux'
export type ComputerCapabilityArchitecture = 'x64' | 'arm64'
export type ComputerCapabilityImplementationKind =
  | 'managed-browser-driver'
  | 'managed-linux-desktop-driver'

const PRODUCTION_IMPLEMENTATIONS: ReadonlySet<ComputerCapabilityImplementationKind> =
  new Set(['managed-browser-driver'])

export type ComputerCapabilityCatalogEntry = Readonly<{
  id: ComputerCapabilityId
  name: string
  description: string
  enabledByDefault: false
  implementationKind: ComputerCapabilityImplementationKind
  supportedTargets: readonly Readonly<{
    platform: ComputerCapabilityPlatform
    architectures: readonly ComputerCapabilityArchitecture[]
  }>[]
  riskSummary: string
  requiredDiagnostics: readonly string[]
}>

const ARCHITECTURES = Object.freeze(['x64', 'arm64'] as const)

export const computerCapabilityCatalog: readonly ComputerCapabilityCatalogEntry[] =
  Object.freeze([
    Object.freeze({
      id: 'host-browser-control',
      name: '浏览器控制',
      description:
        '使用临时隔离会话执行网页操作；命名配置当前仅保存未来托管隔离所需的元数据。',
      enabledByDefault: false,
      implementationKind: 'managed-browser-driver',
      supportedTargets: Object.freeze([
        Object.freeze({
          platform: 'win32',
          architectures: ARCHITECTURES
        }),
        Object.freeze({
          platform: 'darwin',
          architectures: ARCHITECTURES
        }),
        Object.freeze({
          platform: 'linux',
          architectures: ARCHITECTURES
        })
      ]),
      riskSummary:
        '可读取网页内容并代表用户操作网站；当前执行不会复用命名配置，仍必须保持临时隔离和审批策略。',
      requiredDiagnostics: Object.freeze([
        'browser-executable',
        'managed-profile-root'
      ])
    }),
    Object.freeze({
      id: 'linux-desktop-control',
      name: 'Linux 桌面控制',
      description:
        '技术预览：保留 Linux 桌面控制核心与诊断，注册真实原生适配器后才可启用。',
      enabledByDefault: false,
      implementationKind: 'managed-linux-desktop-driver',
      supportedTargets: Object.freeze([
        Object.freeze({
          platform: 'linux',
          architectures: ARCHITECTURES
        })
      ]),
      riskSummary:
        '真实 D-Bus、PipeWire、libei 或 XTest 适配器尚未随产品提供；注册适配器后仍须保持审批、超时和审计边界。',
      requiredDiagnostics: Object.freeze([
        'linux-session',
        'desktop-driver',
        'desktop-permissions'
      ])
    })
  ] satisfies ComputerCapabilityCatalogEntry[])

export function getComputerCapability(
  id: ComputerCapabilityId
): ComputerCapabilityCatalogEntry {
  const capability = computerCapabilityCatalog.find((entry) => entry.id === id)
  if (!capability) {
    throw new Error(`Unknown computer capability: ${id}`)
  }
  return capability
}

export function isComputerCapabilitySupported(
  capability: ComputerCapabilityCatalogEntry,
  platform: NodeJS.Platform,
  architecture: string,
  availableImplementations: ReadonlySet<ComputerCapabilityImplementationKind> =
    PRODUCTION_IMPLEMENTATIONS
): boolean {
  return (
    availableImplementations.has(capability.implementationKind) &&
    capability.supportedTargets.some(
      (target) =>
        target.platform === platform &&
        target.architectures.some((candidate) => candidate === architecture)
    )
  )
}
