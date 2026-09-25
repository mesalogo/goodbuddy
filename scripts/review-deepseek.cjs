// Isolated experiment launcher. Credentials and private output never enter the bundle.
/* global require, __dirname, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { build } = require('esbuild')
const { spawn } = require('node:child_process')
const { mkdirSync, openSync, writeFileSync, existsSync, readFileSync } = require('node:fs')
const { resolve, join, relative, isAbsolute } = require('node:path')
async function main() {
  const [mode, sourceArg, directoryArg, envArg, concurrency = '2'] = process.argv.slice(2)
  if (mode === 'status') {
    console.log(readFileSync(join(resolve(sourceArg), 'metrics.json'), 'utf8'))
    return
  }
  if (!['first', 'finish', 'verify'].includes(mode)) throw Error('Expected first|finish|verify source-directory output-directory env-file [concurrency]')
  const directory = resolve(directoryArg), repository = resolve(__dirname, '..')
  const rel = relative(repository, directory)
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw Error('External output required')
  mkdirSync(directory, { recursive: true })
  const launchPath = join(directory, 'launch.json')
  if (existsSync(launchPath)) {
    const previous = JSON.parse(readFileSync(launchPath, 'utf8'))
    try { process.kill(previous.pid, 0); throw Error('Previous probe PID is still alive') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const outfile = join(directory, 'deepseek.mjs')
  await build({ entryPoints: [join(__dirname, 'review-deepseek.mjs')], outfile, bundle: true, platform: 'node', format: 'esm' })
  const child = spawn(process.execPath, [outfile, mode, resolve(sourceArg), directory, resolve(envArg), concurrency], {
    detached: true, stdio: ['ignore', openSync(join(directory, `${mode}.stdout.private.log`), 'a'), openSync(join(directory, `${mode}.stderr.private.log`), 'a')]
  })
  writeFileSync(launchPath, JSON.stringify({ pid: child.pid, mode, startedAt: new Date().toISOString() }))
  child.unref()
  console.log(JSON.stringify({ pid: child.pid, mode, directory }))
}
main().catch(() => { console.error('Probe launch failed; check arguments and existing probe PID.'); process.exitCode = 1 })
