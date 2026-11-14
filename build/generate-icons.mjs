import console from 'node:console'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import { resize } from 'png-to-ico/lib/png.js'
import { PNG } from 'pngjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererAssetRoot = join(root, 'src', 'renderer', 'src', 'assets')
const websiteAssetRoot = join(root, 'sites', 'assets')

async function readSource(name) {
  const image = PNG.sync.read(await readFile(join(root, 'icons', name)))
  if (image.width !== image.height || image.width < 512) {
    throw new Error(`${name} must be square and at least 512 pixels wide`)
  }
  return image
}

function createIcon(source, size, rounded = false) {
  const image = resize(source, size, size, 'bicubicInterpolation')
  if (rounded) {
    const radius = size * 0.19
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = Math.max(radius - (x + 0.5), x + 0.5 - (size - radius), 0)
        const dy = Math.max(radius - (y + 0.5), y + 0.5 - (size - radius), 0)
        const coverage = Math.min(Math.max(radius + 0.5 - Math.hypot(dx, dy), 0), 1)
        const alphaOffset = (y * size + x) * 4 + 3
        image.data[alphaOffset] = Math.round(image.data[alphaOffset] * coverage)
      }
    }
  }
  const corners = [0, size - 1, (size - 1) * size, size * size - 1]
  if (corners.some((pixel) => image.data[pixel * 4 + 3] !== 0)) {
    throw new Error('Icon corners must be transparent')
  }
  return PNG.sync.write(image)
}

const [lightSource, darkSource, transparentSource, darkTransparentSource] = await Promise.all([
  readSource('g-logo-light.png'),
  readSource('g-logo-dark.png'),
  readSource('g-logo-light-transparent.png'),
  readSource('g-logo-dark-transparent.png')
])
const light = createIcon(lightSource, 512, true)
const dark = createIcon(darkSource, 512, true)
const taskbar = createIcon(transparentSource, 512)
const tray = createIcon(transparentSource, 32)
const darkTaskbar = createIcon(darkTransparentSource, 512)
const darkTray = createIcon(darkTransparentSource, 32)
const rendererLight = createIcon(lightSource, 128, true)
const rendererDark = createIcon(darkSource, 128, true)
const [lightIco, darkIco, taskbarIco, darkTaskbarIco] = await Promise.all([
  pngToIco(light),
  pngToIco(dark),
  pngToIco(taskbar),
  pngToIco(darkTaskbar)
])

await Promise.all([
  mkdir(rendererAssetRoot, { recursive: true }),
  mkdir(websiteAssetRoot, { recursive: true })
])
const outputs = [
  [join(root, 'build', 'icon-light.png'), light],
  [join(root, 'build', 'icon-dark.png'), dark],
  [join(root, 'build', 'icon.png'), light],
  [join(root, 'build', 'icon-taskbar.png'), taskbar],
  [join(root, 'build', 'icon-tray.png'), tray],
  [join(root, 'build', 'icon-taskbar-dark.png'), darkTaskbar],
  [join(root, 'build', 'icon-taskbar-dark.ico'), darkTaskbarIco],
  [join(root, 'build', 'icon-tray-dark.png'), darkTray],
  [join(root, 'build', 'icon-light.ico'), lightIco],
  [join(root, 'build', 'icon-dark.ico'), darkIco],
  [join(root, 'build', 'icon.ico'), lightIco],
  [join(root, 'build', 'icon-taskbar.ico'), taskbarIco],
  [join(rendererAssetRoot, 'goodbuddy-light.png'), rendererLight],
  [join(rendererAssetRoot, 'goodbuddy-dark.png'), rendererDark],
  [join(websiteAssetRoot, 'goodbuddy-light.png'), rendererLight],
  [join(websiteAssetRoot, 'goodbuddy-dark.png'), rendererDark]
]
await Promise.all(outputs.map(([path, contents]) => writeFile(path, contents)))
console.log(`Generated ${outputs.length} brand assets from icons/g-logo-*.png`)
