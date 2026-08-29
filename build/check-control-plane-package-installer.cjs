const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const maximumInstallerBytes = 256 * 1024

function verifyControlPlanePackageInstaller(
  filePath = resolve(
    'out',
    'main',
    'remote-package-installer.mjs'
  )
) {
  const bytes = readFileSync(filePath)
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumInstallerBytes
  ) {
    throw new Error(
      'Control-plane package installer exceeds its transfer limit'
    )
  }
  const source = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true
  }).decode(bytes)
  if (
    /(?:^|\n)\s*(?:import|export)\b[^\r\n]*\bfrom\s*['"]\.{1,2}\//u.test(
      source
    ) ||
    /(?:^|\n)\s*import\s*['"]\.{1,2}\//u.test(source) ||
    /\bimport\s*\(\s*['"]\.{1,2}\//u.test(source)
  ) {
    throw new Error(
      'Control-plane package installer is not a standalone bundle'
    )
  }
  const syntax = spawnSync(
    process.execPath,
    ['--check', filePath],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  )
  if (syntax.status !== 0) {
    throw new Error(
      `Control-plane package installer is not executable: ${
        syntax.stderr.trim() || syntax.stdout.trim()
      }`
    )
  }
  return {
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

if (require.main === module) {
  const result = verifyControlPlanePackageInstaller(
    process.argv[2]
      ? resolve(process.argv[2])
      : undefined
  )
  process.stdout.write(
    `Control-plane package installer: ${result.size} bytes, sha256 ${result.sha256}\n`
  )
}

module.exports = {
  maximumInstallerBytes,
  verifyControlPlanePackageInstaller
}
