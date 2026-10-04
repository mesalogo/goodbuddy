// @vitest-environment node
import { execFile, spawn } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const exec = promisify(execFile)

// Windows uses its real current-user trust store; other platforms need their own trust setup.
// Requires OpenSSL on PATH and Windows consent to temporarily trust the generated CA.
// Opt in with GB_TELEGRAM_PROXY_TLS_TEST=1, then run: npx vitest run tests/telegram-proxy.electron.test.ts
it.skipIf(process.platform !== 'win32' || process.env.GB_TELEGRAM_PROXY_TLS_TEST !== '1')('uses real Electron TLS and CONNECT for Telegram validation, polling, replies and stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-telegram-proxy-'))
  let thumbprint: string | undefined
  try {
    const root = join(directory, 'root.pem')
    const rootKey = join(directory, 'root.key')
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=GoodBuddy temporary Telegram proxy test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', rootKey, '-out', root])
    const key = join(directory, 'server.key')
    const csr = join(directory, 'server.csr')
    const cert = join(directory, 'server.pem')
    const extensions = join(directory, 'server.ext')
    await writeFile(extensions, 'subjectAltName=DNS:api.telegram.org\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
    await exec('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-subj', '/CN=api.telegram.org', '-keyout', key, '-out', csr])
    await exec('openssl', ['x509', '-req', '-in', csr, '-CA', root, '-CAkey', rootKey,
      '-CAcreateserial', '-days', '1', '-extfile', extensions, '-out', cert])
    const host = join(directory, 'main.cjs')
    await build({ entryPoints: ['tests/support/telegram-proxy-main.ts'], outfile: host,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    const electron = createRequire(import.meta.url)('electron') as string
    const env: NodeJS.ProcessEnv = {}
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[name]) env[name] = process.env[name]
    }
    async function run(trusted: boolean): Promise<void> {
      const child = spawn(electron, [host], { env: { ...env,
        GB_PROXY_DIRECTORY: directory, GB_PROXY_TRUSTED: String(trusted)
      }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (data) => { output += data })
      child.stderr.on('data', (data) => { output += data })
      const timer = setTimeout(() => child.kill(), 25_000)
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('exit', resolve)
          child.once('error', reject)
        })
        expect(code, output).toBe(0)
        expect(output).toContain(trusted ? '"telegramProxy":"passed"' : '"untrustedTlsRejected":true')
        process.stdout.write(output)
      } finally {
        clearTimeout(timer)
      }
    }
    await run(false)
    thumbprint = new X509Certificate(await readFile(root)).fingerprint.replaceAll(':', '')
    try {
      await exec('certutil', ['-user', '-addstore', 'Root', root], { timeout: 15_000 })
    } catch (error) {
      throw new Error('Temporary Windows CA import failed or timed out waiting for trust consent. TLS verification was not bypassed.', { cause: error })
    }
    await run(true)
  } finally {
    try {
      if (thumbprint) await exec('certutil', ['-user', '-delstore', 'Root', thumbprint], { timeout: 10_000 })
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}, 75_000)
