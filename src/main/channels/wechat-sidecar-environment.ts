const wechatSidecarEnvironmentNames = [
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE'
] as const

export function buildWechatSidecarEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_TLS_REJECT_UNAUTHORIZED: '1'
  }
  for (const name of wechatSidecarEnvironmentNames) {
    if (source[name] !== undefined) {
      environment[name] = source[name]
    }
  }
  return environment
}
