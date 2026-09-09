const { spawnSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildSync } = require('esbuild')

const output = join(tmpdir(), `goodbuddy-browser-tabs-e2e-${process.pid}.cjs`)

try {
  buildSync({
    entryPoints: [join(process.cwd(), 'tests', 'browser-tabs-electron-e2e.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron']
  })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [output], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
    timeout: 120_000
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(output, { force: true })
}
