import { ArrowDown, FileText, Sparkles } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { AssistantArtifact } from "../../shared/assistant-contracts";
import type {
  AgentQuestionAnswer,
  ApprovalDecision,
  KnowledgeSearchReference,
} from "../../shared/contracts";
import type { ImageOperation } from "../../shared/image-generation-contracts";
import { ChatTimeline, type ImageViewerItem, type Message } from "./ChatTimeline";
import { isUnusedConversation, type Conversation } from "./chat-conversation";
import {
  buildSegments,
  maxRenderedMessageCount,
  overscanFor,
  rangeAround,
  rangeCovers,
  rowAtOffset,
  rowHeightsFor,
  tailRange,
  type MessageRowHeights,
  type MessageWindowRange,
} from "./chat-message-window";
import type { TimeFormatLocale } from "./time-format";

/**
 * Messages added to the scrollable history per "load earlier" step. Only the
 * rows near the viewport are mounted (PERF-14), so this bounds how far the
 * reader can scroll, not how much DOM exists.
 */
export const messageRenderBatchSize = 80;
const chatBottomProximity = 96;

type ChatQuickAction = {
  title: string;
  description: string;
  prompt: string;
};

export type ChatScrollSnapshot = {
  pinnedToBottom: boolean;
  scrollTop: number;
  /**
   * First row visible at the viewport top and its offset from the viewport
   * top. Restoring by row survives estimated spacer heights changing.
   */
  anchorMessageId?: string;
  anchorOffset?: number;
};

type ViewState =
  | { mode: "bottom" }
  | { mode: "range"; start: number; end: number; toEnd: boolean };

const bottomView: ViewState = { mode: "bottom" };

type ScrollAnchor = { id: string; top: number };

type PaneModel = {
  messages: Message[];
  windowStart: number;
  range: MessageWindowRange;
  view: ViewState;
};

function sizeAtFor(
  heights: MessageRowHeights,
  messages: readonly Message[],
): (index: number) => number {
  return (index) => heights.size(messages[index]?.id ?? "");
}

function viewAround(
  heights: MessageRowHeights,
  messages: readonly Message[],
  windowStart: number,
  anchorIndex: number,
  anchorOffset: number,
  overscan: number = overscanFor(heights.viewport),
): ViewState {
  const viewportHeight = heights.viewport;
  const range = rangeAround({
    sizeAt: sizeAtFor(heights, messages),
    windowStart,
    count: messages.length,
    viewportHeight,
    overscan,
    anchorIndex,
    anchorOffset,
  });
  return {
    mode: "range",
    start: range.start,
    end: range.end,
    toEnd: range.end >= messages.length,
  };
}

/** Margin past the viewport that must stay mounted before re-windowing. */
const scrollRewindowMargin = 160;

/** Margin mounted on each side when the scroll position re-windows. */
function scrollRenderOverscan(viewportHeight: number): number {
  return Math.max(800, Math.round(viewportHeight * 1.5));
}

function hasLayout(element: HTMLElement): boolean {
  return element.getBoundingClientRect().height > 0;
}

/**
 * Top of the reading area: the scroller's top plus the content's top padding.
 * Frosted glass moves the scroller under the topbar and grows the padding by
 * the same amount, so anchoring to this edge keeps rows where the reader saw
 * them when the effect is toggled.
 */
function readerTop(container: HTMLElement): number {
  const top = container.getBoundingClientRect().top;
  const content = container.querySelector<HTMLElement>(".chat-content");
  if (!content) return top;
  const padding = Number.parseFloat(getComputedStyle(content).paddingTop);
  return Number.isFinite(padding) ? top + padding : top;
}

export const ChatHistoryPane = memo(function ChatHistoryPane({
  onAddToNote,
  noteMessageNavigation,
  onOpenImageModelSettings,
  onReselectImageSources,
  onEditImage,
  active,
  artifactById,
  conversationHtmlRenderingEnabled,
  conversation,
  locale,
  onCopyMessage,
  onDownloadImage,
  onOpenCitationContext,
  onOpenCitationSource,
  onOpenImage,
  onRespondApproval,
  onRespondQuestion,
  onRetry,
  onScrollSnapshotChange,
  onSetInput,
  onVisibleMessageCountChange,
  quickActions,
  scrollSnapshot,
  taskStrip,
  visibleMessageCount,
}: {
  onAddToNote?: (conversationId: string, message: Message, trigger: HTMLElement) => void;
  noteMessageNavigation?: { conversationId: string; messageId: string; requestId: number };
  onOpenImageModelSettings: () => void;
  onReselectImageSources: (operation: ImageOperation) => void;
  onEditImage: (artifact: AssistantArtifact) => void;
  active: boolean;
  artifactById: ReadonlyMap<string, AssistantArtifact>;
  conversationHtmlRenderingEnabled: boolean;
  conversation: Conversation;
  locale: TimeFormatLocale;
  onCopyMessage: (content: string, kind?: 'tool') => Promise<boolean>;
  onDownloadImage: (item: ImageViewerItem) => void;
  onOpenCitationContext: (reference: KnowledgeSearchReference) => Promise<void>;
  onOpenCitationSource: (reference: KnowledgeSearchReference) => Promise<void>;
  onOpenImage: (item: ImageViewerItem, trigger: HTMLElement) => void;
  onRespondApproval: (
    conversationId: string,
    messageId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  onRespondQuestion: (
    conversationId: string,
    messageId: string,
    questionId: string,
    answers?: AgentQuestionAnswer[],
  ) => Promise<void>;
  onRetry: (content: string) => void;
  onScrollSnapshotChange: (
    conversationId: string,
    snapshot: ChatScrollSnapshot,
  ) => void;
  onSetInput: (value: string) => void;
  onVisibleMessageCountChange: (conversationId: string, count: number) => void;
  quickActions: ChatQuickAction[];
  scrollSnapshot?: ChatScrollSnapshot;
  taskStrip?: ReactNode;
  visibleMessageCount: number;
}): React.JSX.Element {
  const { t } = useTranslation("app");
  const headingId = `chat-heading-${conversation.id}`;
  const messages = conversation.messages;
  const total = messages.length;
  // Measured row heights outlive the pane, so a conversation reopened after
  // keep-alive eviction lays out with real heights.
  const heights = rowHeightsFor(conversation.id);
  const scrollRef = useRef<HTMLElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(scrollSnapshot?.pinnedToBottom ?? true);
  const latestScrollSnapshotRef = useRef(scrollSnapshot);
  const restorePendingRef = useRef(true);
  const wasActiveRef = useRef(false);
  const followFrameRef = useRef<number | undefined>(undefined);
  const anchorRef = useRef<ScrollAnchor | undefined>(undefined);
  const prependScrollPositionRef = useRef<
    { scrollHeight: number; scrollTop: number; windowStart: number } | undefined
  >(undefined);
  // Set when measured heights re-laid out the spacers; a pinned pane then
  // corrects in the same frame instead of waiting for the follow frame.
  const measuredLayoutRef = useRef(false);
  const finalRevealedMessageIdRef = useRef<string | undefined>(undefined);
  const navigationScrolledRef = useRef<number | undefined>(undefined);
  const messageArticleRefs = useRef(new Map<string, HTMLElement>());
  const rowElementsRef = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<ResizeObserver | undefined>(undefined);
  const previousMessageCountRef = useRef(total);
  const modelRef = useRef<PaneModel | undefined>(undefined);
  const [showScrollToBottom, setShowScrollToBottom] = useState(
    scrollSnapshot ? !scrollSnapshot.pinnedToBottom : false,
  );
  // Bumped when new row heights change spacer sizes or the window size.
  const [, setMeasureVersion] = useState(0);
  // Rows kept mounted outside the range: the focused row, the first message
  // after the final "load earlier" step.
  const [keptMessageIds, setKeptMessageIds] = useState<readonly string[]>([]);

  const navigationTarget =
    noteMessageNavigation?.conversationId === conversation.id
      ? noteMessageNavigation
      : undefined;
  const navigationIndex = navigationTarget
    ? messages.findIndex((message) => message.id === navigationTarget.messageId)
    : -1;
  // The scrollable history: the trailing `visibleMessageCount` messages, plus
  // anything up to a note navigation target.
  let windowStart = Math.max(0, total - visibleMessageCount);
  if (navigationIndex >= 0 && navigationIndex < windowStart) {
    windowStart = navigationIndex;
  }
  const hiddenMessageCount = windowStart;

  const [view, setView] = useState<ViewState>(() => {
    if (navigationIndex >= 0) {
      return viewAround(heights, messages, windowStart, navigationIndex, heights.viewport / 3);
    }
    if (scrollSnapshot && !scrollSnapshot.pinnedToBottom) {
      const anchorIndex = scrollSnapshot.anchorMessageId
        ? messages.findIndex((message) => message.id === scrollSnapshot.anchorMessageId)
        : -1;
      if (anchorIndex >= windowStart) {
        return viewAround(heights, messages, windowStart, anchorIndex, scrollSnapshot.anchorOffset ?? 0);
      }
      const row = rowAtOffset(sizeAtFor(heights, messages), windowStart, total, scrollSnapshot.scrollTop);
      return viewAround(heights, messages, windowStart, row.index, row.top - scrollSnapshot.scrollTop);
    }
    return bottomView;
  });

  // A new note navigation request renders the target before scrolling to it.
  const [handledNavigation, setHandledNavigation] = useState(
    navigationIndex >= 0 ? navigationTarget?.requestId : undefined,
  );
  if (
    navigationTarget &&
    navigationIndex >= 0 &&
    navigationTarget.requestId !== handledNavigation
  ) {
    setHandledNavigation(navigationTarget.requestId);
    setView(viewAround(heights, messages, windowStart, navigationIndex, heights.viewport / 3));
  }

  // A message the user just sent brings the view back to the bottom.
  const [seenMessages, setSeenMessages] = useState(messages);
  if (seenMessages !== messages) {
    setSeenMessages(messages);
    if (
      messages.slice(seenMessages.length).some((message) => message.role === "user") &&
      view.mode !== "bottom"
    ) {
      setView(bottomView);
    }
  }

  const sizeAt = sizeAtFor(heights, messages);
  const viewportHeight = heights.viewport;
  let range: MessageWindowRange;
  if (view.mode === "bottom") {
    range = tailRange({
      sizeAt,
      windowStart,
      count: total,
      viewportHeight,
      overscan: overscanFor(viewportHeight),
    });
  } else {
    const start = Math.min(Math.max(view.start, windowStart), total);
    // A reader scrolled up near the end still sees rows appended below, up
    // to a bound; the next scroll recomputes the range.
    const end = view.toEnd
      ? Math.min(total, start + maxRenderedMessageCount * 2)
      : Math.min(Math.max(view.end, start), total);
    range = end > start
      ? { start, end }
      : tailRange({ sizeAt, windowStart, count: total, viewportHeight, overscan: overscanFor(viewportHeight) });
  }
  const rendered: number[] = [];
  for (let index = range.start; index < range.end; index += 1) rendered.push(index);
  for (const id of keptMessageIds) {
    const index = messages.findIndex((message) => message.id === id);
    if (index >= windowStart && (index < range.start || index >= range.end)) {
      rendered.push(index);
    }
  }
  rendered.sort((left, right) => left - right);
  const segments = buildSegments(heights, messages, windowStart, total, rendered);

  useLayoutEffect(() => {
    modelRef.current = { messages, windowStart, range, view };
  });

  const scrollToBottomNow = useCallback((container: HTMLElement): void => {
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
  }, []);

  /** First rendered row reaching into the viewport, relative to its top. */
  const captureAnchor = useCallback((): void => {
    const container = scrollRef.current;
    const list = listRef.current;
    if (!container || !list || !hasLayout(container)) return;
    const viewportTop = readerTop(container);
    let fallback: ScrollAnchor | undefined;
    for (const row of list.querySelectorAll<HTMLElement>(".message-window-row")) {
      const id = row.dataset.messageId;
      if (!id) continue;
      const rect = row.getBoundingClientRect();
      const anchor = { id, top: rect.top - viewportTop };
      fallback = anchor;
      if (rect.bottom > viewportTop) {
        anchorRef.current = anchor;
        return;
      }
    }
    anchorRef.current = fallback;
  }, []);

  /** Moves the scroll position so the anchor row stays where the reader saw it. */
  const correctAnchor = useCallback((): void => {
    const container = scrollRef.current;
    const anchor = anchorRef.current;
    if (!container || !anchor) return;
    const element = rowElementsRef.current.get(anchor.id);
    if (!element || !hasLayout(container)) return;
    const delta =
      element.getBoundingClientRect().top - readerTop(container) - anchor.top;
    if (Math.abs(delta) >= 0.5) container.scrollTop += delta;
  }, []);

  useLayoutEffect(() => {
    const context = contextRef.current;
    const scrollContainer = scrollRef.current;
    const content = scrollContainer?.querySelector<HTMLElement>('.chat-content');
    if (!active || !context || !scrollContainer || !content) return;
    const measure = (): void => {
      // The fixed context strip also needs space inside the scrolling content.
      // Only write on change: the variable lives on the shared scroll region,
      // so every write restyles all kept-alive panes.
      const parent = context.parentElement;
      const height = `${context.getBoundingClientRect().height}px`;
      if (parent && parent.style.getPropertyValue('--chat-context-height') !== height) {
        parent.style.setProperty('--chat-context-height', height);
      }
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    // Hidden panes have no observer, so they never measure rows.
    const observer = new ResizeObserver((entries) => {
      measure();
      let layoutChanged = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target === scrollContainer) {
          if (heights.setViewport(scrollContainer.clientHeight)) layoutChanged = true;
          continue;
        }
        const id = target.dataset?.messageId;
        if (!id) continue;
        const height = target.getBoundingClientRect().height;
        if (height > 0 && heights.set(id, height) === 'new') layoutChanged = true;
      }
      if (layoutChanged) {
        measuredLayoutRef.current = true;
        setMeasureVersion((version) => version + 1);
      }
      if (restorePendingRef.current) return;
      if (pinnedToBottomRef.current) {
        scrollToBottomNow(scrollContainer);
        return;
      }
      // A row above the reader changed height (image, Mermaid, KaTeX).
      correctAnchor();
      captureAnchor();
    });
    observer.observe(context);
    observer.observe(content);
    observer.observe(scrollContainer);
    for (const row of rowElementsRef.current.values()) observer.observe(row);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = undefined;
    };
  }, [active, captureAnchor, correctAnchor, heights, scrollToBottomNow]);

  useEffect(() => {
    if (!active || !navigationTarget) return;
    if (navigationScrolledRef.current === navigationTarget.requestId) return;
    const element = messageArticleRefs.current.get(navigationTarget.messageId);
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      navigationScrolledRef.current = navigationTarget.requestId;
      pinnedToBottomRef.current = false;
      element.scrollIntoView?.({ block: 'center' });
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
      // Keep the target mounted while it has focus, and remember the place.
      setKeptMessageIds([navigationTarget.messageId]);
      captureAnchor();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, captureAnchor, navigationTarget, view, visibleMessageCount]);

  const handleArticleRef = useCallback(
    (messageId: string, element: HTMLElement | null): void => {
      if (element) {
        messageArticleRefs.current.set(messageId, element);
      } else {
        messageArticleRefs.current.delete(messageId);
      }
    },
    [],
  );

  const handleRowRef = useCallback(
    (messageId: string, element: HTMLElement | null): void => {
      const rows = rowElementsRef.current;
      const previous = rows.get(messageId);
      if (previous && previous !== element) {
        observerRef.current?.unobserve(previous);
        rows.delete(messageId);
      }
      if (element && previous !== element) {
        rows.set(messageId, element);
        observerRef.current?.observe(element);
      }
    },
    [],
  );

  const saveScrollPosition = useCallback(
    (scrollContainer: HTMLElement): boolean => {
      const distanceFromBottom =
        scrollContainer.scrollHeight -
        scrollContainer.scrollTop -
        scrollContainer.clientHeight;
      const pinnedToBottom = distanceFromBottom <= chatBottomProximity;
      const anchor = anchorRef.current;
      latestScrollSnapshotRef.current = {
        pinnedToBottom,
        scrollTop: scrollContainer.scrollTop,
        ...(anchor ? { anchorMessageId: anchor.id, anchorOffset: anchor.top } : {}),
      };
      return pinnedToBottom;
    },
    [],
  );

  const handleScrollRef = useCallback(
    (element: HTMLElement | null): void => {
      const previous = scrollRef.current;
      if (previous && previous !== element) {
        saveScrollPosition(previous);
        if (!element && latestScrollSnapshotRef.current) {
          onScrollSnapshotChange(
            conversation.id,
            latestScrollSnapshotRef.current,
          );
        }
      }
      scrollRef.current = element;
    },
    [conversation.id, onScrollSnapshotChange, saveScrollPosition],
  );

  const updateScrollPosition = useCallback((): void => {
    const scrollContainer = scrollRef.current;
    const model = modelRef.current;
    if (!scrollContainer || !model) {
      return;
    }
    captureAnchor();
    const atBottom = saveScrollPosition(scrollContainer);
    pinnedToBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
    if (heights.setViewport(scrollContainer.clientHeight)) {
      setMeasureVersion((version) => version + 1);
    }
    const { messages: current, windowStart: start, range: currentRange } = model;
    let next: ViewState | undefined;
    if (atBottom) {
      next = bottomView;
    } else {
      const topSpacer = listRef.current?.querySelector<HTMLElement>('[data-window-spacer="top"]');
      if (!topSpacer || !hasLayout(scrollContainer)) {
        // No layout (hidden pane, tests): keep the mounted rows.
        next = model.view.mode === "bottom"
          ? { mode: "range", start: currentRange.start, end: currentRange.end, toEnd: true }
          : undefined;
      } else {
        const viewportOffset =
          scrollContainer.getBoundingClientRect().top -
          topSpacer.getBoundingClientRect().top;
        const row = rowAtOffset(sizeAtFor(heights, current), start, current.length, viewportOffset);
        // Hysteresis: re-window only when the viewport plus a small margin
        // leaves the mounted rows, then mount a wider margin, so a steady
        // scroll remounts rows every few screens instead of every event.
        const needed = viewAround(
          heights, current, start, row.index, row.top - viewportOffset,
          scrollRewindowMargin,
        );
        if (needed.mode === "range" && !rangeCovers(currentRange, needed)) {
          next = viewAround(
            heights, current, start, row.index, row.top - viewportOffset,
            scrollRenderOverscan(heights.viewport),
          );
        } else if (model.view.mode === "bottom") {
          next = {
            mode: "range",
            start: currentRange.start,
            end: currentRange.end,
            toEnd: currentRange.end >= current.length,
          };
        }
      }
    }
    if (next) setView(next);
    // Keep the focused row mounted while it scrolls out of the range.
    const focused = document.activeElement;
    const focusedRow = focused instanceof Element
      ? focused.closest<HTMLElement>(".message-window-row")
      : null;
    const focusedId =
      focusedRow && listRef.current?.contains(focusedRow)
        ? focusedRow.dataset.messageId
        : undefined;
    setKeptMessageIds((kept) => {
      const nextKept = focusedId ? [focusedId] : [];
      return kept.length === nextKept.length && kept.every((id, index) => id === nextKept[index])
        ? kept
        : nextKept;
    });
  }, [captureAnchor, heights, saveScrollPosition]);

  // Runs before the positioning effect below, so a sent message pins first.
  useLayoutEffect(() => {
    const previousMessageCount = previousMessageCountRef.current;
    if (
      messages
        .slice(previousMessageCount)
        .some((message) => message.role === "user")
    ) {
      pinnedToBottomRef.current = true;
    }
    previousMessageCountRef.current = messages.length;
  }, [messages]);

  // Positions the scroll container after every commit: restore on
  // activation, keep the reader's row in place while rows mount, unmount or
  // change size, or follow the bottom.
  useLayoutEffect(() => {
    if (!active) {
      wasActiveRef.current = false;
      return;
    }
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }
    const activated = !wasActiveRef.current;
    wasActiveRef.current = true;
    const measuredLayout = measuredLayoutRef.current;
    measuredLayoutRef.current = false;
    if (
      navigationTarget &&
      navigationIndex >= 0 &&
      navigationScrolledRef.current !== navigationTarget.requestId
    ) {
      // The navigation effect scrolls the target into view; do not follow
      // the bottom or restore an older position meanwhile.
      restorePendingRef.current = false;
      pinnedToBottomRef.current = false;
      return;
    }
    const restore = (snapshot: ChatScrollSnapshot): void => {
      pinnedToBottomRef.current = false;
      scrollContainer.scrollTop = snapshot.scrollTop;
      const anchorElement = snapshot.anchorMessageId
        ? rowElementsRef.current.get(snapshot.anchorMessageId)
        : undefined;
      if (anchorElement && hasLayout(scrollContainer)) {
        const delta =
          anchorElement.getBoundingClientRect().top -
          scrollContainer.getBoundingClientRect().top -
          (snapshot.anchorOffset ?? 0);
        if (Math.abs(delta) >= 0.5) scrollContainer.scrollTop += delta;
      }
      captureAnchor();
    };
    if (restorePendingRef.current) {
      restorePendingRef.current = false;
      if (scrollSnapshot && !scrollSnapshot.pinnedToBottom) {
        restore(scrollSnapshot);
        return;
      }
    } else if (activated && !pinnedToBottomRef.current) {
      // Hidden panes may lose scrollTop when the browser detaches or re-lays
      // them out; restore the reader's last position instead of the top.
      const saved = latestScrollSnapshotRef.current;
      if (saved && !saved.pinnedToBottom) {
        restore(saved);
        return;
      }
    }
    const prepend = prependScrollPositionRef.current;
    if (prepend && prepend.windowStart !== windowStart) {
      // Earlier messages were added above everything the reader sees.
      prependScrollPositionRef.current = undefined;
      scrollContainer.scrollTop =
        prepend.scrollTop + (scrollContainer.scrollHeight - prepend.scrollHeight);
      const finalRevealedMessageId = finalRevealedMessageIdRef.current;
      finalRevealedMessageIdRef.current = undefined;
      if (finalRevealedMessageId) {
        messageArticleRefs.current
          .get(finalRevealedMessageId)
          ?.focus({ preventScroll: true });
      }
      if (!pinnedToBottomRef.current) {
        captureAnchor();
        return;
      }
    }
    if (!pinnedToBottomRef.current) {
      correctAnchor();
      captureAnchor();
      return;
    }
    if (activated || measuredLayout) {
      scrollToBottomNow(scrollContainer);
      return;
    }
    // Streaming updates commit many times per frame. Reading scrollHeight here
    // would force a synchronous layout per commit, so follow the bottom once
    // per frame instead; rAF still runs before the frame is painted.
    if (followFrameRef.current !== undefined) {
      return;
    }
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = undefined;
      const container = scrollRef.current;
      if (!container || !pinnedToBottomRef.current) {
        return;
      }
      scrollToBottomNow(container);
    });
  });

  useEffect(
    () => () => {
      if (followFrameRef.current !== undefined) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = undefined;
      }
    },
    [],
  );

  const revealEarlierMessages = useCallback((): void => {
    const scrollContainer = scrollRef.current;
    if (scrollContainer) {
      prependScrollPositionRef.current = {
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop,
        windowStart,
      };
    }
    if (visibleMessageCount + messageRenderBatchSize >= messages.length) {
      const firstId = messages[0]?.id;
      finalRevealedMessageIdRef.current = firstId;
      // The control disappears; focus moves to the first message, which
      // must be mounted for that.
      if (firstId) setKeptMessageIds([firstId]);
    }
    onVisibleMessageCountChange(
      conversation.id,
      visibleMessageCount + messageRenderBatchSize,
    );
  }, [
    conversation.id,
    windowStart,
    messages,
    onVisibleMessageCountChange,
    visibleMessageCount,
  ]);

  const scrollToBottom = (): void => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }
    pinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
    setView(bottomView);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  return (
    <div
      aria-hidden={active ? undefined : "true"}
      className="chat-history-pane"
      data-active={active ? "true" : "false"}
      data-conversation-id={conversation.id}
      hidden={!active}
      inert={!active}
    >
      <h1 className="sr-only" id={headingId}>
        {t("chat.heading")}
      </h1>
      <div className="chat-history-context" ref={contextRef}>{taskStrip}</div>
      <section
        aria-labelledby={headingId}
        className="chat"
        id={active ? "chat-message-list" : undefined}
        onScroll={updateScrollPosition}
        ref={handleScrollRef}
      >
        <div className="chat-content" ref={listRef}>
          {isUnusedConversation(conversation) && (
            <div className="welcome">
              <div className="welcome__badge">
                <Sparkles size={18} />
              </div>
              <h2>{t("chat.welcome.title")}</h2>
              <div className="quick-actions">
                {quickActions.map((action) => (
                  <button
                    key={action.title}
                    onClick={() => onSetInput(action.prompt)}
                    type="button"
                  >
                    <span className="quick-actions__icon">
                      <FileText size={17} />
                    </span>
                    <strong>{action.title}</strong>
                    <small>{action.description}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          <ChatTimeline
            onOpenImageModelSettings={onOpenImageModelSettings}
            onReselectImageSources={onReselectImageSources}
            onEditImage={onEditImage}
            artifactById={artifactById}
            conversationId={conversation.id}
            hiddenMessageCount={hiddenMessageCount}
            isUnusedConversation={isUnusedConversation(conversation)}
            locale={locale}
            messages={messages}
            messageStartIndex={0}
            onArticleRef={handleArticleRef}
            onCopyMessage={onCopyMessage}
            onAddToNote={onAddToNote}
            onDownloadImage={onDownloadImage}
            onOpenCitationContext={onOpenCitationContext}
            onOpenCitationSource={onOpenCitationSource}
            onOpenImage={onOpenImage}
            onRespondApproval={onRespondApproval}
            onRespondQuestion={onRespondQuestion}
            onRetry={onRetry}
            onRevealEarlier={revealEarlierMessages}
            onRowRef={handleRowRef}
            renderAssistantHtml={conversationHtmlRenderingEnabled}
            retryContent={
              messages.at(-2)?.role === "user"
                ? messages.at(-2)?.content
                : undefined
            }
            segments={segments}
            totalMessageCount={total}
          />
        </div>
      </section>
      {active && showScrollToBottom && (
        <button
          aria-controls="chat-message-list"
          aria-label={t("chat.scrollToBottom")}
          className="chat-scroll-to-bottom"
          onClick={scrollToBottom}
          title={t("chat.scrollToBottom")}
          type="button"
        >
          <ArrowDown aria-hidden="true" size={18} />
        </button>
      )}
    </div>
  );
});
