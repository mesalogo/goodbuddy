import type { SetStateAction } from "react";
import type { ContextAttachment } from "../../shared/contracts";
import type { RuntimeSelectionLayer } from "../../shared/runtime-selection-contracts";
import type { TerminalSnapshot } from "../../shared/terminal-contracts";
import type { ImageViewerItem } from "./ChatTimeline";
import { useStableHandlers } from "./stable-derived-value";

/**
 * Everything the composer asks App to do. App passes its latest closures;
 * the returned object never changes identity, so the memoized Composer does
 * not re-render because App created new callbacks.
 *
 * Calls run the implementation of App's latest commit. Async work that must
 * stay with the conversation it started in receives that conversation's ID
 * as an argument instead of reading App's current one.
 */
export type ComposerActions = {
  submit: () => void;
  stop: () => void;
  selectContextFiles: (paths?: string[]) => void;
  addContext: (
    action: () => Promise<ContextAttachment | ContextAttachment[]>,
  ) => void;
  isSelectingContextFiles: () => boolean;
  setContextError: (message: string | undefined) => void;
  removeAttachment: (attachmentId: string) => void;
  removeImageReference: (conversationId: string, artifactId: string) => void;
  restoreQueueItem: (conversationId: string, itemId: string) => Promise<void>;
  interruptQueueItem: (itemId: string) => Promise<void>;
  removeQueueItem: (itemId: string) => Promise<void>;
  queueError: (message: string) => void;
  toggleVoiceInput: () => void;
  compactRuntimeContext: () => void;
  openImageViewer: (item: ImageViewerItem, trigger: HTMLElement) => void;
  openModelSettings: () => void;
  setEnabledKnowledgeLibraryIds: (update: SetStateAction<string[]>) => void;
  setKnowledgeRetrievalMode: (mode: "auto" | "always") => void;
  setStoryGraphEnabled: (conversationId: string, enabled: boolean) => Promise<void>;
  selectExpert: (expertId: string) => void;
  selectRuntimeAgent: (agentId: string) => void;
  selectContinuePreset: (presetId: string) => void;
  selectRuntimeAction: (value: string) => void;
  switchRuntime: (layer: RuntimeSelectionLayer | undefined) => void;
  prepareNativeClientConversation: () => Promise<string>;
  openNativeTerminal: (
    terminal: TerminalSnapshot,
    origin: { projectId: string; conversationId: string },
  ) => void;
  notify: (notification: { tone: "error" | "success"; message: string }) => void;
};

export function useComposerActions(latest: ComposerActions): ComposerActions {
  return useStableHandlers(latest);
}
