import {
  Bot,
  ChevronDown,
  CircleHelp,
  FileText,
  Library,
  LoaderCircle,
  Mic,
  Paperclip,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentRuntimeStatus,
  ContextAttachment,
  ContextFileSelectionProgress,
  KnowledgeSnapshot,
  RuntimeNativeSnapshot,
  RuntimeSettings,
} from "../../shared/contracts";
import {
  defaultContextCompressionSettings,
  maximumPastedImageBytes,
} from "../../shared/contracts";
import type {
  AssistantArtifact,
  ConversationQueueItem,
  InteractiveWorkMode,
} from "../../shared/assistant-contracts";
import type { ExternalKnowledgeInstanceSummary } from "../../shared/external-knowledge-contracts";
import { maximumAttachmentsPerMessage } from "../../shared/attachment-limits";
import { getEffectiveContextTriggerTokens } from "../../shared/context-window";
import {
  agentRuntimeSelectionKey,
  type AgentRuntimeSelection,
  type RuntimeSelectionLayer,
} from "../../shared/runtime-selection-contracts";
import type { TerminalSnapshot } from "../../shared/terminal-contracts";
import { AttachmentActions, AttachmentStatus } from "./AttachmentActions";
import { AttachmentCapabilityNotice } from "./AttachmentCapabilityNotice";
import { AttachmentResultButton } from "./AttachmentResultButton";
import {
  ComposerDraftEffect,
  ComposerDraftHasText,
  ComposerDraftText,
  type ComposerDraftStore,
} from "./composer-draft-store";
import {
  useComposerMenus,
  type ComposerMenuStore,
} from "./composer-menu-store";
import {
  ComposerMenuSelect,
  type ComposerMenuOption,
  type RuntimeActionChoice,
} from "./ComposerMenuSelect";
import { formatAttachmentSize, resizeComposerTextarea } from "./composer-textarea";
import { useComposerConversationView } from "./conversation-selectors";
import type { ConversationStore } from "./conversation-store";
import { ConversationInputQueue } from "./ConversationInputQueue";
import { ImageCapabilityNotice } from "./ImageCapabilityNotice";
import { PendingDocumentImports } from "./PendingDocumentImports";
import { RuntimeModelPicker } from "./RuntimeModelPicker";
import { RuntimeNativeClientActions } from "./RuntimeNativeClientActions";
import { formatCompactTokens } from "./token-format";
import type { ComposerActions } from "./use-composer-actions";
import { SegmentedControl } from "./WorkspacePrimitives";

export type ComposerProps = {
  actions: ComposerActions;
  activeProjectId: string;
  activeRuntimeSelection: AgentRuntimeSelection | undefined;
  assistantExpertOptions: readonly ComposerMenuOption<string>[];
  attachmentButtonRef: RefObject<HTMLButtonElement | null>;
  attachmentOperations: number;
  attachments: readonly ContextAttachment[];
  composerDrafts: ComposerDraftStore;
  contextError: string | undefined;
  conversationHint: string;
  conversationId: string;
  conversationStore: ConversationStore;
  effectiveWorkMode: InteractiveWorkMode;
  executionRunning: boolean;
  externalInstances: readonly ExternalKnowledgeInstanceSummary[];
  fileSelectionProgress: ContextFileSelectionProgress | undefined;
  imageReferences: readonly AssistantArtifact[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  keyboardHint: string;
  knowledgeLibraries: KnowledgeSnapshot["libraries"];
  menuStore: ComposerMenuStore;
  nativeClientAvailable: boolean;
  nativeClientContextKey: string;
  projectRecoveryBlocked: boolean;
  projectRuntimeSelection: RuntimeSelectionLayer | undefined;
  projectUsesManagedSsh: boolean;
  queueItems: ConversationQueueItem[];
  runtime: AgentRuntimeStatus | undefined;
  runtimeActionOptions: readonly RuntimeActionChoice[];
  runtimeAgentOptions: readonly ComposerMenuOption<string>[];
  runtimeContextCompactAvailable: boolean;
  runtimeContextCompacting: boolean;
  runtimeLabel: string;
  runtimeMenuButtonRef: RefObject<HTMLButtonElement | null>;
  runtimeModelDetail: string | undefined;
  runtimeNativeSnapshot: RuntimeNativeSnapshot | undefined;
  runtimePresetOptions: readonly ComposerMenuOption<string>[];
  runtimeSettings: RuntimeSettings | undefined;
  runtimeStatusKey: string;
  runtimeSwitching: boolean;
  selectedContinuePreset: string;
  selectedExpertId: string;
  selectedRuntimeAgent: string;
  selectedRuntimeCommand: string;
  selectingContextFiles: boolean;
  supervisorEnabled?: boolean;
  updateAttachmentBusy: (busy: boolean) => void;
  voiceListening: boolean;
  voiceRecording: boolean;
  /** The workspace view; switching views closes the composer popups. */
  workspaceView: string;
  workModeOptions: readonly ComposerMenuOption<InteractiveWorkMode>[];
};

const composerContextErrorId = "composer-context-error";
const runtimeDetailId = "composer-runtime-detail";

/**
 * The chat composer: queued inputs, attachments, the draft textarea, pickers,
 * runtime controls and the context meter.
 *
 * It reads the draft from the composer draft store, the conversation fields
 * it shows through a narrow selector and its popups from the composer menu
 * store. Its other props change only when what it shows changes, and the
 * actions object is stable, so streaming output, task events and updates to
 * other conversations do not re-render it.
 */
export const Composer = memo(function Composer({
  actions,
  activeProjectId,
  activeRuntimeSelection,
  assistantExpertOptions,
  attachmentButtonRef,
  attachmentOperations,
  attachments,
  composerDrafts,
  contextError,
  conversationHint,
  conversationId,
  conversationStore,
  effectiveWorkMode,
  executionRunning,
  externalInstances,
  fileSelectionProgress,
  imageReferences,
  inputRef,
  keyboardHint,
  knowledgeLibraries,
  menuStore,
  nativeClientAvailable,
  nativeClientContextKey,
  projectRecoveryBlocked,
  projectRuntimeSelection,
  projectUsesManagedSsh,
  queueItems,
  runtime,
  runtimeActionOptions,
  runtimeAgentOptions,
  runtimeContextCompactAvailable,
  runtimeContextCompacting,
  runtimeLabel,
  runtimeMenuButtonRef,
  runtimeModelDetail,
  runtimeNativeSnapshot,
  runtimePresetOptions,
  runtimeSettings,
  runtimeStatusKey,
  runtimeSwitching,
  selectedContinuePreset,
  selectedExpertId,
  selectedRuntimeAgent,
  selectedRuntimeCommand,
  selectingContextFiles,
  supervisorEnabled,
  updateAttachmentBusy,
  voiceListening,
  voiceRecording,
  workspaceView,
  workModeOptions,
}: ComposerProps): React.JSX.Element {
  const { t } = useTranslation("app");
  const view = useComposerConversationView(conversationStore, conversationId);
  const [storyGraphSaving, setStoryGraphSaving] = useState(false);
  const isRunning = view?.running ?? false;
  // Popups belong to one conversation, run state and view, like the former
  // reset in App: changing any of them shows every popup closed.
  const [menus, setMenus] = useComposerMenus(
    menuStore,
    `${conversationId}\u0000${isRunning}\u0000${workspaceView}`,
  );
  const composerOptionsOpen = menus.optionsOpen;
  const knowledgeScopeOpen = menus.knowledgeScopeOpen;
  const composerMenuOpen = menus.menu;
  const runtimeMenuOpen = menus.runtimeMenuOpen;
  const setComposerOptionsOpen = useCallback(
    (open: boolean): void => setMenus({ optionsOpen: open }),
    [setMenus],
  );
  const setKnowledgeScopeOpen = useCallback(
    (open: boolean | ((current: boolean) => boolean)): void =>
      setMenus((current) => ({
        knowledgeScopeOpen:
          typeof open === "function" ? open(current.knowledgeScopeOpen) : open,
      })),
    [setMenus],
  );
  const setComposerMenuOpen = useCallback(
    (menu: typeof composerMenuOpen): void => setMenus({ menu }),
    [setMenus],
  );
  const setRuntimeMenuOpen = useCallback(
    (open: boolean): void => setMenus({ runtimeMenuOpen: open }),
    [setMenus],
  );
  const setExpertMenuOpen = useCallback((open: boolean): void => {
    setMenus(open
      ? { menu: "expert", runtimeMenuOpen: false, knowledgeScopeOpen: false }
      : { menu: undefined });
  }, [setMenus]);
  const setModeMenuOpen = useCallback((open: boolean): void => {
    setMenus(open
      ? { menu: "mode", runtimeMenuOpen: false, optionsOpen: false, knowledgeScopeOpen: false }
      : { menu: undefined });
  }, [setMenus]);
  const setRuntimeAgentMenuOpen = useCallback((open: boolean): void => {
    setMenus(open
      ? { menu: "runtime-agent", runtimeMenuOpen: false, knowledgeScopeOpen: false }
      : { menu: undefined });
  }, [setMenus]);
  const setRuntimeActionMenuOpen = useCallback((open: boolean): void => {
    setMenus(open
      ? { menu: "runtime-action", runtimeMenuOpen: false, knowledgeScopeOpen: false }
      : { menu: undefined });
  }, [setMenus]);
  const setRuntimePresetMenuOpen = useCallback((open: boolean): void => {
    setMenus(open
      ? { menu: "runtime-preset", runtimeMenuOpen: false, knowledgeScopeOpen: false }
      : { menu: undefined });
  }, [setMenus]);
  const composerOptionsRef = useRef<HTMLDivElement>(null);
  const composerOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const knowledgeScopeTriggerRef = useRef<HTMLButtonElement>(null);
  const knowledgeScopePopoverRef = useRef<HTMLDivElement>(null);
  const runtimeMenuRef = useRef<HTMLDivElement>(null);
  const resizeComposer = useCallback((): void => {
    resizeComposerTextarea(inputRef.current);
  }, [inputRef]);
  const restoreQueueItem = useCallback(
    (itemId: string) => actions.restoreQueueItem(conversationId, itemId),
    [actions, conversationId],
  );
  const openNativeTerminal = useCallback(
    (terminal: TerminalSnapshot): void =>
      actions.openNativeTerminal(terminal, { projectId: activeProjectId, conversationId }),
    [actions, activeProjectId, conversationId],
  );
  const activeRuntimeSelectionKey = activeRuntimeSelection
    ? agentRuntimeSelectionKey(activeRuntimeSelection)
    : "";
  const enabledKnowledgeLibraryIds = view?.knowledgeLibraryIds ?? emptyLibraryIds;

  useEffect(() => {
    if (!knowledgeScopeOpen) {
      return;
    }
    const focusFrame = requestAnimationFrame(() => {
      knowledgeScopePopoverRef.current
        ?.querySelector<HTMLInputElement>("input")
        ?.focus();
    });
    const isScopeTarget = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (knowledgeScopePopoverRef.current?.contains(target) === true ||
        knowledgeScopeTriggerRef.current?.contains(target) === true);
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!isScopeTarget(event.target)) {
        setKnowledgeScopeOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      setKnowledgeScopeOpen(false);
      knowledgeScopeTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [knowledgeScopeOpen, setKnowledgeScopeOpen]);

  useEffect(() => {
    if (!composerOptionsOpen) {
      return;
    }
    const isOptionsTarget = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (composerOptionsRef.current?.contains(target) === true ||
        composerOptionsTriggerRef.current?.contains(target) === true);
    const dismissOutside = (event: Event): void => {
      if (!isOptionsTarget(event.target)) {
        setMenus({ optionsOpen: false, knowledgeScopeOpen: false });
      }
    };
    const frame = requestAnimationFrame(() => {
      composerOptionsRef.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")?.focus();
    });
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [composerOptionsOpen, setMenus]);

  useEffect(() => {
    if (!runtimeMenuOpen) {
      return;
    }
    const menu = runtimeMenuRef.current;
    if (!menu) {
      return;
    }
    const menuItems = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"], [role="menuitem"]',
      ),
    ).filter((item) => !item.disabled);
    const initialItem =
      menuItems.find((item) => item.getAttribute("aria-checked") === "true") ??
      menuItems[0];
    menuItems.forEach((item) => {
      item.tabIndex = item === initialItem ? 0 : -1;
    });
    const focusFrame = requestAnimationFrame(() => {
      initialItem?.focus();
    });
    const isRuntimeMenuTarget = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (menu.contains(target) ||
        runtimeMenuButtonRef.current?.contains(target) === true);
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (!isRuntimeMenuTarget(event.target)) {
        setRuntimeMenuOpen(false);
      }
    };
    const dismissOnOutsideFocus = (event: FocusEvent): void => {
      if (!isRuntimeMenuTarget(event.target)) {
        setRuntimeMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("focusin", dismissOnOutsideFocus);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("focusin", dismissOnOutsideFocus);
    };
  }, [activeRuntimeSelectionKey, runtimeMenuButtonRef, runtimeMenuOpen, setRuntimeMenuOpen]);

  const runtimeAgentControlAvailable =
    activeRuntimeSelection?.provider === "opencode" &&
    runtimeAgentOptions.length > 1;
  const runtimePresetControlAvailable =
    activeRuntimeSelection?.provider === "continue" &&
    runtimePresetOptions.length > 1;
  const runtimeActionControlAvailable =
    (activeRuntimeSelection?.provider === "opencode" ||
      activeRuntimeSelection?.provider === "continue") &&
    runtimeActionOptions.length > 1;
  const runtimeControlsAvailable =
    runtimeAgentControlAvailable ||
    runtimePresetControlAvailable ||
    runtimeActionControlAvailable;
  const runtimeControlsProvider = runtimeControlsAvailable
    ? activeRuntimeSelection?.provider === "opencode"
      ? "OpenCode"
      : activeRuntimeSelection?.provider === "continue"
        ? "Continue"
        : undefined
    : undefined;
  const runtimeControlsLabel = runtimeControlsProvider
    ? t("composer.runtimeControls.groupLabel", {
        runtime: runtimeControlsProvider,
      })
    : "";
  const composerOptionSummary = [
    selectedExpertId && runtime?.capability !== "image-generation"
      ? assistantExpertOptions.find((option) => option.value === selectedExpertId)?.label
      : undefined,
    enabledKnowledgeLibraryIds.length > 0
      ? t("composer.knowledge.select", { count: enabledKnowledgeLibraryIds.length })
      : undefined,
    view?.knowledgeRetrievalMode === "always"
      ? t("composer.knowledge.always")
      : undefined,
    runtimeAgentControlAvailable && selectedRuntimeAgent
      ? runtimeAgentOptions.find((option) => option.value === selectedRuntimeAgent)?.label
      : undefined,
    runtimePresetControlAvailable && selectedContinuePreset
      ? runtimePresetOptions.find((option) => option.value === selectedContinuePreset)?.label
      : undefined,
    runtimeActionControlAvailable && selectedRuntimeCommand
      ? runtimeActionOptions.find((option) => option.action?.type === "command" && option.action.id === selectedRuntimeCommand)?.label
      : undefined,
  ].filter(Boolean).join(" · ");

  const composerContextMetrics = useMemo(() => {
    if (
      !view ||
      !runtimeSettings ||
      !activeRuntimeSelection ||
      view.remote
    ) {
      return undefined;
    }
    const resolvedRuntimeSelection = activeRuntimeSelection;
    const activeModelProfile =
      "profileId" in resolvedRuntimeSelection &&
      resolvedRuntimeSelection.profileId
        ? runtimeSettings.modelProfiles.find(
            (candidate) => candidate.id === resolvedRuntimeSelection.profileId,
          )
        : undefined;
    if (activeModelProfile?.protocol === "openai-images-generations") {
      return undefined;
    }
    const latest = view.contextMetrics;
    const applicableLatest =
      latest?.runtimeSelectionKey ===
      agentRuntimeSelectionKey(resolvedRuntimeSelection)
        ? latest
        : undefined;
    if (!applicableLatest) {
      return undefined;
    }
    const compressionSettings =
      runtimeSettings.contextCompression ?? defaultContextCompressionSettings;
    const contextTokens = applicableLatest.contextTokens;
    const contextWindowTokens = activeModelProfile?.contextWindowTokens;
    const effectiveTriggerTokens = getEffectiveContextTriggerTokens({
      triggerTokens: compressionSettings.triggerTokens,
      contextWindowTokens,
    });
    const denominatorTokens = contextWindowTokens;
    const percentage =
      denominatorTokens === undefined
        ? undefined
        : Math.round((contextTokens / denominatorTokens) * 100);

    return {
      contextTokens,
      effectiveTriggerTokens,
      contextWindowTokens,
      compressionEnabled:
        resolvedRuntimeSelection.provider === "model" &&
        compressionSettings.enabled,
      source: applicableLatest.source,
      basis:
        applicableLatest.basis ??
        (applicableLatest.source === "estimated" &&
        view.contextCompressionState
          ? "conversation"
          : "model-call"),
      denominatorTokens,
      percentage,
    };
  }, [view, activeRuntimeSelection, runtimeSettings]);

  const runtimeState =
    runtimeSwitching ||
    !runtime ||
    runtimeStatusKey !== activeRuntimeSelectionKey
      ? "connecting"
      : runtime.available
        ? "ready"
        : "unavailable";
  const runtimeDetail =
    runtimeState === "connecting"
      ? t("runtime.connecting")
      : runtime?.detail ||
        (runtimeState === "unavailable"
          ? t("runtime.unavailable")
          : t("runtime.state.ready"));

  return (
    <>
      <ConversationInputQueue
        items={queueItems}
        onError={actions.queueError}
        onInterruptAndRun={actions.interruptQueueItem}
        onRemove={actions.removeQueueItem}
        onRestore={restoreQueueItem}
        running={executionRunning}
      />
      <div className="composer">
        <ImageCapabilityNotice
          runtime={runtime}
          workMode={effectiveWorkMode}
          hasCallableImageModels={runtimeSettings?.modelProfiles.some(profile =>
            profile.protocol === "openai-images-generations" && profile.allowConversationInvocation === true
          ) ?? false}
          onOpenModelSettings={actions.openModelSettings}
        />
        {composerOptionSummary && (
          <div className="composer__option-summary" aria-label={t("composer.settings")}>
            {composerOptionSummary}
          </div>
        )}
        <PendingDocumentImports key={conversationId} conversationId={conversationId} refreshing={selectingContextFiles} onBusyChange={updateAttachmentBusy} />
        {attachments.some((attachment) => attachment.kind === 'image') && <AttachmentCapabilityNotice key={`${conversationId}:${activeRuntimeSelectionKey}`} conversationId={conversationId} selection={activeRuntimeSelection} revision={`${attachments.map((item) => item.id).join(',')}:${runtimeSettings?.defaultModelProfileId}:${runtimeStatusKey}`} />}
        {(attachments.length > 0 || imageReferences.length > 0 ||
          selectingContextFiles) && (
          <div
            aria-busy={selectingContextFiles}
            aria-describedby={
              contextError
                ? composerContextErrorId
                : undefined
            }
            aria-invalid={contextError ? true : undefined}
            className="context-list"
          >
            {imageReferences.map(artifact => <div className="context-chip" key={artifact.id}>
              {artifact.content && <img alt="" className="context-chip__thumbnail" src={artifact.content} />}
              <span><strong>{artifact.title}</strong><small>{t('chat.images.edit')}</small></span>
              <button type="button" aria-label={t('composer.removeAttachment', { name: artifact.title })}
                onClick={() => actions.removeImageReference(conversationId, artifact.id)}>×</button>
            </div>)}
            {attachments.map((attachment) => (
              <div
                className="context-chip"
                key={attachment.attachmentId ?? attachment.id}
                title={attachment.preview}
              >
                {attachment.kind === "image" &&
                 (attachment.thumbnailUrl || attachment.contentUrl) ? (
                  <button
                    type="button"
                    className="message-image-button"
                    aria-label={t('chat.images.viewNamed', { title: attachment.name })}
                    onClick={(event) => actions.openImageViewer({ src: attachment.contentUrl ?? attachment.thumbnailUrl!, title: attachment.name }, event.currentTarget)}
                  >
                  <img
                    alt=""
                    className="context-chip__thumbnail"
                    src={attachment.thumbnailUrl ?? attachment.contentUrl}
                  />
                  </button>
                ) : (
                  <FileText size={14} />
                )}
                <span>
                  <strong title={attachment.name}>{attachment.name}</strong>
                  <span className="attachment-metadata">
                    <AttachmentStatus attachment={attachment} />
                    <small>
                      {formatAttachmentSize(attachment.size)}
                    </small>
                  </span>
                  <span className="attachment-actions">
                    {attachment.resultId && <AttachmentResultButton resultId={attachment.resultId} name={attachment.name} conversationId={conversationId} />}
                    <AttachmentActions attachment={attachment} conversationId={conversationId} onBusyChange={updateAttachmentBusy} />
                  </span>
                </span>
                <button
                  className="icon-button attachment-action"
                  title={t("composer.removeAttachment", { name: attachment.name })}
                  data-tooltip={t("composer.removeAttachment", { name: attachment.name })}
                  aria-label={t("composer.removeAttachment", {
                    name: attachment.name,
                  })}
                  onClick={() => actions.removeAttachment(attachment.id)}
                  type="button"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
            {selectingContextFiles && (
              <div
                aria-live="polite"
                className="context-chip context-chip--processing"
                role="status"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="context-chip__spinner"
                  size={16}
                />
                <span>
                  <strong>
                    {fileSelectionProgress
                      ? t(
                          `composer.attachmentProgress.${fileSelectionProgress.phase}`,
                          {
                            name: fileSelectionProgress.fileName,
                          },
                        )
                      : t(
                          "composer.attachmentProgress.selecting",
                        )}
                  </strong>
                  <small>
                    {fileSelectionProgress
                      ? t(
                          "composer.attachmentProgress.fileCount",
                          {
                            current:
                              fileSelectionProgress.fileNumber,
                            total:
                              fileSelectionProgress.fileCount,
                          },
                        )
                      : t(
                          "composer.attachmentProgress.waiting",
                        )}
                  </small>
                </span>
                <button type="button" className="icon-button attachment-action" aria-label="取消文件导入" title="取消文件导入" data-tooltip="取消文件导入" onClick={() => void window.goodbuddy.context.cancelImport(fileSelectionProgress?.operationId)}><X size={16} aria-hidden="true" /></button>
                <progress
                  aria-label={t(
                    "composer.attachmentProgress.progressLabel",
                  )}
                />
              </div>
            )}
          </div>
        )}
        <div className="composer__input">
          <ComposerDraftText
            conversationId={conversationId}
            store={composerDrafts}
          >
          {(draft) => (
          <>
          <textarea
            aria-describedby={
              contextError
                ? composerContextErrorId
                : undefined
            }
            aria-invalid={contextError ? true : undefined}
            aria-label={t("composer.inputLabel")}
            placeholder={`${
              runtime?.capability === "image-generation"
                ? `${t("composer.imagePlaceholder")}\n`
                : ""
            }${keyboardHint}\n${conversationHint}`}
            ref={inputRef}
            rows={3}
            title={`${keyboardHint}\n${conversationHint}`}
            value={draft}
            onChange={(event) => composerDrafts.set(conversationId, event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                if (actions.isSelectingContextFiles()) {
                  actions.setContextError(t("composer.attachmentProgress.waitBeforeSending"));
                  return;
                }
                if (files.length > maximumAttachmentsPerMessage) {
                  actions.setContextError(t("composer.errors.attachmentLimit"));
                  return;
                }
                try {
                  const paths = files.map((file) => window.goodbuddy.context.getFilePath(file));
                  if (paths.some(Boolean)) {
                    if (paths.some((path) => !path)) {
                      actions.setContextError(t("composer.errors.pasteFilePath"));
                      return;
                    }
                    actions.selectContextFiles(paths);
                    return;
                  }
                  if (files.some((file) => !file.type.startsWith("image/"))) {
                    actions.setContextError(t("composer.errors.pasteFilePath"));
                    return;
                  }
                } catch (reason) {
                  actions.setContextError(reason instanceof Error ? reason.message : t("composer.errors.addContext"));
                  return;
                }
              }
              const image = files.find((file) => file.type.startsWith("image/"));
              if (!image) {
                return;
              }
              const mimeType =
                image?.type === "image/jpeg" ||
                image?.type === "image/png" ||
                image?.type === "image/webp"
                  ? image.type
                  : undefined;
              event.preventDefault();
              if (!image || !mimeType) {
                actions.setContextError(
                  t("composer.errors.pasteImageType"),
                );
                return;
              }
              actions.addContext(async () => {
                if (image.size > maximumPastedImageBytes) {
                  throw new Error(
                    t("composer.errors.pasteImageSize"),
                  );
                }
                return window.goodbuddy.context.addPastedImage(
                  {
                    data: new Uint8Array(
                      await image.arrayBuffer(),
                    ),
                    mimeType,
                  },
                );
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                actions.submit();
              }
            }}
          />
          {/* After the textarea, so its ref is attached first. */}
          <ComposerDraftEffect
            draft={draft}
            onCommit={resizeComposer}
          />
          </>
          )}
          </ComposerDraftText>
        </div>
        <div className="composer__toolbar">
          <div className="composer__controls">
            <div
              aria-label={t("composer.addContent")}
              className="composer__tool-group"
              role="group"
            >
              <button
                aria-label={t("composer.addAttachment")}
                aria-describedby={
                  contextError
                    ? composerContextErrorId
                    : undefined
                }
                aria-invalid={contextError ? true : undefined}
                disabled={selectingContextFiles || attachmentOperations > 0}
                ref={attachmentButtonRef}
                onClick={() => actions.selectContextFiles()}
                title={t("composer.addAttachment")}
                type="button"
              >
                <Paperclip aria-hidden="true" size={18} />
              </button>
              <button
                aria-label={
                  voiceRecording
                    ? t("composer.voice.stopRecording")
                    : voiceListening
                      ? t("composer.voice.cancel")
                      : t("composer.voice.input")
                }
                aria-pressed={voiceRecording}
                className={
                  voiceRecording
                    ? "composer__voice-button composer__voice-button--recording"
                    : voiceListening
                      ? "composer__voice-button composer__voice-button--processing"
                      : "composer__voice-button"
                }
                data-state={
                  voiceRecording
                    ? "recording"
                    : voiceListening
                      ? "processing"
                      : "idle"
                }
                onClick={actions.toggleVoiceInput}
                title={
                  voiceRecording
                    ? t("composer.voice.stopAndRecognize")
                    : voiceListening
                      ? t("composer.voice.cancel")
                      : t("composer.voice.description")
                }
                type="button"
              >
                <Mic aria-hidden="true" size={18} />
              </button>
            </div>
            <button
              aria-controls="composer-options"
              aria-expanded={composerOptionsOpen}
              aria-haspopup="dialog"
              aria-label={t("composer.options")}
              className="composer__options-trigger"
              onClick={() => {
                setComposerOptionsOpen(!composerOptionsOpen);
                setComposerMenuOpen(undefined);
                setRuntimeMenuOpen(false);
                setKnowledgeScopeOpen(false);
              }}
              ref={composerOptionsTriggerRef}
              title={t("composer.settings")}
              type="button"
            >
              <SlidersHorizontal aria-hidden="true" size={18} />
            </button>
            <div
              aria-label={t("composer.settings")}
              className="composer__options"
              id="composer-options"
              hidden={!composerOptionsOpen}
              ref={composerOptionsRef}
              role="dialog"
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.defaultPrevented) return;
                event.preventDefault();
                event.stopPropagation();
                if (knowledgeScopeOpen) {
                  setKnowledgeScopeOpen(false);
                  knowledgeScopeTriggerRef.current?.focus();
                } else {
                  setComposerOptionsOpen(false);
                  setComposerMenuOpen(undefined);
                  composerOptionsTriggerRef.current?.focus();
                }
              }}
            >
              <strong>{t("composer.settings")}</strong>
              {supervisorEnabled && (
                <label className="toggle-row">
                  <span>{t("composer.storyGraph.label")}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={view?.storyGraphEnabled !== false}
                    disabled={storyGraphSaving}
                    onChange={(event) => {
                      setStoryGraphSaving(true);
                      void actions.setStoryGraphEnabled(conversationId, event.target.checked)
                        .catch((error: unknown) => actions.notify({ tone: "error", message: error instanceof Error ? error.message : String(error) }))
                        .finally(() => setStoryGraphSaving(false));
                    }}
                  />
                </label>
              )}
            {knowledgeLibraries.length > 0 && (
              <div
                className="knowledge-scope"
                onBlurCapture={(event) => {
                  if (
                    event.relatedTarget instanceof Node &&
                    !event.currentTarget.contains(
                      event.relatedTarget,
                    )
                  ) {
                    setKnowledgeScopeOpen(false);
                  }
                }}
              >
                <button
                  aria-controls="knowledge-scope-popover"
                  aria-haspopup="dialog"
                  aria-label={t("composer.knowledge.select", {
                    count: enabledKnowledgeLibraryIds.length,
                  })}
                  aria-expanded={knowledgeScopeOpen}
                  onClick={() => {
                    setComposerMenuOpen(undefined);
                    setRuntimeMenuOpen(false);
                    setKnowledgeScopeOpen(
                      (current) => !current,
                    );
                  }}
                  ref={knowledgeScopeTriggerRef}
                  title={t("composer.knowledge.title")}
                  type="button"
                >
                  <Library aria-hidden="true" size={16} />
                  <span>
                    {t("navigation.knowledge")}
                    <strong>
                      {enabledKnowledgeLibraryIds.length}
                    </strong>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className="knowledge-scope__chevron"
                    size={14}
                  />
                </button>
                {knowledgeScopeOpen && (
                  <div
                    aria-label={t("composer.knowledge.scope")}
                    className="knowledge-scope__popover"
                    id="knowledge-scope-popover"
                    ref={knowledgeScopePopoverRef}
                    role="dialog"
                  >
                    <strong>
                      {t("composer.knowledge.scope")}
                    </strong>
                    {knowledgeLibraries.map(
                      (library) => {
                        const instance = externalInstances.find(item => item.id === library.external?.instanceId);
                        const externalStatus = !instance ? 'temporarily-unavailable' : !instance.enabled ? 'instance-disabled' : instance.credentialStatus !== 'configured' || instance.probeStatus === 'auth-failed' ? 'credential-error' : ['failed', 'unreachable'].includes(instance.probeStatus) ? 'temporarily-unavailable' : 'ready';
                        return (
                        <label key={library.id}>
                          <input
                            disabled={!!library.external && externalStatus !== 'ready'}
                            checked={enabledKnowledgeLibraryIds.includes(
                              library.id,
                            )}
                            onChange={(event) =>
                              actions.setEnabledKnowledgeLibraryIds(
                                (current) =>
                                  event.target.checked
                                    ? [
                                        ...new Set([
                                          ...current,
                                          library.id,
                                        ]),
                                      ]
                                    : current.filter(
                                        (id) =>
                                          id !== library.id,
                                      ),
                              )
                            }
                            type="checkbox"
                          />
                          <span>{library.name}</span>
                          <small>
                            {library.external ? `${({ dify: 'Dify', fastgpt: 'FastGPT', ragflow: 'RAGFlow' })[library.external.provider]} · ${instance?.name ?? library.external.instanceId} · ${t(`external.states.${externalStatus}`, { ns: 'knowledge' })}` : t(
                              "composer.knowledge.documents",
                              {
                                count: library.documentCount,
                              },
                            )}
                          </small>
                        </label>
                      )},
                    )}
                    <div className="knowledge-scope__retrieval-mode">
                      <strong>
                        {t("composer.knowledge.modeLabel")}
                      </strong>
                      <SegmentedControl
                        ariaLabel={t(
                          "composer.knowledge.modeLabel",
                        )}
                        onChange={actions.setKnowledgeRetrievalMode}
                        options={[
                          {
                            value: "auto",
                            label: t(
                              "composer.knowledge.auto",
                            ),
                          },
                          {
                            value: "always",
                            label: t(
                              "composer.knowledge.always",
                            ),
                          },
                        ]}
                        value={
                          view?.knowledgeRetrievalMode ??
                          "auto"
                        }
                      />
                      <small>
                        {view?.knowledgeRetrievalMode ===
                        "always"
                          ? t(
                              "composer.knowledge.alwaysDescription",
                            )
                          : t(
                              "composer.knowledge.autoDescription",
                            )}
                      </small>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="composer__configuration">
              <ComposerMenuSelect
                ariaLabel={t("composer.expertLabel")}
                className="composer-picker--expert"
                disabled={
                  isRunning ||
                  runtime?.capability === "image-generation"
                }
                icon={<Bot aria-hidden="true" size={15} />}
                menuOpen={composerMenuOpen === "expert"}
                onChange={actions.selectExpert}
                onOpenChange={setExpertMenuOpen}
                options={assistantExpertOptions}
                value={selectedExpertId}
              />
            </div>
            {runtimeControlsProvider && (
              <div aria-label={runtimeControlsLabel} className="composer__runtime-toolbar" role="group">
                <strong className="composer__runtime-toolbar-label">{runtimeControlsLabel}</strong>
                <div className="composer__runtime-controls">
                  {runtimeAgentControlAvailable && (
                    <ComposerMenuSelect
                      ariaLabel={t("composer.runtimeControls.agentLabel")}
                      className="composer-picker--runtime"
                      disabled={isRunning}
                      icon={<TerminalSquare aria-hidden="true" size={15} />}
                      menuOpen={composerMenuOpen === "runtime-agent"}
                      onChange={actions.selectRuntimeAgent}
                      onOpenChange={setRuntimeAgentMenuOpen}
                      options={runtimeAgentOptions}
                      value={selectedRuntimeAgent}
                    />
                  )}
                  {runtimePresetControlAvailable && (
                    <ComposerMenuSelect
                      ariaLabel={t("composer.runtimeControls.presetLabel")}
                      className="composer-picker--runtime"
                      disabled={isRunning}
                      icon={<TerminalSquare aria-hidden="true" size={15} />}
                      menuOpen={composerMenuOpen === "runtime-preset"}
                      onChange={actions.selectContinuePreset}
                      onOpenChange={setRuntimePresetMenuOpen}
                      options={runtimePresetOptions}
                      value={selectedContinuePreset}
                    />
                  )}
                  {runtimeActionControlAvailable && (
                    <ComposerMenuSelect
                      ariaLabel={t("composer.runtimeControls.actionLabel")}
                      className="composer-picker--runtime-action"
                      disabled={isRunning}
                      icon={<TerminalSquare aria-hidden="true" size={15} />}
                      menuOpen={composerMenuOpen === "runtime-action"}
                      onChange={actions.selectRuntimeAction}
                      onOpenChange={setRuntimeActionMenuOpen}
                      options={runtimeActionOptions}
                      value={runtimeActionOptions.find((option) => option.action?.type === "command" && option.action.id === selectedRuntimeCommand)?.value ?? ""}
                    />
                  )}
                </div>
              </div>
            )}
            </div>
            <div className="composer__configuration" role="group" aria-label={t("composer.settings")}>
              <div className="runtime-picker">
                <button
                  aria-expanded={runtimeMenuOpen}
                  aria-haspopup="menu"
                  className="model-button"
                  disabled={isRunning || runtimeSwitching}
                  onClick={() => {
                    setComposerOptionsOpen(false);
                    setKnowledgeScopeOpen(false);
                    setComposerMenuOpen(undefined);
                    setRuntimeMenuOpen(!runtimeMenuOpen);
                  }}
                  onKeyDown={(event) => {
                    if (
                      !runtimeMenuOpen &&
                      (event.key === "ArrowDown" ||
                        event.key === "Enter" ||
                        event.key === " ")
                    ) {
                      event.preventDefault();
                      setComposerOptionsOpen(false);
                      setKnowledgeScopeOpen(false);
                      setComposerMenuOpen(undefined);
                      setRuntimeMenuOpen(true);
                    }
                  }}
                  ref={runtimeMenuButtonRef}
                  title={t("runtime.pickerTitle", {
                    label: runtimeModelDetail
                      ? `${runtimeLabel} (${runtimeModelDetail})`
                      : runtimeLabel,
                  })}
                  type="button"
                >
                  <Sparkles aria-hidden="true" size={15} />
                  <span className="model-button__label">
                    {runtimeSwitching
                      ? t("runtime.switching")
                      : runtimeLabel}
                  </span>
                  {!runtimeSwitching && runtimeModelDetail && (
                    <span className="sr-only">{` (${runtimeModelDetail})`}</span>
                  )}
                  {runtime?.capability ===
                    "image-generation" && (
                    <span className="runtime-capability-badge">
                      {t("runtime.imageGeneration")}
                    </span>
                  )}
                  <ChevronDown aria-hidden="true" size={14} />
                </button>
                {runtimeMenuOpen && runtimeSettings && (
                  <RuntimeModelPicker
                    conversationLayer={view?.runtimeSelection}
                    onClose={() => {
                      setRuntimeMenuOpen(false);
                      runtimeMenuButtonRef.current?.focus();
                    }}
                    onManage={() => {
                      setRuntimeMenuOpen(false);
                      actions.openModelSettings();
                    }}
                    onSelect={(layer) => actions.switchRuntime(layer)}
                    projectLayer={projectRuntimeSelection}
                    ref={runtimeMenuRef}
                    remote={projectUsesManagedSsh}
                    runtimeSettings={runtimeSettings}
                  />
                )}
              </div>
              <ComposerMenuSelect
                ariaLabel={t("composer.modeLabel")}
                className={`composer-picker--mode composer-picker--${effectiveWorkMode}`}
                disabled={isRunning}
                icon={
                  effectiveWorkMode === "execute" ? (
                    <ShieldCheck aria-hidden="true" size={15} />
                  ) : (
                    <CircleHelp aria-hidden="true" size={15} />
                  )
                }
                menuOpen={composerMenuOpen === "mode"}
                onChange={actions.setWorkMode}
                onOpenChange={setModeMenuOpen}
                options={workModeOptions}
                triggerLabel={effectiveWorkMode === "execute" ? "Execute" : "Ask"}
                value={effectiveWorkMode}
              />
            </div>
          </div>
          <div className="composer__submit-actions">
            {isRunning && (
              <button
                className="send-button send-button--stop"
                type="button"
                aria-label={t("composer.stop")}
                onClick={() => actions.stop()}
                title={t("composer.stop")}
              >
                <Square
                  aria-hidden="true"
                  fill="currentColor"
                  size={15}
                />
              </button>
            )}
            <span className="sr-only" id={runtimeDetailId}>
              {runtimeDetail}
            </span>
            <ComposerDraftHasText
              conversationId={conversationId}
              store={composerDrafts}
            >
            {(draftHasText) => (
            <button
              aria-describedby={
                runtimeState !== "ready"
                  ? runtimeDetailId
                  : undefined
              }
              className="send-button"
              type="button"
              aria-label={
                executionRunning
                  ? t("composer.queueMessage")
                  : t("composer.send")
              }
              disabled={
                (!draftHasText &&
                  !(
                    activeRuntimeSelection?.provider ===
                      "opencode" &&
                    runtimeNativeSnapshot?.commands.some(
                      (command) =>
                        command.id === selectedRuntimeCommand,
                    )
                  )) ||
                selectingContextFiles || attachmentOperations > 0 ||
                projectRecoveryBlocked ||
                !runtime?.available ||
                runtimeSwitching ||
                runtimeStatusKey !== activeRuntimeSelectionKey
              }
              onClick={() => actions.submit()}
              title={
                executionRunning
                  ? t("composer.queueMessageTitle")
                  : t("composer.sendTitle")
              }
            >
              <Send aria-hidden="true" size={17} />
            </button>
            )}
            </ComposerDraftHasText>
          </div>
        </div>
      </div>
      <div
        className="composer-meta"
      >
        <div className="composer-meta__actions">
        {nativeClientAvailable && <RuntimeNativeClientActions
          browser={activeRuntimeSelection?.provider === "deepseek-harness"}
          contextKey={nativeClientContextKey}
          conversationId={view?.id}
          prepareConversation={actions.prepareNativeClientConversation}
          notify={actions.notify}
          onTerminal={openNativeTerminal}
        />}
        {runtimeContextCompactAvailable && (
          <button
            className="composer-context-compact"
            disabled={runtimeContextCompacting || isRunning}
            onClick={() => actions.compactRuntimeContext()}
            title={runtimeNativeSnapshot?.context.detail}
            type="button"
          >
            {runtimeContextCompacting ? (
              <LoaderCircle
                aria-hidden="true"
                className="context-chip__spinner"
                size={13}
              />
            ) : (
              <RefreshCw aria-hidden="true" size={13} />
            )}
            {runtimeContextCompacting
              ? t("composer.context.compacting")
              : t("composer.context.compact")}
          </button>
        )}
        </div>
        {composerContextMetrics && (
          <div
            className={`composer-context-meter${
              composerContextMetrics.percentage !==
                undefined &&
              composerContextMetrics.percentage >= 90
                ? " composer-context-meter--warning"
                : ""
            }`}
            title={
              composerContextMetrics.compressionEnabled
                ? t("composer.context.compressionTrigger", {
                    tokens: formatCompactTokens(
                      composerContextMetrics.effectiveTriggerTokens,
                    ),
                  })
                : undefined
            }
          >
            <span className="composer-context-meter__summary">
              {composerContextMetrics.denominatorTokens ===
              undefined
                ? t(
                    composerContextMetrics.basis ===
                      "conversation"
                      ? composerContextMetrics.compressionEnabled
                        ? "composer.context.conversationThresholdUsage"
                        : "composer.context.conversationTokenCount"
                      : composerContextMetrics.compressionEnabled
                        ? composerContextMetrics.source ===
                          "provider"
                          ? "composer.context.confirmedThresholdUsage"
                          : "composer.context.thresholdUsage"
                        : composerContextMetrics.source ===
                            "provider"
                          ? "composer.context.confirmedTokenCount"
                          : "composer.context.tokenCount",
                    {
                      used: formatCompactTokens(
                        composerContextMetrics.contextTokens,
                      ),
                      total: formatCompactTokens(
                        composerContextMetrics.effectiveTriggerTokens,
                      ),
                    },
                  )
                : t(
                    composerContextMetrics.basis ===
                      "conversation"
                      ? "composer.context.conversationWindowUsage"
                      : composerContextMetrics.source ===
                          "provider"
                        ? "composer.context.confirmedWindowUsage"
                        : "composer.context.windowUsage",
                    {
                      used: formatCompactTokens(
                        composerContextMetrics.contextTokens,
                      ),
                      total: formatCompactTokens(
                        composerContextMetrics.denominatorTokens,
                      ),
                      percentage:
                        composerContextMetrics.percentage ??
                        0,
                    },
                  )}
            </span>
            {composerContextMetrics.denominatorTokens !==
              undefined && (
              <div
                aria-label={t(
                  "composer.context.progressLabel",
                )}
                aria-valuemax={
                  composerContextMetrics.denominatorTokens
                }
                aria-valuemin={0}
                aria-valuenow={Math.min(
                  composerContextMetrics.contextTokens,
                  composerContextMetrics.denominatorTokens,
                )}
                className="composer-context-meter__track"
                role="progressbar"
              >
                <span
                  className="composer-context-meter__fill"
                  style={{
                    width: `${Math.min(
                      100,
                      composerContextMetrics.percentage ?? 0,
                    )}%`,
                  }}
                />
                {composerContextMetrics.contextWindowTokens !==
                  undefined &&
                  composerContextMetrics.compressionEnabled && (
                    <span
                      aria-hidden="true"
                      className="composer-context-meter__trigger"
                      style={{
                        left: `${Math.min(
                          100,
                          Math.round(
                            (composerContextMetrics.effectiveTriggerTokens /
                              composerContextMetrics.contextWindowTokens) *
                              100,
                          ),
                        )}%`,
                      }}
                    />
                  )}
              </div>
            )}
          </div>
        )}
        {contextError && (
          <span
            aria-label={contextError}
            className="composer-meta__error"
            id={composerContextErrorId}
            role="alert"
          >
            {contextError}
          </span>
        )}
      </div>
    </>
  );
});

const emptyLibraryIds: string[] = [];
