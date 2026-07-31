const { spawnSync } = require('node:child_process')
const {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
)
const outputRoot = join(root, 'dist')
const stagingRoot = join(outputRoot, '.portable-stage-x64')
const unpackedPath = join(stagingRoot, 'win-unpacked')
const portableName = `GoodBuddy-${packageJson.version}-win-x64-portable`
const portablePath = join(outputRoot, portableName)

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Portable 目录当前必须在 Windows x64 上构建')
}
if (statSync(portablePath, { throwIfNoEntry: false })) {
  throw new Error(
    `输出目录已存在，请先移动或删除：${portablePath}`
  )
}

mkdirSync(outputRoot, { recursive: true })
rmSync(stagingRoot, { recursive: true, force: true })

const result = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'electron-builder', 'cli.js'),
    '--dir',
    '--x64',
    `--config.directories.output=${stagingRoot}`,
    '--config.electronDist=node_modules/electron/dist'
  ],
  {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true
  }
)

if (result.error) {
  rmSync(stagingRoot, { recursive: true, force: true })
  throw result.error
}
if (result.status !== 0) {
  rmSync(stagingRoot, { recursive: true, force: true })
  throw new Error(
    `Electron Builder 构建失败（code ${result.status ?? 1}）`
  )
}
if (!statSync(unpackedPath, { throwIfNoEntry: false })?.isDirectory()) {
  rmSync(stagingRoot, { recursive: true, force: true })
  throw new Error('Electron Builder 未生成 portable 目录')
}
renameSync(unpackedPath, portablePath)
rmSync(stagingRoot, { recursive: true, force: true })

console.log(`Portable 目录构建完成：${portablePath}`)
console.log(`启动文件：${join(portablePath, 'GoodBuddy.exe')}`)
