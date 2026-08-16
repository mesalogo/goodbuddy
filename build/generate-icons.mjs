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
const websiteAssetRoot = join(root, 'sites', 'assets')

const lightTile = {
  left: 40,
  top: 32,
  right: 704,
  bottom: 696,
  radius: 126,
  edgeColor: [255, 255, 255]
}

const darkTile = {
  left: 20,
  top: 16,
  right: 684,
  bottom: 680,
  radius: 126,
  edgeColor: [15, 21, 31]
}

function cropSquare(source, size) {
  const output = new PNG({ width: size, height: size })
  PNG.bitblt(source, output, 0, 0, size, size, 0, 0)
  return output
}

function scaleTile(tile, sourceSize, targetSize) {
  const scale = targetSize / sourceSize
  return {
    left: tile.left * scale,
    top: tile.top * scale,
    right: tile.right * scale,
    bottom: tile.bottom * scale,
    radius: tile.radius * scale,
    edgeColor: tile.edgeColor
  }
}

function cropTile(source, tile) {
  const width = Math.round(tile.right - tile.left)
  const height = Math.round(tile.bottom - tile.top)
  if (width !== height || width <= 0) {
    throw new Error('图标卡片裁剪区域必须是有效正方形')
  }
  const output = new PNG({ width, height })
  PNG.bitblt(
    source,
    output,
    Math.round(tile.left),
    Math.round(tile.top),
    width,
    height,
    0,
    0
  )
  return {
    image: output,
    tile: {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      radius: tile.radius,
      edgeColor: tile.edgeColor
    }
  }
}

function roundedRectangleDistance(x, y, tile) {
  const centerX = (tile.left + tile.right) / 2
  const centerY = (tile.top + tile.bottom) / 2
  const halfWidth = (tile.right - tile.left) / 2
  const halfHeight = (tile.bottom - tile.top) / 2
  const offsetX = Math.abs(x - centerX) - (halfWidth - tile.radius)
  const offsetY = Math.abs(y - centerY) - (halfHeight - tile.radius)
  return (
    Math.hypot(Math.max(offsetX, 0), Math.max(offsetY, 0)) +
    Math.min(Math.max(offsetX, offsetY), 0) -
    tile.radius
  )
}

function applyRoundedTransparency(image, tile) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = pixelOffset(image, x, y)
      const distance = roundedRectangleDistance(x + 0.5, y + 0.5, tile)
      const coverage = Math.min(Math.max(0.5 - distance, 0), 1)
      if (coverage >= 1) {
        if (distance > -2 && image.data[offset + 3] < 255) {
          image.data[offset] = tile.edgeColor[0]
          image.data[offset + 1] = tile.edgeColor[1]
          image.data[offset + 2] = tile.edgeColor[2]
        }
        continue
      }
      image.data[offset] = tile.edgeColor[0]
      image.data[offset + 1] = tile.edgeColor[1]
      image.data[offset + 2] = tile.edgeColor[2]
      image.data[offset + 3] = Math.round(
        image.data[offset + 3] * coverage
      )
    }
  }
}

function createRoundedIcon(source, tile, size) {
  const cropped = cropTile(source, tile)
  applyRoundedTransparency(cropped.image, cropped.tile)
  const output = resize(
    cropped.image,
    size,
    size,
    'bicubicInterpolation'
  )
  applyRoundedTransparency(
    output,
    scaleTile(cropped.tile, cropped.image.width, size)
  )
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

function assertTransparentCorners(image, label) {
  const corners = [
    pixelOffset(image, 0, 0),
    pixelOffset(image, image.width - 1, 0),
    pixelOffset(image, 0, image.height - 1),
    pixelOffset(image, image.width - 1, image.height - 1)
  ]
  if (corners.some((offset) => image.data[offset + 3] !== 0)) {
    throw new Error(`${label} 的圆角外侧必须透明`)
  }
}

function assertDarkEdgeHasNoWhiteFringe(image) {
  const edgeWidth = Math.max(4, Math.round(image.width * 0.08))
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (
        x >= edgeWidth &&
        x < image.width - edgeWidth &&
        y >= edgeWidth &&
        y < image.height - edgeWidth
      ) {
        continue
      }
      const offset = pixelOffset(image, x, y)
      const alpha = image.data[offset + 3]
      if (
        alpha > 0 &&
        alpha < 255 &&
        Math.max(
          image.data[offset],
          image.data[offset + 1],
          image.data[offset + 2]
        ) > 96
      ) {
        throw new Error(
          `暗色图标的透明边缘仍包含白色像素：${x},${y} ` +
            `rgba(${image.data[offset]},${image.data[offset + 1]},` +
            `${image.data[offset + 2]},${alpha})`
        )
      }
    }
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

  const taskbar = createTaskbarIcon(lightSquare)
  const light = createRoundedIcon(lightSquare, lightTile, 512)
  const dark = createRoundedIcon(darkSquare, darkTile, 512)
  const rendererLight = createRoundedIcon(lightSquare, lightTile, 128)
  const rendererDark = createRoundedIcon(darkSquare, darkTile, 128)
  assertTaskbarIcon(taskbar)
  assertTransparentCorners(light, '亮色图标')
  assertTransparentCorners(dark, '暗色图标')
  assertTransparentCorners(rendererLight, '亮色界面图标')
  assertTransparentCorners(rendererDark, '暗色界面图标')
  assertTransparentCorners(taskbar, '任务栏图标')
  assertDarkEdgeHasNoWhiteFringe(dark)
  assertDarkEdgeHasNoWhiteFringe(rendererDark)
  const tray = resize(taskbar, 32, 32, 'bicubicInterpolation')
  assertTransparentCorners(tray, '托盘图标')
  const lightPng = PNG.sync.write(light)
  const darkPng = PNG.sync.write(dark)
  const taskbarPng = PNG.sync.write(taskbar)
  const trayPng = PNG.sync.write(tray)
  const rendererLightPng = PNG.sync.write(rendererLight)
  const rendererDarkPng = PNG.sync.write(rendererDark)
  await Promise.all([
    mkdir(rendererAssetRoot, { recursive: true }),
    mkdir(websiteAssetRoot, { recursive: true })
  ])

  const outputs = [
    [join(root, 'build', 'icon-light.png'), lightPng],
    [join(root, 'build', 'icon-dark.png'), darkPng],
    [join(root, 'build', 'icon.png'), lightPng],
    [join(root, 'build', 'icon-taskbar.png'), taskbarPng],
    [join(root, 'build', 'icon-tray.png'), trayPng],
    [join(rendererAssetRoot, 'goodbuddy-light.png'), rendererLightPng],
    [join(rendererAssetRoot, 'goodbuddy-dark.png'), rendererDarkPng],
    [join(websiteAssetRoot, 'goodbuddy-light.png'), rendererLightPng],
    [join(websiteAssetRoot, 'goodbuddy-dark.png'), rendererDarkPng]
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
