/*
 * Feishu/Lark app registration by QR code (device-code flow).
 * Adapted from OpenClaw extensions/feishu/src/app-registration.ts
 * Copyright (c) 2026 OpenClaw Foundation, MIT License.
 * The accounts endpoint is undocumented; callers must keep manual entry available.
 */
import type { FeishuDomain } from '../../shared/channel-settings-contracts'
import type { FeishuFetch } from './feishu-api'

const REGISTRATION_PATH = '/oauth/v1/app/registration'
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_INTERVAL_SECONDS = 5
const DEFAULT_EXPIRE_SECONDS = 600

export type AppRegistrationResult = { appId: string; appSecret: string; domain: FeishuDomain; openId?: string }

export type PollOutcome =
  | { status: 'success'; result: AppRegistrationResult }
  | { status: 'access_denied' }
  | { status: 'expired' }
  | { status: 'timeout' }
  | { status: 'error'; message: string }

function accountsBaseUrl(domain: FeishuDomain): string {
  return domain === 'lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn'
}

async function postRegistration<T>(fetchImpl: FeishuFetch, domain: FeishuDomain, body: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetchImpl(`${accountsBaseUrl(domain)}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  // Pending and error states come back as 4xx with a JSON body.
  const text = await response.text()
  if (text.length > 256 * 1024) throw new Error('飞书注册响应过大')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`飞书注册接口返回了非 JSON 响应（HTTP ${response.status}）`)
  }
}

const positiveSeconds = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 86_400 ? value : fallback

export async function beginAppRegistration(fetchImpl: FeishuFetch, domain: FeishuDomain, signal?: AbortSignal): Promise<{
  deviceCode: string; qrUrl: string; interval: number; expireIn: number
}> {
  const init = await postRegistration<{ supported_auth_methods?: string[] }>(fetchImpl, domain, { action: 'init' }, signal)
  if (!init.supported_auth_methods?.includes('client_secret')) {
    throw new Error('当前环境不支持扫码创建飞书应用')
  }
  const begin = await postRegistration<{
    device_code?: string; verification_uri_complete?: string; interval?: number; expire_in?: number
  }>(fetchImpl, domain, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id'
  }, signal)
  if (!begin.device_code || !begin.verification_uri_complete) throw new Error('飞书注册接口没有返回二维码')
  const qrUrl = new URL(begin.verification_uri_complete)
  if (qrUrl.protocol !== 'https:') throw new Error('飞书注册接口返回了无效的二维码地址')
  qrUrl.searchParams.set('from', 'oc_onboard')
  qrUrl.searchParams.set('tp', 'ob_cli_app')
  return {
    deviceCode: begin.device_code,
    qrUrl: qrUrl.toString(),
    interval: positiveSeconds(begin.interval, DEFAULT_INTERVAL_SECONDS),
    expireIn: positiveSeconds(begin.expire_in, DEFAULT_EXPIRE_SECONDS)
  }
}

export async function pollAppRegistration(params: {
  fetch: FeishuFetch
  deviceCode: string
  interval: number
  expireIn: number
  initialDomain: FeishuDomain
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}): Promise<PollOutcome> {
  const sleep = params.sleep ?? ((ms, signal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  }))
  let interval = params.interval
  let domain = params.initialDomain
  let switched = false
  const deadline = Date.now() + params.expireIn * 1000
  while (Date.now() < deadline) {
    if (params.signal?.aborted) return { status: 'timeout' }
    let response: {
      client_id?: string; client_secret?: string; error?: string; error_description?: string
      user_info?: { open_id?: string; tenant_brand?: 'feishu' | 'lark' }
    }
    try {
      response = await postRegistration(params.fetch, domain, { action: 'poll', device_code: params.deviceCode, tp: 'ob_cli_app' }, params.signal)
    } catch {
      await sleep(interval * 1000, params.signal)
      continue
    }
    if (!switched && response.user_info?.tenant_brand === 'lark' && domain !== 'lark') {
      domain = 'lark'
      switched = true
      continue
    }
    if (response.client_id && response.client_secret) {
      return {
        status: 'success',
        result: {
          appId: response.client_id,
          appSecret: response.client_secret,
          domain,
          ...(response.user_info?.open_id ? { openId: response.user_info.open_id } : {})
        }
      }
    }
    if (response.error && response.error !== 'authorization_pending') {
      if (response.error === 'slow_down') interval += 5
      else if (response.error === 'access_denied') return { status: 'access_denied' }
      else if (response.error === 'expired_token') return { status: 'expired' }
      else return { status: 'error', message: `${response.error}: ${response.error_description ?? 'unknown'}` }
    }
    await sleep(interval * 1000, params.signal)
  }
  return { status: 'timeout' }
}
