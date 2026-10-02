import { ArrowDown, FileText, Sparkles } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import type { TimeFormatLocale } from "./time-format";

export const messageRenderBatchSize = 80;
/**
 * A freshly mounted pane first renders only this many trailing messages, which
 * fill the viewport, and renders the rest of its batch after the first paint.
 * Opening a long conversation then costs roughly a quarter of the Markdown and
 * layout work before anything is shown.
 */
export const initialMessageRenderCount = 20;
/**
 * The rest of the batch is caught up in steps of this many messages, one step
 * per frame, so no single catch-up commit becomes a long frame.
 */
export const catchUpMessageRenderStep = 20;
const chatBottomProximity = 96;

type ChatQuickAction = {
  title: string;
  description: string;
  prompt: string;
};

export type ChatScrollSnapshot = {
  pinnedToBottom: boolean;
  scrollTop: number;
};

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
  const scrollRef = useRef<HTMLElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(scrollSnapshot?.pinnedToBottom ?? true);
  const latestScrollSnapshotRef = useRef(scrollSnapshot);
  const restorePendingRef = useRef(true);
  const wasActiveRef = useRef(false);
  const followFrameRef = useRef<number | undefined>(undefined);
  const prependScrollPositionRef = useRef<
    | {
        scrollHeight: number;
        scrollTop: number;
      }
    | undefined
  >(undefined);
  const finalRevealedMessageIdRef = useRef<string | undefined>(undefined);
  const messageArticleRefs = useRef(new Map<string, HTMLElement>());
  const previousMessageCountRef = useRef(conversation.messages.length);
  const [showScrollToBottom, setShowScrollToBottom] = useState(
    scrollSnapshot ? !scrollSnapshot.pinnedToBottom : false,
  );
  // Only a pane that opens at the bottom renders in steps. A saved scroll
  // position or a note target refers to the full batch, so those render it
  // at once. `undefined` means the full batch is rendered.
  const [initialRenderLimit, setInitialRenderLimit] = useState<
    number | undefined
  >(() =>
    (scrollSnapshot === undefined || scrollSnapshot.pinnedToBottom) &&
    noteMessageNavigation?.conversationId !== conversation.id &&
    Math.min(visibleMessageCount, conversation.messages.length) >
      initialMessageRenderCount
      ? initialMessageRenderCount
      : undefined,
  );
  const [steppedVisibleMessageCount] = useState(visibleMessageCount);
  // Stepping only covers the batch the pane opened with. A changed batch
  // ("load earlier", note navigation) or a note target for this pane ends the
  // stepping and renders the full batch at once. Adjusting state during
  // render avoids committing a partial step first.
  const stopStepping =
    initialRenderLimit !== undefined &&
    (visibleMessageCount !== steppedVisibleMessageCount ||
      noteMessageNavigation?.conversationId === conversation.id);
  if (stopStepping) setInitialRenderLimit(undefined);
  const steppingLimit = stopStepping ? undefined : initialRenderLimit;
  const initialRenderScrollRef = useRef<
    { scrollHeight: number; scrollTop: number } | undefined
  >(undefined);
  const initialRenderTarget = Math.min(
    visibleMessageCount,
    conversation.messages.length,
  );
  useEffect(() => {
    if (steppingLimit === undefined) return;
    // Grow by one step once the previous step has been painted. A plain
    // update, not a transition: streaming rows commit synchronously many times
    // per second and would keep restarting a transition (see
    // live-message-store).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        const scrollContainer = scrollRef.current;
        initialRenderScrollRef.current = scrollContainer
          ? {
              scrollHeight: scrollContainer.scrollHeight,
              scrollTop: scrollContainer.scrollTop,
            }
          : undefined;
        const nextLimit = steppingLimit + catchUpMessageRenderStep;
        setInitialRenderLimit(
          nextLimit >= initialRenderTarget ? undefined : nextLimit,
        );
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [steppingLimit, initialRenderTarget]);
  const renderedMessageCount =
    steppingLimit === undefined
      ? visibleMessageCount
      : Math.min(visibleMessageCount, steppingLimit);
  const visibleMessageStartIndex = Math.max(
    0,
    conversation.messages.length - renderedMessageCount,
  );
  const visibleMessages = useMemo(
    () => conversation.messages.slice(visibleMessageStartIndex),
    [conversation.messages, visibleMessageStartIndex],
  );
  // The "load earlier" control reflects the real batch, not the partial step.
  const hiddenMessageCount = Math.max(
    0,
    conversation.messages.length - visibleMessageCount,
  );

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
    const observer = new ResizeObserver(() => {
      measure();
      if (restorePendingRef.current || !pinnedToBottomRef.current) return;
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'auto' });
    });
    observer.observe(context);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!active || noteMessageNavigation?.conversationId !== conversation.id) return;
    const element = messageArticleRefs.current.get(noteMessageNavigation.messageId);
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.scrollIntoView?.({ block: 'center' });
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, conversation.id, noteMessageNavigation, visibleMessageCount]);

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

  const saveScrollPosition = useCallback(
    (scrollContainer: HTMLElement): boolean => {
      const distanceFromBottom =
        scrollContainer.scrollHeight -
        scrollContainer.scrollTop -
        scrollContainer.clientHeight;
      const pinnedToBottom = distanceFromBottom <= chatBottomProximity;
      latestScrollSnapshotRef.current = {
        pinnedToBottom,
        scrollTop: scrollContainer.scrollTop,
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
    if (!scrollContainer) {
      return;
    }
    const atBottom = saveScrollPosition(scrollContainer);
    pinnedToBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, [saveScrollPosition]);

  useLayoutEffect(() => {
    const previousMessageCount = previousMessageCountRef.current;
    if (
      conversation.messages
        .slice(previousMessageCount)
        .some((message) => message.role === "user")
    ) {
      pinnedToBottomRef.current = true;
    }
    previousMessageCountRef.current = conversation.messages.length;
  }, [conversation.messages]);

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
    if (restorePendingRef.current) {
      restorePendingRef.current = false;
      if (scrollSnapshot && !scrollSnapshot.pinnedToBottom) {
        pinnedToBottomRef.current = false;
        scrollContainer.scrollTop = scrollSnapshot.scrollTop;
        return;
      }
    } else if (activated && !pinnedToBottomRef.current) {
      // Hidden panes may lose scrollTop when the browser detaches or re-lays
      // them out; restore the reader's last position instead of the top.
      const saved = latestScrollSnapshotRef.current;
      if (saved && !saved.pinnedToBottom) {
        scrollContainer.scrollTop = saved.scrollTop;
        return;
      }
    }
    if (!pinnedToBottomRef.current) {
      return;
    }
    if (activated) {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: "auto",
      });
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
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    });
  }, [active, conversation.messages, scrollSnapshot, visibleMessageCount]);

  useEffect(
    () => () => {
      if (followFrameRef.current !== undefined) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = undefined;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const previous = prependScrollPositionRef.current;
    if (!previous) {
      return;
    }
    prependScrollPositionRef.current = undefined;
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainer.scrollTop =
      previous.scrollTop +
      (scrollContainer.scrollHeight - previous.scrollHeight);
    const finalRevealedMessageId = finalRevealedMessageIdRef.current;
    finalRevealedMessageIdRef.current = undefined;
    if (finalRevealedMessageId) {
      messageArticleRefs.current
        .get(finalRevealedMessageId)
        ?.focus({ preventScroll: true });
    }
  }, [visibleMessageCount]);

  // Each catch-up step lands above what the reader sees: stay at the bottom,
  // or keep the reader's place if they already scrolled up.
  useLayoutEffect(() => {
    const previous = initialRenderScrollRef.current;
    initialRenderScrollRef.current = undefined;
    const scrollContainer = scrollRef.current;
    if (!previous || !scrollContainer) return;
    scrollContainer.scrollTop = pinnedToBottomRef.current
      ? scrollContainer.scrollHeight
      : previous.scrollTop +
        (scrollContainer.scrollHeight - previous.scrollHeight);
  }, [initialRenderLimit]);

  const revealEarlierMessages = useCallback((): void => {
    setInitialRenderLimit(undefined);
    const scrollContainer = scrollRef.current;
    if (scrollContainer) {
      prependScrollPositionRef.current = {
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop,
      };
    }
    if (
      visibleMessageCount + messageRenderBatchSize >=
      conversation.messages.length
    ) {
      finalRevealedMessageIdRef.current = conversation.messages[0]?.id;
    }
    onVisibleMessageCountChange(
      conversation.id,
      visibleMessageCount + messageRenderBatchSize,
    );
  }, [
    conversation.id,
    conversation.messages,
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
        <div className="chat-content">
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
            messages={visibleMessages}
            messageStartIndex={visibleMessageStartIndex}
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
            renderAssistantHtml={conversationHtmlRenderingEnabled}
            retryContent={
              conversation.messages.at(-2)?.role === "user"
                ? conversation.messages.at(-2)?.content
                : undefined
            }
            totalMessageCount={conversation.messages.length}
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
