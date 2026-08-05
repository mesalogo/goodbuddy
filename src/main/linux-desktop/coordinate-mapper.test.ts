import { describe, expect, it } from 'vitest'
import {
  CoordinateMapper,
  type CapturedFrameLayout,
  type DesktopLayout
} from './coordinate-mapper'

const layout: DesktopLayout = {
  revision: 7,
  capturedAt: 1_000,
  displays: [
    {
      id: 'left',
      logicalBounds: { x: -1024, y: -100, width: 1024, height: 768 },
      scale: 1.25,
      rotation: 0
    },
    {
      id: 'rotated',
      logicalBounds: { x: 0, y: 0, width: 800, height: 600 },
      scale: 2,
      rotation: 90
    }
  ]
}

const frame = (
  overrides: Partial<CapturedFrameLayout> = {}
): CapturedFrameLayout => ({
  frameId: 'frame-1',
  displayId: 'left',
  sourceBounds: { x: -1024, y: -100, width: 1024, height: 768 },
  width: 1280,
  height: 960,
  layoutRevision: 7,
  capturedAt: 1_001,
  expiresAt: 2_000,
  ...overrides
})

describe('CoordinateMapper', () => {
  it('maps negative origins and fractional display scale', () => {
    const mapper = new CoordinateMapper(() => 1_100)
    mapper.updateLayout(layout)

    expect(mapper.mapPoint({ x: -512, y: 284 }, frame())).toEqual({
      frameId: 'frame-1',
      x: 640,
      y: 480
    })
  })

  it('maps rotated displays into their physical frame orientation', () => {
    const mapper = new CoordinateMapper(() => 1_100)
    mapper.updateLayout(layout)
    const rotated = frame({
      frameId: 'rotated-frame',
      displayId: 'rotated',
      sourceBounds: { x: 0, y: 0, width: 800, height: 600 },
      width: 1200,
      height: 1600
    })

    expect(mapper.mapPoint({ x: 400, y: 300 }, rotated)).toEqual({
      frameId: 'rotated-frame',
      x: 600,
      y: 800
    })
    expect(mapper.mapPoint({ x: 0, y: 0 }, rotated)).toEqual({
      frameId: 'rotated-frame',
      x: 1199,
      y: 0
    })
  })

  it('maps bounded rectangles without crossing frame edges', () => {
    const mapper = new CoordinateMapper(() => 1_100)
    mapper.updateLayout(layout)

    expect(
      mapper.mapRect(
        { x: -1024, y: -100, width: 1024, height: 768 },
        frame()
      )
    ).toEqual({ x: 0, y: 0, width: 1280, height: 960 })
  })

  it.each([
    frame({ layoutRevision: 6 }),
    frame({ expiresAt: 1_100 }),
    frame({ width: 1270 }),
    frame({
      sourceBounds: { x: -2000, y: -100, width: 1024, height: 768 }
    })
  ])('rejects stale or inconsistent captured frame layout', (captured) => {
    const mapper = new CoordinateMapper(() => 1_100)
    mapper.updateLayout(layout)
    expect(() => mapper.mapPoint({ x: -512, y: 284 }, captured)).toThrow()
  })

  it('rejects stale and non-monotonic desktop layouts', () => {
    const mapper = new CoordinateMapper(() => 7_000)
    mapper.updateLayout(layout)
    expect(() => mapper.mapPoint({ x: -512, y: 284 }, frame())).toThrow(
      'stale'
    )
    expect(() => mapper.updateLayout(layout)).toThrow('revision is stale')
  })
})
