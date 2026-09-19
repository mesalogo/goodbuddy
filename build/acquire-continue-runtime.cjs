const { createHash } = require('node:crypto')
const { mkdirSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')
const { readRemoteRuntimeLock, resolveLockedRuntimeInput } = require('./remote-runtime-bundle.cjs')

const [directory, architecture, platform = 'linux'] = process.argv.slice(2)
if (!directory) throw new Error('Continue archive destination is required')
const input = resolveLockedRuntimeInput(readRemoteRuntimeLock(), architecture, platform, 'continue')
const destination = resolve(directory)
mkdirSync(destination, { recursive: true })
execFileSync('npm', ['pack', `${input.packageName}@${input.version}`, '--ignore-scripts',
  '--registry=https://registry.npmjs.org', '--pack-destination', destination], { stdio: 'ignore' })
const archive = join(destination, input.archive)
if (`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}` !== input.integrity) {
  throw new Error('Continue archive integrity mismatch')
}
process.stdout.write(`${archive}\n`)
