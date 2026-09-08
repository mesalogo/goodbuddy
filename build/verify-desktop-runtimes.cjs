const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')
const { opencodeVersion } = require('./opencode-config.cjs')

function verifyOpenCodeConfig(resources, source) {
  const destination = join(resources, 'runtimes', 'opencode-config')
  const manifestPath = join(destination, 'node_modules', '@opencode-ai', 'plugin', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== '@opencode-ai/plugin' || manifest.version !== opencodeVersion) {
    throw new Error('Packaged OpenCode plugin version is invalid')
  }
  const pending = [source]
  let files = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(file)
      } else if (entry.isFile()) {
        const target = join(destination, relative(source, file))
        if (!statSync(target, { throwIfNoEntry: false })?.isFile() ||
            !readFileSync(target).equals(readFileSync(file))) {
          throw new Error(`Packaged OpenCode dependency is missing or changed: ${relative(source, file)}`)
        }
        files++
      }
    }
  }
  return files
}

function verifyHarnessBundleImports(source, name) {
  if (/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@deepseek-ai\//u.test(source)) {
    throw new Error(`DeepSeek Harness bundle contains an external DeepSeek dependency: ${name}`)
  }
}

module.exports = { verifyOpenCodeConfig, verifyHarnessBundleImports }
