import { createServer } from 'node:net'

export async function getAvailableLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        address && typeof address === 'object' ? address.port : 0
      server.close((error) => {
        if (error) {
          reject(error)
        } else if (port > 0) {
          resolvePort(port)
        } else {
          reject(new Error('无法分配本机端口'))
        }
      })
    })
  })
}
