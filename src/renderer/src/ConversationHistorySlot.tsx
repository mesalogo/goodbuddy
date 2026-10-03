import { memo, useEffect, useMemo, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type {
  AssistantProject,
  AssistantSchedule,
  AssistantTask,
  InteractiveWorkMode,
} from "../../shared/assistant-contracts";
import { normalizeInteractiveWorkMode } from "../../shared/assistant-contracts";
import { ChatHistoryPane } from "./ChatHistoryPane";
import type { Conversation } from "./chat-conversation";
import { useConversation, type ConversationStore } from "./conversation-store";
import { ConversationTaskStrip } from "./ConversationTaskStrip";
import { displayErrorMessage } from "./error-message";
import { RuntimeChecklistStrip } from "./RuntimeChecklistStrip";
import { useArtifactById } from "./task-selectors";
import type { TaskStore } from "./task-store";

function ConversationHistoryLoader({ conversationId, active, load }: {
  conversationId: string;
  active: boolean;
  load: (id: string) => Promise<Conversation>;
}): React.JSX.Element {
  const { t } = useTranslation("app");
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    void load(conversationId).catch(reason => {
      if (mounted) setError(displayErrorMessage(reason, t("conversation.historyLoadFailed")));
    });
    return () => { mounted = false; };
  }, [conversationId, load, attempt, t]);
  return <section hidden={!active} className="empty-state" aria-busy={!error}>
    <p role={error ? "alert" : "status"}>{error ?? t("conversation.historyLoading")}</p>
    {error && <button type="button" className="secondary-button" onClick={() => {
      setError(undefined);
      setAttempt(value => value + 1);
    }}>{t("conversation.historyRetry")}</button>}
  </section>;
}

type PaneProps = Omit<ComponentProps<typeof ChatHistoryPane>, "conversation" | "taskStrip" | "artifactById">;

export type ConversationHistorySlotProps = PaneProps & {
  conversationId: string;
  store: ConversationStore;
  /** Artifacts are read here, so a new result re-renders the panes, not App. */
  taskStore: TaskStore;
  loadHistory: (conversationId: string) => Promise<Conversation>;
  /** The active conversation's effective mode; others use their own or the project's. */
  workModeOverride?: InteractiveWorkMode;
  projects: readonly AssistantProject[];
  tasks: AssistantTask[];
  schedules: AssistantSchedule[];
  selectedAssistantTaskId?: string;
  onRemoveSchedule: (scheduleId: string) => Promise<void>;
  onRunSchedule: (scheduleId: string) => Promise<void>;
  onSelectTask: (taskId: string) => void;
  onSetScheduleEnabled: (scheduleId: string, enabled: boolean) => Promise<void>;
};

/**
 * One kept conversation pane. It subscribes to its own conversation in the
 * store, so message updates (streaming flushes, tool events) re-render only
 * this slot, never App; the task strip element is rebuilt only when its
 * inputs change, keeping the memoized pane skipped otherwise.
 */
export const ConversationHistorySlot = memo(function ConversationHistorySlot({
  conversationId,
  store,
  taskStore,
  loadHistory,
  workModeOverride,
  projects,
  tasks,
  schedules,
  selectedAssistantTaskId,
  onRemoveSchedule,
  onRunSchedule,
  onSelectTask,
  onSetScheduleEnabled,
  ...paneProps
}: ConversationHistorySlotProps): React.JSX.Element | null {
  const conversation = useConversation(store, conversationId);
  const artifactById = useArtifactById(taskStore);
  const remote = Boolean(conversation?.remote);
  const conversationMode = workModeOverride ?? normalizeInteractiveWorkMode(
    conversation?.workMode ??
      projects.find(project => project.id === conversation?.projectId)?.defaultWorkMode,
  );
  const selectedTaskId = tasks.some(task => task.id === selectedAssistantTaskId)
    ? selectedAssistantTaskId : undefined;
  const messages = conversation?.messages;
  const activeMessageId = conversation?.activeRequest?.messageId;
  const { locale } = paneProps;
  const taskStrip = useMemo(() => messages && (
    <div className="conversation-context-strips">
      {!remote && (
        <ConversationTaskStrip
          conversationMode={conversationMode}
          locale={locale}
          onRemoveSchedule={onRemoveSchedule}
          onRunSchedule={onRunSchedule}
          onSelectTask={onSelectTask}
          onSetScheduleEnabled={onSetScheduleEnabled}
          schedules={schedules}
          selectedTaskId={selectedTaskId}
          tasks={tasks}
        />
      )}
      <RuntimeChecklistStrip messages={messages} activeMessageId={activeMessageId} />
    </div>
  ), [remote, conversationMode, locale, onRemoveSchedule, onRunSchedule, onSelectTask,
    onSetScheduleEnabled, schedules, selectedTaskId, tasks, messages, activeMessageId]);
  if (!conversation) return null;
  if (conversation.messageSummary) {
    return (
      <ConversationHistoryLoader
        conversationId={conversation.id}
        active={paneProps.active}
        load={loadHistory}
      />
    );
  }
  return <ChatHistoryPane {...paneProps} artifactById={artifactById} conversation={conversation} taskStrip={taskStrip} />;
});
