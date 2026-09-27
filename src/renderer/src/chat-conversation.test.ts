import { describe, expect, it } from "vitest";
import { sortConversationsForDisplay, type Conversation } from "./chat-conversation";

describe("conversation display order", () => {
  it("uses stable message times for details, summaries and live messages attached to summaries", () => {
    const conversations: Conversation[] = [
      { id: "detail", title: "Detail", updatedAt: 900, messages: [
        { id: "a", role: "user", content: "", state: "complete", createdAt: 200 },
        { id: "b", role: "assistant", content: "", state: "streaming", createdAt: 100 },
      ] },
      { id: "summary", title: "Summary", updatedAt: 800, messages: [], messageSummary: { count: 2, latestMessageAt: 300 } },
      { id: "live", title: "Live", updatedAt: 700, messageSummary: { count: 2, latestMessageAt: 100 }, messages: [
        { id: "c", role: "assistant", content: "", state: "streaming", createdAt: 400 },
      ] },
      { id: "empty", title: "Empty", updatedAt: 500, messages: [] },
      { id: "pinned", title: "Pinned", updatedAt: 1, messages: [], pinned: true },
    ];
    const sorted = sortConversationsForDisplay(conversations);
    expect(sorted.map(item => item.id)).toEqual(["pinned", "empty", "live", "summary", "detail"]);
    expect(conversations[0]?.id).toBe("detail");
    expect(sorted.at(-1)).toBe(conversations[0]);
  });

  it("breaks equal message times by ID even when refresh input order and updatedAt change", () => {
    const a: Conversation = { id: "a", title: "A", updatedAt: 20, messages: [], messageSummary: { count: 1, latestMessageAt: 0 } };
    const b: Conversation = { ...a, id: "b", updatedAt: 30 };
    expect(sortConversationsForDisplay([b, a]).map(item => item.id)).toEqual(["a", "b"]);
    expect(sortConversationsForDisplay([{ ...a, updatedAt: 40 }, b]).map(item => item.id)).toEqual(["a", "b"]);
  });
});
