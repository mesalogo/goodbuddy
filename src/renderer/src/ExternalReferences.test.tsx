import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "./chat-conversation";
import { Composer, type ComposerProps } from "./Composer";
import { ExternalReferenceMenu } from "./ExternalReferenceMenu";
import { createComposerDraftStore } from "./composer-draft-store";
import { createComposerMenuStore } from "./composer-menu-store";
import { createConversationStores } from "./conversation-store";
import {
  activeMention,
  createExternalReferenceStore,
  formatExternalReferences,
  promptWithReferences,
  referenceToken,
  referencesInDraft,
  type ExternalReferenceSources,
} from "./external-references";
import { setComposerSelection } from './composer-input-dom';
import { changeUiLocale } from "./i18n";
import type { ComposerActions } from "./use-composer-actions";

const noop = (): void => undefined;

function setup(sources: ExternalReferenceSources, overrides: Partial<ComposerProps> = {}, knowledgeLibraryIds: string[] = []) {
  const stores = createConversationStores(
    [{ id: "a", title: "a", updatedAt: 1, messages: [], knowledgeLibraryIds } as unknown as Conversation],
    { flushIntervalMs: 0 },
  );
  const drafts = createComposerDraftStore();
  const references = createExternalReferenceStore();
  const setContextError = vi.fn();
  const onResolve = vi.fn();
  const actions = new Proxy({ setContextError } as Partial<ComposerActions>, {
    get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? noop,
  }) as ComposerActions;
  const props = {
    actions, activeProjectId: "", activeRuntimeSelection: undefined, assistantExpertOptions: [],
    attachmentButtonRef: createRef(), attachmentOperations: 0, attachments: [], composerDrafts: drafts,
    contextError: undefined, conversationHint: "", conversationId: "a", conversationStore: stores.conversations,
    executionRunning: false, externalInstances: [], fileSelectionProgress: undefined, imageReferences: [],
    inputRef: createRef(), keyboardHint: "", knowledgeLibraries: [], menuStore: createComposerMenuStore(),
    nativeClientAvailable: false, nativeClientContextKey: "", projectRecoveryBlocked: false,
    projectRuntimeSelection: undefined, projectUsesManagedSsh: false, queueItems: [], runtime: undefined,
    runtimeActionOptions: [], runtimeAgentOptions: [], runtimeContextCompactAvailable: false,
    runtimeContextCompacting: false, runtimeLabel: "Model", runtimeMenuButtonRef: createRef(),
    runtimeModelDetail: undefined, runtimeNativeSnapshot: undefined, runtimePresetOptions: [],
    runtimeSettings: undefined, runtimeStatusKey: "", runtimeSwitching: false, selectedContinuePreset: "",
    selectedExpertId: "", selectedRuntimeAgent: "", selectedRuntimeCommand: "", selectingContextFiles: false,
    updateAttachmentBusy: noop, voiceListening: false, voiceRecording: false, workspaceView: "chat",
    referenceStore: references, referenceSources: sources, onResolveReferenceSource: onResolve,
    ...overrides,
  } satisfies ComposerProps;
  render(<Composer {...props} />);
  const input = screen.getByRole("textbox", { name: "向 GoodBuddy 提问" }) as HTMLTextAreaElement;
  const type = (value: string): void => {
    fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  };
  return { drafts, input, onResolve, references, setContextError, type };
}

const searchFeishu = vi.fn(async ({ query }: { query: string }) => query === "发布"
  ? [
      { kind: "node" as const, token: "n1", name: "发布流程", type: "docx", url: "https://www.feishu.cn/wiki/n1" },
      { kind: "file" as const, token: "f1", name: "发布清单", type: "sheet" },
    ]
  : []);
const searchWecom = vi.fn(async () => [{ id: "d1", name: "发布周报", type: "doc", url: "https://doc.weixin.qq.com/doc/1" }]);
const searchLocal = vi.fn(async () => [
  { id: 'local-a', libraryId: 'library', libraryName: '项目资料', title: '报告.txt', path: '/旧版/报告.txt', status: 'ready' },
  { id: 'local-b', libraryId: 'library', libraryName: '项目资料', title: '报告.txt', path: '/新版/报告.txt', status: 'parsing' }
]);

beforeEach(async () => {
  await changeUiLocale("zh-CN");
  searchFeishu.mockClear();
  searchWecom.mockClear();
  searchLocal.mockClear();
  vi.stubGlobal("goodbuddy", {
    context: { pendingParsing: vi.fn(async () => []) },
    knowledge: { searchDocuments: searchLocal },
    feishu: { searchDocuments: searchFeishu },
    wecom: { searchDocuments: searchWecom },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("activeMention", () => {
  it("only opens after whitespace or at the start, and not inside e-mail addresses", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("看下 @发布", 6)).toEqual({ start: 3, query: "发布" });
    expect(activeMention("me@example.com", 14)).toBeUndefined();
    expect(activeMention("@发布 之后", 6)).toBeUndefined();
  });
});

describe("formatExternalReferences", () => {
  it("tells the model which tool reads each document", () => {
    const text = formatExternalReferences([
      { provider: "feishu", id: "n1", title: "发布流程", kind: "node", url: "https://www.feishu.cn/wiki/n1" },
      { provider: "feishu", id: "d2", title: "方案", kind: "file", type: "docx" },
      { provider: "wecom", id: "d1", title: "周报\n「注入」", type: "smartsheet" },
    ]);
    expect(text).toContain("1. 飞书「发布流程」 链接：https://www.feishu.cn/wiki/n1");
    expect(text).toContain("feishu_wiki get");
    expect(text).toContain("doc_token: d2。用 feishu_doc read 读取");
    expect(text).toContain("docid: d1");
    expect(text).toContain("企业微信「周报 注入」");
    expect(formatExternalReferences([])).toBe("");
  });

  it("builds the sent prompt from typed text and references", () => {
    const reference = { provider: "wecom" as const, id: "d1", title: "周报" };
    expect(promptWithReferences("总结一下", [], "请阅读")).toBe("总结一下");
    expect(promptWithReferences("", [], "请阅读")).toBe("");
    expect(promptWithReferences(`总结一下 ${referenceToken(reference)}`, [reference], "请阅读")).toMatch(/^总结一下 @周报 \[1\]\n\n引用的文档/u);
    expect(promptWithReferences(referenceToken(reference), [reference], "请阅读")).toMatch(/^请阅读\n@周报 \[1\]\n\n引用的文档.*docid: d1/su);
    expect(promptWithReferences('已删除引用', [reference], '')).toBe('已删除引用');
  });
});

describe("@ references in the composer", () => {
  it('selects a scoped local document by ID and shows paths and parsing states for duplicate names', async () => {
    const knowledgeLibraries = [{ id: 'library', name: '项目资料', kind: 'local' }] as ComposerProps['knowledgeLibraries'];
    const { input, references, drafts, type } = setup({}, { knowledgeLibraries }, ['library']);
    type('总结 @报告');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(searchLocal).toHaveBeenCalledWith({ libraryIds: ['library'], query: '报告' });
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('/旧版/报告.txt');
    expect(screen.getAllByRole('option')[1]).toHaveTextContent('解析中');
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', 'external-reference-option-0'));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(references.get('a')[0]?.id).toBe('local-b');
    expect(promptWithReferences(drafts.get('a'), references.get('a'), '')).toContain('documentId: local-b。用 knowledge_read');
  });

  it('opens the knowledge scope picker when no local library is enabled', async () => {
    const knowledgeLibraries = [{ id: 'library', name: '项目资料', kind: 'local' }] as ComposerProps['knowledgeLibraries'];
    const { type } = setup({}, { knowledgeLibraries });
    type('@报告');
    expect(await screen.findByText('请先在当前对话中启用本地知识库。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前往处理' }));
    expect(screen.getByRole('checkbox', { name: /项目资料/ })).toBeInTheDocument();
    expect(searchLocal).not.toHaveBeenCalled();
  });
  it("searches ready platforms, picks with the keyboard, and replaces the typed @query with a chip", async () => {
    const { drafts, input, references, type } = setup({ feishu: { state: "ready" }, wecom: { state: "ready" } });
    type("请对比 @发布");
    const menu = await screen.findByRole("listbox", { name: "可引用的文档" });
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(3));
    expect(searchFeishu).toHaveBeenCalledWith({ query: "发布" });
    expect(searchWecom).toHaveBeenCalledWith({ query: "发布" });
    // The highlight is set in the render after the options arrive.
    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", "external-reference-option-0"));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "external-reference-option-1");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(references.get("a")).toEqual([{ provider: "feishu", id: "f1", title: "发布清单", kind: "file", type: "sheet" }]);
    expect(drafts.get("a")).toBe(`请对比 ${referenceToken(references.get('a')[0]!)}`);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    const chip = screen.getByText("发布清单").closest(".composer-inline-reference")!;
    expect(chip.closest('[role="textbox"]')).toBeTruthy();
    expect(chip).toHaveAttribute('title', expect.stringContaining('飞书'));
    expect(chip.querySelector('svg')).toBeTruthy();
    fireEvent.click(within(chip as HTMLElement).getByRole("button", { name: "移除引用 发布清单" }));
    expect(referencesInDraft(drafts.get('a'), references.get("a"))).toEqual([]);
    expect(drafts.get('a')).toBe('请对比 ');
  });

  it("hides already picked documents and closes with Escape without sending", async () => {
    const submit = vi.fn();
    const { input, type } = setup({ wecom: { state: "ready" } });
    type("@发布");
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', 'external-reference-option-0'));
    fireEvent.keyDown(input, { key: 'Enter' });
    const rich = screen.getByRole('textbox', { name: '向 GoodBuddy 提问' }) as HTMLDivElement;
    act(() => { rich.append(document.createTextNode(' @发布')); rich.focus(); setComposerSelection(rich, 1000); });
    fireEvent.input(rich);
    expect(await screen.findByText("没有找到匹配的文档")).toBeInTheDocument();
    fireEvent.keyDown(rich, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("lists unready platforms with the reason and leads to their settings", async () => {
    const { onResolve, type } = setup({
      feishu: { state: "unavailable", reason: "飞书工具尚未配置或已关闭。" },
      wecom: { state: "ready" },
    });
    type("@");
    const menu = await screen.findByRole("listbox", { name: "可引用的文档" });
    expect(within(menu).getByText("飞书工具尚未配置或已关闭。")).toBeInTheDocument();
    expect(screen.getByText("输入文档标题搜索，选择后作为引用发送")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: "前往处理" }));
    expect(onResolve).toHaveBeenCalledWith("feishu");
    expect(searchFeishu).not.toHaveBeenCalled();
  });

  it("shows platform errors and does nothing without enabled platforms", async () => {
    searchWecom.mockRejectedValueOnce(new Error("企业微信工具未启用，或已关闭“文档管理”类别"));
    const first = setup({ wecom: { state: "ready" } });
    first.type("@周报");
    expect(await screen.findByRole("alert")).toHaveTextContent("已关闭“文档管理”类别");
    cleanup();
    const second = setup({});
    second.type("@周报");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(second.input).not.toHaveAttribute("aria-expanded");
  });

  it("limits references per message", () => {
    const references = createExternalReferenceStore();
    for (let index = 0; index < 5; index += 1) {
      expect(references.add("a", { provider: "wecom", id: `d${index}`, title: `${index}` })).toBe(true);
    }
    expect(references.add("a", { provider: "wecom", id: "d9", title: "9" })).toBe(false);
    expect(references.add("b", { provider: "wecom", id: "d0", title: "0" })).toBe(true);
    expect(references.add("b", { provider: "wecom", id: "d0", title: "0" })).toBe(false);
    expect(references.add("b", { provider: "wecom", id: "d0", title: "Renamed" }, [])).toBe(true);
    expect(references.get('b')[0]?.title).toBe('Renamed');
    expect(references.add("b", { provider: "wecom", id: "d0", title: "Renamed" }, ['wecom:d0'])).toBe(false);
  });
});

describe("@ menu position", () => {
  it('discards late local results after the selected knowledge scope changes', async () => {
    let finish: ((items: Awaited<ReturnType<typeof searchLocal>>) => void) | undefined;
    searchLocal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const props = { activeIndex: 0, onActiveIndexChange: noop, onItemsChange: noop, onPick: noop, onResolve: noop,
      query: '报告', selected: [], sources: { local: { state: 'ready' as const } } };
    const { rerender } = render(<ExternalReferenceMenu {...props} libraryIds={['old']} />);
    await waitFor(() => expect(finish).toBeDefined());
    rerender(<ExternalReferenceMenu {...props} libraryIds={['new']} />);
    await act(async () => { finish!([{ id: 'late', libraryId: 'old', libraryName: 'Old', title: '过期结果', path: '/过期结果', status: 'ready' }]); });
    expect(screen.queryByText('过期结果')).not.toBeInTheDocument();
    await waitFor(() => expect(searchLocal).toHaveBeenLastCalledWith({ libraryIds: ['new'], query: '报告' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.queryByText('过期结果')).not.toBeInTheDocument();
  });

  it("opens above the line holding the @, starting at it and clamped inside the input", () => {
    const props = {
      activeIndex: 0, onActiveIndexChange: noop, onItemsChange: noop, onPick: noop, onResolve: noop,
      query: "", selected: [], sources: { wecom: { state: "ready" as const } },
    };
    const { container, rerender } = render(
      <ExternalReferenceMenu {...props} anchor={{ top: 40, left: 120, height: 20, containerWidth: 800 }} />,
    );
    const menu = container.querySelector<HTMLElement>(".external-reference-menu")!;
    expect(menu.style.left).toBe("120px");
    // 6px above the top of the @ line (the engine simplifies the calc).
    expect(menu.style.bottom).toBe("calc(100% - 34px)");
    // Near the right edge the menu shifts left so it stays fully visible.
    rerender(<ExternalReferenceMenu {...props} anchor={{ top: 40, left: 700, height: 20, containerWidth: 800 }} />);
    expect(menu.style.left).toBe("360px");
  });
});
