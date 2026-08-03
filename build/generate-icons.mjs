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

function createTaskbarIcon(source) {
  const output = new PNG({ width: 640, height: 640 })
  const bounds = {
    left: 80,
    top: 90,
    right: 660,
    bottom: 535
  }
  const offsetX = 30
  const offsetY = 90
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const sourceOffset = pixelOffset(source, x, y)
      const red = source.data[sourceOffset]
      const green = source.data[sourceOffset + 1]
      const blue = source.data[sourceOffset + 2]
      const maximum = Math.max(red, green, blue)
      const minimum = Math.min(red, green, blue)
      const insideFace =
        Math.hypot(x - 244, y - 380) <= 96 ||
        Math.hypot(x - 490, y - 380) <= 96
      const keep =
        isBrandColor(red, green, blue) ||
        maximum < 110 ||
        (insideFace && minimum > 210)
      if (!keep) {
        continue
      }
      const targetX = x - bounds.left + offsetX
      const targetY = y - bounds.top + offsetY
      const targetOffset = pixelOffset(output, targetX, targetY)
      for (let channel = 0; channel < 4; channel += 1) {
        output.data[targetOffset + channel] =
          source.data[sourceOffset + channel]
      }
    }
  }
  return resize(output, 512, 512, 'bicubicInterpolation')
}

function assertTaskbarIcon(image) {
  let visiblePixels = 0
  let colorfulPixels = 0
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] < 16) {
      continue
    }
    visiblePixels += 1
    if (
      isBrandColor(
        image.data[index],
        image.data[index + 1],
        image.data[index + 2]
      )
    ) {
      colorfulPixels += 1
    }
  }
  if (
    image.data[pixelOffset(image, 0, 0) + 3] !== 0 ||
    visiblePixels < 40_000 ||
    colorfulPixels < 20_000
  ) {
    throw new Error('Windows 任务栏图标生成失败')
  }
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
  const taskbar = createTaskbarIcon(lightSquare)
  assertTaskbarIcon(taskbar)
  const tray = resize(taskbar, 32, 32, 'bicubicInterpolation')
  const lightPng = PNG.sync.write(light)
  const darkPng = PNG.sync.write(dark)
  const taskbarPng = PNG.sync.write(taskbar)
  const trayPng = PNG.sync.write(tray)
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
    [join(root, 'build', 'icon-taskbar.png'), taskbarPng],
    [join(root, 'build', 'icon-tray.png'), trayPng],
    [join(rendererAssetRoot, 'goodbuddy-light.png'), rendererLightPng],
    [join(rendererAssetRoot, 'goodbuddy-dark.png'), rendererDarkPng]
  ]
  await Promise.all(outputs.map(([path, contents]) => writeFile(path, contents)))

  const lightIco = await pngToIco(lightPng)
  const darkIco = await pngToIco(darkPng)
  const taskbarIco = await pngToIco(taskbarPng)
  await Promise.all([
    writeFile(join(root, 'build', 'icon-light.ico'), lightIco),
    writeFile(join(root, 'build', 'icon-dark.ico'), darkIco),
    writeFile(join(root, 'build', 'icon.ico'), lightIco),
    writeFile(join(root, 'build', 'icon-taskbar.ico'), taskbarIco)
  ])
}

await main()
