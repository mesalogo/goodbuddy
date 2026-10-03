import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Conversation } from "./chat-conversation";
import { useConversationTitles } from "./conversation-selectors";
import { createConversationStores } from "./conversation-store";
import { usePaneOrder } from "./pane-order";

function conversation(id: string, title = id): Conversation {
  return { id, title, updatedAt: 1, messages: [] } as unknown as Conversation;
}

describe("useConversationTitles", () => {
  it("keeps the same map while only non-title fields change", () => {
    const { conversations: store } = createConversationStores(
      [conversation("a"), conversation("b")],
      { flushIntervalMs: 0 },
    );
    const { result } = renderHook(() => useConversationTitles(store, "New"));
    const first = result.current;
    act(() => store.set((current) => current.map((item) => ({ ...item, updatedAt: 2 }))));
    expect(result.current).toBe(first);
    act(() => store.set((current) => current.map((item) =>
      item.id === "b" ? { ...item, title: "Renamed" } : item)));
    expect(result.current).not.toBe(first);
    expect(result.current.get("b")).toBe("Renamed");
  });
});

describe("usePaneOrder", () => {
  it("keeps existing panes in place and returns the same array when unchanged", () => {
    const { result, rerender } = renderHook(({ ids }) => usePaneOrder(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    const first = result.current;
    expect(first).toEqual(["a", "b"]);
    rerender({ ids: ["b", "a"] });
    expect(result.current).toBe(first);
    rerender({ ids: ["c", "a", "b"] });
    expect(result.current).toEqual(["a", "b", "c"]);
  });
});
