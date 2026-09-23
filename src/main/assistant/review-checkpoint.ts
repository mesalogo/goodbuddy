import type { SupervisionEvidence, SupervisionRunRequest } from '../../shared/supervision-contracts'

export type ReviewCheckpoint = { source: string; revision: string; offset: number; length: number }
export type ReviewBatch = { stage: 'heartbeat' | 'supervisor'; scope: string; checkpoints: ReviewCheckpoint[]; evidence: SupervisionEvidence[] }

export function reviewScope(scope: SupervisionRunRequest['scope']): string {
  return JSON.stringify(scope.kind === 'global' ? scope : {
    kind: scope.kind, projectIds: [...new Set(scope.projectIds)].sort()
  })
}
