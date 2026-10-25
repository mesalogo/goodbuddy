import { officeCapabilitiesSchema, officeOriginSchema, type OfficeCapabilities } from '../shared/office-contracts'

export async function readOfficeCapabilities(serverUrl: string): Promise<OfficeCapabilities> {
  const origin = new URL(officeOriginSchema.parse(serverUrl)).origin
  let response: Response
  try {
    response = await fetch(`${origin}/api/v1/office/config`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  } catch (cause) {
    throw new Error(`无法连接 ShareServer ${origin}，请检查主机地址、端口和网络`, { cause })
  }
  if (response.status === 404) throw new Error('此 ShareServer 未提供 Office 能力，请检查服务地址或联系管理员启用 Office')
  if (!response.ok) throw new Error(`检查 ShareServer Office 能力失败（HTTP ${response.status}）`)
  let value: unknown
  try { value = await response.json() }
  catch (cause) { throw new Error('此地址未返回 Office 配置，请填写 ShareServer Web 服务地址', { cause }) }
  const parsed = officeCapabilitiesSchema.safeParse(value)
  if (!parsed.success) throw new Error('此地址未返回有效的 ShareServer Office 配置，请填写 Web 服务地址')
  return parsed.data
}

export function requireOfficeEditing(config: OfficeCapabilities, name?: string): void {
  if (!config.enabled) throw new Error('此 ShareServer 尚未启用 Office 在线编辑，请联系管理员启用或更换服务器')
  if (!config.versionedDownload) throw new Error('请更新 ShareServer Office 服务（需要版本下载接口）')
  if (name && !config.formats.includes(name.split('.').pop()!.toLowerCase())) {
    throw new Error(`此 ShareServer 不支持编辑该文件；支持格式：${config.formats.join('、')}`)
  }
}
