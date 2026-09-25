/* global require, process, __dirname, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { build } = require('esbuild')
const { spawn } = require('node:child_process')
const { mkdirSync, openSync, existsSync, writeFileSync, readFileSync } = require('node:fs')
const { resolve, join, relative, isAbsolute } = require('node:path')
async function main() {
  const [source, outputArg, env, mode] = process.argv.slice(2)
  const output = resolve(outputArg), repo = resolve(__dirname, '..'), rel = relative(repo, output)
  if (!(rel.startsWith('..') || isAbsolute(rel))) throw new Error('Use an external output directory')
  if (existsSync(output)) {
    if (mode !== 'resume-cached') throw new Error('Use a new external output directory')
    const previous = JSON.parse(readFileSync(join(output, 'launch.json'), 'utf8'))
    try { process.kill(previous.pid, 0); throw new Error('Previous probe is still running') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  mkdirSync(output, { recursive: true })
  const entry = join(output, 'probe.cjs')
  await build({ entryPoints: [join(__dirname, 'supervision-production-live.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const child = spawn(process.execPath, [entry, resolve(source), output, resolve(env), ...(mode ? [mode] : [])], {
    detached: true, env: { ...process.env, NODE_PATH: join(repo, 'node_modules') },
    stdio: ['ignore', openSync(join(output, 'stdout.log'), 'a'), openSync(join(output, 'stderr.private.log'), 'a')]
  })
  writeFileSync(join(output, 'launch.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }))
  child.unref()
  console.log(JSON.stringify({ pid: child.pid, output }))
}
main().catch(() => { console.error('Production probe launch failed'); process.exitCode = 1 })
