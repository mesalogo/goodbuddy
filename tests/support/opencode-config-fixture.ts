import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function createOpenCodeConfigFixture(projectRoot: string): string {
  const config = join(projectRoot, '.runtime-resources', 'opencode-config')
  const files = {
    'node_modules/@opencode-ai/plugin/package.json': JSON.stringify({
      name: '@opencode-ai/plugin', version: '1.18.29'
    }),
    'node_modules/@opencode-ai/plugin/index.js': 'export default {}\n',
    'node_modules/.bin/unused': 'unused CLI shim\n'
  }
  for (const [name, content] of Object.entries(files)) {
    const destination = join(config, name)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
    chmodSync(destination, 0o755)
  }
  const license = join(projectRoot, 'node_modules', 'opencode-ai', 'LICENSE')
  mkdirSync(dirname(license), { recursive: true })
  writeFileSync(license, 'fixture license\n')
  return config
}
