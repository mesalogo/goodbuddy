import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  isMissingFileError,
  writeJsonFileAtomically
} from '../settings-file-utils'

const MAXIMUM_RECORD_BYTES = 8 * 1024 * 1024
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

type PendingRemoteEnvironmentOperationBase = {
  hostId: string
  targetIdentity: string
  operationId: string
  size: number
  sha256: string
  urls: readonly string[]
}

export type PersistedRemoteEnvironmentMetadataSnapshot = {
  path:
    | '.goodbuddy/agent/release-keys.json'
    | '.goodbuddy/agent/registry.json'
    | '.goodbuddy/runtimes/release-keys.json'
    | '.goodbuddy/runtimes/remote-runtime-lock.json'
    | '.goodbuddy/runtimes/registry.json'
  contentsBase64?: string
  uid: number
}

export type PendingRemoteEnvironmentOperation =
  PendingRemoteEnvironmentOperationBase &
    (
      | { version: 1 }
      | {
          version: 2
          metadataSnapshots:
            readonly PersistedRemoteEnvironmentMetadataSnapshot[]
        }
    )

export class RemoteEnvironmentOperationStore {
  readonly #directory: string

  constructor(userDataPath: string) {
    this.#directory = resolve(
      userDataPath,
      'remote-components',
      'pending-environment-operations'
    )
  }

  async load(
    hostId: string
  ): Promise<PendingRemoteEnvironmentOperation | undefined> {
    const path = this.#path(hostId)
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined
      }
      throw error
    }
    if (bytes.byteLength > MAXIMUM_RECORD_BYTES) {
      throw new Error('远程环境恢复记录超过大小限制')
    }
    let value: unknown
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      )
    } catch (error) {
      throw new Error('远程环境恢复记录无效', {
        cause: error
      })
    }
    return parsePendingOperation(value, hostId)
  }

  save(operation: PendingRemoteEnvironmentOperation): Promise<void> {
    return writeJsonFileAtomically(
      this.#path(operation.hostId),
      parsePendingOperation(operation, operation.hostId)
    )
  }

  remove(hostId: string): Promise<void> {
    return rm(this.#path(hostId), { force: true })
  }

  #path(hostId: string): string {
    if (
      !hostId ||
      hostId.length > 512 ||
      /[\p{Cc}\p{Cs}\u2028\u2029\ufffd]/u.test(hostId)
    ) {
      throw new Error('远程环境恢复 Host ID 无效')
    }
    const name = createHash('sha256')
      .update(hostId)
      .digest('hex')
    return join(this.#directory, `${name}.json`)
  }
}

function parsePendingOperation(
  value: unknown,
  expectedHostId: string
): PendingRemoteEnvironmentOperation {
  if (typeof value !== 'object' || value === null) {
    throw new Error('远程环境恢复记录无效')
  }
  const record = value as Record<string, unknown>
  const version = record.version
  const expectedKeys = version === 2
    ? [
        'hostId',
        'metadataSnapshots',
        'operationId',
        'sha256',
        'size',
        'targetIdentity',
        'urls',
        'version'
      ]
    : [
        'hostId',
        'operationId',
        'sha256',
        'size',
        'targetIdentity',
        'urls',
        'version'
      ]
  if (
    Object.keys(value).sort().join('\0') !==
      expectedKeys.sort().join('\0')
  ) {
    throw new Error('远程环境恢复记录无效')
  }
  if (
    (version !== 1 && version !== 2) ||
    record.hostId !== expectedHostId ||
    typeof record.targetIdentity !== 'string' ||
    !SHA256_PATTERN.test(record.targetIdentity) ||
    typeof record.operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(record.operationId) ||
    !Number.isSafeInteger(record.size) ||
    Number(record.size) <= 0 ||
    typeof record.sha256 !== 'string' ||
    !SHA256_PATTERN.test(record.sha256) ||
    !Array.isArray(record.urls) ||
    record.urls.length > 4 ||
    record.urls.some(
      (url) =>
        typeof url !== 'string' ||
        Buffer.byteLength(url, 'utf8') > 4_096
    )
  ) {
    throw new Error('远程环境恢复记录无效')
  }
  const base: PendingRemoteEnvironmentOperationBase = {
    hostId: expectedHostId,
    targetIdentity: record.targetIdentity,
    operationId: record.operationId,
    size: Number(record.size),
    sha256: record.sha256,
    urls: [...record.urls] as string[]
  }
  if (version === 1) {
    return { version: 1, ...base }
  }
  return {
    version: 2,
    ...base,
    metadataSnapshots: parseMetadataSnapshots(
      record.metadataSnapshots
    )
  }
}

const metadataPaths =
  new Set<PersistedRemoteEnvironmentMetadataSnapshot['path']>([
    '.goodbuddy/agent/release-keys.json',
    '.goodbuddy/agent/registry.json',
    '.goodbuddy/runtimes/release-keys.json',
    '.goodbuddy/runtimes/remote-runtime-lock.json',
    '.goodbuddy/runtimes/registry.json'
  ])

function parseMetadataSnapshots(
  value: unknown
): readonly PersistedRemoteEnvironmentMetadataSnapshot[] {
  if (!Array.isArray(value) || value.length !== metadataPaths.size) {
    throw new Error('远程环境恢复记录无效')
  }
  const paths = new Set<string>()
  let totalBytes = 0
  const snapshots = value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !(
        Object.keys(item).sort().join('\0') ===
          ['path', 'uid'].sort().join('\0') ||
        Object.keys(item).sort().join('\0') ===
          ['contentsBase64', 'path', 'uid'].sort().join('\0')
      )
    ) {
      throw new Error('远程环境恢复记录无效')
    }
    const snapshot = item as Record<string, unknown>
    if (
      typeof snapshot.path !== 'string' ||
      !metadataPaths.has(
        snapshot.path as PersistedRemoteEnvironmentMetadataSnapshot['path']
      ) ||
      paths.has(snapshot.path) ||
      !Number.isSafeInteger(snapshot.uid) ||
      Number(snapshot.uid) < 0
    ) {
      throw new Error('远程环境恢复记录无效')
    }
    paths.add(snapshot.path)
    if (snapshot.contentsBase64 === undefined) {
      return {
        path:
          snapshot.path as PersistedRemoteEnvironmentMetadataSnapshot['path'],
        uid: Number(snapshot.uid)
      }
    }
    if (
      typeof snapshot.contentsBase64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(snapshot.contentsBase64)
    ) {
      throw new Error('远程环境恢复记录无效')
    }
    const contents = Buffer.from(
      snapshot.contentsBase64,
      'base64'
    )
    if (
      contents.toString('base64') !==
        snapshot.contentsBase64 ||
      contents.byteLength > 1024 * 1024
    ) {
      throw new Error('远程环境恢复记录无效')
    }
    totalBytes += contents.byteLength
    return {
      path:
        snapshot.path as PersistedRemoteEnvironmentMetadataSnapshot['path'],
      contentsBase64: snapshot.contentsBase64,
      uid: Number(snapshot.uid)
    }
  })
  if (
    paths.size !== metadataPaths.size ||
    [...metadataPaths].some((path) => !paths.has(path)) ||
    totalBytes > 5 * 1024 * 1024
  ) {
    throw new Error('远程环境恢复记录无效')
  }
  return snapshots
}
