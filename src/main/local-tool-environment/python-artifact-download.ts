import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { PythonArtifact } from './python-artifact-catalog'

const redirectStatuses = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError')
  }
}

function secureUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Managed Python download URL must be plain HTTPS')
  }
  return url
}

async function close(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined)
}

export async function downloadPythonArtifact(options: {
  artifact: PythonArtifact
  destinationPath: string
  transport?: typeof fetch
  signal?: AbortSignal
  onProgress?: (receivedBytes: number, totalBytes: number) => void
}): Promise<void> {
  const transport = options.transport ?? fetch
  const allowedHosts = new Set(options.artifact.redirectHosts)
  let url = secureUrl(options.artifact.url)
  if (!allowedHosts.has(url.hostname)) {
    throw new Error('Managed Python initial download host is not declared')
  }
  let response: Response | undefined
  for (let redirects = 0; ; redirects += 1) {
    ensureNotAborted(options.signal)
    response = await transport(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal
    })
    if (!redirectStatuses.has(response.status)) {
      break
    }
    if (redirects >= MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Managed Python download has too many redirects')
    }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) {
      throw new Error('Managed Python redirect has no location')
    }
    const next = secureUrl(new URL(location, url).toString())
    if (!allowedHosts.has(next.hostname)) {
      throw new Error('Managed Python download redirected to an undeclared host')
    }
    url = next
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Managed Python download failed with HTTP ${response.status}`)
  }
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) !== options.artifact.size)
  ) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('Managed Python download size does not match the catalog')
  }

  let output: FileHandle | undefined
  const hash = createHash('sha256')
  let received = 0
  try {
    output = await open(options.destinationPath, 'wx')
    const reader = response.body.getReader()
    while (true) {
      ensureNotAborted(options.signal)
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.byteLength
      if (received > options.artifact.size) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Managed Python download exceeds the catalog size')
      }
      hash.update(value)
      let offset = 0
      while (offset < value.byteLength) {
        const { bytesWritten } = await output.write(
          value,
          offset,
          value.byteLength - offset
        )
        if (bytesWritten <= 0) {
          throw new Error('Managed Python artifact write was incomplete')
        }
        offset += bytesWritten
      }
      options.onProgress?.(received, options.artifact.size)
    }
    if (
      received !== options.artifact.size ||
      hash.digest('hex') !== options.artifact.sha256
    ) {
      throw new Error('Managed Python artifact integrity check failed')
    }
    await output.sync()
    await close(output)
    output = undefined
  } catch (error) {
    await close(output)
    await rm(options.destinationPath, { force: true }).catch(() => undefined)
    throw error
  }
}
