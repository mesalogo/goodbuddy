const {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const tar = require('tar')

const root = join(__dirname, '..', '..')
const defaultOutput = join(
  root,
  'dist',
  'loongarch-cross',
  'goodbuddy-loongarch-cross-input.tgz'
)
const inputPaths = [
  'LICENSE',
  'agent-runtime-lock.json',
  'package.json',
  'package-lock.json',
  'remote-runtime-lock.json',
  'out',
  'resources/agent-release-keys.json',
  'resources/release-notes.json',
  'resources/skills',
  'build/icon.png',
  'build/icon-tray.png',
  'node_modules/@continuedev/cli/package.json',
  'node_modules/@continuedev/cli/dist/cn.js',
  'node_modules/@continuedev/cli/dist/index.js',
  'node_modules/@continuedev/cli/dist/xhr-sync-worker.js',
  'node_modules/npm'
]

function parseArguments(argv) {
  const options = { output: defaultOutput }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--output') {
      throw new Error(`未知参数：${argument}`)
    }
    const value = argv[index + 1]
    if (!value) {
      throw new Error('--output 缺少值')
    }
    options.output = resolve(value)
    index += 1
  }
  return options
}

function verifyInputs(projectRoot = root) {
  for (const relativePath of inputPaths) {
    if (!existsSync(join(projectRoot, relativePath))) {
      throw new Error(`龙芯交叉构建输入缺失：${relativePath}`)
    }
  }
}

async function createInputArchive(outputPath, projectRoot = root) {
  verifyInputs(projectRoot)
  const resolvedOutput = resolve(outputPath)
  const temporaryOutput = `${resolvedOutput}.partial-${process.pid}`
  mkdirSync(dirname(resolvedOutput), { recursive: true })
  rmSync(temporaryOutput, { force: true })
  try {
    await tar.c(
      {
        cwd: projectRoot,
        file: temporaryOutput,
        gzip: true,
        portable: true,
        noMtime: true
      },
      inputPaths
    )
    if (!statSync(temporaryOutput).isFile()) {
      throw new Error('龙芯交叉构建输入归档未生成')
    }
    rmSync(resolvedOutput, { force: true })
    renameSync(temporaryOutput, resolvedOutput)
  } finally {
    rmSync(temporaryOutput, { force: true })
  }
  return resolvedOutput
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const output = await createInputArchive(options.output)
  console.log(`龙芯交叉构建输入已生成：${output}`)
}

module.exports = {
  createInputArchive,
  inputPaths,
  parseArguments,
  verifyInputs
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
