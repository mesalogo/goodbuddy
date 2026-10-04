import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { AgentEvent } from "../../shared/contracts";
import type {
  AssistantTask,
  ConversationContextCompressionMarker,
  ConversationMessageBlock,
} from "../../shared/assistant-contracts";
import { appendConversationQuestionBlock } from "../../shared/conversation-question-blocks";
import { knowledgeReferenceKey } from "../../shared/knowledge-reference";
import type { ActivityRecord, ActivityStore } from "./activity-store";
import type { Message, SubagentActivity, ToolActivity } from "./ChatTimeline";
import type { ConversationStore } from "./conversation-store";
import type { LiveMessageStore } from "./live-message-store";
import type { TaskStore } from "./task-store";
import type { AppNotificationInput } from "./notifications";

/**
 * Applies agent run events (IPC `agent.onEvent`) to the conversation store,
 * the live-message store and App's task/activity/artifact state.
 *
 * Moved out of App unchanged; App passes its current setters and refs. Text
 * and reasoning deltas go to the live-message store only, so they never
 * touch App state; everything else is a store or state update, in the order
 * the events arrive.
 */

export type ActiveRun = {
  conversationId: string;
  messageId: string;
  taskId?: string;
  projectId?: string;
  runtimeSelectionKey: string;
};

type Ref<T> = { current: T };

export type AgentEventDependencies = {
  activeRuns: Ref<Map<string, ActiveRun>>;
  activeConversationIdRef: Ref<string>;
  activeProjectIdRef: Ref<string>;
  hydratingArtifactIds: Ref<Set<string>>;
  /** Set when a run ends: persist with the next list commit. */
  requestPersistenceFlush: () => void;
  tRef: Ref<TFunction<"app">>;
  conversationStore: ConversationStore;
  liveMessages: LiveMessageStore;
  setConversations: ConversationStore["set"];
  /** Tasks and artifacts; updates re-render only the views that select them. */
  taskStore: TaskStore;
  /** Activity history; its actions also queue the incremental save. */
  activityStore: ActivityStore;
  setUnreadConversationIds: Dispatch<SetStateAction<Set<string>>>;
  notify: (notification: AppNotificationInput) => void;
  updateMessage: (conversationId: string, messageId: string, update: (message: Message) => Message) => void;
  /** Adds a record with the conversation's project scope. */
  recordActivity: (record: Omit<ActivityRecord, "id" | "createdAt" | "scope">) => void;
  loadWorkspaceChanges: (projectId: string) => Promise<void>;
  markConversationCompleted: (conversationId: string) => void;
  setConversationActivity: (conversationId: string, active: boolean) => void;
  releaseConversationQueueAfterRun: (run: Pick<ActiveRun, "conversationId" | "projectId">) => void;
};

export { mergeArtifacts } from "./task-store";

function upsertMessageToolBlock(
  blocks: ConversationMessageBlock[] | undefined,
  tool: ToolActivity,
): ConversationMessageBlock[] | undefined {
  if (!blocks) {
    return blocks;
  }
  const callId = tool.callId;
  const index = callId
    ? blocks.findIndex(
        (block) => block.type === "tool" && block.tool.callId === callId,
      )
    : -1;
  if (index >= 0) {
    return blocks.map((block, blockIndex) =>
      blockIndex === index && block.type === "tool"
        ? { ...block, tool }
        : block,
    );
  }
  return [
    ...blocks,
    {
      id: crypto.randomUUID(),
      type: "tool",
      tool,
    },
  ];
}

function upsertMessageSubagentBlock(
  blocks: ConversationMessageBlock[] | undefined,
  childTaskId: string,
  runtimeCallId?: string,
): ConversationMessageBlock[] | undefined {
  if (!blocks) {
    return blocks;
  }
  if (
    blocks.some(
      (block) => block.type === "subagent" && block.childTaskId === childTaskId,
    )
  ) {
    return blocks;
  }
  const provisionalIndex = runtimeCallId
    ? blocks.findIndex(
        (block) => block.type === "tool" && block.tool.callId === runtimeCallId,
      )
    : -1;
  if (provisionalIndex >= 0) {
    return blocks.map((block, index) =>
      index === provisionalIndex
        ? {
            id: block.id,
            type: "subagent" as const,
            childTaskId,
          }
        : block,
    );
  }
  return [
    ...blocks,
    {
      id: crypto.randomUUID(),
      type: "subagent",
      childTaskId,
    },
  ];
}

function terminalizeMessageToolBlocks(
  blocks: ConversationMessageBlock[] | undefined,
  state: "failed" | "cancelled" | "interrupted",
): ConversationMessageBlock[] | undefined {
  return blocks?.map((block) =>
    block.type === "tool" &&
    (block.tool.state === "pending" || block.tool.state === "running")
      ? {
          ...block,
          tool: {
            ...block.tool,
            state,
          },
        }
      : block,
  );
}

function isErrorRepresentedByFailedTool(
  tools: ToolActivity[] | undefined,
  errorMessage: string,
): boolean {
  return Boolean(
    tools?.some(
      (tool) =>
        tool.state === "failed" &&
        ((tool.error && errorMessage.includes(tool.error)) ||
          (tool.callId && errorMessage.includes(tool.callId))),
    ),
  );
}

export function handleAgentEvent(event: AgentEvent, deps: AgentEventDependencies): void {
  const {
    activeRuns, activeConversationIdRef, activeProjectIdRef, taskStore, hydratingArtifactIds,
    requestPersistenceFlush, tRef, conversationStore, liveMessages, setConversations,
    activityStore, setUnreadConversationIds, notify,
    updateMessage, recordActivity, loadWorkspaceChanges, markConversationCompleted,
    setConversationActivity, releaseConversationQueueAfterRun,
  } = deps;
  const setAssistantTasks = taskStore.setTasks;
  const run = activeRuns.current.get(event.requestId);
  if (!run) {
    if (event.type !== "approval") {
      return;
    }
    const attachScheduledApproval = (
      task: AssistantTask | undefined,
    ): void => {
      if (!task?.conversationId || task.origin !== "schedule") {
        return;
      }
      setAssistantTasks((current) =>
        current.map((candidate) =>
          candidate.id === task.id
            ? { ...candidate, status: "waiting_approval" }
            : candidate,
        ),
      );
      if (activeConversationIdRef.current !== task.conversationId) {
        setUnreadConversationIds((current) => {
          const next = new Set(current);
          next.add(task.conversationId!);
          return next;
        });
      }
      setConversations((current) =>
        current.map((conversation) => {
          if (conversation.id !== task.conversationId) {
            return conversation;
          }
          const existing = conversation.messages.find(
            (message) => message.approval?.id === event.approvalId,
          );
          if (existing) {
            return conversation;
          }
          return {
            ...conversation,
            updatedAt: Date.now(),
            messages: [
              ...conversation.messages,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: event.title,
                createdAt: Date.now(),
                state: "complete",
                task: {
                  id: task.id,
                  title: task.title,
                },
                approval: {
                  id: event.approvalId,
                  title: event.title,
                  description: event.description,
                  toolName: event.toolName,
                  argumentSummary: event.argumentSummary,
                  allowPermanent: event.allowPermanent,
                },
              },
            ],
          };
        }),
      );
    };
    const task = taskStore.getTasks().find(
      (candidate) => candidate.id === event.requestId,
    );
    if (task) {
      attachScheduledApproval(task);
    } else {
      void window.goodbuddy.tasks
        .list()
        .then((tasks) => {
          setAssistantTasks(tasks);
          attachScheduledApproval(
            tasks.find((candidate) => candidate.id === event.requestId),
          );
        })
        .catch(() => undefined);
    }
    return;
  }

  const liveMessage = conversationStore.getState()
    .find((conversation) => conversation.id === run.conversationId)
    ?.messages.find((message) => message.id === run.messageId);
  if (event.type === "question-resolved") {
    updateMessage(run.conversationId, run.messageId, (message) => {
      if (!message.pendingQuestions?.some((question) => question.questionId === event.questionId)) return message;
      const pendingQuestions = message.pendingQuestions.filter((question) => question.questionId !== event.questionId);
      if (!pendingQuestions.length && !message.approval && message.state === "streaming") {
        setAssistantTasks((current) => current.map((task) =>
          task.id === event.requestId && task.status === "waiting_approval" ? { ...task, status: "running" } : task,
        ));
      }
      return { ...message, pendingQuestions };
    });
    return;
  }
  if (event.type === "question" && (
    liveMessage?.state !== "streaming" ||
    liveMessage.pendingQuestions?.some((question) => question.questionId === event.questionId) ||
    liveMessage.answeredQuestions?.some((question) => question.questionId === event.questionId)
  )) return;
  setAssistantTasks((current) => {
    let changed = false;
    const updated = current.map((task) => {
      if (task.id !== event.requestId) {
        return task;
      }
      const status: AssistantTask["status"] =
        event.type === "approval" || event.type === "question"
          ? "waiting_approval"
          : event.type === "done"
            ? "completed"
            : event.type === "error"
              ? event.status
              : liveMessage?.pendingQuestions?.length || liveMessage?.approval
                ? "waiting_approval"
                : "running";
      const completedAt =
        event.type === "done" || event.type === "error"
          ? new Date().toISOString()
          : task.completedAt;
      const error = event.type === "error" ? event.message : task.error;
      if (
        task.status === status &&
        task.completedAt === completedAt &&
        task.error === error
      ) {
        return task;
      }
      changed = true;
      return {
        ...task,
        status,
        completedAt,
        error,
      };
    });
    return changed ? updated : current;
  });
  if (event.type === "done") {
    if (run.projectId && activeProjectIdRef.current === run.projectId) {
      void loadWorkspaceChanges(run.projectId).catch(() =>
        notify({
          tone: "error",
          message: tRef.current("notices.workspaceChangesReadFailed"),
        }),
      );
    }
    void window.goodbuddy.artifacts
      .list()
      .then((artifacts) => taskStore.mergeArtifacts(artifacts))
      .catch(() =>
        notify({
          tone: "error",
          message: tRef.current("notices.resultsRefreshFailed"),
        }),
      );
  } else if (event.type === "artifact") {
    hydratingArtifactIds.current.add(event.artifactId);
    void window.goodbuddy.artifacts
      .get(event.artifactId)
      .then((artifact) => taskStore.mergeArtifacts([artifact]))
      .catch(() =>
        notify({
          tone: "error",
          message: tRef.current("notices.generatedImageReadFailed"),
        }),
      )
      .finally(() => {
        hydratingArtifactIds.current.delete(event.artifactId);
      });
  }

  if (event.type === "checklist") {
    updateMessage(run.conversationId, run.messageId, (message) =>
      message.state === "streaming"
        ? { ...message, runtimeChecklist: event.checklist }
        : message,
    );
  } else if (event.type === "text" || event.type === "reasoning") {
    // Rendered by the message row from the live store; App state absorbs
    // the deltas later (see live-message-store.ts).
    liveMessages.append(
      run.conversationId,
      run.messageId,
      event.type,
      event.delta,
      liveMessage,
    );
  } else if (event.type === "context-metrics") {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === run.conversationId
          ? {
              ...conversation,
              contextMetrics: {
                contextTokens: event.contextTokens,
                source: event.source,
                basis: "model-call",
                runtimeSelectionKey: run.runtimeSelectionKey,
              },
            }
          : conversation,
      ),
    );
  } else if (event.type === "context-compression") {
    const estimatedAfterTokens = event.estimatedAfterTokens;
    const conversationScoped = event.scope !== "agent-run";
    const scope = event.scope ?? "conversation";
    const marker: ConversationContextCompressionMarker = {
      state: event.state === "started" ? "compressing" : event.state,
      scope,
      estimatedBeforeTokens: event.estimatedBeforeTokens,
      estimatedAfterTokens: event.estimatedAfterTokens,
      compressionCount: event.compressionCount,
    };
    updateMessage(run.conversationId, run.messageId, (message) => {
      const current =
        message.contextCompressions ??
        (message.contextCompression ? [message.contextCompression] : []);
      const existingIndex = current.findIndex(
        (compression) => (compression.scope ?? "conversation") === scope,
      );
      const contextCompressions =
        existingIndex >= 0
          ? [
              ...current.filter(
                (_compression, index) => index !== existingIndex,
              ),
              marker,
            ]
          : [...current, marker];
      return {
        ...message,
        contextCompression: undefined,
        contextCompressions,
      };
    });
    if (
      conversationScoped &&
      event.state === "completed" &&
      estimatedAfterTokens !== undefined
    ) {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === run.conversationId
            ? {
                ...conversation,
                contextMetrics: {
                  runtimeSelectionKey: run.runtimeSelectionKey,
                  contextTokens: estimatedAfterTokens,
                  source: "estimated",
                  basis: "conversation",
                },
                contextCompressionState:
                  event.conversationState ??
                  conversation.contextCompressionState,
              }
            : conversation,
        ),
      );
    } else if (conversationScoped && event.conversationState) {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === run.conversationId
            ? {
                ...conversation,
                contextCompressionState: event.conversationState,
              }
            : conversation,
        ),
      );
    }
  } else if (event.type === "status") {
    updateMessage(run.conversationId, run.messageId, (message) => ({
      ...message,
      status: event.message,
    }));
  } else if (event.type === "tool") {
    recordActivity({
      conversationId: run.conversationId,
      requestId: event.requestId,
      callId: event.callId.slice(0, 256),
      kind: "tool",
      title: event.name,
      detail: [event.summary, event.error].filter(Boolean).join("\n"),
      status:
        event.state === "pending"
          ? "pending"
          : event.state === "running"
            ? "running"
            : event.state === "failed"
              ? "failed"
              : "completed",
    });
    updateMessage(run.conversationId, run.messageId, (message) => {
      const tools = [...(message.tools ?? [])];
      const index = tools.findIndex(
        (tool) => tool.callId === event.callId.slice(0, 256),
      );
      const tool = {
        callId: event.callId.slice(0, 256),
        name: event.name,
        state: event.state,
        summary: event.summary,
        input: event.input,
        output: event.output,
        error: event.error,
      };
      if (index >= 0) {
        tools[index] = tool;
      } else {
        tools.push(tool);
      }
      const blocks = upsertMessageToolBlock(message.blocks, tool);
      return {
        ...message,
        tools,
        blocks,
        status: undefined,
      };
    });
  } else if (event.type === "subagent") {
    const actor =
      "actor" in event
        ? event.actor
        : {
            kind: "expert" as const,
            expertId: event.expertId,
            expertName: event.expertName,
          };
    const actorLabel =
      actor.kind === "direct-model"
        ? tRef.current("chat.subagents.directModelLabel")
        : actor.expertName;
    const childStatus = event.state;
    const completedAt =
      event.state === "completed" ||
      event.state === "failed" ||
      event.state === "cancelled"
        ? new Date().toISOString()
        : undefined;
    if (actor.kind === "expert") {
      setAssistantTasks((current) => {
        const existing = current.find(
          (task) => task.id === event.childTaskId,
        );
        const childTask: AssistantTask = {
          id: event.childTaskId,
          projectId: run.projectId,
          conversationId: run.conversationId,
          parentTaskId: event.requestId,
          expertId: actor.expertId,
          routingMode:
            event.routingMode === "native" ? undefined : event.routingMode,
          title: actor.expertName,
          instructions:
            event.reason ??
            tRef.current("chat.subagents.fallbackTask", {
              name: actor.expertName,
            }),
          origin: "subagent",
          status: childStatus,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          startedAt:
            event.state === "running"
              ? (existing?.startedAt ?? new Date().toISOString())
              : existing?.startedAt,
          completedAt: completedAt ?? existing?.completedAt,
          error: event.error,
        };
        if (
          existing &&
          (Object.keys(childTask) as (keyof AssistantTask)[]).every(
            (key) => existing[key] === childTask[key],
          )
        ) {
          return current;
        }
        return existing
          ? current.map((task) =>
              task.id === event.childTaskId ? childTask : task,
            )
          : [...current, childTask];
      });
    }
    if (event.runtimeCallId) {
      activityStore.removeToolByCallId(event.requestId, event.runtimeCallId);
    }
    recordActivity({
      conversationId: run.conversationId,
      requestId: event.requestId,
      callId: event.childTaskId,
      kind: "subagent",
      title: actorLabel,
      detail: [
        actor.kind === "direct-model"
          ? tRef.current("chat.subagents.directModel")
          : event.routingMode === "smart"
            ? tRef.current("chat.subagents.smart")
            : event.routingMode === "native"
              ? tRef.current("chat.subagents.native")
              : tRef.current("chat.subagents.manual"),
        event.reason,
        event.error,
      ]
        .filter(Boolean)
        .join(" · "),
      status: event.state === "queued" ? "pending" : event.state,
    });
    updateMessage(run.conversationId, run.messageId, (message) => {
      const subagents = [...(message.subagents ?? [])];
      const index = subagents.findIndex(
        (subagent) => subagent.childTaskId === event.childTaskId,
      );
      const commonSubagent = {
        childTaskId: event.childTaskId,
        routingMode: event.routingMode,
        runtimeCallId: event.runtimeCallId,
        state: event.state,
        reason: event.reason,
        progress: event.progress,
        output: event.output,
        error: event.error,
      };
      const subagent: SubagentActivity =
        "actor" in event
          ? { ...commonSubagent, actor: event.actor }
          : {
              ...commonSubagent,
              expertId: event.expertId,
              expertName: event.expertName,
            };
      if (index >= 0) {
        subagents[index] = subagent;
      } else {
        subagents.push(subagent);
      }
      const runtimeCallId = event.runtimeCallId;
      const blocks = upsertMessageSubagentBlock(
        message.blocks,
        event.childTaskId,
        runtimeCallId,
      );
      return {
        ...message,
        subagents,
        tools: runtimeCallId
          ? message.tools?.filter((tool) => tool.callId !== runtimeCallId)
          : message.tools,
        blocks,
      };
    });
  } else if (event.type === "approval") {
    recordActivity({
      conversationId: run.conversationId,
      requestId: event.requestId,
      kind: "approval",
      title: event.title,
      detail: event.description,
      status: "pending",
    });
    updateMessage(run.conversationId, run.messageId, (message) => ({
      ...message,
      status: undefined,
      approval: {
        id: event.approvalId,
        taskId: run.taskId,
        title: event.title,
        description: event.description,
        toolName: event.toolName,
        argumentSummary: event.argumentSummary,
        allowPermanent: event.allowPermanent,
      },
    }));
  } else if (event.type === "question") {
    updateMessage(run.conversationId, run.messageId, (message) => {
      if (message.state !== "streaming" ||
        message.pendingQuestions?.some((question) => question.questionId === event.questionId) ||
        message.answeredQuestions?.some((question) => question.questionId === event.questionId)) {
        return message;
      }
      return {
        ...message,
        status: undefined,
        blocks: appendConversationQuestionBlock(message.blocks, event.questionId),
        pendingQuestions: [...(message.pendingQuestions ?? []), event],
      };
    });
  } else if (event.type === "artifact") {
    updateMessage(run.conversationId, run.messageId, (message) => ({
      ...message,
      artifactIds: [
        ...new Set([...(message.artifactIds ?? []), event.artifactId]),
      ].slice(-8),
      imageContextNotice: event.imageContextNotice,
      status: tRef.current("chat.status.savingImage"),
    }));
  } else if (event.type === "knowledge-retrieval") {
    updateMessage(run.conversationId, run.messageId, (message) => ({
      ...message,
      knowledgeRetrieval: {
        mode: event.mode,
        state: event.state,
        libraryCount: event.libraryCount,
        resultCount: event.resultCount,
        durationMs: event.durationMs,
        usedChannels: event.usedChannels,
        warnings: event.warnings,
      },
      status:
        event.state === "searching"
          ? tRef.current("chat.knowledgeRetrieval.searching")
          : undefined,
    }));
  } else if (event.type === "source-references") {
    updateMessage(run.conversationId, run.messageId, (message) => {
      const incoming = [
        ...new Map(
          event.references.map((reference) => [
            knowledgeReferenceKey(reference),
            reference,
          ]),
        ).values(),
      ];
      const incomingKeys = new Set(incoming.map(knowledgeReferenceKey));
      const references = [
        ...incoming,
        ...(message.sourceReferences ?? []).filter(
          (reference) => !incomingKeys.has(knowledgeReferenceKey(reference)),
        ),
      ].slice(0, 20);
      return {
        ...message,
        sourceReferences: references,
      };
    });
  } else if (event.type === "done" || event.type === "error") {
    const terminalStatus =
      event.type === "error"
        ? event.status === "cancelled"
          ? "cancelled"
          : "failed"
        : "completed";
    const incompleteSubagentError = tRef.current(
      "chat.subagents.incomplete",
    );
    const incompleteActivityDetail = tRef.current(
      "chat.status.activityIncomplete",
    );
    activityStore.updateRequest(
      event.requestId,
      terminalStatus,
      event.type === "error"
        ? event.message
        : tRef.current("chat.status.taskCompleted"),
    );
    activityStore.settleRequest(
      event.requestId,
      event.type === "done" ? "interrupted" : terminalStatus,
      event.type === "done" ? incompleteActivityDetail : event.message,
    );
    recordActivity({
      conversationId: run.conversationId,
      requestId: event.requestId,
      kind: "result",
      title:
        event.type === "error"
          ? tRef.current(event.status === "cancelled"
              ? "chat.status.taskCancelled" : "chat.status.taskFailed")
          : tRef.current("chat.status.taskCompleted"),
      detail:
        event.type === "error"
          ? event.message
          : tRef.current("chat.status.runtimeCompleted"),
      status: terminalStatus,
    });
    setAssistantTasks((current) =>
      current.map((task) =>
        task.parentTaskId === event.requestId &&
        (task.status === "queued" || task.status === "running")
          ? {
              ...task,
              status: event.type === "done" ? "failed" : terminalStatus,
              completedAt: new Date().toISOString(),
              error:
                event.type === "error"
                  ? event.message
                  : incompleteSubagentError,
            }
          : task,
      ),
    );
    updateMessage(run.conversationId, run.messageId, (message) => {
      const representedToolError =
        event.type === "error" &&
        isErrorRepresentedByFailedTool(message.tools, event.message);
      const toolTerminalState =
        event.type === "error"
          ? event.status === "cancelled"
            ? ("cancelled" as const)
            : ("failed" as const)
          : ("interrupted" as const);
      return {
        ...message,
        state: event.type === "error" ? "error" : "complete",
        terminalStatus: event.type === "error"
          ? event.status === "cancelled" ? "cancelled" : "failed"
          : undefined,
        status:
          event.type === "error" && (event.status === "cancelled" || !representedToolError)
            ? event.message
            : event.type === "done"
              ? tRef.current("chat.status.taskCompleted")
              : undefined,
        contextCompression:
          event.type === "error" &&
          message.contextCompression?.state === "compressing"
            ? {
                ...message.contextCompression,
                state: "failed" as const,
              }
            : message.contextCompression,
        contextCompressions:
          event.type === "error"
            ? message.contextCompressions?.map((compression) =>
                compression.state === "compressing"
                  ? {
                      ...compression,
                      state: "failed" as const,
                    }
                  : compression,
              )
            : message.contextCompressions,
        approval: undefined,
        pendingQuestions: undefined,
        tools: toolTerminalState
          ? message.tools?.map((tool) =>
              tool.state === "pending" || tool.state === "running"
                ? { ...tool, state: toolTerminalState }
                : tool,
            )
          : message.tools,
        subagents: message.subagents?.map((subagent) =>
          subagent.state === "queued" || subagent.state === "running"
            ? {
                ...subagent,
                state:
                  event.type === "error"
                    ? event.status === "cancelled"
                      ? ("cancelled" as const)
                      : ("failed" as const)
                    : ("failed" as const),
                ...(event.type === "error" && event.status !== "cancelled"
                  ? { error: event.message.slice(0, 1_000) }
                  : event.type === "done"
                    ? { error: incompleteSubagentError }
                    : {}),
              }
            : subagent,
        ),
        blocks: terminalizeMessageToolBlocks(message.blocks, toolTerminalState),
      };
    });
    activeRuns.current.delete(event.requestId);
    if (event.type === "done") markConversationCompleted(run.conversationId);
    setConversationActivity(run.conversationId, false);
    releaseConversationQueueAfterRun(run);
    requestPersistenceFlush();
  }
}
