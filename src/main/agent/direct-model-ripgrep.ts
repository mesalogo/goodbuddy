import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { WorkspaceAccess } from '../workspace'
import { LocalDirectModelProcessService } from './direct-model-process-service'

export const ripgrepInputSchema = z.object({
  args: z.array(z.string().refine((value) => !value.includes('\0'), 'Invalid argument')),
  cwd: z.string().min(1).refine((value) => !value.includes('\0'), 'Invalid directory').optional()
}).strict()
export type WorkspaceRipgrepInput = z.infer<typeof ripgrepInputSchema>

// Only Ask needs argument inspection: these options consume the next argument.
const valueOptions = new Set([
  'after-context', 'before-context', 'context', 'context-separator', 'colors', 'color',
  'dfa-size-limit', 'encoding', 'engine', 'field-context-separator', 'field-match-separator',
  'glob', 'iglob', 'max-count', 'max-columns', 'max-depth', 'max-filesize',
  'path-separator', 'regex-size-limit', 'replace', 'sort', 'sortr', 'threads',
  'type', 'type-not', 'type-add', 'type-clear', 'regexp', 'file', 'ignore-file',
  'hyperlink-format', 'pre-glob'
])
const shortValueOptions = new Set('ABCEefgMmrjtT'.split(''))

async function checkAskArguments(input: WorkspaceRipgrepInput, workspace: WorkspaceAccess, signal: AbortSignal): Promise<void> {
  const identity = await workspace.getIdentity()
  const root = identity.canonicalDisplayPath
  const cwd = resolve(root, input.cwd ?? '.')
  const paths: string[] = [cwd]
  const positional: string[] = []
  let hasPattern = false
  let filesOnly = false
  let literal = false
  for (let i = 0; i < input.args.length; i++) {
    const arg = input.args[i]!
    if (literal || !arg.startsWith('-') || arg === '-') {
      positional.push(arg)
      continue
    }
    if (arg === '--') { literal = true; continue }
    if (arg.startsWith('--')) {
      const [name, ...inline] = arg.slice(2).split('=')
      if (['pre', 'hostname-bin', 'follow', 'search-zip'].includes(name!)) {
        throw new Error(`Ask mode does not allow --${name}; use Execute mode.`)
      }
      if (name === 'files') filesOnly = true
      if (name === 'regexp' || name === 'file') hasPattern = true
      if (valueOptions.has(name!)) {
        const value = inline.length ? inline.join('=') : input.args[++i]
        if (value !== undefined && (name === 'file' || name === 'ignore-file')) paths.push(resolve(cwd, value))
      }
    } else {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!
        if (flag === 'L' || flag === 'z') throw new Error(`Ask mode does not allow -${flag}; use Execute mode.`)
        if (flag === 'e' || flag === 'f') hasPattern = true
        if (shortValueOptions.has(flag)) {
          const value = arg.slice(j + 1) || input.args[++i]
          if (flag === 'f' && value !== undefined) paths.push(resolve(cwd, value))
          break
        }
      }
    }
  }
  if (!hasPattern && !filesOnly) positional.shift()
  paths.push(...positional.filter((path) => path !== '-').map((path) => resolve(cwd, path)))
  for (const path of paths) {
    const local = relative(root, path)
    if (isAbsolute(local) || local.split(/[\\/]/u).includes('..')) throw new Error('文件路径不能超出项目工作区')
    if (local) {
      try {
        await workspace.stat({ path: local, signal })
      } catch (error) {
        signal.throwIfAborted()
        // Let rg report missing search targets with its native exit code and stderr.
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
  }
}

export async function searchWorkspaceWithRipgrep(
  executablePath: string,
  input: WorkspaceRipgrepInput,
  workspace: WorkspaceAccess,
  signal: AbortSignal,
  service: LocalDirectModelProcessService,
  conversationId: string,
  workMode: 'ask' | 'execute'
) {
  signal.throwIfAborted()
  if (workMode === 'ask') await checkAskArguments(input, workspace, signal)
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
