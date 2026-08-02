import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import { resize } from 'png-to-ico/lib/png.js'
import { PNG } from 'pngjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lightSourcePath = join(
  root,
  'icons',
  'ChatGPT_xQBGv24GYc.png'
)
const darkSourcePath = join(
  root,
  'icons',
  'ChatGPT_qPkaIrLGsm.png'
)
const rendererAssetRoot = join(root, 'src', 'renderer', 'src', 'assets')

function cropSquare(source, size) {
  const output = new PNG({ width: size, height: size })
  PNG.bitblt(source, output, 0, 0, size, size, 0, 0)
  return output
}

function pixelOffset(image, x, y) {
  return (y * image.width + x) * 4
}

function repairLightCursor(image) {
  for (let y = 246; y <= 284; y += 1) {
    const leftOffset = pixelOffset(image, 632, y)
    const rightOffset = pixelOffset(image, 670, y)
    for (let x = 636; x <= 664; x += 1) {
      const amount = (x - 632) / (670 - 632)
      const targetOffset = pixelOffset(image, x, y)
      for (let channel = 0; channel < 4; channel += 1) {
        image.data[targetOffset + channel] = Math.round(
          image.data[leftOffset + channel] * (1 - amount) +
            image.data[rightOffset + channel] * amount
        )
      }
    }
  }
}

function isBrandColor(red, green, blue) {
  return (
    Math.max(red, green, blue) - Math.min(red, green, blue) > 36 &&
    (green > 90 || blue > 100)
  )
}

function repairDarkCursor(dark, light) {
  for (let y = 570; y <= 606; y += 1) {
    const backgroundOffset = pixelOffset(dark, 640, y)
    for (let x = 540; x <= 568; x += 1) {
      const targetOffset = pixelOffset(dark, x, y)
      if (
        isBrandColor(
          dark.data[targetOffset],
          dark.data[targetOffset + 1],
          dark.data[targetOffset + 2]
        )
      ) {
        continue
      }
      const lightOffset = pixelOffset(light, x + 20, y + 17)
      if (
        isBrandColor(
          light.data[lightOffset],
          light.data[lightOffset + 1],
          light.data[lightOffset + 2]
        )
      ) {
        dark.data[targetOffset] = light.data[lightOffset]
        dark.data[targetOffset + 1] = light.data[lightOffset + 1]
        dark.data[targetOffset + 2] = light.data[lightOffset + 2]
        dark.data[targetOffset + 3] = 255
        continue
      }
      dark.data[targetOffset] = dark.data[backgroundOffset]
      dark.data[targetOffset + 1] = dark.data[backgroundOffset + 1]
      dark.data[targetOffset + 2] = dark.data[backgroundOffset + 2]
      dark.data[targetOffset + 3] = 255
    }
  }
}

function assertCursorRemoved(light, dark) {
  for (let y = 246; y <= 284; y += 1) {
    for (let x = 636; x <= 664; x += 1) {
      const offset = pixelOffset(light, x, y)
      if (
        Math.max(
          light.data[offset],
          light.data[offset + 1],
          light.data[offset + 2]
        ) < 190
      ) {
        throw new Error('亮色图标的鼠标指针修复失败')
      }
    }
  }
  for (let y = 570; y <= 606; y += 1) {
    for (let x = 540; x <= 568; x += 1) {
      const offset = pixelOffset(dark, x, y)
      const channels = [
        dark.data[offset],
        dark.data[offset + 1],
        dark.data[offset + 2]
      ]
      if (
        Math.max(...channels) - Math.min(...channels) < 20 &&
        Math.max(...channels) > 80
      ) {
        throw new Error('暗色图标的鼠标指针修复失败')
      }
    }
  }
}

async function main() {
  const lightSource = PNG.sync.read(await readFile(lightSourcePath))
  const darkSource = PNG.sync.read(await readFile(darkSourcePath))
  const lightSquare = cropSquare(lightSource, 744)
  const darkSquare = cropSquare(darkSource, 718)
  repairLightCursor(lightSquare)
  repairDarkCursor(darkSquare, lightSquare)
  assertCursorRemoved(lightSquare, darkSquare)

  const light = resize(lightSquare, 512, 512, 'bicubicInterpolation')
  const dark = resize(darkSquare, 512, 512, 'bicubicInterpolation')
  const lightPng = PNG.sync.write(light)
  const darkPng = PNG.sync.write(dark)
  const rendererLightPng = PNG.sync.write(
    resize(light, 128, 128, 'bicubicInterpolation')
  )
  const rendererDarkPng = PNG.sync.write(
    resize(dark, 128, 128, 'bicubicInterpolation')
  )
  await mkdir(rendererAssetRoot, { recursive: true })

  const outputs = [
    [join(root, 'build', 'icon-light.png'), lightPng],
    [join(root, 'build', 'icon-dark.png'), darkPng],
    [join(root, 'build', 'icon.png'), lightPng],
    [join(rendererAssetRoot, 'goodbuddy-light.png'), rendererLightPng],
    [join(rendererAssetRoot, 'goodbuddy-dark.png'), rendererDarkPng]
  ]
  await Promise.all(outputs.map(([path, contents]) => writeFile(path, contents)))

  const lightIco = await pngToIco(lightPng)
  const darkIco = await pngToIco(darkPng)
  await Promise.all([
    writeFile(join(root, 'build', 'icon-light.ico'), lightIco),
    writeFile(join(root, 'build', 'icon-dark.ico'), darkIco),
    writeFile(join(root, 'build', 'icon.ico'), lightIco)
  ])
}

await main()
