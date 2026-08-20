import { z } from 'zod'

const sha256Pattern = /^[a-f0-9]{64}$/u
const immutableRevisionPattern = /^[a-f0-9]{40,64}$/u
const hostNamePattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/u

export const modelDownloadSourceSchema = z.enum([
  'modelscope',
  'hugging-face'
])

export type ModelDownloadSource = z.infer<
  typeof modelDownloadSourceSchema
>

export const MODEL_DOWNLOAD_SOURCES = modelDownloadSourceSchema.options
export const MODEL_DOWNLOAD_REDIRECT_HOSTS = {
  modelscope: ['cdn-lfs-cn-1.modelscope.cn'],
  'hugging-face': [
    'cdn-lfs.hf.co',
    'cdn-lfs-us-1.hf.co',
    'cdn-lfs-eu-1.hf.co',
    'cas-bridge.xethub.hf.co'
  ]
} as const satisfies Record<
  ModelDownloadSource,
  readonly string[]
>

function isSourceHost(
  source: ModelDownloadSource,
  hostname: string
): boolean {
  return source === 'modelscope'
    ? hostname === 'modelscope.cn' || hostname === 'www.modelscope.cn'
    : hostname === 'huggingface.co'
}

export const modelArtifactFingerprintSchema = z
  .object({
    size: z.number().int().positive().safe(),
    sha256: z.string().regex(sha256Pattern)
  })
  .strict()

export const modelArtifactTargetSchema = z
  .object({
    size: modelArtifactFingerprintSchema.shape.size.optional(),
    sha256: modelArtifactFingerprintSchema.shape.sha256.optional(),
    url: z.url().max(2_048),
    repositoryUrl: z.url().max(2_048),
    revision: z.string().regex(immutableRevisionPattern),
    redirectHosts: z
      .array(z.string().max(253).regex(hostNamePattern))
      .max(16)
      .default([])
  })
  .strict()
  .superRefine((target, context) => {
    if ((target.size === undefined) !== (target.sha256 === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['size'],
        message: '来源专用模型工件必须同时声明大小和 SHA-256'
      })
    }
    for (const [key, value] of [
      ['url', target.url],
      ['repositoryUrl', target.repositoryUrl]
    ] as const) {
      const parsed = new URL(value)
      if (
        parsed.protocol !== 'https:' ||
        (parsed.port !== '' && parsed.port !== '443') ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message:
            '模型地址必须是使用标准端口、无凭据和 Fragment 的 HTTPS URL'
        })
      }
    }
    const encodedRevision = encodeURIComponent(target.revision)
    const downloadUrl = new URL(target.url)
    const repositoryUrl = new URL(target.repositoryUrl)
    const repositoryPath = repositoryUrl.pathname.replace(/\/+$/u, '')
    if (
      downloadUrl.origin !== repositoryUrl.origin ||
      !downloadUrl.pathname.startsWith(
        `${repositoryPath}/resolve/${encodedRevision}/`
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: '模型下载地址必须属于声明仓库并包含固定 Revision'
      })
    }
  })

export const modelArtifactTargetsSchema = z
  .object({
    modelscope: modelArtifactTargetSchema.optional(),
    'hugging-face': modelArtifactTargetSchema.optional()
  })
  .strict()
  .superRefine((targets, context) => {
    for (const source of MODEL_DOWNLOAD_SOURCES) {
      const target = targets[source]
      if (!target) {
        continue
      }
      const downloadHost = new URL(target.url).hostname
      const repositoryHost = new URL(target.repositoryUrl).hostname
      if (
        !isSourceHost(source, downloadHost) ||
        !isSourceHost(source, repositoryHost)
      ) {
        context.addIssue({
          code: 'custom',
          path: [source],
          message: '模型地址与声明的下载源不匹配'
        })
      }
      const allowedRedirectHosts: ReadonlySet<string> = new Set(
        MODEL_DOWNLOAD_REDIRECT_HOSTS[source]
      )
      target.redirectHosts.forEach((hostname, index) => {
        if (!allowedRedirectHosts.has(hostname)) {
          context.addIssue({
            code: 'custom',
            path: [source, 'redirectHosts', index],
            message: '模型重定向主机不属于声明的下载源'
          })
        }
      })
    }
  })

export const modelDownloadAvailabilitySchema = z
  .object({
    source: modelDownloadSourceSchema,
    available: z.boolean(),
    totalBytes: z.number().int().positive().safe().optional(),
    unavailableReason: z.string().trim().min(1).max(500).optional()
  })
  .strict()
  .superRefine((availability, context) => {
    if (availability.available && availability.totalBytes === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['totalBytes'],
        message: '可下载模型必须提供总大小'
      })
    }
    if (
      !availability.available &&
      availability.unavailableReason === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['unavailableReason'],
        message: '不可下载模型必须说明原因'
      })
    }
  })

export type ModelArtifactTarget = z.infer<
  typeof modelArtifactTargetSchema
>
export type ModelArtifactFingerprint = z.infer<
  typeof modelArtifactFingerprintSchema
>
export type ModelArtifactTargets = z.infer<
  typeof modelArtifactTargetsSchema
>
export type ModelDownloadAvailability = z.infer<
  typeof modelDownloadAvailabilitySchema
>

export type ResolvableModelArtifactFile<Role extends string = string> = {
  name: string
  role: Role
  size: number
  sha256: string
  targets: ModelArtifactTargets
}

export type ResolvedModelArtifactFile<Role extends string = string> = {
  name: string
  role: Role
  size: number
  sha256: string
  target: ModelArtifactTarget
}

export type ResolvedModelPackage<Role extends string = string> = {
  source: ModelDownloadSource
  totalBytes: number
  files: ResolvedModelArtifactFile<Role>[]
}

export type ModelPackageFingerprintFile<
  Role extends string = string
> = {
  name: string
  role: Role
  size: number
  sha256: string
}

export type ModelPackageFingerprint<
  Role extends string = string
> = {
  totalBytes: number
  files: ModelPackageFingerprintFile<Role>[]
}

function totalModelBytes(
  files: readonly { size: number }[]
): number {
  const totalBytes = files.reduce(
    (total, file) => total + file.size,
    0
  )
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new RangeError('模型总大小超出安全范围')
  }
  return totalBytes
}

export function getModelDownloadAvailability(
  files: readonly ResolvableModelArtifactFile[],
  source: ModelDownloadSource
): ModelDownloadAvailability {
  const available =
    files.length > 0 && files.every((file) => file.targets[source])
  if (!available) {
    return modelDownloadAvailabilitySchema.parse({
      source,
      available: false,
      unavailableReason: '当前下载源暂不提供此模型的完整已验证文件'
    })
  }
  return modelDownloadAvailabilitySchema.parse({
    source,
    available: true,
    totalBytes: totalModelBytes(
      files.map((file) => ({
        size: file.targets[source]!.size ?? file.size
      }))
    )
  })
}

export function resolveModelDownloadPackage<Role extends string>(
  files: readonly ResolvableModelArtifactFile<Role>[],
  source: ModelDownloadSource
): ResolvedModelPackage<Role> {
  const availability = getModelDownloadAvailability(files, source)
  if (!availability.available || availability.totalBytes === undefined) {
    throw new Error(
      availability.unavailableReason ??
        '当前下载源暂不提供此模型的完整已验证文件'
    )
  }
  return {
    source,
    totalBytes: availability.totalBytes,
    files: files.map((file) => {
      const target = file.targets[source]
      if (!target) {
        throw new Error('模型下载元数据不完整')
      }
      return {
        name: file.name,
        role: file.role,
        size: target.size ?? file.size,
        sha256: target.sha256 ?? file.sha256,
        target
      }
    })
  }
}

export function getModelPackageFingerprints<Role extends string>(
  files: readonly ResolvableModelArtifactFile<Role>[]
): ModelPackageFingerprint<Role>[] {
  const candidates: ModelPackageFingerprint<Role>[] = [
    {
      totalBytes: totalModelBytes(files),
      files: files.map((file) => ({
        name: file.name,
        role: file.role,
        size: file.size,
        sha256: file.sha256
      }))
    }
  ]
  for (const source of MODEL_DOWNLOAD_SOURCES) {
    if (!files.every((file) => file.targets[source])) {
      continue
    }
    const resolved = resolveModelDownloadPackage(files, source)
    candidates.push({
      totalBytes: resolved.totalBytes,
      files: resolved.files.map((file) => ({
        name: file.name,
        role: file.role,
        size: file.size,
        sha256: file.sha256
      }))
    })
  }
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate.files)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export function modelPackageFingerprintMatches<
  Role extends string
>(
  expected: ModelPackageFingerprint<Role>,
  actual: readonly ModelPackageFingerprintFile[]
): boolean {
  return (
    actual.length === expected.files.length &&
    expected.files.every((file) =>
      actual.some(
        (candidate) =>
          candidate.name === file.name &&
          candidate.role === file.role &&
          candidate.size === file.size &&
          candidate.sha256 === file.sha256
      )
    )
  )
}

export function getMaximumModelPackageBytes(
  files: readonly ResolvableModelArtifactFile[]
): number {
  return Math.max(
    ...getModelPackageFingerprints(files).map(
      (fingerprint) => fingerprint.totalBytes
    )
  )
}

export const modelArtifactIdentitySchema = z
  .object({
    size: modelArtifactFingerprintSchema.shape.size,
    sha256: modelArtifactFingerprintSchema.shape.sha256,
    targets: modelArtifactTargetsSchema
  })
  .strict()
