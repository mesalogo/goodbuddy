import type { SshExecutionSpaceDescriptor } from './execution-space-resolver'

/**
 * Prevents a request from combining persisted remote Runtime evidence with a
 * different Agent installation. Runtime provider, model profile, and Ask /
 * Execute behavior are validated by the live Runtime path for each request.
 */
export function assertRemoteRuntimeRequestValidated(
  executionSpace: SshExecutionSpaceDescriptor
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
}
