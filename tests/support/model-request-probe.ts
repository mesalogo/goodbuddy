import { createServer } from 'node:http'

export type ModelRequestProbeObservation = {
  headerValue: string
  bodyFields: Record<string, unknown>
}

export async function createModelRequestProbe(options: {
  upstreamUrl: URL
  headerName: string
  bodyFieldNames?: readonly string[]
  removeBodyFieldNames?: readonly string[]
}): Promise<{
  baseUrl: string
  observations: ModelRequestProbeObservation[]
  close(): Promise<void>
}> {
  const normalizedHeaderName = options.headerName.toLowerCase()
  const observations: ModelRequestProbeObservation[] = []
  const server = createServer(async (request, response) => {
    try {
      let rawBody = ''
      for await (const chunk of request) {
        rawBody += String(chunk)
      }
      const body = JSON.parse(rawBody) as Record<string, unknown>
      observations.push({
        headerValue: String(
          request.headers[normalizedHeaderName] ?? ''
        ),
        bodyFields: Object.fromEntries(
          (options.bodyFieldNames ?? []).map((name) => [
            name,
            body[name]
          ])
        )
      })
      for (const name of options.removeBodyFieldNames ?? []) {
        Reflect.deleteProperty(body, name)
      }

      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
          headers.set(name, value.join(', '))
        } else if (value !== undefined) {
          headers.set(name, value)
        }
      }
      for (const name of [
        'connection',
        'content-length',
        'host',
        'transfer-encoding',
        normalizedHeaderName
      ]) {
        headers.delete(name)
      }
      const upstream = await fetch(options.upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
      })
      response.statusCode = upstream.status
      const contentType = upstream.headers.get('content-type')
      if (contentType) {
        response.setHeader('content-type', contentType)
      }
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      response.statusCode = 502
      response.end('Model request probe failed')
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind model request probe')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    observations,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) =>
          error ? reject(error) : resolveClose()
        )
      })
  }
}
