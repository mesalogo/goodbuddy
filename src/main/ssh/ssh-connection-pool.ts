import { createHmac, getCiphers, randomBytes } from "node:crypto";
import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import {
  BoundedStagedSftp,
  type BoundedSftpLimits,
  type StagedSftp,
} from "./bounded-sftp";
import { listBoundedSftpDirectories } from "./bounded-directory-sftp";
import type { ResolvedSshHost } from "./ssh-host-store";
import {
  AGENT_BOOTSTRAP_PROBE_COMMAND,
  buildFixedAgentSshCommand,
  parseAgentBootstrapProbeOutput,
  type AgentLifecycleAction,
  type AgentRuntimeActivationAction,
  type VerifiedAgentInstallationId,
} from "./ssh-agent-command";
import {
  createSshRemotePackageBootstrapExecutor,
  SSH_REMOTE_PACKAGE_BOOTSTRAP_COMMAND,
  type SshRemotePackageBootstrapCommitResult,
  type SshRemotePackageBootstrapExecutor,
  type SshRemotePackageBootstrapOptions,
  type SshRemotePackageBootstrapPrepareResult,
  type SshRemotePackageBootstrapProbeResult,
  type SshRemotePackageBootstrapCleanupResult,
  type SshRemotePackageUploadStagingResult,
  type SshRemotePackageCandidate,
} from "./ssh-remote-package-bootstrap";
import type {
  AgentBootstrapProbeResult,
  SshHostDirectoryBrowseResult,
} from "../../shared/ssh-host-contracts";
import {
  buildAuthenticatedSshConnectConfig,
  createStrongSshAlgorithms,
  defaultSystemAgent,
  safeSshError,
  SSH_CONNECTION_TIMEOUT_MS,
} from "./ssh-transport";

const FIXED_COMMAND_TIMEOUT_MS = 15_000;
const CHANNEL_OPEN_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_POOL_ENTRIES = 32;

export type SshConnectionPoolTarget = {
  host: ResolvedSshHost;
  hostRevision: number;
  hostKeyGeneration: number;
};

export type SshPoolConnectionIdentity = {
  hostId: string;
  hostRevision: number;
  hostKeyGeneration: number;
  authenticationIdentity: string;
};

export type AgentDiagnosticResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type SshTerminalShellOptions = {
  cols: number;
  rows: number;
  term?: string;
};

export interface AuthenticatedSshConnection {
  readonly identity: SshPoolConnectionIdentity;
  isUsable(): boolean;
  onDisconnect(listener: (error?: Error) => void): () => void;
  openTerminalShell(
    options: SshTerminalShellOptions,
    signal?: AbortSignal,
  ): Promise<ClientChannel>;
  openAgentAttach(
    installationId: VerifiedAgentInstallationId,
    signal?: AbortSignal,
  ): Promise<ClientChannel>;
  runAgentDoctor(
    installationId: VerifiedAgentInstallationId,
    signal?: AbortSignal,
  ): Promise<AgentDiagnosticResult>;
  runAgentBootstrapProbe(
    signal?: AbortSignal,
  ): Promise<AgentBootstrapProbeResult>;
  probeRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapProbeResult>;
  createRemotePackageUploadStaging(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageUploadStagingResult>;
  prepareRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapPrepareResult>;
  prepareUploadedRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapPrepareResult>;
  commitRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapCommitResult>;
  cleanupRemotePackageBootstrap(
    operationId: string,
    options?: Pick<SshRemotePackageBootstrapOptions, "signal">,
  ): Promise<SshRemotePackageBootstrapCleanupResult>;
  runAgentLifecycleAction(
    installationId: VerifiedAgentInstallationId,
    action: AgentLifecycleAction,
    signal?: AbortSignal,
  ): Promise<AgentDiagnosticResult>;
  runAgentRuntimeAction(
    installationId: VerifiedAgentInstallationId,
    action: AgentRuntimeActivationAction,
    signal?: AbortSignal,
  ): Promise<AgentDiagnosticResult>;
  openStagedSftp(
    stagingDirectory: string,
    limits?: BoundedSftpLimits,
    signal?: AbortSignal,
  ): Promise<StagedSftp>;
  listDirectories(
    path?: string,
    signal?: AbortSignal,
  ): Promise<SshHostDirectoryBrowseResult>;
  dispose(): void;
}

export interface SshConnectionLease extends Omit<
  AuthenticatedSshConnection,
  | "dispose"
  | "onDisconnect"
  | "openTerminalShell"
  | "createRemotePackageUploadStaging"
  | "prepareUploadedRemotePackageBootstrap"
> {
  release(): void;
}

export interface SshTerminalConnectionLease extends SshConnectionLease {
  onDisconnect(listener: (error?: Error) => void): () => void;
  openTerminalShell(
    options: SshTerminalShellOptions,
    signal?: AbortSignal,
  ): Promise<ClientChannel>;
}

export interface SshRemotePackageBootstrapLease extends SshRemotePackageBootstrapExecutor {
  readonly identity: SshPoolConnectionIdentity;
  isUsable(): boolean;
  release(): void;
}

type InternalSshConnectionLease = SshTerminalConnectionLease &
  Pick<
    AuthenticatedSshConnection,
    | "createRemotePackageUploadStaging"
    | "prepareUploadedRemotePackageBootstrap"
  >;

type ClientLike = Pick<
  Client,
  "connect" | "end" | "destroy" | "exec" | "shell" | "sftp" | "on" | "once"
>;

type SshConnectionDependencies = {
  createClient: () => ClientLike;
  supportedOpenSslCiphers: () => readonly string[];
  systemAgent: () => string | undefined;
  controlPlanePackageInstaller: Buffer | string;
};

export type SshConnectionFactory = (
  target: SshConnectionPoolTarget,
  identity: SshPoolConnectionIdentity,
  signal: AbortSignal,
) => Promise<AuthenticatedSshConnection>;

type PoolEntry = {
  key: string;
  identity: SshPoolConnectionIdentity;
  controller: AbortController;
  connectionPromise: Promise<AuthenticatedSshConnection>;
  connection?: AuthenticatedSshConnection;
  leases: number;
  waiters: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};

function createAbortError(signal?: AbortSignal): unknown {
  return (
    signal?.reason ??
    new DOMException("The operation was aborted", "AbortError")
  );
}

function validatePoolTarget(target: SshConnectionPoolTarget): void {
  if (
    !target.host.id ||
    !Number.isSafeInteger(target.hostRevision) ||
    target.hostRevision <= 0 ||
    !Number.isSafeInteger(target.hostKeyGeneration) ||
    target.hostKeyGeneration <= 0
  ) {
    throw new Error("SSH 连接身份无效");
  }
  if (!target.host.hostKey) {
    throw new Error("请先验证并接受 SSH 主机密钥");
  }
  if (target.host.hostKey.generation !== target.hostKeyGeneration) {
    throw new Error("SSH 主机密钥代际不匹配");
  }
}

function validateConnectionIdentity(
  target: SshConnectionPoolTarget,
  identity: SshPoolConnectionIdentity,
): void {
  if (
    identity.hostId !== target.host.id ||
    identity.hostRevision !== target.hostRevision ||
    identity.hostKeyGeneration !== target.hostKeyGeneration ||
    !/^[a-f0-9]{64}$/u.test(identity.authenticationIdentity)
  ) {
    throw new Error("SSH 连接身份与认证目标不匹配");
  }
}

function createSshAuthenticationIdentity(
  host: ResolvedSshHost,
  systemAgent: string | undefined,
  identityKey: Buffer,
): string {
  const credentialIdentity =
    host.authentication === "password" ? host.password : systemAgent;
  if (!credentialIdentity) {
    throw new Error(
      host.authentication === "password"
        ? "SSH 主机尚未配置密码"
        : "当前系统未检测到可用的 SSH Agent",
    );
  }
  return createHmac("sha256", identityKey)
    .update(
      JSON.stringify([
        "goodbuddy-ssh-auth-v1",
        host.id,
        host.hostname,
        host.port,
        host.username,
        host.authentication,
        credentialIdentity,
      ]),
    )
    .digest("hex");
}

function poolKey(identity: SshPoolConnectionIdentity): string {
  return [
    identity.hostId,
    identity.hostRevision,
    identity.hostKeyGeneration,
    identity.authenticationIdentity,
  ].join("\0");
}

function waitForSharedConnection(
  promise: Promise<AuthenticatedSshConnection>,
  signal?: AbortSignal,
): Promise<AuthenticatedSshConnection> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (connection) => {
        signal.removeEventListener("abort", abort);
        resolve(connection);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class Ssh2AuthenticatedConnection implements AuthenticatedSshConnection {
  private usable = true;
  private disposed = false;
  private agentBootstrapProbe: AgentBootstrapProbeResult | undefined;
  private readonly disconnectListeners = new Set<(error?: Error) => void>();

  private constructor(
    readonly identity: SshPoolConnectionIdentity,
    private readonly client: ClientLike,
    private readonly controlPlanePackageInstaller: Buffer,
  ) {
    const disconnected = (error?: Error): void => {
      if (!this.usable) {
        return;
      }
      this.usable = false;
      this.agentBootstrapProbe = undefined;
      for (const listener of [...this.disconnectListeners]) {
        listener(error);
      }
    };
    this.client.on("close", disconnected);
    this.client.on("end", disconnected);
    this.client.on("error", (error: Error) => disconnected(error));
  }

  static connect(
    target: SshConnectionPoolTarget,
    identity: SshPoolConnectionIdentity,
    signal: AbortSignal,
    dependencies: Partial<SshConnectionDependencies> = {},
  ): Promise<Ssh2AuthenticatedConnection> {
    validatePoolTarget(target);
    validateConnectionIdentity(target, identity);
    const resolvedDependencies: SshConnectionDependencies = {
      createClient: () => new Client(),
      supportedOpenSslCiphers: getCiphers,
      systemAgent: defaultSystemAgent,
      controlPlanePackageInstaller: Buffer.alloc(0),
      ...dependencies,
    };
    const algorithms = createStrongSshAlgorithms(
      resolvedDependencies.supportedOpenSslCiphers(),
    );
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError(signal));
        return;
      }
      const client = resolvedDependencies.createClient();
      let settled = false;
      let hostKeyMismatch = false;
      const settle = (
        connection?: Ssh2AuthenticatedConnection,
        error?: unknown,
      ): void => {
        if (settled) {
          connection?.dispose();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (error) {
          client.destroy();
          reject(error);
        } else if (connection) {
          resolve(connection);
        }
      };
      const abort = (): void => {
        settle(undefined, createAbortError(signal));
      };
      const timeout = setTimeout(() => {
        settle(undefined, new Error("SSH 连接超时"));
      }, SSH_CONNECTION_TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });
      client.once("error", (error) => {
        settle(
          undefined,
          hostKeyMismatch
            ? new Error("SSH 主机密钥已变化，请重新验证主机身份")
            : safeSshError(error),
        );
      });
      client.once("ready", () => {
        settle(
          new Ssh2AuthenticatedConnection(
            identity,
            client,
            Buffer.from(resolvedDependencies.controlPlanePackageInstaller),
          ),
        );
      });
      let config: ConnectConfig;
      try {
        config = buildAuthenticatedSshConnectConfig(
          target.host,
          algorithms,
          resolvedDependencies.systemAgent(),
          () => {
            hostKeyMismatch = true;
          },
        );
      } catch (error) {
        settle(undefined, error);
        return;
      }
      client.connect(config);
    });
  }

  isUsable(): boolean {
    return this.usable;
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    if (!this.usable) {
      queueMicrotask(() => listener());
      return () => undefined;
    }
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  openTerminalShell(
    options: SshTerminalShellOptions,
    signal?: AbortSignal,
  ): Promise<ClientChannel> {
    this.assertUsable();
    if (
      !Number.isSafeInteger(options.cols) ||
      options.cols <= 0 ||
      !Number.isSafeInteger(options.rows) ||
      options.rows <= 0
    ) {
      return Promise.reject(new Error("SSH PTY 尺寸无效"));
    }
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, channel?: ClientChannel): void => {
        if (settled) {
          channel?.destroy();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error || !channel) {
          reject(error ?? new Error("无法打开 SSH 终端通道"));
        } else {
          resolve(channel);
        }
      };
      const abort = (): void => {
        finish(createAbortError(signal));
      };
      const timeout = setTimeout(() => {
        finish(new Error("SSH 终端通道打开超时"));
      }, CHANNEL_OPEN_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      this.client.shell(
        {
          term: options.term ?? "xterm-256color",
          cols: options.cols,
          rows: options.rows,
          width: 0,
          height: 0,
        },
        { env: {}, x11: false },
        (error, channel) => finish(error, channel),
      );
    });
  }

  async openAgentAttach(
    installationId: VerifiedAgentInstallationId,
    signal?: AbortSignal,
  ): Promise<ClientChannel> {
    const channel = await this.openFixedChannel(
      buildFixedAgentSshCommand(installationId, {
        kind: "attach",
      }),
      signal,
    );
    if (signal?.aborted) {
      channel.destroy();
      throw createAbortError(signal);
    }
    if (signal) {
      const abort = (): void => {
        channel.destroy();
      };
      signal.addEventListener("abort", abort, { once: true });
      channel.once("close", () => {
        signal.removeEventListener("abort", abort);
      });
    }
    return channel;
  }

  async runAgentBootstrapProbe(
    signal?: AbortSignal,
  ): Promise<AgentBootstrapProbeResult> {
    this.assertUsable();
    signal?.throwIfAborted();
    if (this.agentBootstrapProbe !== undefined) {
      return this.agentBootstrapProbe;
    }
    const result = await this.runBoundedCommand(
      AGENT_BOOTSTRAP_PROBE_COMMAND,
      signal,
    );
    if (result.exitCode !== 0 || result.stderr.length !== 0) {
      throw new Error("Agent 启动探针执行失败");
    }
    const probe = parseAgentBootstrapProbeOutput(result.stdout);
    this.agentBootstrapProbe = probe;
    return probe;
  }

  probeRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapProbeResult> {
    return this.remotePackageBootstrap().probe(candidate, options);
  }

  createRemotePackageUploadStaging(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageUploadStagingResult> {
    return this.remotePackageBootstrap().createUploadStaging(
      candidate,
      options,
    );
  }

  prepareRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapPrepareResult> {
    return this.remotePackageBootstrap().prepare(candidate, options);
  }

  prepareUploadedRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapPrepareResult> {
    return this.remotePackageBootstrap().prepareUploaded(candidate, options);
  }

  commitRemotePackageBootstrap(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapCommitResult> {
    return this.remotePackageBootstrap().commit(candidate, options);
  }

  cleanupRemotePackageBootstrap(
    operationId: string,
    options?: Pick<SshRemotePackageBootstrapOptions, "signal">,
  ): Promise<SshRemotePackageBootstrapCleanupResult> {
    return this.remotePackageBootstrap().cleanup(operationId, options);
  }

  runAgentDoctor(
    installationId: VerifiedAgentInstallationId,
    signal?: AbortSignal,
  ): Promise<AgentDiagnosticResult> {
    return this.runBoundedCommand(
      buildFixedAgentSshCommand(installationId, {
        kind: "doctor",
      }),
      signal,
    );
  }

  runAgentLifecycleAction(
    installationId: VerifiedAgentInstallationId,
    action: AgentLifecycleAction,
    signal?: AbortSignal,
  ): Promise<AgentDiagnosticResult> {
    return this.runBoundedCommand(
      buildFixedAgentSshCommand(installationId, {
        kind: "lifecycle",
        action,
      }),
      signal,
    );
  }

  runAgentRuntimeAction(
    installationId: VerifiedAgentInstallationId,
    action: AgentRuntimeActivationAction,
    signal?: AbortSignal,
  ): Promise<AgentDiagnosticResult> {
    return this.runBoundedCommand(
      buildFixedAgentSshCommand(installationId, action),
      signal,
    );
  }

  openStagedSftp(
    stagingDirectory: string,
    limits?: BoundedSftpLimits,
    signal?: AbortSignal,
  ): Promise<StagedSftp> {
    this.assertUsable();
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, sftp?: SFTPWrapper): void => {
        if (settled) {
          sftp?.end();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error || !sftp) {
          reject(error ?? new Error("无法打开 SFTP 通道"));
          return;
        }
        try {
          resolve(new BoundedStagedSftp(sftp, stagingDirectory, limits));
        } catch (validationError) {
          sftp.end();
          reject(validationError);
        }
      };
      const abort = (): void => {
        finish(createAbortError(signal));
      };
      const timeout = setTimeout(() => {
        finish(new Error("SFTP 通道打开超时"));
      }, CHANNEL_OPEN_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      this.client.sftp((error, sftp) => {
        finish(error, sftp);
      });
    });
  }

  listDirectories(
    path?: string,
    signal?: AbortSignal,
  ): Promise<SshHostDirectoryBrowseResult> {
    this.assertUsable();
    return listBoundedSftpDirectories(
      (callback) => {
        this.client.sftp((error, sftp) => {
          callback(error, sftp);
        });
      },
      path,
      signal,
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.usable = false;
    this.agentBootstrapProbe = undefined;
    for (const listener of [...this.disconnectListeners]) {
      listener();
    }
    this.disconnectListeners.clear();
    this.client.end();
    this.client.destroy();
  }

  private assertUsable(): void {
    if (!this.usable) {
      throw new Error("SSH 连接已关闭");
    }
  }

  private remotePackageBootstrapExecutor:
    SshRemotePackageBootstrapExecutor | undefined;

  private remotePackageBootstrap(): SshRemotePackageBootstrapExecutor {
    this.remotePackageBootstrapExecutor ??=
      createSshRemotePackageBootstrapExecutor(
        (signal) =>
          this.openFixedChannel(
            SSH_REMOTE_PACKAGE_BOOTSTRAP_COMMAND,
            signal,
            true,
          ),
        this.controlPlanePackageInstaller,
      );
    return this.remotePackageBootstrapExecutor;
  }

  private openFixedChannel(
    command: string,
    signal?: AbortSignal,
    allowHalfOpen = false,
  ): Promise<ClientChannel> {
    this.assertUsable();
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, channel?: ClientChannel): void => {
        if (settled) {
          channel?.destroy();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error || !channel) {
          reject(error ?? new Error("无法打开 Agent SSH 通道"));
        } else {
          resolve(channel);
        }
      };
      const abort = (): void => {
        finish(createAbortError(signal));
      };
      const timeout = setTimeout(() => {
        finish(new Error("Agent SSH 通道打开超时"));
      }, CHANNEL_OPEN_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      this.client.exec(
        command,
        {
          env: {},
          pty: false,
          x11: false,
          allowHalfOpen,
        },
        (error, channel) => finish(error, channel),
      );
    });
  }

  private async runBoundedCommand(
    command: string,
    signal?: AbortSignal,
  ): Promise<AgentDiagnosticResult> {
    const channel = await this.openFixedChannel(command, signal);
    if (signal?.aborted) {
      channel.destroy();
      throw createAbortError(signal);
    }
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (
        result?: AgentDiagnosticResult,
        error?: unknown,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) {
          channel.destroy();
          reject(error);
        } else if (result) {
          resolve(result);
        }
      };
      const collect = (destination: Buffer[], chunk: Buffer | string): void => {
        const buffer = Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > MAX_DIAGNOSTIC_OUTPUT_BYTES) {
          finish(undefined, new Error("Agent 诊断输出超过安全限制"));
          return;
        }
        destination.push(buffer);
      };
      const abort = (): void => {
        finish(undefined, createAbortError(signal));
      };
      const timeout = setTimeout(() => {
        finish(undefined, new Error("Agent 诊断超时"));
      }, FIXED_COMMAND_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      channel.on("data", (chunk: Buffer | string) => {
        collect(stdout, chunk);
      });
      channel.stderr.on("data", (chunk: Buffer | string) => {
        collect(stderr, chunk);
      });
      channel.once("error", (error: Error) => {
        finish(undefined, error);
      });
      channel.once("close", (code: number | null) => {
        finish({
          exitCode: typeof code === "number" ? code : null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  }
}

export class SshConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly factory: SshConnectionFactory;
  private readonly systemAgent: () => string | undefined;
  private readonly idleTimeoutMs: number;
  private readonly authenticationIdentityKey = randomBytes(32);
  private disposed = false;

  constructor(
    factory?: SshConnectionFactory,
    options: {
      systemAgent?: () => string | undefined;
      idleTimeoutMs?: number;
      controlPlanePackageInstaller?: Buffer | string;
    } = {},
  ) {
    this.systemAgent = options.systemAgent ?? defaultSystemAgent;
    this.factory =
      factory ??
      ((target, identity, signal) =>
        Ssh2AuthenticatedConnection.connect(target, identity, signal, {
          systemAgent: this.systemAgent,
          controlPlanePackageInstaller:
            options.controlPlanePackageInstaller ?? Buffer.alloc(0),
        }));
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
      throw new Error("SSH 连接池空闲超时无效");
    }
  }

  async acquire(
    target: SshConnectionPoolTarget,
    signal?: AbortSignal,
  ): Promise<SshConnectionLease> {
    if (this.disposed) {
      throw new Error("SSH 连接池已关闭");
    }
    signal?.throwIfAborted();
    validatePoolTarget(target);
    const identity: SshPoolConnectionIdentity = {
      hostId: target.host.id,
      hostRevision: target.hostRevision,
      hostKeyGeneration: target.hostKeyGeneration,
      authenticationIdentity: createSshAuthenticationIdentity(
        target.host,
        this.systemAgent(),
        this.authenticationIdentityKey,
      ),
    };
    const key = poolKey(identity);
    let entry = this.entries.get(key);
    if (entry?.connection && !entry.connection.isUsable()) {
      this.disposeEntry(entry);
      entry = undefined;
    }
    if (!entry) {
      if (this.entries.size >= MAX_POOL_ENTRIES) {
        let oldestIdleEntry: PoolEntry | undefined;
        for (const candidate of this.entries.values()) {
          if (candidate.leases === 0 && candidate.waiters === 0) {
            oldestIdleEntry = candidate;
            break;
          }
        }
        if (oldestIdleEntry) {
          this.disposeEntry(oldestIdleEntry);
        } else {
          throw new Error("SSH 连接池已达到安全上限");
        }
      }
      const controller = new AbortController();
      const newEntry: PoolEntry = {
        key,
        identity,
        controller,
        connectionPromise: Promise.resolve(undefined as never),
        leases: 0,
        waiters: 0,
      };
      newEntry.connectionPromise = this.factory(
        target,
        identity,
        controller.signal,
      ).then(
        (connection) => {
          if (this.disposed || this.entries.get(key) !== newEntry) {
            connection.dispose();
            throw new Error("SSH 连接请求已失效");
          }
          newEntry.connection = connection;
          return connection;
        },
        (error: unknown) => {
          if (this.entries.get(key) === newEntry) {
            this.entries.delete(key);
          }
          throw error;
        },
      );
      this.entries.set(key, newEntry);
      entry = newEntry;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.waiters += 1;
    try {
      const connection = await waitForSharedConnection(
        entry.connectionPromise,
        signal,
      );
      if (!connection.isUsable()) {
        this.disposeEntry(entry);
        throw new Error("SSH 连接已关闭");
      }
      entry.leases += 1;
      return this.createLease(entry, connection);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0 && entry.leases === 0) {
        this.scheduleIdleDisposal(entry);
      }
    }
  }

  async acquireRemotePackageBootstrap(
    target: SshConnectionPoolTarget,
    signal?: AbortSignal,
  ): Promise<SshRemotePackageBootstrapLease> {
    const lease = await this.acquire(target, signal);
    const bootstrapConnection = lease as InternalSshConnectionLease;
    return {
      identity: lease.identity,
      isUsable: () => lease.isUsable(),
      probe: (candidate, options) =>
        lease.probeRemotePackageBootstrap(candidate, options),
      createUploadStaging: (candidate, options) =>
        bootstrapConnection.createRemotePackageUploadStaging(
          candidate,
          options,
        ),
      prepare: (candidate, options) =>
        lease.prepareRemotePackageBootstrap(candidate, options),
      prepareUploaded: (candidate, options) =>
        bootstrapConnection.prepareUploadedRemotePackageBootstrap(
          candidate,
          options,
        ),
      commit: (candidate, options) =>
        lease.commitRemotePackageBootstrap(candidate, options),
      cleanup: (operationId, options) =>
        lease.cleanupRemotePackageBootstrap(operationId, options),
      release: () => lease.release(),
    };
  }

  async acquireTerminal(
    target: SshConnectionPoolTarget,
    signal?: AbortSignal,
  ): Promise<SshTerminalConnectionLease> {
    return (await this.acquire(target, signal)) as SshTerminalConnectionLease;
  }

  disposeHost(hostId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.identity.hostId === hostId) {
        this.disposeEntry(entry);
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      this.disposeEntry(entry);
    }
  }

  private createLease(
    entry: PoolEntry,
    connection: AuthenticatedSshConnection,
  ): SshConnectionLease {
    let released = false;
    const assertActive = (): void => {
      if (released) {
        throw new Error("SSH 连接租约已释放");
      }
    };
    const lease: InternalSshConnectionLease = {
      identity: connection.identity,
      isUsable: () => !released && connection.isUsable(),
      onDisconnect: (listener) => {
        assertActive();
        return connection.onDisconnect(listener);
      },
      openTerminalShell: (options, signal) => {
        assertActive();
        return connection.openTerminalShell(options, signal);
      },
      openAgentAttach: (installationId, signal) => {
        assertActive();
        return connection.openAgentAttach(installationId, signal);
      },
      runAgentDoctor: (installationId, signal) => {
        assertActive();
        return connection.runAgentDoctor(installationId, signal);
      },
      runAgentBootstrapProbe: (signal) => {
        assertActive();
        return connection.runAgentBootstrapProbe(signal);
      },
      probeRemotePackageBootstrap: (candidate, options) => {
        assertActive();
        return connection.probeRemotePackageBootstrap(candidate, options);
      },
      createRemotePackageUploadStaging: (candidate, options) => {
        assertActive();
        return connection.createRemotePackageUploadStaging(candidate, options);
      },
      prepareRemotePackageBootstrap: (candidate, options) => {
        assertActive();
        return connection.prepareRemotePackageBootstrap(candidate, options);
      },
      prepareUploadedRemotePackageBootstrap: (candidate, options) => {
        assertActive();
        return connection.prepareUploadedRemotePackageBootstrap(
          candidate,
          options,
        );
      },
      commitRemotePackageBootstrap: (candidate, options) => {
        assertActive();
        return connection.commitRemotePackageBootstrap(candidate, options);
      },
      cleanupRemotePackageBootstrap: (operationId, options) => {
        assertActive();
        return connection.cleanupRemotePackageBootstrap(operationId, options);
      },
      runAgentLifecycleAction: (installationId, action, signal) => {
        assertActive();
        return connection.runAgentLifecycleAction(
          installationId,
          action,
          signal,
        );
      },
      runAgentRuntimeAction: (installationId, action, signal) => {
        assertActive();
        return connection.runAgentRuntimeAction(installationId, action, signal);
      },
      openStagedSftp: (stagingDirectory, limits, signal) => {
        assertActive();
        return connection.openStagedSftp(stagingDirectory, limits, signal);
      },
      listDirectories: (path, signal) => {
        assertActive();
        return connection.listDirectories(path, signal);
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        entry.leases -= 1;
        if (entry.leases === 0 && entry.waiters === 0) {
          this.scheduleIdleDisposal(entry);
        }
      },
    };
    return lease;
  }

  private scheduleIdleDisposal(entry: PoolEntry): void {
    if (this.entries.get(entry.key) !== entry || entry.idleTimer) {
      return;
    }
    if (!entry.connection || this.idleTimeoutMs === 0) {
      this.disposeEntry(entry);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.leases === 0 && entry.waiters === 0) {
        this.disposeEntry(entry);
      }
    }, this.idleTimeoutMs);
  }

  private disposeEntry(entry: PoolEntry): void {
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.controller.abort();
    entry.connection?.dispose();
  }
}
