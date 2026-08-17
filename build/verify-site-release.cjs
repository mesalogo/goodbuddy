const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--manifest' || !argv[1]) {
    throw new Error('必须指定 --manifest')
  }
  return { manifest: resolve(argv[1]) }
}

async function verifySiteRelease(manifest, request = fetch) {
  const files = Object.values(manifest?.targets ?? {}).flatMap(
    (target) => Object.values(target?.files ?? {})
  )
  if (files.length !== 12) {
    throw new Error(`官网发布文件数量错误：${files.length}`)
  }
  const urls = new Set()
  for (const file of files) {
    if (
      typeof file?.url !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      urls.has(file.url)
    ) {
      throw new Error('官网发布文件元数据无效')
    }
    urls.add(file.url)
    const response = await request(file.url, {
      method: 'HEAD',
      redirect: 'error'
    })
    if (!response.ok) {
      throw new Error(`OSS 文件不可访问：${file.url}（${response.status}）`)
    }
    const contentLength = Number(response.headers.get('content-length'))
    if (contentLength !== file.size) {
      throw new Error(
        `OSS 文件大小不匹配：${file.url}，期望 ${file.size}，实际 ${contentLength}`
      )
    }
  }
  return files.length
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'))
  const count = await verifySiteRelease(manifest)
  console.log(`OSS 发布文件验证通过：${count} 个`)
}

module.exports = {
  parseArguments,
  verifySiteRelease
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
