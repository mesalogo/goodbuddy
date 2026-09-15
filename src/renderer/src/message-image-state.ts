import type { Message } from './ChatTimeline'

function sameItems<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  return left === right || (
    (left?.length ?? 0) === (right?.length ?? 0) &&
    (left ?? []).every((item, index) => item === right?.[index])
  )
}

/** Preserve message identity when reconciling unchanged, Main-owned image state. */
export function mergeMessageImageState(
  base: Message,
  persisted: Message,
  local: Message | undefined
): Message {
  if (!persisted.imageOperations?.length && !local?.imageOperations?.length &&
    !persisted.imageSourceArtifactIds?.length && !local?.imageSourceArtifactIds?.length &&
    !persisted.artifactIds?.length && !local?.artifactIds?.length) return base

  const operations = new Map(persisted.imageOperations?.map(operation => [operation.id, operation]))
  for (const operation of local?.imageOperations ?? []) {
    if (operation.updatedAt > (operations.get(operation.id)?.updatedAt ?? -1)) {
      operations.set(operation.id, operation)
    }
  }
  const imageOperations = [...operations.values()]
  const imageSourceArtifactIds = persisted.imageSourceArtifactIds ?? local?.imageSourceArtifactIds
  const artifactIds = [...new Set([
    ...(base === local ? local?.artifactIds ?? [] : []),
    ...(persisted.artifactIds ?? []),
    ...imageOperations.flatMap(operation => operation.artifactIds)
  ])].slice(-8)
  if (sameItems(base.imageOperations, imageOperations) &&
    sameItems(base.imageSourceArtifactIds, imageSourceArtifactIds) &&
    sameItems(base.artifactIds, artifactIds)) return base

  return {
    ...base,
    imageOperations: imageOperations.length ? imageOperations : undefined,
    imageSourceArtifactIds,
    artifactIds: artifactIds.length ? artifactIds : undefined
  }
}
