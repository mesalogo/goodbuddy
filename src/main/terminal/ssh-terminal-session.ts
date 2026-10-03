import { StringDecoder } from "node:string_decoder";
import type { ClientChannel } from "ssh2";
import {
  TERMINAL_LIMITS,
  terminalSizeSchema,
  type TerminalError,
  type TerminalEvent,
  type TerminalExit,
  type TerminalSessionId,
  type TerminalSize,
  type TerminalSnapshot,
  type TerminalTarget,
} from "../../shared/terminal-contracts";
import {
  type SshConnectionPool,
  type SshConnectionPoolTarget,
  type SshTerminalConnectionLease,
} from "../ssh/ssh-connection-pool";
import {
  TerminalOutputCoalescer,
  type TerminalOutputCoalescerOptions,
} from "./terminal-output-coalescer";

const SSH_TERMINAL_TERM = "xterm-256color";

export type SshTerminalSessionOptions = {
  sessionId: TerminalSessionId;
  target: TerminalTarget;
  targetLabel: string;
  title: string;
  shell?: string;
  command?: string;
  workingDirectory?: string;
  size: TerminalSize;
  poolTarget: SshConnectionPoolTarget;
  onEvent: (event: TerminalEvent) => void;
  signal?: AbortSignal;
};

export type SshTerminalSession = {
  write(data: string): void;
  resize(size: TerminalSize): void;
  acknowledge(sequence: number): void;
  snapshot(): TerminalSnapshot;
  close(): TerminalSnapshot;
};

type RunningSession = {
  lease: SshTerminalConnectionLease;
  channel: ClientChannel;
  removeDisconnectListener: () => void;
};

type TerminalEventPayload =
  | { type: "output"; data: string }
  | { type: "state"; state: TerminalSnapshot["state"] }
  | { type: "exit"; exit: TerminalExit }
  | { type: "error"; error: TerminalError };

function quotePosixShellArgument(value: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("远程工作目录包含无效字符");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function eventByteLength(event: TerminalEvent): number {
  switch (event.type) {
    case "output":
      return Buffer.byteLength(event.data);
    case "error":
      return Buffer.byteLength(event.error.message) + 64;
    default:
      return 64;
  }
}

const PAUSE_PENDING_BYTES =
  TERMINAL_LIMITS.maximumBufferedOutputBytes - TERMINAL_LIMITS.maximumEventBytes;

export async function createSshTerminalSession(
  pool: SshConnectionPool,
  options: SshTerminalSessionOptions,
  coalescing?: Omit<TerminalOutputCoalescerOptions, "emit">,
): Promise<SshTerminalSession> {
  const initialSize = terminalSizeSchema.parse(options.size);
  const workingDirectoryCommand = options.workingDirectory && !options.command
    ? `cd -- ${quotePosixShellArgument(options.workingDirectory)} || exit\r`
    : undefined;
  const lease = await pool.acquireTerminal(options.poolTarget, options.signal);
  let channel: ClientChannel;
  try {
    channel = await lease.openTerminalShell(
      {
        cols: initialSize.cols,
        rows: initialSize.rows,
        term: SSH_TERMINAL_TERM,
        ...(options.command ? { command: options.command } : {}),
      },
      options.signal,
    );
  } catch (error) {
    lease.release();
    throw error;
  }

  let state: TerminalSnapshot["state"] = "running";
  let size = initialSize;
  let sequence = 0;
  let exit: TerminalExit | null = null;
  let error: TerminalError | null = null;
  let closed = false;
  let paused = false;
  let pendingBytes = 0;
  const pendingEvents: Array<{ event: TerminalEvent; bytes: number }> = [];
  const decoder = new StringDecoder("utf8");
  let running: RunningSession | undefined;

  const updateBackpressure = (): void => {
    if (
      !paused &&
      (pendingEvents.length >= TERMINAL_LIMITS.maximumPendingEvents ||
        pendingBytes + output.bufferedBytes >= PAUSE_PENDING_BYTES)
    ) {
      paused = true;
      channel.pause();
    }
  };

  const emit = (event: TerminalEventPayload): void => {
    if (event.type !== "output") {
      // Control events must follow every byte received before them.
      output.flush();
    }
    sequence += 1;
    const sequenced = {
      ...event,
      sessionId: options.sessionId,
      sequence,
    } as TerminalEvent;
    const bytes = eventByteLength(sequenced);
    pendingEvents.push({ event: sequenced, bytes });
    pendingBytes += bytes;
    options.onEvent(sequenced);
    updateBackpressure();
  };

  const output = new TerminalOutputCoalescer({
    ...coalescing,
    emit: (data) => emit({ type: "output", data }),
  });

  const release = (): void => {
    // Every terminal path calls release() after its final events; stop the
    // flush timer and drop anything that can no longer be delivered.
    output.dispose();
    const active = running;
    running = undefined;
    active?.removeDisconnectListener();
    active?.lease.release();
  };

  const interrupt = (disconnectError?: Error): void => {
    if (closed || state !== "running") {
      return;
    }
    state = "interrupted";
    error = {
      code: "interrupted",
      message: disconnectError?.message || "SSH 连接已中断",
      retryable: true,
    };
    emit({ type: "error", error });
    emit({ type: "state", state });
    release();
    channel.destroy();
  };

  const removeDisconnectListener = lease.onDisconnect(interrupt);
  running = { lease, channel, removeDisconnectListener };

  channel.on("data", (chunk: Buffer | string) => {
    if (closed || state !== "running") {
      return;
    }
    const text =
      typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    output.push(text);
    updateBackpressure();
  });
  channel.once(
    "exit",
    (code: number | null, signal?: string) => {
      if (closed || state !== "running") {
        return;
      }
      exit =
        typeof code === "number"
          ? { exitCode: code, signal: null }
          : { exitCode: null, signal: signal || "UNKNOWN" };
    },
  );
  channel.once("error", (channelError: Error) => {
    interrupt(channelError);
  });
  channel.once("close", () => {
    if (closed || state !== "running") {
      release();
      return;
    }
    output.push(decoder.end());
    output.flush();
    if (!lease.isUsable()) {
      interrupt();
      return;
    }
    state = "exited";
    exit ??= { exitCode: 0, signal: null };
    emit({ type: "exit", exit });
    emit({ type: "state", state });
    release();
  });

  if (workingDirectoryCommand) {
    channel.write(workingDirectoryCommand);
  }
  emit({ type: "state", state });

  const currentSnapshot = (): TerminalSnapshot => ({
    sessionId: options.sessionId,
    target: options.target,
    targetLabel: options.targetLabel,
    title: options.title,
    state,
    shell: options.shell ?? "login shell",
    workingDirectory: options.workingDirectory || "~",
    size,
    lastSequence: sequence,
    exit,
    error,
  });

  return {
    write(data) {
      if (closed || state !== "running") {
        return;
      }
      channel.write(data);
    },
    resize(nextSize) {
      if (closed || state !== "running") {
        return;
      }
      size = terminalSizeSchema.parse(nextSize);
      channel.setWindow(size.rows, size.cols, 0, 0);
    },
    acknowledge(acknowledgedSequence) {
      if (
        !Number.isSafeInteger(acknowledgedSequence) ||
        acknowledgedSequence < 0
      ) {
        throw new Error("终端输出确认序号无效");
      }
      while (
        pendingEvents[0] &&
        pendingEvents[0].event.sequence <= acknowledgedSequence
      ) {
        pendingBytes -= pendingEvents.shift()?.bytes ?? 0;
      }
      if (
        paused &&
        pendingEvents.length < TERMINAL_LIMITS.maximumPendingEvents &&
        pendingBytes + output.bufferedBytes < PAUSE_PENDING_BYTES
      ) {
        paused = false;
        channel.resume();
      }
    },
    snapshot() {
      return currentSnapshot();
    },
    close() {
      if (closed) {
        return currentSnapshot();
      }
      closed = true;
      if (state === "running") {
        state = "closing";
        emit({ type: "state", state });
        exit = { exitCode: null, signal: "SIGHUP" };
      }
      release();
      channel.close();
      channel.destroy();
      if (state === "closing") {
        state = "exited";
        emit({ type: "exit", exit: exit! });
        emit({ type: "state", state });
      }
      return currentSnapshot();
    },
  };
}

export const sshTerminalInternals = {
  quotePosixShellArgument,
};
