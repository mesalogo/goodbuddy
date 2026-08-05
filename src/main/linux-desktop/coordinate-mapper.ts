export type DesktopPoint = {
  x: number
  y: number
}

export type DesktopRect = DesktopPoint & {
  width: number
  height: number
}

export type DisplayRotation = 0 | 90 | 180 | 270

export type DisplayLayout = {
  id: string
  logicalBounds: DesktopRect
  scale: number
  rotation: DisplayRotation
}

export type DesktopLayout = {
  revision: number
  capturedAt: number
  displays: DisplayLayout[]
}

export type CapturedFrameLayout = {
  frameId: string
  displayId: string
  sourceBounds: DesktopRect
  width: number
  height: number
  layoutRevision: number
  capturedAt: number
  expiresAt: number
}

export type FramePoint = {
  frameId: string
  x: number
  y: number
}

const finiteRect = (rect: DesktopRect): boolean =>
  Number.isFinite(rect.x) &&
  Number.isFinite(rect.y) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width > 0 &&
  rect.height > 0

const containsPoint = (rect: DesktopRect, point: DesktopPoint): boolean =>
  point.x >= rect.x &&
  point.y >= rect.y &&
  point.x < rect.x + rect.width &&
  point.y < rect.y + rect.height

const containsRect = (outer: DesktopRect, inner: DesktopRect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

export class CoordinateMapper {
  private layout: DesktopLayout | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maximumLayoutAgeMs = 5_000
  ) {}

  updateLayout(layout: DesktopLayout): void {
    if (
      !Number.isSafeInteger(layout.revision) ||
      layout.revision < 1 ||
      !Number.isFinite(layout.capturedAt) ||
      layout.displays.length === 0 ||
      layout.displays.some(
        (display) =>
          !display.id ||
          !finiteRect(display.logicalBounds) ||
          !Number.isFinite(display.scale) ||
          display.scale <= 0 ||
          display.scale > 8
      ) ||
      new Set(layout.displays.map((display) => display.id)).size !==
        layout.displays.length
    ) {
      throw new Error('Invalid desktop layout')
    }
    if (this.layout && layout.revision <= this.layout.revision) {
      throw new Error('Desktop layout revision is stale')
    }
    this.layout = structuredClone(layout)
  }

  mapPoint(
    point: DesktopPoint,
    frame: CapturedFrameLayout
  ): FramePoint {
    const { display } = this.validateFrame(frame)
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !containsPoint(frame.sourceBounds, point)
    ) {
      throw new Error('Desktop point is outside the captured frame')
    }

    const u = (point.x - frame.sourceBounds.x) / frame.sourceBounds.width
    const v = (point.y - frame.sourceBounds.y) / frame.sourceBounds.height
    const rotated = this.rotate(u, v, display.rotation)
    return {
      frameId: frame.frameId,
      x: Math.min(frame.width - 1, Math.max(0, Math.floor(rotated.x * frame.width))),
      y: Math.min(
        frame.height - 1,
        Math.max(0, Math.floor(rotated.y * frame.height))
      )
    }
  }

  mapRect(rect: DesktopRect, frame: CapturedFrameLayout): DesktopRect {
    if (!finiteRect(rect) || !containsRect(frame.sourceBounds, rect)) {
      throw new Error('Desktop rectangle is outside the captured frame')
    }
    const right = rect.x + rect.width
    const bottom = rect.y + rect.height
    const xInset = Math.min(rect.width / 2, Math.max(1e-9, rect.width * 1e-9))
    const yInset = Math.min(
      rect.height / 2,
      Math.max(1e-9, rect.height * 1e-9)
    )
    const points = [
      this.mapPoint({ x: rect.x, y: rect.y }, frame),
      this.mapPoint({ x: right - xInset, y: rect.y }, frame),
      this.mapPoint({ x: rect.x, y: bottom - yInset }, frame),
      this.mapPoint(
        { x: right - xInset, y: bottom - yInset },
        frame
      )
    ]
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return {
      x,
      y,
      width: Math.max(...xs) - x + 1,
      height: Math.max(...ys) - y + 1
    }
  }

  private validateFrame(frame: CapturedFrameLayout): {
    display: DisplayLayout
  } {
    const layout = this.layout
    if (!layout) {
      throw new Error('Desktop layout is unavailable')
    }
    if (
      this.now() - layout.capturedAt >= this.maximumLayoutAgeMs ||
      frame.layoutRevision !== layout.revision ||
      this.now() >= frame.expiresAt ||
      frame.capturedAt < layout.capturedAt
    ) {
      throw new Error('Desktop layout or captured frame is stale')
    }
    const display = layout.displays.find(
      (candidate) => candidate.id === frame.displayId
    )
    if (
      !display ||
      !frame.frameId ||
      !finiteRect(frame.sourceBounds) ||
      !containsRect(display.logicalBounds, frame.sourceBounds) ||
      !Number.isSafeInteger(frame.width) ||
      frame.width < 1 ||
      !Number.isSafeInteger(frame.height) ||
      frame.height < 1
    ) {
      throw new Error('Invalid captured frame layout')
    }
    const rotated = display.rotation === 90 || display.rotation === 270
    const expectedWidth =
      (rotated ? frame.sourceBounds.height : frame.sourceBounds.width) *
      display.scale
    const expectedHeight =
      (rotated ? frame.sourceBounds.width : frame.sourceBounds.height) *
      display.scale
    if (
      Math.abs(frame.width - expectedWidth) > 1 ||
      Math.abs(frame.height - expectedHeight) > 1
    ) {
      throw new Error('Captured frame scale does not match the display')
    }
    return { display }
  }

  private rotate(u: number, v: number, rotation: DisplayRotation): DesktopPoint {
    switch (rotation) {
      case 0:
        return { x: u, y: v }
      case 90:
        return { x: 1 - v, y: u }
      case 180:
        return { x: 1 - u, y: 1 - v }
      case 270:
        return { x: v, y: 1 - u }
    }
  }
}
