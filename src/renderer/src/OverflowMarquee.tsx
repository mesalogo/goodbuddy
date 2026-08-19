import { useCallback, useLayoutEffect, useRef } from 'react'

interface OverflowMarqueeProps {
  className?: string
  text: string
}

const marqueePixelsPerSecond = 64
const minimumMarqueeDurationMs = 1_200
const maximumMarqueeDurationMs = 8_000

export function OverflowMarquee({
  className,
  text
}: OverflowMarqueeProps): React.JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)

  const measureOverflow = useCallback((): void => {
    const container = containerRef.current
    const track = trackRef.current
    if (!container || !track) {
      return
    }

    const overflowDistance = Math.ceil(
      track.scrollWidth - container.clientWidth
    )
    if (overflowDistance <= 1) {
      delete container.dataset.overflowing
      container.style.removeProperty('--overflow-marquee-distance')
      container.style.removeProperty('--overflow-marquee-duration')
      return
    }

    const duration = Math.min(
      maximumMarqueeDurationMs,
      Math.max(
        minimumMarqueeDurationMs,
        Math.round(
          (overflowDistance / marqueePixelsPerSecond) * 1_000
        )
      )
    )
    container.dataset.overflowing = 'true'
    container.style.setProperty(
      '--overflow-marquee-distance',
      `${overflowDistance}px`
    )
    container.style.setProperty(
      '--overflow-marquee-duration',
      `${duration}ms`
    )
  }, [])

  useLayoutEffect(() => {
    measureOverflow()
    const container = containerRef.current
    const track = trackRef.current
    if (
      !container ||
      !track ||
      typeof ResizeObserver !== 'function'
    ) {
      window.addEventListener('resize', measureOverflow)
      return () =>
        window.removeEventListener('resize', measureOverflow)
    }

    const observer = new ResizeObserver(measureOverflow)
    observer.observe(container)
    observer.observe(track)
    return () => observer.disconnect()
  }, [measureOverflow, text])

  return (
    <span
      className={
        className
          ? `overflow-marquee ${className}`
          : 'overflow-marquee'
      }
      onMouseEnter={measureOverflow}
      ref={containerRef}
      title={text}
    >
      <span
        className="overflow-marquee__track"
        ref={trackRef}
      >
        {text}
      </span>
    </span>
  )
}
