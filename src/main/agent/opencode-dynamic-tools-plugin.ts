// Runs inside the embedded OpenCode process. Its normal notification refresh is
// asynchronous; await its cache-updated event only when the gateway reports a
// changed catalog. Keep the connection intact for parallel tool calls.
export const openCodeDynamicToolsPlugin = `export default async () => {
  const pending = new Map();
  return {
    "tool.execute.before": async (input) => {
      const name = /^(gbc-[a-zA-Z0-9-]+)_/.exec(input.tool)?.[1];
      if (!name) return;
      let finish;
      const promise = new Promise(resolve => { finish = resolve; });
      const entry = { name, sessionID: input.sessionID, promise, finish };
      pending.set(input.callID, entry);
    },
    event: async ({ event }) => {
      if (event.type === "session.idle" || (event.type === "session.status" && event.properties.status.type === "idle")) {
        for (const [callID, entry] of pending) {
          if (entry.sessionID === event.properties.sessionID) { entry.finish(false); pending.delete(callID); }
        }
      }
      if (event.type === "message.part.updated" && event.properties.part.type === "tool" && event.properties.part.state.status === "error") {
        const callID = event.properties.part.callID;
        pending.get(callID)?.finish(false);
        pending.delete(callID);
      }
      if (event.type !== "mcp.tools.changed") return;
      for (const entry of pending.values()) {
        if (entry.name === event.properties.server) entry.finish(true);
      }
    },
    "tool.execute.after": async (input, result) => {
      const entry = pending.get(input.callID);
      if (!entry) {
        if (result?._meta?.["goodbuddy/toolsChanged"] === true) throw new Error("OpenCode MCP tool catalog refresh timed out");
        return;
      }
      const timer = setTimeout(() => entry.finish(false), 30000);
      timer.unref?.();
      try {
        if (result?._meta?.["goodbuddy/toolsChanged"] === true && !await entry.promise) {
          throw new Error("OpenCode MCP tool catalog refresh timed out");
        }
      } finally {
        clearTimeout(timer);
        pending.delete(input.callID);
      }
    }
  }
};
`
