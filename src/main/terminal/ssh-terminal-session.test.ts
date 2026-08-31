import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthenticatedSshConnection,
  SshConnectionPoolTarget,
  SshPoolConnectionIdentity,
  SshTerminalShellOptions,
} from "../ssh/ssh-connection-pool";
import { SshConnectionPool } from "../ssh/ssh-connection-pool";
import {
  createSshTerminalSession,
  sshTerminalInternals,
} from "./ssh-terminal-session";

const sessionId = "00000000-0000-4000-8000-000000000501";
const hostId = "00000000-0000-4000-8000-000000000502";
const projectId = "00000000-0000-4000-8000-000000000503";

function createTarget(): SshConnectionPoolTarget {
  return {
    host: {
      id: hostId,
      name: "Build host",
      hostname: "build.example.com",
      port: 22,
      username: "builder",
      authentication: "password",
      password: "private password",
      hostKey: {
        algorithm: "ssh-ed25519",
        publicKeyBase64: "pinned",
        fingerprintSha256: `SHA256:${"A".repeat(43)}`,
        generation: 3,
      },
    },
    hostRevision: 7,
    hostKeyGeneration: 3,
  };
}

function createChannel() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    write: vi.fn(() => true),
    setWindow: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
  });
}

function createHarness(idleTimeoutMs = 60_000) {
  const channel = createChannel();
  let usable = true;
  const disconnectListeners = new Set<(error?: Error) => void>();
  let shellOptions: SshTerminalShellOptions | undefined;
  const identity: SshPoolConnectionIdentity = {
    hostId,
    hostRevision: 7,
    hostKeyGeneration: 3,
    authenticationIdentity: "a".repeat(64),
  };
  const connection = {
    identity,
    isUsable: vi.fn(() => usable),
    onDisconnect: vi.fn((listener: (error?: Error) => void) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    }),
    openTerminalShell: vi.fn(
      async (options: SshTerminalShellOptions) => {
        shellOptions = options;
        return channel as never;
      },
    ),
    openAgentAttach: vi.fn(),
    runAgentDoctor: vi.fn(),
    runAgentBootstrapProbe: vi.fn(),
    probeRemotePackageBootstrap: vi.fn(),
    createRemotePackageUploadStaging: vi.fn(),
    prepareRemotePackageBootstrap: vi.fn(),
    prepareUploadedRemotePackageBootstrap: vi.fn(),
    commitRemotePackageBootstrap: vi.fn(),
    cleanupRemotePackageBootstrap: vi.fn(),
    runAgentLifecycleAction: vi.fn(),
    runAgentRuntimeAction: vi.fn(),
    openStagedSftp: vi.fn(),
    listDirectories: vi.fn(),
    dispose: vi.fn(() => {
      usable = false;
    }),
  } satisfies AuthenticatedSshConnection;
  const pool = new SshConnectionPool(async () => connection, {
    idleTimeoutMs,
  });
  const events: Array<{
    type: string;
    sequence: number;
    [key: string]: unknown;
  }> = [];

  return {
    channel,
    connection,
    pool,
    events,
    shellOptions: () => shellOptions,
    disconnect(error?: Error) {
      usable = false;
      for (const listener of [...disconnectListeners]) {
        listener(error);
      }
    },
  };
}

async function openSession(harness: ReturnType<typeof createHarness>) {
  return createSshTerminalSession(harness.pool, {
    sessionId,
    target: { type: "project", projectId },
    targetLabel: "Build host",
    title: "终端 · Build host",
    shell: "/bin/bash",
    workingDirectory: "/srv/team's app",
    size: { cols: 120, rows: 40 },
    poolTarget: createTarget(),
    onEvent: (event) => harness.events.push(event),
  });
}

describe("SSH terminal session", () => {
  it("holds a pool lease and opens a login shell with the requested PTY and quoted cwd", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(100);
      const session = await openSession(harness);

      expect(harness.shellOptions()).toEqual({
        cols: 120,
        rows: 40,
        term: "xterm-256color",
      });
      expect(harness.channel.write).toHaveBeenCalledWith(
        "cd -- '/srv/team'\"'\"'s app' || exit\r",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.connection.dispose).not.toHaveBeenCalled();

      expect(session.close()).toMatchObject({
        state: "exited",
        exit: { exitCode: null, signal: "SIGHUP" },
      });
      expect(session.close()).toMatchObject({ state: "exited" });
      expect(harness.channel.close).toHaveBeenCalledOnce();
      expect(harness.channel.destroy).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.connection.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards writes and resizes while running and returns an authoritative snapshot", async () => {
    const harness = createHarness();
    const session = await openSession(harness);

    session.write("printf '你好'\\r");
    session.resize({ cols: 90, rows: 28 });

    expect(harness.channel.write).toHaveBeenLastCalledWith(
      "printf '你好'\\r",
    );
    expect(harness.channel.setWindow).toHaveBeenCalledWith(28, 90, 0, 0);
    expect(session.snapshot()).toMatchObject({
      sessionId,
      state: "running",
      shell: "/bin/bash",
      workingDirectory: "/srv/team's app",
      size: { cols: 90, rows: 28 },
      lastSequence: 1,
    });
    session.close();
  });

  it("emits ordered bounded output and pauses until acknowledged", async () => {
    const harness = createHarness();
    const session = await openSession(harness);

    for (let index = 0; index < 255; index += 1) {
      harness.channel.emit("data", `chunk-${index}`);
    }

    expect(harness.events).toHaveLength(256);
    expect(harness.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 256 }, (_, index) => index + 1),
    );
    expect(harness.channel.pause).toHaveBeenCalledOnce();
    session.acknowledge(256);
    expect(harness.channel.resume).toHaveBeenCalledOnce();
    session.close();
  });

  it("marks a disconnected SSH transport interrupted immediately and rejects late I/O", async () => {
    const harness = createHarness();
    const session = await openSession(harness);
    harness.disconnect(new Error("socket reset"));

    expect(session.snapshot()).toMatchObject({
      state: "interrupted",
      error: {
        code: "interrupted",
        message: "socket reset",
        retryable: true,
      },
    });
    expect(harness.events.at(-1)).toMatchObject({
      type: "state",
      state: "interrupted",
    });
    const writes = harness.channel.write.mock.calls.length;
    session.write("late");
    session.resize({ cols: 80, rows: 24 });
    expect(harness.channel.write).toHaveBeenCalledTimes(writes);
    expect(harness.channel.setWindow).not.toHaveBeenCalled();
    session.close();
  });

  it("records normal shell exit before releasing the channel lease", async () => {
    const harness = createHarness();
    const session = await openSession(harness);
    harness.channel.emit("exit", 7);
    harness.channel.emit("close");

    expect(session.snapshot()).toMatchObject({
      state: "exited",
      exit: { exitCode: 7, signal: null },
    });
    expect(harness.events.slice(-2)).toMatchObject([
      { type: "exit", exit: { exitCode: 7, signal: null } },
      { type: "state", state: "exited" },
    ]);
    session.close();
  });

  it("strictly quotes POSIX paths and rejects line-based command injection", () => {
    expect(sshTerminalInternals.quotePosixShellArgument("a'b")).toBe(
      "'a'\"'\"'b'",
    );
    expect(() =>
      sshTerminalInternals.quotePosixShellArgument("/srv/app\nwhoami"),
    ).toThrow("无效字符");
  });

  it("opens a Host-home shell without injecting a cwd command", async () => {
    const harness = createHarness();
    const session = await createSshTerminalSession(harness.pool, {
      sessionId,
      target: { type: "project", projectId },
      targetLabel: "Build host",
      title: "终端 · Build host",
      size: { cols: 80, rows: 24 },
      poolTarget: createTarget(),
      onEvent: (event) => harness.events.push(event),
    });

    expect(harness.channel.write).not.toHaveBeenCalled();
    expect(session.snapshot().workingDirectory).toBe("~");
    session.close();
  });
});
