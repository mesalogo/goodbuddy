import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMinimap, minimapDayStarts, minimapLines, minimapMessageColor, minimapScrollTop } from "./ChatMinimap";
import { MessageRowHeights } from "./chat-message-window";
import type { Message } from "./ChatTimeline";
import { formatDayLabel } from "./time-format";

function message(role: Message["role"], id: string, extra: Partial<Message> = {}): Message {
  return { id, role, content: id, createdAt: 1, state: "complete", ...extra } as Message;
}

function scroller(scrollHeight = 1_000, clientHeight = 200, scrollTop = 0): HTMLElement {
  const element = document.createElement("section");
  let top = scrollTop;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    offsetTop: { configurable: true, value: 0 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(scrollHeight - clientHeight, value)); },
    },
  });
  element.scrollTo = vi.fn(({ top: next }: ScrollToOptions) => {
    element.scrollTop = next ?? 0;
    element.dispatchEvent(new Event("scroll"));
  }) as typeof element.scrollTo;
  return element;
}

const messages = Array.from({ length: 20 }, (_, index) => message(index % 2 ? "assistant" : "user", `m${index}`));

describe("ChatMinimap", () => {
  let fillRect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      fillRect,
      setTransform: vi.fn(),
      set fillStyle(_value: string) {},
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("colors only by role: user blue, agent gray", () => {
    expect(minimapMessageColor(message("user", "user"))).toBe("#6d9ee8");
    expect(minimapMessageColor(message("assistant", "assistant"))).toBe("#8f98a8");
    expect(minimapMessageColor(message("assistant", "tool", { tools: [{ callId: "1" }] as never }))).toBe("#8f98a8");
    expect(minimapMessageColor(message("assistant", "failed", { state: "error", terminalStatus: "failed" }))).toBe("#8f98a8");
    expect(minimapMessageColor(message("assistant", "cancelled", { state: "error", terminalStatus: "cancelled" }))).toBe("#8f98a8");
  });

  it("clamps minimap positions to the scrollable range", () => {
    expect(minimapScrollTop(-1, 1_000, 200)).toBe(0);
    expect(minimapScrollTop(0.5, 1_000, 200)).toBe(400);
    expect(minimapScrollTop(2, 1_000, 200)).toBe(800);
  });

  it("profiles messages as wrapped text lines with blank lines and code", () => {
    const lines = minimapLines(message("assistant", "a", {
      content: `${"x".repeat(100)}\n\n\`\`\`ts\n    code\n\`\`\`\n中文`,
    }));
    expect(lines).toEqual([
      { indent: 0, width: 72 / 72, code: false },
      { indent: 0, width: 28 / 72, code: false },
      { indent: 0, width: 0, code: false },
      { indent: 4 / 72, width: 4 / 72, code: true },
      { indent: 0, width: 4 / 72, code: false },
    ]);
    expect(minimapLines(message("assistant", "empty", { content: "" }))).toHaveLength(1);
  });

  it("draws one stroke per text line in the expanded overview", () => {
    const long = [message("assistant", "long", { content: Array.from({ length: 30 }, () => "line").join("\n") }), message("user", "u")];
    const heights = new MessageRowHeights();
    heights.set("long", 900);
    heights.set("u", 100);
    const view = render(<ChatMinimap messages={long} rowHeights={heights} scrollContainerRef={{ current: scroller() }} />);
    fillRect.mockClear();
    fireEvent.pointerEnter(view.getByRole("scrollbar"));
    // 180 px block at a 3 px pitch fits all 30 lines; the user turn draws one.
    expect(fillRect).toHaveBeenCalledTimes(31);
  });

  it("spaces expanded strokes evenly across messages of different lengths", () => {
    const mixed = [
      message("assistant", "a", { content: Array.from({ length: 40 }, () => "line").join("\n") }),
      message("user", "b"),
      message("assistant", "c", { content: Array.from({ length: 3 }, () => "line").join("\n") }),
      message("assistant", "d", { content: Array.from({ length: 200 }, () => "line").join("\n") }),
    ];
    render(<ChatMinimap messages={mixed} rowHeights={new MessageRowHeights()} scrollContainerRef={{ current: scroller() }} />);
    fillRect.mockClear();
    fireEvent.pointerEnter(document.querySelector(".chat-minimap")!);
    const ys = fillRect.mock.calls.map((call) => call[1] as number);
    expect(ys.length).toBeGreaterThan(10);
    const gaps = ys.slice(1).map((y, index) => y - ys[index]!);
    // Every gap is a multiple of the same pitch (message separators skip rows).
    const pitch = Math.min(...gaps);
    for (const gap of gaps) expect(gap / pitch).toBeCloseTo(Math.round(gap / pitch), 5);
  });

  it("spans the scroller height and moves the slider synchronously on scroll", () => {
    const scroll = scroller();
    const view = render(<ChatMinimap messages={messages} rowHeights={new MessageRowHeights()} scrollContainerRef={{ current: scroll }} />);
    const rail = view.getByRole("scrollbar");
    expect(rail.style.display).toBe("");
    expect(fillRect).toHaveBeenCalledTimes(messages.length);
    const slider = rail.querySelector<HTMLElement>(".chat-minimap__viewport")!;
    expect(slider.style.height).toBe("40px");
    scroll.scrollTop = 800;
    scroll.dispatchEvent(new Event("scroll"));
    // No frame or React commit in between: the slider is already at the end.
    expect(slider.style.transform).toBe("translateY(160px)");
    expect(rail).toHaveAttribute("aria-valuenow", "100");
  });

  it("keeps the overview drawing stable while rows are measured during scrolling", () => {
    const scroll = scroller();
    const heights = new MessageRowHeights();
    const view = render(<ChatMinimap messages={messages} rowHeights={heights} scrollContainerRef={{ current: scroll }} />);
    fillRect.mockClear();
    // Scrolling mounts and measures rows: heights change, messages do not.
    heights.set("m0", 900);
    heights.set("m1", 30);
    view.rerender(<ChatMinimap messages={messages} rowHeights={heights} scrollContainerRef={{ current: scroll }} />);
    scroll.dispatchEvent(new Event("scroll"));
    expect(fillRect).not.toHaveBeenCalled();
  });

  it("places the slider on the overview span of the rows in view", () => {
    // Row 0 is tall in pixels but short in text: the overview gives it 1/20.
    const scroll = scroller(1_000, 200);
    const heights = new MessageRowHeights();
    heights.set("m0", 810);
    for (let index = 1; index < messages.length; index += 1) heights.set(`m${index}`, 10);
    const view = render(<ChatMinimap messages={messages} rowHeights={heights} scrollContainerRef={{ current: scroll }} />);
    const slider = view.getByRole("scrollbar").querySelector<HTMLElement>(".chat-minimap__viewport")!;
    // Viewport [0, 200] lies inside row 0, i.e. inside its 10 px overview block.
    expect(slider.style.transform).toBe("translateY(0px)");
    expect(slider.style.height).toBe("16px");
  });

  it("finds the first message of every local day", () => {
    const at = (day: number, hour: number) => new Date(2026, 7, day, hour).getTime();
    const dated = [
      message("user", "a", { createdAt: at(20, 9) }),
      message("assistant", "b", { createdAt: at(20, 23) }),
      message("user", "c", { createdAt: at(21, 0) }),
      message("assistant", "d", { createdAt: at(21, 8) }),
      message("user", "e", { createdAt: at(23, 12) }),
    ];
    expect(minimapDayStarts(dated)).toEqual([0, 2, 4]);
  });

  it("marks the start of each day on the rail and skips crowded markers", () => {
    const at = (day: number) => new Date(2026, 7, day, 12).getTime();
    const dated = [
      message("user", "a", { createdAt: at(20) }),
      message("assistant", "b", { createdAt: at(20) }),
      message("user", "c", { createdAt: at(21) }),
      message("assistant", "d", { createdAt: at(21) }),
    ];
    const view = render(<ChatMinimap locale="zh-CN" messages={dated} rowHeights={new MessageRowHeights()} scrollContainerRef={{ current: scroller() }} />);
    const rail = view.getByRole("scrollbar");
    const marks = () => [...rail.querySelectorAll<HTMLElement>(".chat-minimap__day")];
    // Collapsed: no markers.
    expect(marks()).toHaveLength(0);
    fireEvent.pointerEnter(rail);
    // Four 2-row messages on a 200 px rail: days start at rows 0 and 4; the
    // first label is kept half a line inside the rail.
    expect(marks().map((mark) => mark.style.transform)).toEqual(["translateY(6px)", "translateY(100px)"]);
    expect(marks().map((mark) => mark.textContent)).toEqual([
      formatDayLabel(at(20), "zh-CN"),
      formatDayLabel(at(21), "zh-CN"),
    ]);
    fireEvent.pointerLeave(rail);
    expect(marks()).toHaveLength(0);

    const crowded = Array.from({ length: 200 }, (_, index) => message("user", `x${index}`, { createdAt: at(1) + index * 86_400_000 }));
    view.rerender(<ChatMinimap locale="zh-CN" messages={crowded} rowHeights={new MessageRowHeights()} scrollContainerRef={{ current: scroller() }} />);
    fireEvent.pointerEnter(rail);
    const tops = marks().map((mark) => Number(/translateY\((.+)px\)/.exec(mark.style.transform)?.[1]));
    expect(tops.length).toBeGreaterThan(1);
    expect(tops.length).toBeLessThan(200);
    for (let index = 1; index < tops.length; index += 1) expect(tops[index]! - tops[index - 1]!).toBeGreaterThanOrEqual(14);
  });

  it("hides itself when the conversation does not scroll", () => {
    const view = render(<ChatMinimap messages={messages} rowHeights={new MessageRowHeights()} scrollContainerRef={{ current: scroller(200, 200) }} />);
    expect(view.getByRole("scrollbar", { hidden: true }).style.display).toBe("none");
  });

  it("expands on hover and redraws the wider overview", () => {
    const view = render(<ChatMinimap messages={messages} rowHeights={new MessageRowHeights()} scrollContainerRef={{ current: scroller() }} />);
    const rail = view.getByRole("scrollbar");
    fillRect.mockClear();
    fireEvent.pointerEnter(rail);
    expect(rail).toHaveAttribute("data-expanded", "true");
    expect(fillRect).toHaveBeenCalledTimes(messages.length);
    fireEvent.pointerLeave(rail);
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("jumps on track clicks, drags the slider, and pages by keyboard", () => {
    const scroll = scroller();
    const view = render(<ChatMinimap messages={messages} rowHeights={new MessageRowHeights()} scrollContainerRef={{ current: scroll }} />);
    const rail = view.getByRole("scrollbar");
    const slider = rail.querySelector<HTMLElement>(".chat-minimap__viewport")!;
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({ top: 0, height: 200, left: 0, right: 14 } as DOMRect);
    vi.spyOn(slider, "getBoundingClientRect").mockImplementation(() => {
      const top = Number(/translateY\((.+)px\)/.exec(slider.style.transform)?.[1] ?? 0);
      return { top, bottom: top + 40, height: 40 } as DOMRect;
    });
    // Track click centers the slider under the pointer: (100 - 20) / 160.
    fireEvent.pointerDown(rail, { button: 0, clientY: 100, pointerId: 1 });
    expect(scroll.scrollTop).toBe(400);
    fireEvent.pointerMove(rail, { clientY: 180, pointerId: 1 });
    expect(scroll.scrollTop).toBe(800);
    fireEvent.pointerUp(rail, { clientY: 180, pointerId: 1 });
    fireEvent.pointerMove(rail, { clientY: 0, pointerId: 1 });
    expect(scroll.scrollTop).toBe(800);
    act(() => fireEvent.keyDown(rail, { key: "Home" }));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    act(() => fireEvent.keyDown(rail, { key: "End" }));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ top: 1_000, behavior: "auto" });
  });
});
