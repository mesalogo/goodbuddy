import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { isDeepSeekHarnessCompatibleBaseUrl } from '../../shared/deepseek-harness-compatibility'
import {
  runtimeExtensionConfigurationSchema,
  runtimeExtensionIdSchema
} from '../../shared/runtime-extension-contracts'

export const DEEPSEEK_HARNESS_CONTROL_PROTOCOL =
  'goodbuddy.deepseek-harness.control'
export const DEEPSEEK_HARNESS_CONTROL_VERSION = 1
export const DEEPSEEK_HARNESS_HOST_VERSION = '0.1.0-rc.6'
export const DEEPSEEK_HARNESS_CREDENTIAL_REF =
  'GOODBUDDY_HARNESS_MODEL_API_KEY'

const skillPackageSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    directory: z.string().min(1).max(32_768).refine(isAbsolute)
  })
  .strict()

const extensionPackageSchema = z
  .object({
    id: runtimeExtensionIdSchema,
    entrypoint: z.string().min(1).max(32_768).refine(isAbsolute),
    configuration: runtimeExtensionConfigurationSchema
  })
  .strict()

export const controlledHarnessHostConfigSchema = z
  .object({
    workspace: z.string().min(1).max(32_768).refine(isAbsolute),
    dshHome: z.string().min(1).max(32_768).refine(isAbsolute),
    baseUrl: z
      .url()
      .max(2_048)
      .refine(isDeepSeekHarnessCompatibleBaseUrl),
    api: z.literal('openai-completions'),
    provider: z.literal('goodbuddy'),
    model: z.string().min(1).max(128),
    harnessVersion: z.literal(DEEPSEEK_HARNESS_HOST_VERSION),
    credentialRefs: z
      .tuple([z.literal(DEEPSEEK_HARNESS_CREDENTIAL_REF)])
      .readonly(),
    skillPackages: z.array(skillPackageSchema).max(64),
    extensionPackages: z.array(extensionPackageSchema).max(64),
    maxFrameBytes: z.literal(1024 * 1024)
  })
  .strict()

export type ControlledHarnessBootstrapConfig = z.infer<
  typeof controlledHarnessHostConfigSchema
>

export type DeepSeekHarnessControlMessage =
  | {
      protocol: typeof DEEPSEEK_HARNESS_CONTROL_PROTOCOL
      version: typeof DEEPSEEK_HARNESS_CONTROL_VERSION
      type: 'start'
      config: ControlledHarnessBootstrapConfig
    }
  | {
      protocol: typeof DEEPSEEK_HARNESS_CONTROL_PROTOCOL
      version: typeof DEEPSEEK_HARNESS_CONTROL_VERSION
      type: 'ready'
      failedExtensionIds: readonly string[]
    }
  | {
      protocol: typeof DEEPSEEK_HARNESS_CONTROL_PROTOCOL
      version: typeof DEEPSEEK_HARNESS_CONTROL_VERSION
      type: 'fatal'
      code: string
    }

export function parseHarnessControlMessage(
  value: unknown
): DeepSeekHarnessControlMessage | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    record.protocol !== DEEPSEEK_HARNESS_CONTROL_PROTOCOL ||
    record.version !== DEEPSEEK_HARNESS_CONTROL_VERSION
  ) {
    return undefined
  }
  if (
    record.type === 'ready' &&
    Object.keys(record).length === 4 &&
    Array.isArray(record.failedExtensionIds)
  ) {
    const failedExtensionIds = z
      .array(runtimeExtensionIdSchema)
      .max(64)
      .safeParse(record.failedExtensionIds)
    return failedExtensionIds.success
      ? {
          protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
          version: DEEPSEEK_HARNESS_CONTROL_VERSION,
          type: 'ready',
          failedExtensionIds: failedExtensionIds.data
        }
      : undefined
  }
  if (
    record.type === 'fatal' &&
    Object.keys(record).length === 4 &&
    typeof record.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(record.code)
  ) {
    return record as DeepSeekHarnessControlMessage
  }
  if (
    record.type === 'start' &&
    Object.keys(record).length === 4
  ) {
    const parsed = controlledHarnessHostConfigSchema.safeParse(
      record.config
    )
    return parsed.success
      ? {
          protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
          version: DEEPSEEK_HARNESS_CONTROL_VERSION,
          type: 'start',
          config: parsed.data
        }
      : undefined
  }
  return undefined
}
