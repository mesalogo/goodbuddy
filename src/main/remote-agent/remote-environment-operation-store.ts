import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  isMissingFileError,
  writeJsonFileAtomically
} from '../settings-file-utils'

const MAXIMUM_RECORD_BYTES = 64 * 1024
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export type PendingRemoteEnvironmentOperation = {
  version: 1
  hostId: string
  targetIdentity: string
  operationId: string
  size: number
  sha256: string
  urls: readonly string[]
}

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
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).sort().join('\0') !==
      [
        'hostId',
        'operationId',
        'sha256',
        'size',
        'targetIdentity',
        'urls',
        'version'
      ].sort().join('\0')
  ) {
    throw new Error('远程环境恢复记录无效')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
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
  return {
    version: 1,
    hostId: expectedHostId,
    targetIdentity: record.targetIdentity,
    operationId: record.operationId,
    size: Number(record.size),
    sha256: record.sha256,
    urls: [...record.urls] as string[]
  }
}
