import type {
  ComputerControlApprovalRequest,
  ComputerControlApprovalResult
} from '../../shared/computer-control-contracts'

export const COMPUTER_CONTROL_APPROVAL_DEADLINE_MS = 120_000

export interface ComputerControlApprovalProvider {
  request(
    request: ComputerControlApprovalRequest,
    signal: AbortSignal
  ): Promise<ComputerControlApprovalResult>
}
