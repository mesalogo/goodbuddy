import { randomUUID } from 'node:crypto'
import type { StagedSftp } from '../ssh/bounded-sftp'
import { isMissingPathError } from './path-errors'

const PRIVATE_FILE_MODE = 0o600

export const REMOTE_ENVIRONMENT_METADATA_PATHS = [
  '.goodbuddy/agent/release-keys.json',
  '.goodbuddy/agent/registry.json',
  '.goodbuddy/runtimes/release-keys.json',
  '.goodbuddy/runtimes/remote-runtime-lock.json',
  '.goodbuddy/runtimes/registry.json'
] as const

export type RemoteEnvironmentMetadataSnapshot = {
  path: (typeof REMOTE_ENVIRONMENT_METADATA_PATHS)[number]
  contents?: Buffer
  uid: number
}

export async function snapshotRemoteEnvironmentMetadata(
  sftp: StagedSftp,
  uid: number,
  signal: AbortSignal
): Promise<readonly RemoteEnvironmentMetadataSnapshot[]> {
  const snapshots: RemoteEnvironmentMetadataSnapshot[] = []
  for (const path of REMOTE_ENVIRONMENT_METADATA_PATHS) {
    signal.throwIfAborted()
    const metadata = await metadataIfPresent(sftp, path, signal)
    if (!metadata) {
      snapshots.push({ path, uid })
      continue
    }
    assertPrivateFile(metadata, path, uid)
    snapshots.push({
      path,
      contents: await sftp.readFile(path, signal),
      uid
    })
  }
  return snapshots
}

export async function restoreRemoteEnvironmentMetadata(
  sftp: StagedSftp,
  snapshots: readonly RemoteEnvironmentMetadataSnapshot[]
): Promise<void> {
  const errors: unknown[] = []
  for (const snapshot of snapshots) {
    try {
      await restoreRemoteEnvironmentMetadataFile(sftp, snapshot)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      '远程运行环境元数据回滚不完整'
    )
  }
}

async function restoreRemoteEnvironmentMetadataFile(
  sftp: StagedSftp,
  snapshot: RemoteEnvironmentMetadataSnapshot
): Promise<void> {
  const existing = await metadataIfPresent(sftp, snapshot.path)
  if (snapshot.contents === undefined) {
    if (existing) {
      assertPrivateFile(existing, snapshot.path, snapshot.uid)
      await sftp.unlink(snapshot.path)
    }
    return
  }

  if (existing) {
    assertPrivateFile(existing, snapshot.path, snapshot.uid)
    if (
      existing.size === snapshot.contents.byteLength &&
      (await sftp.readFile(snapshot.path)).equals(snapshot.contents)
    ) {
      return
    }
  }

  const temporary =
    `.goodbuddy/.environment-metadata-rollback-${randomUUID()}.tmp`
  try {
    await sftp.writeFile(temporary, snapshot.contents)
    await sftp.chmod(temporary, PRIVATE_FILE_MODE)
    await sftp.replaceFile(temporary, snapshot.path)
    const restored = await sftp.lstat(snapshot.path)
    assertPrivateFile(restored, snapshot.path, snapshot.uid)
    if (
      restored.size !== snapshot.contents.byteLength ||
      !(await sftp.readFile(snapshot.path)).equals(snapshot.contents)
    ) {
      throw new Error(
        `远程运行环境元数据 ${snapshot.path} 回滚校验失败`
      )
    }
  } catch (error) {
    await sftp.unlink(temporary).catch((cleanupError: unknown) => {
      if (!isMissingPathError(cleanupError)) {
        throw cleanupError
      }
    })
    throw error
  }
}

async function metadataIfPresent(
  sftp: StagedSftp,
  path: string,
  signal?: AbortSignal
) {
  try {
    return await sftp.lstat(path, signal)
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

function assertPrivateFile(
  metadata: Awaited<ReturnType<StagedSftp['lstat']>>,
  path: string,
  uid: number
): void {
  if (
    metadata.type !== 'file' ||
    metadata.uid !== uid ||
    metadata.mode !== PRIVATE_FILE_MODE
  ) {
    throw new Error(
      `远程运行环境元数据 ${path} 的类型、所有者或权限无效`
    )
  }
}
