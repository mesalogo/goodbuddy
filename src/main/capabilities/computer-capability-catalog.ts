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
      name: '内置浏览器',
      description:
        '使用 GoodBuddy 内置的临时隔离浏览器执行网页操作，不会控制客户端已安装的浏览器。',
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
        '总开关关闭时不会向直连模型提供浏览器工具；开启后可在 Execute 模式直接读取网页并操作网站，不再逐次询问。',
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
