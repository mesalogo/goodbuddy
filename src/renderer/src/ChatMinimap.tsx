import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Message } from "./ChatTimeline";
import type { MessageRowHeights } from "./chat-message-window";

/** Rail width when idle and when hovered (expanded overview), in CSS pixels. */
export const minimapCollapsedWidth = 14;
export const minimapExpandedWidth = 80;

/** Only two colors: user turns are blue, every agent turn is gray. */
export function minimapMessageColor(message: Message): string {
  return message.role === "user" ? "#6d9ee8" : "#8f98a8";
}

export function minimapScrollTop(
  pointerRatio: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  return Math.min(1, Math.max(0, pointerRatio)) * maxScrollTop;
}

/**
 * Stable overview weight of a message, in text-line units: its wrapped lines
 * plus fixed room for the header/padding and each tool row. It depends only on
 * the message content, never on measured DOM heights, so the overview keeps
 * its density while the timeline measures rows during scrolling.
 */
export function minimapMessageWeight(message: Message): number {
  return minimapLines(message).length + 3 + 2 * (message.tools?.length ?? 0);
}

/** Largest index i in [0, prefix.length - 2] with prefix[i] <= value. */
function locate(prefix: Float64Array, value: number): number {
  let low = 0;
  let high = prefix.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (prefix[middle]! <= value) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/** Maps a position on one prefix-sum axis to the other, row by row. */
function mapAxis(from: Float64Array, to: Float64Array, value: number): number {
  const count = from.length - 1;
  if (count <= 0) return 0;
  const clamped = Math.min(from[count]!, Math.max(0, value));
  const index = locate(from, clamped);
  const span = from[index + 1]! - from[index]!;
  const fraction = span > 0 ? (clamped - from[index]!) / span : 0;
  return to[index]! + fraction * (to[index + 1]! - to[index]!);
}

function prefixSums(messages: readonly Message[], size: (message: Message) => number): Float64Array {
  const prefix = new Float64Array(messages.length + 1);
  for (let index = 0; index < messages.length; index += 1) {
    prefix[index + 1] = prefix[index]! + Math.max(0, size(messages[index]!));
  }
  return prefix;
}

/** Characters per minimap text line, roughly one reading-column line. */
const minimapCharsPerLine = 72;
/** Upper bound of text lines kept per message; very long replies are sampled. */
const minimapMaxLines = 600;

/**
 * Coarse text-line profile of a message: one entry per wrapped visual line,
 * holding its indent and length as fractions of a full line. Empty entries
 * (`width === 0`) are blank lines. Code fences become indented strokes.
 */
export type MinimapLine = { indent: number; width: number; code: boolean };

const lineCache = new WeakMap<Message, MinimapLine[]>();

export function minimapLines(message: Message): MinimapLine[] {
  const cached = lineCache.get(message);
  if (cached) return cached;
  const lines: MinimapLine[] = [];
  let code = false;
  const source = message.content ?? "";
  for (const raw of source.split("\n")) {
    if (lines.length >= minimapMaxLines) break;
    if (/^\s*(```|~~~)/.test(raw)) {
      code = !code;
      continue;
    }
    const text = raw.replace(/\t/g, "  ");
    const trimmed = text.trimStart();
    if (!trimmed) {
      lines.push({ indent: 0, width: 0, code });
      continue;
    }
    const indent = Math.min(0.5, (text.length - trimmed.length) / minimapCharsPerLine);
    // Wide (CJK) characters take about two columns.
    let columns = 0;
    for (const char of trimmed) columns += char.charCodeAt(0) > 0x2e7f ? 2 : 1;
    const span = Math.max(1, Math.round(minimapCharsPerLine * (1 - indent)));
    while (columns > 0 && lines.length < minimapMaxLines) {
      const take = Math.min(span, columns);
      lines.push({ indent, width: take / minimapCharsPerLine, code });
      columns -= take;
    }
  }
  // Tool calls or attachments without text still show as one stroke.
  if (lines.length === 0) lines.push({ indent: 0, width: 0.35, code: false });
  lineCache.set(message, lines);
  return lines;
}

type ChatMinimapProps = {
  messages: readonly Message[];
  rowHeights: MessageRowHeights;
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type Drag = { pointerId: number; grabOffset: number };

/**
 * Replaces the native scrollbar of the chat scroller with a canvas overview.
 * Geometry follows the scroller on every scroll/resize event by writing styles
 * directly, so the viewport indicator never waits for a React commit.
 */
export function ChatMinimap({ messages, rowHeights, scrollContainerRef }: ChatMinimapProps): React.JSX.Element {
  const { t } = useTranslation("app");
  const railRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sliderRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<Drag | undefined>(undefined);
  const expandedRef = useRef(false);
  const drawnRef = useRef<{ width: number; height: number; messages: readonly Message[] | undefined }>({ width: 0, height: 0, messages: undefined });
  const layoutRef = useRef({ scrollable: false, railHeight: -1, percent: -1, scrollHeight: -1 });
  const dataRef = useRef({ messages, rowHeights });
  // Overview axis: stable content weights. Scroll axis: current row heights
  // (measured or estimated). The slider maps between them row by row, so the
  // drawing never changes when rows are measured during scrolling.
  const axesRef = useRef<{ messages: readonly Message[] | undefined; weights: Float64Array; pixels: Float64Array }>({
    messages: undefined, weights: new Float64Array(1), pixels: new Float64Array(1),
  });

  const refreshAxes = useCallback((): void => {
    const { messages: current, rowHeights: heights } = dataRef.current;
    const axes = axesRef.current;
    const weights = axes.messages === current ? axes.weights : prefixSums(current, minimapMessageWeight);
    axesRef.current = { messages: current, weights, pixels: prefixSums(current, (message) => heights.size(message.id)) };
  }, []);

  const draw = useCallback((force: boolean): void => {
    const canvas = canvasRef.current;
    const rail = railRef.current;
    const container = scrollContainerRef.current;
    if (!canvas || !rail || !container) return;
    const width = rail.clientWidth ||
      (expandedRef.current ? minimapExpandedWidth : minimapCollapsedWidth);
    const height = Math.max(1, rail.clientHeight || container.clientHeight);
    const { messages: current } = dataRef.current;
    const drawn = drawnRef.current;
    if (!force && drawn.width === width && drawn.height === height && drawn.messages === current) return;
    drawnRef.current = { width, height, messages: current };
    if (axesRef.current.messages !== current) refreshAxes();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const { weights } = axesRef.current;
    const totalWeight = weights[current.length] ?? 0;
    if (totalWeight <= 0) return;
    const expanded = expandedRef.current;
    const inset = expanded ? 6 : 2;
    const lineSpan = width - inset * 2;
    // Expanded rows: thin strokes on a device-pixel-friendly pitch.
    const pitch = ratio >= 2 ? 2 : 3;
    const stroke = ratio >= 2 ? 1.5 : 2;
    for (let index = 0; index < current.length; index += 1) {
      const message = current[index]!;
      const top = (weights[index]! / totalWeight) * height;
      const blockHeight = Math.max(1, ((weights[index + 1]! - weights[index]!) / totalWeight) * height);
      context.fillStyle = minimapMessageColor(message);
      if (!expanded) {
        context.fillRect(inset, top, lineSpan, blockHeight);
        continue;
      }
      // Expanded: one stroke per wrapped text line, like an editor minimap.
      // User turns are right-aligned and narrower, echoing the chat layout.
      const user = message.role === "user";
      const span = user ? lineSpan * 0.7 : lineSpan;
      const base = user ? width - inset - span : inset;
      const lines = minimapLines(message);
      const rows = Math.max(1, Math.min(lines.length, Math.floor(blockHeight / pitch)));
      const rowStep = rows > 1 ? Math.min(pitch * 1.6, blockHeight / rows) : 0;
      for (let row = 0; row < rows; row += 1) {
        const line = lines[Math.floor((row * lines.length) / rows)];
        if (!line || line.width <= 0) continue;
        const lineWidth = Math.max(2, Math.min(1, line.width) * span);
        const left = user ? base + span - lineWidth : base + line.indent * span;
        context.globalAlpha = line.code ? 0.6 : 1;
        context.fillRect(left, top + row * rowStep, Math.min(lineWidth, base + span - left), Math.min(stroke, blockHeight));
      }
      context.globalAlpha = 1;
    }
  }, [refreshAxes, scrollContainerRef]);

  /** Overview position (0..railHeight) of a scroll-content offset. */
  const toRail = (offset: number, scrollHeight: number, railHeight: number): number => {
    const { weights, pixels } = axesRef.current;
    const count = pixels.length - 1;
    const totalPixels = pixels[count] ?? 0;
    const totalWeight = weights[count] ?? 0;
    if (totalPixels <= 0 || totalWeight <= 0 || scrollHeight <= 0) return (offset / Math.max(1, scrollHeight)) * railHeight;
    // Scroll content and the row model differ only by padding; scale linearly.
    const pixel = (offset / scrollHeight) * totalPixels;
    return (mapAxis(pixels, weights, pixel) / totalWeight) * railHeight;
  };

  /** Scroll-content offset of an overview position (inverse of toRail). */
  const fromRail = (y: number, scrollHeight: number, railHeight: number): number => {
    const { weights, pixels } = axesRef.current;
    const count = pixels.length - 1;
    const totalPixels = pixels[count] ?? 0;
    const totalWeight = weights[count] ?? 0;
    if (totalPixels <= 0 || totalWeight <= 0 || railHeight <= 0) return (y / Math.max(1, railHeight)) * scrollHeight;
    const pixel = mapAxis(weights, pixels, (y / railHeight) * totalWeight);
    return (pixel / totalPixels) * scrollHeight;
  };

  /** Syncs the slider with the scroller; runs synchronously in the event. */
  const sync = useCallback((): void => {
    const rail = railRef.current;
    const slider = sliderRef.current;
    const container = scrollContainerRef.current;
    if (!rail || !slider || !container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const scrollable = scrollHeight > clientHeight + 1 && dataRef.current.messages.length > 0;
    const last = layoutRef.current;
    if (last.scrollable !== scrollable) rail.style.display = scrollable ? "" : "none";
    if (!scrollable) {
      layoutRef.current = { ...last, scrollable };
      return;
    }
    // The rail spans the reading area below the title bar and context strip
    // (CSS). Its height is read only when it may have changed, so a plain
    // scroll event does no layout reads.
    let { railHeight } = last;
    const shown = !last.scrollable;
    if (shown || railHeight < 0) railHeight = rail.clientHeight || clientHeight;
    // Row measurements change scrollHeight; only then rebuild the pixel axis.
    if (shown || last.scrollHeight !== scrollHeight || axesRef.current.messages !== dataRef.current.messages) refreshAxes();
    // The slider covers the overview span of the rows in view, so it sits
    // exactly on the strokes of the visible messages.
    let top = toRail(scrollTop, scrollHeight, railHeight);
    let bottom = toRail(scrollTop + clientHeight, scrollHeight, railHeight);
    if (bottom - top < 16) {
      const center = (top + bottom) / 2;
      top = Math.max(0, Math.min(railHeight - 16, center - 8));
      bottom = top + 16;
    }
    slider.style.height = `${bottom - top}px`;
    slider.style.transform = `translateY(${top}px)`;
    const maxScrollTop = scrollHeight - clientHeight;
    const percent = Math.round(maxScrollTop > 0 ? (scrollTop / maxScrollTop) * 100 : 0);
    if (percent !== last.percent) rail.setAttribute("aria-valuenow", String(percent));
    layoutRef.current = { scrollable, railHeight, percent, scrollHeight };
    if (shown) draw(false);
  }, [draw, refreshAxes, scrollContainerRef]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("scroll", sync, { passive: true });
    // Content growth (streaming, measurement, resize) changes scrollHeight
    // without a scroll event.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    observer?.observe(container);
    if (container.firstElementChild) observer?.observe(container.firstElementChild);
    // The rail itself shrinks when the context strip above the reading area
    // grows, independently of the scroller size.
    const rail = railRef.current;
    const railObserver = typeof ResizeObserver === "undefined" || !rail
      ? undefined
      : new ResizeObserver(() => {
        if (rail.clientHeight === layoutRef.current.railHeight) return;
        layoutRef.current = { ...layoutRef.current, railHeight: -1 };
        sync();
        draw(false);
      });
    if (rail) railObserver?.observe(rail);
    // The per-commit effect below performs the initial sync.
    return () => {
      container.removeEventListener("scroll", sync);
      observer?.disconnect();
      railObserver?.disconnect();
    };
  }, [draw, scrollContainerRef, sync]);

  // Pane commits keep the slider in sync (row measurements move scrollHeight).
  // The canvas redraws only when the message list itself changes; draw()
  // compares identities, so measurement-only commits never repaint it.
  useLayoutEffect(() => {
    dataRef.current = { messages, rowHeights };
    sync();
    if (layoutRef.current.scrollable) draw(false);
  });

  const scrollToSliderTop = (clientY: number, grabOffset: number): void => {
    const rail = railRef.current;
    const container = scrollContainerRef.current;
    if (!rail || !container) return;
    const bounds = rail.getBoundingClientRect();
    const target = fromRail(clientY - bounds.top - grabOffset, container.scrollHeight, bounds.height);
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    container.scrollTop = minimapScrollTop(maxScrollTop > 0 ? target / maxScrollTop : 0, container.scrollHeight, container.clientHeight);
    sync();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const slider = sliderRef.current;
    if (!slider) return;
    const sliderBounds = slider.getBoundingClientRect();
    const onSlider = event.clientY >= sliderBounds.top && event.clientY <= sliderBounds.bottom;
    // Grabbing the slider keeps its offset; clicking the track centers it.
    const grabOffset = onSlider ? event.clientY - sliderBounds.top : sliderBounds.height / 2;
    dragRef.current = { pointerId: event.pointerId, grabOffset };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    if (!onSlider) scrollToSliderTop(event.clientY, grabOffset);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) scrollToSliderTop(event.clientY, drag.grabOffset);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const setExpanded = (expanded: boolean): void => {
    if (expandedRef.current === expanded) return;
    expandedRef.current = expanded;
    const rail = railRef.current;
    if (rail) rail.dataset.expanded = expanded ? "true" : "false";
    draw(true);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const step = Math.max(1, container.clientHeight * 0.8);
    if (event.key === "Home") container.scrollTo({ top: 0, behavior: "auto" });
    else if (event.key === "End") container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    else if (event.key === "PageUp") container.scrollTo({ top: container.scrollTop - step, behavior: "auto" });
    else if (event.key === "PageDown") container.scrollTo({ top: container.scrollTop + step, behavior: "auto" });
    else return;
    event.preventDefault();
  };

  return (
    <div
      aria-controls="chat-message-list"
      aria-label={t("chat.minimap")}
      aria-orientation="vertical"
      aria-valuemax={100}
      aria-valuemin={0}
      className="chat-minimap"
      data-expanded="false"
      onKeyDown={onKeyDown}
      onLostPointerCapture={() => { dragRef.current = undefined; }}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setExpanded(true)}
      onPointerLeave={() => { if (!dragRef.current) setExpanded(false); }}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => {
        endDrag(event);
        const bounds = railRef.current?.getBoundingClientRect();
        if (bounds && (event.clientX < bounds.left || event.clientX > bounds.right)) setExpanded(false);
      }}
      onWheel={onWheel}
      ref={railRef}
      // Shown by sync() once the scroller overflows; React never rewrites it.
      style={{ display: "none" }}
      role="scrollbar"
      tabIndex={0}
    >
      <canvas aria-hidden="true" className="chat-minimap__canvas" ref={canvasRef} />
      <span aria-hidden="true" className="chat-minimap__viewport" ref={sliderRef} />
    </div>
  );
}
