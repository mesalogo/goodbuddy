import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runAgentCli } from './cli'

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return await runAgentCli(argv)
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  process.exitCode = await main()
}
