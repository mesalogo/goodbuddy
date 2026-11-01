import {
  systemOneEndpoint,
  systemOneRequestSchema,
  systemOneResponseSchema,
  type SystemOneRequest,
  type SystemOneResponse
} from '../../shared/system-one-contracts'
import type { ResolvedModelProfile } from '../runtime-settings-store'

export class SystemOneRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SystemOneRequestError'
  }
}

export type SystemOneFetcher = typeof fetch

export async function requestSystemOne(
  profile: ResolvedModelProfile,
  request: SystemOneRequest,
  signal: AbortSignal,
  fetcher: SystemOneFetcher = fetch
): Promise<SystemOneResponse> {
  if (profile.protocol !== 'system-one') {
    throw new SystemOneRequestError('所选模型连接不是 System One 协议')
  }
  const parsedRequest = systemOneRequestSchema.safeParse({
    ...request,
    model: profile.modelName
  })
  if (!parsedRequest.success) {
    throw new SystemOneRequestError('System One 请求格式无效')
  }
  const headers = new Headers({
    'content-type': 'application/json',
    ...(profile.requestHeaders ?? {})
  })
  if (profile.authentication === 'api-key') {
    if (!profile.apiKey) {
      throw new SystemOneRequestError('System One API Key 未配置')
    }
    headers.set('authorization', `Bearer ${profile.apiKey}`)
  }
  let response: Response
  try {
    response = await fetcher(systemOneEndpoint(profile.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(parsedRequest.data),
      signal
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new SystemOneRequestError('System One 请求失败', undefined, { cause: error })
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new SystemOneRequestError('System One 返回了无效 JSON', response.status, { cause: error })
  }
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null && 'error' in body
      ? String(body.error)
      : `HTTP ${response.status}`
    throw new SystemOneRequestError(`System One 请求失败：${detail}`.slice(0, 2_048), response.status)
  }
  const parsedResponse = systemOneResponseSchema.safeParse(body)
  if (!parsedResponse.success) {
    throw new SystemOneRequestError('System One 响应格式无效', response.status)
  }
  return parsedResponse.data
}
