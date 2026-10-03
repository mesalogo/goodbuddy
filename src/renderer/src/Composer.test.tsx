import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "./chat-conversation";
import { Composer, type ComposerProps } from "./Composer";
import { createComposerDraftStore } from "./composer-draft-store";
import { createComposerMenuStore } from "./composer-menu-store";
import { createConversationStores } from "./conversation-store";
import { changeUiLocale } from "./i18n";
import type { ComposerActions } from "./use-composer-actions";

function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return { id, title: id, updatedAt: 1, messages: [], ...overrides } as Conversation;
}

const noop = (): void => undefined;
const actions = new Proxy({}, {
  get: () => noop,
}) as ComposerActions;

function setup() {
  const stores = createConversationStores(
    [conversation("a"), conversation("b")],
    { flushIntervalMs: 0 },
  );
  const drafts = createComposerDraftStore();
  const props: ComposerProps = {
    actions,
    activeProjectId: "",
    activeRuntimeSelection: undefined,
    assistantExpertOptions: [],
    attachmentButtonRef: createRef(),
    attachmentOperations: 0,
    attachments: [],
    composerDrafts: drafts,
    contextError: undefined,
    conversationHint: "",
    conversationId: "a",
    conversationStore: stores.conversations,
    effectiveWorkMode: "ask",
    executionRunning: false,
    externalInstances: [],
    fileSelectionProgress: undefined,
    imageReferences: [],
    inputRef: createRef(),
    keyboardHint: "",
    knowledgeLibraries: [],
    menuStore: createComposerMenuStore(),
    nativeClientAvailable: false,
    nativeClientContextKey: "",
    projectRecoveryBlocked: false,
    projectRuntimeSelection: undefined,
    projectUsesManagedSsh: false,
    queueItems: [],
    runtime: undefined,
    runtimeActionOptions: [],
    runtimeAgentOptions: [],
    runtimeContextCompactAvailable: false,
    runtimeContextCompacting: false,
    runtimeLabel: "Model",
    runtimeMenuButtonRef: createRef(),
    runtimeModelDetail: undefined,
    runtimeNativeSnapshot: undefined,
    runtimePresetOptions: [],
    runtimeSettings: undefined,
    runtimeStatusKey: "",
    runtimeSwitching: false,
    selectedContinuePreset: "",
    selectedExpertId: "",
    selectedRuntimeAgent: "",
    selectedRuntimeCommand: "",
    selectingContextFiles: false,
    updateAttachmentBusy: noop,
    voiceListening: false,
    voiceRecording: false,
    workspaceView: "chat",
    workModeOptions: [],
  };
  const renders = vi.fn();
  const view = render(
    <Profiler id="composer" onRender={renders}>
      <Composer {...props} />
    </Profiler>,
  );
  renders.mockClear();
  return { drafts, props, renders, rerender: view.rerender, store: stores.conversations };
}

beforeEach(async () => {
  await changeUiLocale("en-US");
  vi.stubGlobal("goodbuddy", {
    context: { pendingParsing: vi.fn(async () => []) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Composer render boundary", () => {
  it("does not re-render when another conversation changes", () => {
    const { renders, store } = setup();
    act(() => store.set((current) => current.map((item) =>
      item.id === "b" ? { ...item, title: "B", updatedAt: 2 } : item)));
    expect(renders).not.toHaveBeenCalled();
  });

  it("does not re-render when its own conversation only gains a message", () => {
    const { renders, store } = setup();
    act(() => store.set((current) => current.map((item) =>
      item.id === "a"
        ? {
            ...item,
            updatedAt: 2,
            messages: [{ id: "m1", role: "user", content: "hi", createdAt: 1, state: "done", blocks: [] } as unknown as Conversation["messages"][number]],
          }
        : item)));
    expect(renders).not.toHaveBeenCalled();
  });

  it("re-renders when its conversation starts running and shows the stop button", () => {
    const { renders, store } = setup();
    act(() => store.set((current) => current.map((item) =>
      item.id === "a"
        ? {
            ...item,
            messages: [{ id: "m1", role: "assistant", content: "", createdAt: 1, state: "streaming", blocks: [] } as unknown as Conversation["messages"][number]],
          }
        : item)));
    expect(renders).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
  });

  it("typing in another conversation's draft does not re-render the composer", () => {
    const { drafts, renders } = setup();
    act(() => drafts.set("b", "hello"));
    expect(renders).not.toHaveBeenCalled();
  });
});
