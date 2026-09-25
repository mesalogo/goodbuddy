/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process')
const { openSync, existsSync, writeFileSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const directory = resolve(process.argv[2])
if (existsSync(join(directory, 'launch.json'))) {
  if (process.argv[4] !== 'resume-cached') throw new Error('Already launched; inspect saved metrics')
  const previous = JSON.parse(readFileSync(join(directory, 'launch.json'), 'utf8'))
  try { process.kill(previous.pid, 0); throw new Error('Previous probe is still running') }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}
const child = spawn(process.execPath, [join(directory, 'live.cjs'), directory, resolve(process.argv[3]), ...(process.argv[4] ? [process.argv[4]] : [])], {
  detached: true, env: { ...process.env, NODE_PATH: resolve('node_modules') },
  stdio: ['ignore', openSync(join(directory, 'stdout.log'), 'a'), openSync(join(directory, 'stderr.private.log'), 'a')]
})
writeFileSync(join(directory, 'launch.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }))
child.unref()
console.log(JSON.stringify({ pid: child.pid, directory }))
