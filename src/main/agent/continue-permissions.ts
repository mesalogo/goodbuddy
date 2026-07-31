import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'

const permissionsSchema = z
  .object({
    allow: z.array(z.string().min(1).max(1_024)).max(512).optional(),
    ask: z.array(z.string().min(1).max(1_024)).max(512).optional(),
    exclude: z.array(z.string().min(1).max(1_024)).max(512).optional()
  })
  .strict()

type PermissionsConfig = z.infer<typeof permissionsSchema>

const primaryArgumentByTool: Record<string, string> = {
  Bash: 'command',
  MultiEdit: 'file_path',
  Fetch: 'url'
}

const updateQueues = new Map<string, Promise<void>>()

function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(
    `^${escaped.replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`,
    'u'
  ).test(value)
}

function askRuleMatchesAllow(askRule: string, allowRule: string): boolean {
  const allowMatch = allowRule.match(/^([^(]+)\((.*)\)$/u)
  if (!allowMatch) {
    return false
  }
  const toolName = allowMatch[1]
  const argument = allowMatch[2]
  if (!toolName || argument === undefined) {
    return false
  }
  if (askRule === '*' || matchesGlob(toolName, askRule)) {
    return true
  }
  const askMatch = askRule.match(/^([^(]+)\((.*)\)$/u)
  const askToolName = askMatch?.[1]
  const askArgument = askMatch?.[2]
  return Boolean(
    askToolName &&
      askArgument !== undefined &&
      matchesGlob(toolName, askToolName) &&
      matchesGlob(argument, askArgument)
  )
}

function sanitizePatternValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.length > 1_024 ||
    trimmed.includes(')') ||
    trimmed.includes('*') ||
    trimmed.includes('?') ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    return undefined
  }
  return trimmed
}

export function createContinuePermissionRule(
  toolName: string,
  toolArguments: Record<string, unknown>
): string {
  const normalizedName = toolName.trim()
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(normalizedName)) {
    throw new Error('Continue 工具名称无法安全写入权限规则')
  }
  const argumentName = primaryArgumentByTool[normalizedName]
  if (!argumentName) {
    throw new Error('该 Continue 工具无法生成足够窄化的永久权限规则')
  }
  const argument = sanitizePatternValue(toolArguments[argumentName])
  if (!argument) {
    throw new Error('Continue 工具参数无法安全写入永久权限规则')
  }
  return `${normalizedName}(${argument})`
}

export function getContinuePermissionsPath(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const continueHome =
    environment.CONTINUE_GLOBAL_DIR?.trim() ||
    join(homedir(), '.continue')
  return join(
    isAbsolute(continueHome) ? continueHome : resolve(continueHome),
    'permissions.yaml'
  )
}

async function loadPermissions(filePath: string): Promise<PermissionsConfig> {
  try {
    return permissionsSchema.parse(parse(await readFile(filePath, 'utf8')))
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {}
    }
    throw new Error('Continue permissions.yaml 无法安全解析', {
      cause: error
    })
  }
}

async function persistPermission(
  filePath: string,
  rule: string
): Promise<void> {
  const config = await loadPermissions(filePath)
  const existing = await lstat(filePath).catch(() => undefined)
  if (existing?.isSymbolicLink()) {
    throw new Error('拒绝通过符号链接更新 Continue 权限文件')
  }
  if ((config.ask ?? []).some((item) => askRuleMatchesAllow(item, rule))) {
    throw new Error(
      '现有 Continue ask 规则优先级高于永久允许，未修改权限文件'
    )
  }
  const allow = [...new Set([...(config.allow ?? []), rule])]
  const ask = (config.ask ?? []).filter((item) => item !== rule)
  const nextConfig: PermissionsConfig = {
    ...config,
    allow,
    ...(ask.length > 0 ? { ask } : { ask: [] })
  }
  const contents = [
    '# Continue CLI permissions managed by Continue and GoodBuddy.',
    stringify(nextConfig).trim(),
    ''
  ].join('\n')

  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.goodbuddy-${crypto.randomUUID()}.tmp`
  const backupPath = `${filePath}.goodbuddy.bak`
  try {
    await writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    try {
      await copyFile(filePath, backupPath)
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        throw error
      }
    }
    await rename(temporaryPath, filePath)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export function addContinuePermanentPermission(
  rule: string,
  filePath = getContinuePermissionsPath()
): Promise<void> {
  const previous = updateQueues.get(filePath) ?? Promise.resolve()
  const operation = previous.then(() => persistPermission(filePath, rule))
  const settled = operation.then(
    () => undefined,
    () => undefined
  )
  const queued = settled.finally(() => {
    if (updateQueues.get(filePath) === queued) {
      updateQueues.delete(filePath)
    }
  })
  updateQueues.set(filePath, queued)
  return operation
}
