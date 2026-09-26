import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

/** Keep upstream module-relative assets and licenses, including trash's native helpers. */
export async function packageObsidianMcpVault(projectRoot: string, output: string): Promise<void> {
  const modules = resolve(projectRoot, 'node_modules')
  const visited = new Set<string>()
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  async function copyDependency(name: string, from: string): Promise<void> {
    let directory = from
    let source: string
    for (;;) {
      source = join(directory, 'node_modules', name)
      if (await stat(join(source, 'package.json')).then(() => true, () => false)) break
      const parent = dirname(directory)
      if (parent === directory) throw new Error(`Missing MCPVault dependency: ${name}`)
      directory = parent
    }
    if (visited.has(source)) return
    visited.add(source)
    const target = join(output, 'node_modules', relative(modules, source))
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
      version: string
      dependencies?: Record<string, string>
    }
    if (name === '@bitbonsai/mcpvault' && manifest.version !== '0.16.0') {
      throw new Error(`Expected MCPVault 0.16.0, found ${manifest.version}`)
    }
    await cp(source, target, {
      recursive: true,
      filter: (path) => path === source || !relative(source, path).split(/[\\/]/u).includes('node_modules')
    })
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await copyDependency(dependency, source)
    }
  }

  await copyDependency('@bitbonsai/mcpvault', projectRoot)
}
