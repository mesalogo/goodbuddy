import { z } from 'zod'
import type { WorkspaceAccess } from '../workspace'
import { LocalDirectModelProcessService } from './direct-model-process-service'

export const ripgrepInputSchema = z.object({
  args: z.array(z.string().refine((value) => !value.includes('\0'), 'Invalid argument')),
  cwd: z.string().min(1).refine((value) => !value.includes('\0'), 'Invalid directory').optional()
}).strict()
export type WorkspaceRipgrepInput = z.infer<typeof ripgrepInputSchema>

export async function searchWorkspaceWithRipgrep(
  executablePath: string,
  input: WorkspaceRipgrepInput,
  workspace: WorkspaceAccess,
  signal: AbortSignal,
  service: LocalDirectModelProcessService,
  conversationId: string
) {
  signal.throwIfAborted()
  let execution
  try {
    execution = await service.executeFile(
      executablePath, ['--no-config', '--color=never', '--line-number', ...input.args],
      { workspace, signal, conversationId }, input.cwd
    )
  } catch (error) {
    signal.throwIfAborted()
    // Spawn failures are installation/environment failures, not search errors.
    throw new Error('Unable to launch bundled ripgrep', { cause: error })
  }
  const { shell, ...result } = execution
  void shell
  signal.throwIfAborted()
  return result
}
