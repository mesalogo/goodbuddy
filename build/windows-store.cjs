'use strict'

const { join } = require('node:path')
const { mkdir, readFile, writeFile } = require('node:fs/promises')

function storeBuilderArguments(outputDirectory, environment = process.env) {
  const values = {}
  for (const key of ['MS_STORE_IDENTITY_NAME', 'MS_STORE_PUBLISHER', 'MS_STORE_PUBLISHER_DISPLAY_NAME']) {
    const value = environment[key]?.trim()
    if (!value) throw new Error(`MSIX 构建需要 ${key}，请从 Partner Center 产品标识页面填写`)
    values[key] = value
  }
  if (!/^[A-Za-z0-9.-]{3,50}$/u.test(values.MS_STORE_IDENTITY_NAME)) {
    throw new Error('MS_STORE_IDENTITY_NAME 格式无效')
  }
  if (!values.MS_STORE_PUBLISHER.startsWith('CN=')) {
    throw new Error('MS_STORE_PUBLISHER 必须使用 Partner Center 提供的完整 CN= 标识')
  }
  return [
    '--config.extraMetadata.goodbuddyWindowsDistribution=store',
    `--config.directories.buildResources=${join(outputDirectory, 'store-resources')}`,
    '--config.appx.artifactName=GoodBuddy-${version}-windows-${arch}.msix',
    `--config.appx.identityName=${values.MS_STORE_IDENTITY_NAME}`,
    `--config.appx.publisher=${values.MS_STORE_PUBLISHER}`,
    `--config.appx.publisherDisplayName=${values.MS_STORE_PUBLISHER_DISPLAY_NAME}`,
    '--config.appx.applicationId=GoodBuddy',
    '--config.appx.displayName=GoodBuddy',
    '--config.appx.minVersion=10.0.19041.0',
    '--config.appx.setBuildNumber=false',
    '--config.appx.electronUpdaterAware=false'
  ]
}

async function prepareStoreAssets(outputDirectory) {
  const { PNG } = require('pngjs')
  const { resize } = await import('png-to-ico/lib/png.js')
  const source = PNG.sync.read(await readFile(join(__dirname, 'icon.png')))
  const directory = join(outputDirectory, 'store-resources', 'appx')
  await mkdir(directory, { recursive: true })
  for (const [name, width, height] of [
    ['StoreLogo.png', 50, 50],
    ['Square44x44Logo.png', 44, 44],
    ['Square150x150Logo.png', 150, 150],
    ['Wide310x150Logo.png', 310, 150]
  ]) {
    const size = Math.min(width, height)
    const square = resize(source, size, size, 'bicubicInterpolation')
    const image = new PNG({ width, height })
    image.data.fill(0)
    PNG.bitblt(square, image, 0, 0, size, size, Math.floor((width - size) / 2), 0)
    await writeFile(join(directory, name), PNG.sync.write(image))
  }
}

module.exports = { storeBuilderArguments, prepareStoreAssets }
