import type { WorkMode } from '../../shared/assistant-contracts'
import {
  agentRuntimeSelectionKey,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'
import type { SshExecutionSpaceDescriptor } from './execution-space-resolver'

/**
 * Prevents a request from reusing persisted remote Runtime evidence under a
 * different Runtime selection, work mode, or Agent install.
 */
export function assertRemoteRuntimeRequestValidated(
  executionSpace: SshExecutionSpaceDescriptor,
  selection: AgentRuntimeSelection,
  workMode: WorkMode
): void {
  const executionValidation = executionSpace.validation
  const runtimeValidation = executionSpace.runtimeValidation
  if (
    !executionValidation ||
    !runtimeValidation ||
    executionValidation.agentInstallationIdAtValidation !==
      runtimeValidation.agentInstallationIdAtValidation
  ) {
    throw new Error('远程 Project 缺少完整的当前验证，请重新验证')
  }
  if (
    runtimeValidation.runtimeSelectionKey !==
    agentRuntimeSelectionKey(selection)
  ) {
    throw new Error('远程 Project 的 Runtime 选择已变化，请重新验证')
  }
  if (runtimeValidation.workMode !== workMode) {
    throw new Error(
      `远程 Project 仅验证了 ${runtimeValidation.workMode === 'ask' ? 'Ask' : 'Execute'} 模式，请先重新验证工作模式`
    )
  }
}
