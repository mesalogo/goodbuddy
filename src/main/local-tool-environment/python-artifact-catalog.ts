import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const platformSchema = z.enum(['win32', 'darwin', 'linux'])
const archSchema = z.enum(['x64', 'arm64'])
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const httpsUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    context.addIssue({ code: 'custom', message: 'must be a plain HTTPS URL' })
  }
})

const pinnedArtifacts: Record<string, {
  fileName: string
  size: number
  sha256: string
}> = {
  'win32/x64': {
    fileName: 'python.3.13.15.nupkg',
    size: 14391248,
    sha256: '05357887df50d3153efc681bdf432c321d3e2f9ce5788f99f4515b27e8fda0ac'
  },
  'win32/arm64': {
    fileName: 'pythonarm64.3.13.15.nupkg',
    size: 13762836,
    sha256: '3c1b1fdf56adc14634165df922d447520aefdc4a8411a34c34d8a062a4edf494'
  },
  'darwin/x64': {
    fileName: 'cpython-3.13.15+20260825-x86_64-apple-darwin-install_only_stripped.tar.gz',
    size: 24921256,
    sha256: 'd33d61f7f4982c94216e14a43599c75657b7d0839277fc72bc6dbac53e8229bc'
  },
  'darwin/arm64': {
    fileName: 'cpython-3.13.15+20260825-aarch64-apple-darwin-install_only_stripped.tar.gz',
    size: 25140257,
    sha256: '149038dd0c194c25d4616d7e42a35f67f2edee96412788f74115819b6a4c8548'
  },
  'linux/x64': {
    fileName: 'cpython-3.13.15+20260825-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
    size: 34813635,
    sha256: '8af9a8214c71b2dd698005e39fab87aad02a994330508857da4e6d1ba7e6ddb6'
  },
  'linux/arm64': {
    fileName: 'cpython-3.13.15+20260825-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz',
    size: 29222461,
    sha256: 'e5d0df1a6070a8614d808496e5ea28c727480e40ffcce1a94697a067f1690aa8'
  }
}

const artifactSchema = z.object({
  platform: platformSchema,
  arch: archSchema,
  archiveFormat: z.enum(['nuget-zip', 'tar.gz']),
  payloadRoot: z.enum(['tools', 'python']),
  fileName: z.string().min(1).max(255).regex(/^[^/\\\0]+$/u),
  size: z.number().int().positive().safe(),
  sha256: sha256Schema,
  nativeUrl: httpsUrlSchema,
  ossUrl: httpsUrlSchema
}).strict().superRefine((artifact, context) => {
  const windows = artifact.platform === 'win32'
  const key = `${artifact.platform}/${artifact.arch}`
  const pinned = pinnedArtifacts[key]
  if (
    !pinned ||
    artifact.fileName !== pinned.fileName ||
    artifact.size !== pinned.size ||
    artifact.sha256 !== pinned.sha256
  ) {
    context.addIssue({
      code: 'custom',
      message: `artifact does not match the CPython 3.13.15 pin for ${key}`
    })
  }
  if (
    (windows && (
      artifact.archiveFormat !== 'nuget-zip' ||
      artifact.payloadRoot !== 'tools' ||
      !artifact.fileName.endsWith('.nupkg')
    )) ||
    (!windows && (
      artifact.archiveFormat !== 'tar.gz' ||
      artifact.payloadRoot !== 'python' ||
      !artifact.fileName.endsWith('.tar.gz')
    ))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'archive format does not match the platform'
    })
  }
  const expectedOssPath =
    `/tool-artifacts/python/3.13.15/${artifact.sha256}/` +
    encodeURIComponent(artifact.fileName).replaceAll('%2F', '/')
  const oss = new URL(artifact.ossUrl)
  if (
    oss.hostname !== 'goodbuddy.oss-cn-beijing.aliyuncs.com' ||
    oss.pathname !== expectedOssPath
  ) {
    context.addIssue({ code: 'custom', message: 'OSS key is not immutable' })
  }
  const expectedNativeUrl = windows
    ? `https://api.nuget.org/v3-flatcontainer/${
      artifact.arch === 'x64' ? 'python' : 'pythonarm64'
    }/3.13.15/${artifact.fileName}`
    : 'https://github.com/astral-sh/python-build-standalone/releases/' +
      `download/20260825/${encodeURIComponent(artifact.fileName)}`
  if (artifact.nativeUrl !== expectedNativeUrl) {
    context.addIssue({
      code: 'custom',
      message: 'native URL does not match the pinned upstream release'
    })
  }
})

const catalogSchema = z.object({
  formatVersion: z.literal(1),
  pythonVersion: z.literal('3.13.15'),
  artifacts: z.array(artifactSchema).length(6)
}).strict().superRefine((catalog, context) => {
  const expected = new Set([
    'win32/x64', 'win32/arm64',
    'darwin/x64', 'darwin/arm64',
    'linux/x64', 'linux/arm64'
  ])
  for (const artifact of catalog.artifacts) {
    const key = `${artifact.platform}/${artifact.arch}`
    if (!expected.delete(key)) {
      context.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: `duplicate or unsupported target: ${key}`
      })
    }
  }
  if (expected.size > 0) {
    context.addIssue({
      code: 'custom',
      path: ['artifacts'],
      message: `missing targets: ${[...expected].join(', ')}`
    })
  }
})

export type PythonArtifactSource = 'native' | 'oss'
export type PythonArtifactPlatform = z.infer<typeof platformSchema>
export type PythonArtifactArch = z.infer<typeof archSchema>
export type PythonArtifactCatalog = z.infer<typeof catalogSchema>
export type PythonArtifact = z.infer<typeof artifactSchema> & {
  source: PythonArtifactSource
  url: string
  redirectHosts: readonly string[]
}

export function parsePythonArtifactCatalog(value: unknown): PythonArtifactCatalog {
  return catalogSchema.parse(value)
}

export async function loadPythonArtifactCatalog(
  catalogPath: string
): Promise<PythonArtifactCatalog> {
  const text = await readFile(catalogPath, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('Managed Python artifact catalog is not valid JSON', {
      cause: error
    })
  }
  return parsePythonArtifactCatalog(value)
}

export function selectPythonArtifact(options: {
  catalog: PythonArtifactCatalog
  platform: PythonArtifactPlatform
  arch: PythonArtifactArch
  source: PythonArtifactSource
}): PythonArtifact {
  const artifact = options.catalog.artifacts.find(
    (candidate) =>
      candidate.platform === options.platform &&
      candidate.arch === options.arch
  )
  if (!artifact) {
    throw new Error(`Managed Python is unavailable for ${options.platform}/${options.arch}`)
  }
  const url = options.source === 'native'
    ? artifact.nativeUrl
    : artifact.ossUrl
  const host = new URL(url).hostname
  const redirectHosts =
    options.source === 'oss'
      ? [host]
      : artifact.platform === 'win32'
        ? [host, 'globalcdn.nuget.org']
        : [host, 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
  return { ...artifact, source: options.source, url, redirectHosts }
}
