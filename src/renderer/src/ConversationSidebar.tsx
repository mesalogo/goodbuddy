import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  GitFork,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  projectChannelLabels,
  type AssistantProject,
  type AssistantSchedule,
  type AssistantTask,
} from "../../shared/assistant-contracts";
import { getConversationDisplayTitle, type Conversation } from "./chat-conversation";
import type { ConversationActivity } from "./conversation-activity";
import { useConversationList, type ConversationStore } from "./conversation-store";
import { formatMediumDateTime } from "./locale-formatters";
import type { AppNotificationInput } from "./notifications";
import { OverflowMarquee } from "./OverflowMarquee";
import { findTaskSchedule } from "./TaskScheduleActions";
import { formatConversationListTime, type TimeFormatLocale } from "./time-format";
import { useConversationListOrder } from "./use-conversation-list-order";
import { DestructiveConfirmActions } from "./WorkspacePrimitives";

/** Delay before searching message text, so typing does not scan every keystroke. */
const conversationSearchSnapshotDelayMs = 250;
const emptyConversationTasks: AssistantTask[] = [];
const emptyAssistantSchedules: AssistantSchedule[] = [];
type SearchMatches = { query: string; ids: ReadonlySet<string> };
const noSearchMatches: SearchMatches = { query: "", ids: new Set() };

export function ConversationBranchBadge({
  sourceTitle,
}: {
  sourceTitle: string;
}): React.JSX.Element {
  const { t } = useTranslation("app");
  const label = t("conversation.branch.badge", {
    title: sourceTitle,
  });
  return (
    <span
      aria-label={label}
      className="conversation-branch-badge"
      title={label}
    >
      <GitFork aria-hidden="true" size={13} />
    </span>
  );
}

export type ConversationListRowHandlers = {
  toggleTasks: (conversationId: string) => void;
  select: (conversationId: string) => void;
  toggleActions: (conversationId: string) => void;
  registerActionTrigger: (conversationId: string, element: HTMLButtonElement | null) => void;
  closeActions: (conversationId: string) => void;
  pin: (conversation: Conversation) => void;
  branch: (conversation: Conversation, disabledReason: string | undefined) => void;
  startRename: (conversationId: string) => void;
  copy: (conversation: Conversation) => void;
  exportConversation: (conversation: Conversation) => void;
  cancelDelete: () => void;
  confirmDelete: (conversationId: string) => void;
  requestDelete: (conversationId: string) => void;
  saveTitle: (conversationId: string, title: string) => void;
  cancelRename: (conversationId: string) => void;
  openTask: (task: AssistantTask) => void;
  viewAllTasks: (conversationId: string, firstTaskId: string | undefined) => void;
};

type ConversationListRowProps = {
  conversation: Conversation;
  conversationTitle: string;
  conversationTasks: readonly AssistantTask[];
  tasksExpanded: boolean;
  activity: ConversationActivity | undefined;
  branchSourceTitle: string | undefined;
  branchDisabledReason: string | undefined;
  branching: boolean;
  active: boolean;
  unread: boolean;
  actionsOpen: boolean;
  menuVisible: boolean;
  pinDisabled: boolean;
  renaming: boolean;
  confirmingDelete: boolean;
  deleting: boolean;
  selectedTaskId: string | undefined;
  schedules: readonly AssistantSchedule[];
  locale: TimeFormatLocale;
  /** Current calendar day; re-renders rows so "today" times stay correct. */
  listTimeDay: string;
  actionsRef: React.RefObject<HTMLDivElement | null>;
  handlers: ConversationListRowHandlers;
};

// Rows skip re-rendering unless their own props change, so streaming into one
// conversation re-renders only that row instead of the whole list.
const ConversationListRow = memo(function ConversationListRow({
  conversation,
  conversationTitle,
  conversationTasks,
  tasksExpanded,
  activity,
  branchSourceTitle,
  branchDisabledReason,
  branching,
  active,
  unread,
  actionsOpen,
  menuVisible,
  pinDisabled,
  renaming,
  confirmingDelete,
  deleting,
  selectedTaskId,
  schedules,
  locale,
  listTimeDay,
  actionsRef,
  handlers,
}: ConversationListRowProps): React.JSX.Element {
  void listTimeDay;
  const { t } = useTranslation("app");
  const { t: tWorkspace } = useTranslation("workspace");
  const branchDisabledReasonId = `conversation-branch-disabled-${conversation.id}`;
  return (
    <div className="conversation-entry" key={conversation.id}>
      <div className="conversation-row">
        {conversationTasks.length > 0 && (
          <button
            aria-expanded={tasksExpanded}
            aria-label={t("conversation.tasks.toggle", {
              title: conversationTitle,
              count: conversationTasks.length,
            })}
            className="conversation-task-toggle"
            onClick={() => handlers.toggleTasks(conversation.id)}
            type="button"
          >
            {tasksExpanded ? (
              <ChevronDown aria-hidden="true" size={13} />
            ) : (
              <ChevronRight aria-hidden="true" size={13} />
            )}
          </button>
        )}
        <button
          className={
            active
              ? "conversation-item conversation-item--active"
              : "conversation-item"
          }
          type="button"
          onClick={() => handlers.select(conversation.id)}
        >
          <span className="conversation-item__primary">
            {conversation.pinned && (
              <span className="conversation-pin">
                <Pin size={13} role="img" aria-label={t("conversation.actions.pinned")}><title>{t("conversation.actions.pinned")}</title></Pin>
              </span>
            )}
            {branchSourceTitle && (
              <ConversationBranchBadge
                sourceTitle={branchSourceTitle}
              />
            )}
            {conversation.remote && (
              <b className="conversation-source-badge">
                {projectChannelLabels[conversation.remote.channel]}
              </b>
            )}
            <OverflowMarquee
              className="conversation-item__title"
              text={conversationTitle}
            />
            {unread && (
              <i
                aria-label={t("conversation.unread")}
                className="conversation-unread"
                title={t("conversation.unreadRemote")}
              />
            )}
          </span>
          <small>
            <time
              dateTime={new Date(
                conversation.updatedAt,
              ).toISOString()}
              title={formatMediumDateTime(
                conversation.updatedAt,
                locale,
              )}
            >
              {formatConversationListTime(
                conversation.updatedAt,
                locale,
              )}
            </time>
          </small>
        </button>
        {activity && (
          <span
            aria-label={activity.status === "running"
              ? t("conversation.active")
              : tWorkspace(`projectActivity.status.${activity.status}`)}
            className={activity.status === "running"
              ? "conversation-activity-indicator"
              : "conversation-activity-indicator conversation-activity-indicator--attention"}
            role="status"
            title={tWorkspace(`projectActivity.status.${activity.status}`)}
          />
        )}
        <button
          aria-controls={`conversation-actions-${conversation.id}`}
          aria-haspopup="menu"
          aria-expanded={actionsOpen}
          aria-label={t("conversation.actions.more", {
            title: conversationTitle,
          })}
          className="conversation-more"
          onClick={() => handlers.toggleActions(conversation.id)}
          ref={(element) => handlers.registerActionTrigger(conversation.id, element)}
          type="button"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {menuVisible && createPortal(
        <div
          ref={actionsRef}
          role="menu"
          onKeyDown={(event) => {
            if (event.defaultPrevented) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              handlers.closeActions(conversation.id);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([aria-disabled="true"])'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}
          aria-label={t("conversation.actions.region", {
            title: conversationTitle,
          })}
          className="conversation-actions"
          id={`conversation-actions-${conversation.id}`}
        >
          <button role="menuitem" type="button" disabled={pinDisabled} onClick={() => handlers.pin(conversation)}>
            {conversation.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {t(conversation.pinned ? "conversation.actions.unpin" : "conversation.actions.pin")}
          </button>
          {!conversation.remote && (
            <>
              <button
                role="menuitem"
                aria-describedby={
                  branchDisabledReason
                    ? branchDisabledReasonId
                    : undefined
                }
                aria-disabled={
                  branchDisabledReason ? true : undefined
                }
                onClick={() => handlers.branch(conversation, branchDisabledReason)}
                title={branchDisabledReason}
                type="button"
              >
                <GitFork
                  aria-hidden="true"
                  className="conversation-branch-icon"
                  size={14}
                />
                {branching
                  ? t("conversation.branch.creating")
                  : t("conversation.actions.branch")}
              </button>
              {branchDisabledReason && (
                <span
                  className="sr-only"
                  id={branchDisabledReasonId}
                >
                  {branchDisabledReason}
                </span>
              )}
            </>
          )}
          {!conversation.remote && (
            <button
              role="menuitem"
              onClick={() => handlers.startRename(conversation.id)}
              type="button"
            >
              <Edit3 size={14} />
              {t("conversation.actions.rename")}
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => handlers.copy(conversation)}
            type="button"
          >
            <Copy size={14} />
            {t("conversation.actions.copy")}
          </button>
          <button
            role="menuitem"
            onClick={() => handlers.exportConversation(conversation)}
            type="button"
          >
            <Download size={14} />
            {t("conversation.actions.export")}
          </button>
          {!conversation.remote && (
            <DestructiveConfirmActions
              triggerRole="menuitem"
              cancelAriaLabel={t("conversation.delete.cancelAria", {
                title: conversationTitle,
              })}
              confirmAriaLabel={t(
                "conversation.delete.confirmAria",
                {
                  title: conversationTitle,
                },
              )}
              confirmLabel={t("conversation.delete.confirm")}
              confirming={confirmingDelete}
              disabled={deleting}
              icon={<Trash2 aria-hidden="true" size={14} />}
              onCancel={handlers.cancelDelete}
              onConfirm={() => handlers.confirmDelete(conversation.id)}
              onRequestConfirm={() => handlers.requestDelete(conversation.id)}
              triggerAriaLabel={t(
                "conversation.delete.triggerAria",
                {
                  title: conversationTitle,
                },
              )}
              triggerLabel={t("conversation.delete.trigger")}
            />
          )}
        </div>, document.body
      )}
      {!conversation.remote &&
        renaming && (
          <form
            className="conversation-rename"
            onSubmit={(event) => {
              event.preventDefault();
              const input =
                event.currentTarget.elements.namedItem("title");
              if (input instanceof HTMLInputElement) {
                handlers.saveTitle(conversation.id, input.value);
              }
            }}
          >
            <input
              aria-label={t("conversation.renameAria", {
                title: conversationTitle,
              })}
              autoFocus
              defaultValue={conversation.title}
              maxLength={80}
              name="title"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  handlers.cancelRename(conversation.id);
                }
              }}
              pattern=".*\S.*"
              required
            />
            <button
              aria-label={t("conversation.saveName")}
              type="submit"
            >
              <Check size={14} />
            </button>
            <button
              aria-label={t("conversation.cancelRename")}
              onClick={() => {
                handlers.cancelRename(conversation.id);
              }}
              type="button"
            >
              <X size={14} />
            </button>
          </form>
        )}
      {tasksExpanded && conversationTasks.length > 0 && (
        <ul
          aria-label={t("conversation.tasks.list", {
            title: conversationTitle,
          })}
          className="conversation-task-children"
        >
          {conversationTasks.slice(0, 3).map((task) => {
            const schedule = findTaskSchedule(task, schedules);
            const statusLabel = tWorkspace(
              `task.status.${task.status}`,
            );
            const metadata = schedule
              ? [
                  tWorkspace(
                    `sidebar.tasks.schedule.recurrence.${schedule.recurrence}`,
                  ),
                  task.status === "completed"
                    ? undefined
                    : statusLabel,
                ]
                  .filter((value) => value !== undefined)
                  .join(" · ")
              : task.status === "completed"
                ? ""
                : statusLabel;
            return (
              <li key={task.id}>
                <button
                  className={
                    selectedTaskId === task.id
                      ? "conversation-task-child conversation-task-child--active"
                      : "conversation-task-child"
                  }
                  onClick={() => handlers.openTask(task)}
                  type="button"
                >
                  <span className="conversation-task-child__title">
                    {task.title}
                  </span>
                  {metadata && (
                    <small className="conversation-task-child__meta">
                      {metadata}
                    </small>
                  )}
                  {task.status === "completed" ? (
                    <span
                      className="task-status-dot task-status-dot--completed conversation-task-child__completed-status"
                      title={statusLabel}
                    >
                      <Check
                        aria-hidden="true"
                        size={7}
                        strokeWidth={3}
                      />
                      <span className="sr-only">{statusLabel}</span>
                    </span>
                  ) : (
                    <span
                      aria-hidden="true"
                      className={`task-status-dot task-status-dot--${task.status}`}
                    />
                  )}
                </button>
              </li>
            );
          })}
          {conversationTasks.length > 3 && (
            <li>
              <button
                className="conversation-task-view-all"
                onClick={() => handlers.viewAllTasks(conversation.id, conversationTasks[0]?.id)}
                type="button"
              >
                {t("conversation.tasks.viewAll", {
                  count: conversationTasks.length,
                })}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
});

export type ConversationSidebarActions = {
  newConversation: () => void;
  clearSearch: () => void;
  retryLoad: () => void;
  notify: (notification: AppNotificationInput) => void;
};

type ConversationSidebarProps = {
  store: ConversationStore;
  activeId: string;
  activeProjectId: string;
  activeProjectKind: AssistantProject["kind"] | undefined;
  searchQuery: string;
  conversationStoreReady: boolean;
  loadError: string | undefined;
  locale: TimeFormatLocale;
  sidebarOpen: boolean;
  tasksByConversation: ReadonlyMap<string, readonly AssistantTask[]>;
  expandedTaskConversationIds: ReadonlySet<string>;
  activityByConversationId: ReadonlyMap<string, ConversationActivity>;
  activeConversationIds: ReadonlySet<string>;
  queuedConversationIds: ReadonlySet<string>;
  unreadConversationIds: ReadonlySet<string>;
  conversationActionsId: string;
  confirmingConversationId: string;
  deletingConversationId: string;
  renamingConversationId: string;
  branchingConversationId: string;
  pinningConversationId: string;
  assistantSchedules: readonly AssistantSchedule[];
  selectedAssistantTaskId: string | undefined;
  actionsRef: React.RefObject<HTMLDivElement | null>;
  handlers: ConversationListRowHandlers;
  actions: ConversationSidebarActions;
};

/**
 * The sidebar's conversation list. It reads the conversation store itself, so
 * conversation updates re-render this list (and only the changed rows), not
 * App; switching conversations re-renders only the previous and next row.
 */
export const ConversationSidebar = memo(function ConversationSidebar({
  store,
  activeId,
  activeProjectId,
  activeProjectKind,
  searchQuery,
  conversationStoreReady,
  loadError,
  locale,
  sidebarOpen,
  tasksByConversation,
  expandedTaskConversationIds,
  activityByConversationId,
  activeConversationIds,
  queuedConversationIds,
  unreadConversationIds,
  conversationActionsId,
  confirmingConversationId,
  deletingConversationId,
  renamingConversationId,
  branchingConversationId,
  pinningConversationId,
  assistantSchedules,
  selectedAssistantTaskId,
  actionsRef,
  handlers,
  actions,
}: ConversationSidebarProps): React.JSX.Element {
  const { t } = useTranslation("app");
  const conversations = useConversationList(store);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [localSearchMatches, setLocalSearchMatches] = useState<SearchMatches>(noSearchMatches);
  const [persistedSearchMatches, setPersistedSearchMatches] = useState<SearchMatches>(noSearchMatches);

  useEffect(() => {
    if (!searchQuery.trim()) {
      return;
    }
    const timeout = window.setTimeout(
      () => {
        const query = searchQuery.trim().toLocaleLowerCase();
        setLocalSearchMatches({ query, ids: new Set(conversations.filter(conversation =>
          conversation.messages.some(message => message.content.toLocaleLowerCase().includes(query))
        ).map(conversation => conversation.id)) });
      },
      conversationSearchSnapshotDelayMs,
    );
    return () => window.clearTimeout(timeout);
  }, [conversations, searchQuery]);

  useEffect(() => {
    const query = deferredSearchQuery.trim().toLocaleLowerCase();
    if (!query || !conversationStoreReady) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      void window.goodbuddy.conversations.search(query, store.getState().map(item => item.id)).then(ids => {
        if (active) setPersistedSearchMatches({ query, ids: new Set(ids) });
      }).catch(() => {
        if (active) actions.notify({
          tone: "error", message: t("notices.remoteConversationRefreshFailed"),
          dedupeKey: "conversation-search",
        });
      });
    }, conversationSearchSnapshotDelayMs);
    return () => { active = false; window.clearTimeout(timeout); };
    // Local matches settling reruns the search, as before the extraction.
  }, [deferredSearchQuery, conversationStoreReady, localSearchMatches, store, actions, t]);

  const query = deferredSearchQuery.trim().toLocaleLowerCase();
  const matchingConversations = useMemo(() => conversations.filter(
    (conversation) =>
      (!activeProjectId || conversation.projectId === activeProjectId) &&
      (activeProjectKind !== "channel" || conversation.remote !== undefined) &&
      (!query ||
        (persistedSearchMatches.query === query && persistedSearchMatches.ids.has(conversation.id)) ||
        conversation.title.toLocaleLowerCase().includes(query) ||
        (localSearchMatches.query === query && localSearchMatches.ids.has(conversation.id))),
  ), [activeProjectId, activeProjectKind, conversations, query, localSearchMatches, persistedSearchMatches]);
  const { conversations: filteredConversations, listProps } = useConversationListOrder(
    matchingConversations,
    JSON.stringify([activeProjectId, activeProjectKind, query]),
    Boolean(conversationActionsId),
  );
  const defaultTitle = t("conversation.defaultTitle");
  const conversationById = useMemo(
    () => new Map(conversations.map((item) => [item.id, item])),
    [conversations],
  );
  const titleById = (conversationId: string): string | undefined => {
    const source = conversationById.get(conversationId);
    return source ? getConversationDisplayTitle(source, defaultTitle) : undefined;
  };
  const listTimeDay = new Date().toDateString();

  return (
    <section className="sidebar-conversations" aria-label={t("sidebar.recent")}>
      <div className="conversation-list" {...listProps}>
        {!loadError &&
          filteredConversations.map((conversation) => {
            const conversationTasks =
              tasksByConversation.get(conversation.id) ?? emptyConversationTasks;
            const tasksExpanded = expandedTaskConversationIds.has(conversation.id);
            const branchUnavailable =
              activeConversationIds.has(conversation.id) ||
              queuedConversationIds.has(conversation.id);
            const branchDisabledReason = !conversationStoreReady
              ? t("conversation.branch.storageUnavailable")
              : branchingConversationId
                ? branchingConversationId === conversation.id
                  ? t("conversation.branch.creating")
                  : t("conversation.branch.anotherCreating")
                : branchUnavailable
                  ? t("conversation.branch.unavailable")
                  : undefined;
            return (
              <ConversationListRow
                key={conversation.id}
                actionsOpen={conversationActionsId === conversation.id}
                actionsRef={actionsRef}
                active={conversation.id === activeId}
                activity={activityByConversationId.get(conversation.id)}
                branchDisabledReason={branchDisabledReason}
                branchSourceTitle={conversation.branch
                  ? titleById(conversation.branch.sourceConversationId) ?? conversation.branch.sourceTitle
                  : undefined}
                branching={branchingConversationId === conversation.id}
                confirmingDelete={confirmingConversationId === conversation.id}
                conversation={conversation}
                conversationTasks={conversationTasks}
                conversationTitle={getConversationDisplayTitle(conversation, defaultTitle)}
                deleting={deletingConversationId === conversation.id}
                handlers={handlers}
                listTimeDay={listTimeDay}
                locale={locale}
                menuVisible={sidebarOpen && conversationActionsId === conversation.id}
                pinDisabled={!conversationStoreReady || Boolean(pinningConversationId)}
                renaming={renamingConversationId === conversation.id}
                schedules={tasksExpanded ? assistantSchedules : emptyAssistantSchedules}
                selectedTaskId={tasksExpanded && conversationTasks.some((task) => task.id === selectedAssistantTaskId) ? selectedAssistantTaskId : undefined}
                tasksExpanded={tasksExpanded}
                unread={unreadConversationIds.has(conversation.id)}
              />
            );
          })}
        {loadError ? (
          <div className="conversation-empty" role="alert">
            <strong>{t("conversation.loadFailed")}</strong>
            <span>{loadError}</span>
            <button
              className="secondary-button"
              onClick={actions.retryLoad}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={13} />
              {t("conversation.retryLoad")}
            </button>
          </div>
        ) : filteredConversations.length === 0 ? (
          deferredSearchQuery.trim() ? (
            <div className="conversation-empty">
              <strong>{t("conversation.noMatches")}</strong>
              <span>{t("conversation.noMatchesDescription")}</span>
              <button
                className="secondary-button"
                onClick={actions.clearSearch}
                type="button"
              >
                {t("conversation.clearSearch")}
              </button>
            </div>
          ) : activeProjectKind === "channel" ? (
            <div className="conversation-empty">
              <strong>{t("conversation.noRemote")}</strong>
              <span>{t("chat.remote.waiting")}</span>
            </div>
          ) : (
            <div className="conversation-empty">
              <strong>{t("conversation.empty")}</strong>
              <span>{t("conversation.emptyDescription")}</span>
              <button
                className="secondary-button"
                onClick={actions.newConversation}
                type="button"
              >
                <MessageSquarePlus aria-hidden="true" size={13} />
                {t("sidebar.newConversation")}
              </button>
            </div>
          )
        ) : null}
      </div>
    </section>
  );
});
