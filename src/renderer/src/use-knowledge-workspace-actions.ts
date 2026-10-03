import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { KnowledgeSnapshot } from "../../shared/contracts";
import type { AppNotificationInput } from "./notifications";
import type { KnowledgeWorkspaceProps } from "./knowledge-workspace/types";
import { useStableHandlers } from "./stable-derived-value";

/** The knowledge route's callbacks; moved out of App's JSX so they keep their identity. */
export type KnowledgeWorkspaceActions = Required<Pick<
  KnowledgeWorkspaceProps,
  | "notify" | "onExternalChanged" | "onRetryLoad" | "onSelectLibrary" | "onCreateLibrary"
  | "onDeleteLibrary" | "onUpdateLibrary" | "onReextractGraph" | "onImportFiles"
  | "onImportDirectory" | "onImportUrl" | "onOpenDocumentSource" | "onOpenModelSettings"
  | "onSyncSource" | "onPauseSource" | "onRetrySource" | "onRemoveSource" | "onRetrieve"
  | "onUpdateKnowledgeSettings" | "onListChunks" | "onUpdateChunk" | "onDeleteChunk"
  | "onRebuildDocument" | "onRebuildLibrary" | "onCancelRebuild" | "onGetEmbeddingIndex"
  | "onRebuildEmbeddingIndex" | "onCancelTask" | "onRetryTask" | "onOpenReferenceSource"
  | "onUseInChat" | "onMoveNode" | "onCreateEntity" | "onUpdateEntity" | "onDeleteEntity"
  | "onMergeEntities" | "onCreateRelation" | "onUpdateRelation" | "onDeleteRelation"
  | "onOpenEvidence"
>>;

export type KnowledgeWorkspaceActionDeps = {
  notify: (input: AppNotificationInput) => void;
  t: TFunction<"app">;
  selectedLibraryId: string | undefined;
  refreshKnowledge: (libraryId?: string) => Promise<unknown>;
  refreshSelectedKnowledge: () => Promise<void>;
  retryKnowledgeLoad: () => Promise<void>;
  runKnowledgeSourceAction: <T>(action: () => Promise<T>) => Promise<T>;
  createKnowledgeLibrary: KnowledgeWorkspaceProps["onCreateLibrary"];
  deleteKnowledgeLibrary: KnowledgeWorkspaceProps["onDeleteLibrary"];
  setEnabledKnowledgeLibraryIds: (update: SetStateAction<string[]>) => void;
  setKnowledgeSnapshot: Dispatch<SetStateAction<KnowledgeSnapshot>>;
  openModelSettings: () => void;
  showChatAndFocusComposer: () => void;
};

export function useKnowledgeWorkspaceActions(
  deps: KnowledgeWorkspaceActionDeps,
): KnowledgeWorkspaceActions {
  const {
    notify, t, selectedLibraryId, refreshKnowledge, refreshSelectedKnowledge,
    runKnowledgeSourceAction: run, setEnabledKnowledgeLibraryIds,
  } = deps;
  // Looked up per call, like the former inline callbacks.
  const knowledge = (): typeof window.goodbuddy.knowledge => window.goodbuddy.knowledge;
  const requireLibrary = (): string => {
    if (!selectedLibraryId) throw new Error(t("notices.selectKnowledgeBase"));
    return selectedLibraryId;
  };
  return useStableHandlers<KnowledgeWorkspaceActions>({
    notify,
    onExternalChanged: async (snapshot, createdId) => {
      await refreshKnowledge(createdId ?? snapshot?.selectedLibraryId ?? selectedLibraryId);
      if (createdId) setEnabledKnowledgeLibraryIds((current) => [...new Set([...current, createdId])]);
    },
    onRetryLoad: deps.retryKnowledgeLoad,
    onSelectLibrary: (libraryId) => {
      void refreshKnowledge(libraryId).catch(() => {
        // KnowledgeWorkspace renders the recoverable load error.
      });
    },
    onCreateLibrary: deps.createKnowledgeLibrary,
    onDeleteLibrary: deps.deleteKnowledgeLibrary,
    onUpdateLibrary: async (libraryId, update) => {
      await run(async () => {
        await knowledge().updateLibrary(libraryId, update);
      });
      notify({
        tone: "success",
        message: t("notices.knowledgeSettingsUpdated"),
        dedupeKey: `knowledge-library:${libraryId}`,
      });
    },
    onReextractGraph: async (libraryId) => {
      await run(() => knowledge().reextractGraph(libraryId));
      notify({
        tone: "success",
        message: t("notices.knowledgeGraphRebuilt"),
        dedupeKey: `knowledge-graph:${libraryId}`,
      });
    },
    onImportFiles: (libraryId, files, graphStrategy) =>
      run(() => knowledge().importDroppedFiles(libraryId, files, graphStrategy)),
    onImportDirectory: (libraryId, _files, graphStrategy) =>
      run(() => knowledge().selectDirectory(libraryId, graphStrategy)),
    onImportUrl: (libraryId, url, graphStrategy) =>
      run(() => knowledge().importUrl(libraryId, url, graphStrategy)),
    onOpenDocumentSource: (libraryId, documentId) =>
      knowledge().openDocumentSource({ knowledgeBaseId: libraryId, documentId }),
    onOpenModelSettings: deps.openModelSettings,
    onSyncSource: (sourceId) => run(() => knowledge().syncSource(sourceId)),
    onPauseSource: (sourceId) => run(() => knowledge().pauseSource(sourceId)),
    onRetrySource: (sourceId) => run(() => knowledge().retrySource(sourceId)),
    onRemoveSource: (sourceId) => run(() => knowledge().removeSource(sourceId)),
    onRetrieve: (libraryId, query, settings) =>
      knowledge().retrieve({ knowledgeBaseId: libraryId, query, settings }),
    onUpdateKnowledgeSettings: async (libraryId, settings) => {
      await run(() => knowledge().updateSettings({ knowledgeBaseId: libraryId, ...settings }));
      notify({
        tone: "success",
        message: t("notices.knowledgeSettingsUpdated"),
        dedupeKey: `knowledge-retrieval-settings:${libraryId}`,
      });
    },
    onListChunks: ({ libraryId, documentId, page, pageSize, search }) =>
      knowledge().listChunks({ knowledgeBaseId: libraryId, documentId, page, pageSize, search }),
    onUpdateChunk: (input) => knowledge().updateChunk(input),
    onDeleteChunk: (input) => knowledge().deleteChunk(input),
    onRebuildDocument: (libraryId, documentId) =>
      run(async () => {
        await knowledge().rebuildDocument({ knowledgeBaseId: libraryId, documentId });
      }),
    onRebuildLibrary: (libraryId) =>
      run(async () => {
        const result = await knowledge().rebuildLibrary({ knowledgeBaseId: libraryId });
        if (result.failed > 0) {
          throw new Error(t("notices.knowledgeRebuildPartial", {
            rebuilt: result.rebuilt,
            failed: result.failed,
          }));
        }
        notify({
          tone: "success",
          message: t("notices.knowledgeRebuildCompleted", { count: result.rebuilt }),
          dedupeKey: `knowledge-rebuild:${libraryId}`,
        });
      }),
    onCancelRebuild: async (libraryId) => {
      if (!await knowledge().cancelRebuild(libraryId)) {
        throw new Error(t("notices.knowledgeRebuildNotRunning"));
      }
    },
    onGetEmbeddingIndex: (libraryId) => knowledge().getEmbeddingIndex(libraryId),
    onRebuildEmbeddingIndex: (libraryId) => knowledge().rebuildEmbeddingIndex(libraryId),
    onCancelTask: async (taskId) => {
      if (!await knowledge().cancelTask(taskId)) {
        throw new Error(t("notices.knowledgeTaskNotRunning"));
      }
      await refreshSelectedKnowledge();
    },
    onRetryTask: (taskId) => run(() => knowledge().retryTask(taskId)),
    onOpenReferenceSource: (input) => knowledge().openReferenceSource(input),
    onUseInChat: (libraryId) => {
      setEnabledKnowledgeLibraryIds((current) =>
        current.includes(libraryId) ? current : [...current, libraryId]);
      deps.showChatAndFocusComposer();
    },
    onMoveNode: (nodeId, position) => {
      deps.setKnowledgeSnapshot((current) => ({
        ...current,
        graphNodes: current.graphNodes.map((node) =>
          node.id === nodeId ? { ...node, ...position } : node),
      }));
      void knowledge().moveEntity(nodeId, position).catch(() => void refreshSelectedKnowledge());
    },
    onCreateEntity: async (input) => {
      const libraryId = requireLibrary();
      await run(() => knowledge().createEntity(libraryId, input));
    },
    onUpdateEntity: (entityId, update) => run(() => knowledge().updateEntity(entityId, update)),
    onDeleteEntity: (entityId) => run(() => knowledge().deleteEntity(entityId)),
    onMergeEntities: (sourceId, targetId) => run(() => knowledge().mergeEntities(sourceId, targetId)),
    onCreateRelation: async (input) => {
      const libraryId = requireLibrary();
      await run(() => knowledge().createRelation(libraryId, input));
    },
    onUpdateRelation: (relationId, input) => run(() => knowledge().updateRelation(relationId, input)),
    onDeleteRelation: (relationId) => run(() => knowledge().deleteRelation(relationId)),
    onOpenEvidence: (evidence) =>
      notify({
        tone: "info",
        message: t("notices.evidenceExcerpt", {
          source: `${evidence.documentName}${evidence.location ? ` · ${evidence.location}` : ""}`,
          excerpt: evidence.excerpt,
        }).slice(0, 500),
      }),
  });
}
