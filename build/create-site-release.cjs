const {
  mkdirSync,
  readFileSync,
  writeFileSync
} = require('node:fs')
const { dirname, resolve } = require('node:path')

const supportedTargets = new Map([
  ['windows-x64', ['nsis', 'portable']],
  ['windows-arm64', ['nsis', 'portable']],
  ['macos-x64', ['dmg', 'zip']],
  ['macos-arm64', ['dmg', 'zip']],
  ['linux-x64', ['AppImage', 'deb']],
  ['linux-arm64', ['AppImage', 'deb']]
])

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (
      argument === '--manifest' ||
      argument === '--base-url' ||
      argument === '--output'
    ) {
      const value = argv[index + 1]
      if (!value) {
        throw new Error(`${argument} 缺少值`)
      }
      options[argument.slice(2)] = value
      index += 1
    } else {
      throw new Error(`未知参数：${argument}`)
    }
  }
  if (!options.manifest || !options.baseUrl || !options.output) {
    throw new Error('必须指定 --manifest、--base-url 和 --output')
  }
  return {
    manifest: resolve(options.manifest),
    baseUrl: options.baseUrl,
    output: resolve(options.output)
  }
}

function validateBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`OSS 基础地址无效：${value}`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('OSS 基础地址必须是无凭据、查询参数和片段的 HTTPS 地址')
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }
  return url
}

function assertFile(file, targetKey) {
  if (
    !file ||
    typeof file.name !== 'string' ||
    !/^GoodBuddy-[A-Za-z0-9._-]+$/u.test(file.name) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    typeof file.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(file.sha256)
  ) {
    throw new Error(`发布文件元数据无效：${targetKey}`)
  }
}

function formatForFile(fileName, platform) {
  if (platform === 'windows') {
    if (/-setup\.exe$/u.test(fileName)) {
      return 'nsis'
    }
    if (/-portable\.zip$/u.test(fileName)) {
      return 'portable'
    }
  } else if (platform === 'macos') {
    if (fileName.endsWith('.dmg')) {
      return 'dmg'
    }
    if (fileName.endsWith('.zip')) {
      return 'zip'
    }
  } else if (platform === 'linux') {
    if (fileName.endsWith('.AppImage')) {
      return 'AppImage'
    }
    if (fileName.endsWith('.deb')) {
      return 'deb'
    }
  }
  return undefined
}

function createSiteRelease(manifest, baseUrlValue) {
  if (
    !manifest ||
    manifest.formatVersion !== 1 ||
    manifest.productName !== 'GoodBuddy' ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
    !Array.isArray(manifest.targets)
  ) {
    throw new Error('聚合发布 manifest 元数据无效')
  }
  const baseUrl = validateBaseUrl(baseUrlValue)
  const seenTargets = new Set()
  const targets = {}
  for (const target of manifest.targets) {
    const key = `${target?.platform}-${target?.arch}`
    const expectedFormats = supportedTargets.get(key)
    if (
      !expectedFormats ||
      seenTargets.has(key) ||
      !Array.isArray(target.formats) ||
      !Array.isArray(target.files) ||
      target.formats.length !== expectedFormats.length ||
      !expectedFormats.every(
        (format, index) => target.formats[index] === format
      ) ||
      target.files.length !== expectedFormats.length
    ) {
      throw new Error(`发布目标元数据无效：${key}`)
    }
    const files = {}
    for (const file of target.files) {
      assertFile(file, key)
      const format = formatForFile(file.name, target.platform)
      if (!format || !expectedFormats.includes(format) || files[format]) {
        throw new Error(`发布文件格式无效：${file.name}`)
      }
      files[format] = {
        name: file.name,
        size: file.size,
        sha256: file.sha256,
        url: new URL(encodeURIComponent(file.name), baseUrl).href
      }
    }
    if (expectedFormats.some((format) => !files[format])) {
      throw new Error(`发布目标文件不完整：${key}`)
    }
    targets[key] = {
      platform: target.platform,
      arch: target.arch,
      files
    }
    seenTargets.add(key)
  }
  if (seenTargets.size !== supportedTargets.size) {
    throw new Error(
      `发布目标数量错误：期望 ${supportedTargets.size}，实际 ${seenTargets.size}`
    )
  }
  return {
    formatVersion: 1,
    productName: manifest.productName,
    version: manifest.version,
    targets,
    checksumUrl: new URL('SHA256SUMS', baseUrl).href,
    fallbackUrl: 'https://github.com/mesalogo/goodbuddy/releases/latest'
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'))
  const siteRelease = createSiteRelease(manifest, options.baseUrl)
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(
    options.output,
    `${JSON.stringify(siteRelease, null, 2)}\n`,
    'utf8'
  )
  console.log(`官网发布索引已生成：${options.output}`)
}

module.exports = {
  createSiteRelease,
  parseArguments,
  validateBaseUrl
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
