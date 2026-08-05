const {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} = require('node:fs')
const { basename, dirname, isAbsolute, join, relative, resolve } = require('node:path')
const { sha256File } = require('./file-hash.cjs')

const root = join(__dirname, '..')
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
)
const productName = packageJson.build?.productName ?? packageJson.name
const manifestName = 'release-manifest.json'
const targetDefinitions = [
  { platform: 'windows', arch: 'x64', formats: ['nsis', 'portable'] },
  { platform: 'windows', arch: 'arm64', formats: ['nsis', 'portable'] },
  { platform: 'macos', arch: 'x64', formats: ['dmg', 'zip'] },
  { platform: 'macos', arch: 'arm64', formats: ['dmg', 'zip'] },
  { platform: 'linux', arch: 'x64', formats: ['AppImage', 'deb'] },
  { platform: 'linux', arch: 'arm64', formats: ['AppImage', 'deb'] }
]
const allowedExtensions = {
  nsis: '.exe',
  portable: '.exe',
  dmg: '.dmg',
  zip: '.zip',
  AppImage: '.AppImage',
  deb: '.deb'
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--input' || argument === '--output') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error(`${argument} 缺少值`)
      }
      options[argument.slice(2)] = resolve(value)
      index += 1
    } else {
      throw new Error(`未知参数：${argument}`)
    }
  }
  if (!options.input || !options.output) {
    throw new Error('必须指定 --input 和 --output')
  }
  return options
}

function assertPlainFile(filePath, description) {
  const status = lstatSync(filePath, { throwIfNoEntry: false })
  if (!status?.isFile() || status.isSymbolicLink()) {
    throw new Error(`${description}必须是普通文件：${filePath}`)
  }
}

function assertSafeName(name, description) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    isAbsolute(name) ||
    basename(name) !== name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error(`${description}包含不安全路径：${String(name)}`)
  }
}

function readManifest(directory) {
  const filePath = join(directory, manifestName)
  assertPlainFile(filePath, '平台 manifest')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析平台 manifest：${filePath}`, {
      cause: error
    })
  }
  return { filePath, manifest }
}

function assertManifest(manifest, expected) {
  if (
    !manifest ||
    manifest.formatVersion !== 1 ||
    manifest.productName !== productName ||
    manifest.version !== packageJson.version ||
    manifest.platform !== expected.platform ||
    manifest.arch !== expected.arch ||
    !Array.isArray(manifest.formats) ||
    manifest.formats.length !== expected.formats.length ||
    !expected.formats.every(
      (format, index) => manifest.formats[index] === format
    ) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(
      `平台 manifest 元数据错误：${expected.platform}-${expected.arch}`
    )
  }
}

function expectedFormatForFile(name, target) {
  if (target.platform === 'windows') {
    if (/-setup\.exe$/u.test(name)) {
      return 'nsis'
    }
    if (/-portable\.exe$/u.test(name)) {
      return 'portable'
    }
    return undefined
  }
  return target.formats.find((format) =>
    name.endsWith(allowedExtensions[format])
  )
}

function listTargetDirectories(inputDirectory) {
  if (lstatSync(inputDirectory).isSymbolicLink()) {
    throw new Error(`拒绝符号链接：${inputDirectory}`)
  }
  const inputRoot = realpathSync(inputDirectory)
  return readdirSync(inputRoot, { withFileTypes: true })
    .map((entry) => {
      if (entry.isSymbolicLink()) {
        throw new Error(`拒绝符号链接：${join(inputRoot, entry.name)}`)
      }
      if (!entry.isDirectory()) {
        throw new Error(`下载目录只能包含目标目录：${entry.name}`)
      }
      const directory = realpathSync(join(inputRoot, entry.name))
      const pathFromRoot = relative(inputRoot, directory)
      if (
        pathFromRoot.startsWith('..') ||
        isAbsolute(pathFromRoot)
      ) {
        throw new Error(`目标目录越出输入目录：${directory}`)
      }
      return directory
    })
}

async function aggregateRelease(inputDirectory, outputDirectory) {
  const resolvedInput = resolve(inputDirectory)
  const resolvedOutput = resolve(outputDirectory)
  const outputFromInput = relative(resolvedInput, resolvedOutput)
  const inputFromOutput = relative(resolvedOutput, resolvedInput)
  if (
    outputFromInput === '' ||
    (!outputFromInput.startsWith('..') &&
      !isAbsolute(outputFromInput)) ||
    (!inputFromOutput.startsWith('..') &&
      !isAbsolute(inputFromOutput))
  ) {
    throw new Error('输入目录和上传目录必须相互独立')
  }
  const directories = listTargetDirectories(inputDirectory)
  if (directories.length !== targetDefinitions.length) {
    throw new Error(
      `发布目标数量错误：期望 ${targetDefinitions.length}，实际 ${directories.length}`
    )
  }

  const manifests = directories.map(readManifest)
  const byTarget = new Map()
  for (const item of manifests) {
    const key = `${item.manifest.platform}-${item.manifest.arch}`
    if (byTarget.has(key)) {
      throw new Error(`发布目标重复：${key}`)
    }
    byTarget.set(key, item)
  }

  const fileNames = new Set()
  const targets = []
  mkdirSync(outputDirectory, { recursive: false })
  for (const expected of targetDefinitions) {
    const key = `${expected.platform}-${expected.arch}`
    const item = byTarget.get(key)
    if (!item) {
      throw new Error(`缺少发布目标：${key}`)
    }
    assertManifest(item.manifest, expected)

    const directory = dirname(item.filePath)
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`拒绝符号链接：${join(directory, entry.name)}`)
      }
      if (!entry.isFile()) {
        throw new Error(`目标目录只能包含普通文件：${entry.name}`)
      }
    }
    if (entries.length !== item.manifest.files.length + 1) {
      throw new Error(`目标目录包含 manifest 未声明的文件：${key}`)
    }

    const seenFormats = new Set()
    const files = []
    for (const file of item.manifest.files) {
      assertSafeName(file?.name, '发布文件名')
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(file.sha256)
      ) {
        throw new Error(`发布文件元数据错误：${file?.name ?? key}`)
      }
      if (fileNames.has(file.name)) {
        throw new Error(`发布文件名全局重复：${file.name}`)
      }
      const format = expectedFormatForFile(file.name, expected)
      if (!format || seenFormats.has(format)) {
        throw new Error(`发布文件格式或数量错误：${file.name}`)
      }
      const source = join(directory, file.name)
      assertPlainFile(source, '发布文件')
      const actualSize = lstatSync(source).size
      const actualHash = await sha256File(source)
      if (actualSize !== file.size || actualHash !== file.sha256) {
        throw new Error(`发布文件完整性校验失败：${file.name}`)
      }
      assertPlainFile(source, '发布文件')
      copyFileSync(source, join(outputDirectory, file.name))
      fileNames.add(file.name)
      seenFormats.add(format)
      files.push({
        name: file.name,
        size: file.size,
        sha256: file.sha256
      })
    }
    if (
      expected.formats.some((format) => !seenFormats.has(format))
    ) {
      throw new Error(`发布目标格式不完整：${key}`)
    }

    const renamedManifest = `release-manifest-${key}.json`
    writeFileSync(
      join(outputDirectory, renamedManifest),
      `${JSON.stringify(item.manifest, null, 2)}\n`,
      'utf8'
    )
    targets.push({
      platform: expected.platform,
      arch: expected.arch,
      formats: [...expected.formats],
      manifest: renamedManifest,
      files
    })
  }

  if (byTarget.size !== targetDefinitions.length) {
    throw new Error('包含未知发布目标')
  }
  const aggregateManifest = {
    formatVersion: 1,
    productName,
    version: packageJson.version,
    targets,
    files: targets.flatMap((target) =>
      target.files.map((file) => ({
        platform: target.platform,
        arch: target.arch,
        ...file
      }))
    )
  }
  writeFileSync(
    join(outputDirectory, manifestName),
    `${JSON.stringify(aggregateManifest, null, 2)}\n`,
    'utf8'
  )

  const checksumNames = readdirSync(outputDirectory)
    .sort((left, right) => left.localeCompare(right))
  const checksums = []
  for (const name of checksumNames) {
    assertSafeName(name, '上传文件名')
    const filePath = join(outputDirectory, name)
    assertPlainFile(filePath, '上传文件')
    checksums.push(`${await sha256File(filePath)}  ${name}`)
  }
  writeFileSync(
    join(outputDirectory, 'SHA256SUMS'),
    `${checksums.join('\n')}\n`,
    'utf8'
  )
  return aggregateManifest
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  await aggregateRelease(options.input, options.output)
  console.log(`发布资产聚合完成：${options.output}`)
}

module.exports = {
  aggregateRelease,
  assertSafeName,
  parseArguments,
  targetDefinitions
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
