import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientChannel } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import {
  createSshRemotePackageBootstrapExecutor,
  SSH_REMOTE_PACKAGE_BOOTSTRAP_COMMAND,
  SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT,
  SshRemotePackageCommitIndeterminateError,
  type SshRemotePackageCandidate,
  type SshRemotePackageIdentity,
} from "./ssh-remote-package-bootstrap";

const operationId = "00000000-0000-4000-8000-000000000301";
const controlPlaneInstaller = Buffer.from(
  '"use strict";console.log("control-plane installer");\n',
  "utf8",
);
const controlPlaneInstallerSha256 = createHash("sha256")
  .update(controlPlaneInstaller)
  .digest("hex");
const candidate: SshRemotePackageCandidate = {
  operationId,
  urls: [
    "https://github.com/mesalogo/goodbuddy/releases/download/agent-v1.0.0/goodbuddy-agent-1.0.0-linux-x64.gbagent",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/package.gbagent",
  ],
  size: 12_345,
  sha256: "a".repeat(64),
};
const identity: SshRemotePackageIdentity = {
  archiveSha256: candidate.sha256,
  agent: {
    installationId: `agent-${"b".repeat(64)}`,
    agentVersion: "1.2.3-alpha.1+build.5",
    manifestSha256: "b".repeat(64),
    binaryDigest: `sha256:${"b".repeat(64)}`,
    platform: "linux",
    architecture: "x64",
    protocol: { major: 1, minor: 2 },
    supervisor: "detached-on-demand",
  },
  runtime: {
    runtimeId: "opencode",
    runtimeVersion: "2.3.4",
    bundleDigest: `sha256:${"c".repeat(64)}`,
    manifestDigest: `sha256:${"d".repeat(64)}`,
    runtimeAdapterDigest: `sha256:${"e".repeat(64)}`,
    acpCapabilitiesDigest: `sha256:${"f".repeat(64)}`,
    platform: "linux",
    architecture: "x64",
    protocol: { major: 3, minor: 4 },
  },
};

function identityResult(command: "prepare" | "commit") {
  return {
    type: "result",
    command,
    status: command === "prepare" ? "prepared" : "committed",
    ...identity,
  };
}

type FakeChannel = EventEmitter & {
  stderr: EventEmitter;
  destroy: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function createChannel(
  onEnd?: (payload: Buffer, channel: FakeChannel) => void,
): FakeChannel {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    destroy: vi.fn(),
    end: vi.fn((program: Buffer) => {
      onEnd?.(protocolPayload(Buffer.from(program)), channel);
    }),
  });
  return channel;
}

function protocolPayload(program: Buffer): Buffer {
  const opening = Buffer.from(
    "exec 3<<'GOODBUDDY_REMOTE_PACKAGE_INPUT_V1'\n",
    "ascii",
  );
  const closing = Buffer.from("GOODBUDDY_REMOTE_PACKAGE_INPUT_V1\n", "ascii");
  expect(program.subarray(0, opening.length)).toEqual(opening);
  const end = program.indexOf(closing, opening.length);
  expect(end).toBeGreaterThan(opening.length);
  expect(program.subarray(end + closing.length).toString("utf8")).toBe(
    SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT,
  );
  return program.subarray(opening.length, end);
}

function executorFor(
  channel: FakeChannel,
  installer: Buffer | string = controlPlaneInstaller,
) {
  const openChannel = vi.fn(async () => channel as unknown as ClientChannel);
  return {
    executor: createSshRemotePackageBootstrapExecutor(openChannel, installer),
    openChannel,
  };
}

function respond(
  channel: FakeChannel,
  messages: readonly Record<string, unknown>[],
  code = 0,
): void {
  queueMicrotask(() => {
    const output = `${messages
      .map((message) => JSON.stringify(message))
      .join("\n")}\n`;
    channel.emit("data", output.slice(0, 11));
    channel.emit("data", Buffer.from(output.slice(11)));
    channel.emit("close", code);
  });
}

describe("fixed SSH remote package bootstrap", () => {
  it("keeps candidate data in bounded structured stdin and uses one fixed command", async () => {
    let request = "";
    const channel = createChannel((payload, active) => {
      request = payload.toString("utf8");
      respond(active, [
        { type: "progress", phase: "checking" },
        { type: "result", status: "available" },
      ]);
    });
    const { executor, openChannel } = executorFor(channel);
    const progress = vi.fn();

    await expect(
      executor.probe(candidate, { onProgress: progress }),
    ).resolves.toEqual({ available: true });
    expect(openChannel).toHaveBeenCalledOnce();
    expect(request.split("\n")).toEqual([
      "GOODBUDDY_REMOTE_PACKAGE_BOOTSTRAP_V1",
      "probe",
      operationId,
      "12345",
      "a".repeat(64),
      "0",
      "0".repeat(64),
      "",
      "2",
      ...candidate.urls,
      "",
    ]);
    expect(progress).toHaveBeenCalledWith({ phase: "checking" });
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_COMMAND).toBe("exec sh -s");
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "IFS= read -r action",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "curl --silent --show-error",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      '--max-redirs 0 --proto "=https"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'prepare --operation-root "$operation_root" --archive "$archive"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'commit --operation-root "$operation_root"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'cat -- "$installer_output" || stop failed installer-failed',
    );
    const commitResultOffset = SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.indexOf(
      'cat -- "$installer_output" || stop failed installer-failed',
    );
    const commitCleanupOffset = SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.indexOf(
      'operation_created=1\n  rm -rf -- "$operation_root"',
      commitResultOffset,
    );
    expect(commitResultOffset).toBeGreaterThan(-1);
    expect(commitCleanupOffset).toBe(-1);
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'if [ "$action" = commit-status ]; then',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).not.toContain(
      candidate.urls[0],
    );
  });

  it("transfers the bounded control-plane installer only for prepare actions", async () => {
    const requests: string[] = [];
    const openChannel = vi.fn(async () => {
      const channel = createChannel((payload, active) => {
        requests.push(payload.toString("utf8"));
        const action = requests.at(-1)?.split("\n")[1];
        respond(
          active,
          action === "prepare" || action === "prepare-uploaded"
            ? [identityResult("prepare")]
            : action === "commit"
              ? [identityResult("commit")]
              : action === "commit-status"
                ? [identityResult("commit")]
                : action === "cleanup"
                  ? [{ type: "result", status: "cleaned" }]
                  : action === "create-upload-staging"
                    ? [
                        {
                          type: "result",
                          status: "upload-staging-created",
                          operationId,
                          archivePath: `/home/builder/.goodbuddy/agent/staging/op-${operationId}/package.gbagent`,
                          bootstrapNodePath: `/home/builder/.goodbuddy/agent/staging/op-${operationId}/bootstrap/agent/node`,
                        },
                      ]
                    : [{ type: "result", status: "available" }],
        );
      });
      return channel as unknown as ClientChannel;
    });
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );

    await executor.probe(candidate);
    await executor.createUploadStaging(candidate);
    await executor.prepare(candidate);
    await executor.prepareUploaded(candidate);
    await executor.commit(candidate);
    await executor.commitStatus(candidate);
    await executor.cleanup(operationId);

    const fields = requests.map((request) => request.split("\n"));
    expect(fields[0]?.slice(5, 8)).toEqual(["0", "0".repeat(64), ""]);
    expect(fields[1]?.slice(5, 8)).toEqual(["0", "0".repeat(64), ""]);
    expect(fields[2]?.slice(5, 8)).toEqual([
      String(controlPlaneInstaller.byteLength),
      controlPlaneInstallerSha256,
      controlPlaneInstaller.toString("base64"),
    ]);
    expect(fields[3]?.slice(5, 8)).toEqual([
      String(controlPlaneInstaller.byteLength),
      controlPlaneInstallerSha256,
      controlPlaneInstaller.toString("base64"),
    ]);
    for (const index of [4, 5, 6]) {
      expect(fields[index]?.slice(5, 8)).toEqual(["0", "0".repeat(64), ""]);
    }
    expect(requests.map((request) => request.split("\n")[1])).toEqual([
      "probe",
      "create-upload-staging",
      "prepare",
      "prepare-uploaded",
      "commit",
      "commit-status",
      "cleanup",
    ]);
    expect(fields[3]?.slice(8)).toEqual(["0", ""]);
  });

  it("copies installer bytes and rejects empty, malformed, or oversized installers before SSH", async () => {
    const channel = createChannel((payload, active) => {
      const fields = payload.toString("utf8").split("\n");
      expect(fields[5]).toBe(String(controlPlaneInstaller.byteLength));
      expect(fields[6]).toBe(controlPlaneInstallerSha256);
      expect(fields[7]).toBe(controlPlaneInstaller.toString("base64"));
      respond(active, [identityResult("prepare")]);
    });
    const openChannel = vi.fn(async () => channel as unknown as ClientChannel);
    const mutable = Buffer.from(controlPlaneInstaller);
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      mutable,
    );
    mutable.fill(0);

    expect(() =>
      createSshRemotePackageBootstrapExecutor(openChannel, ""),
    ).toThrow("安装器大小无效");
    expect(() =>
      createSshRemotePackageBootstrapExecutor(
        openChannel,
        Buffer.alloc(256 * 1024 + 1),
      ),
    ).toThrow("安装器大小无效");
    expect(() =>
      createSshRemotePackageBootstrapExecutor(openChannel, Buffer.from([0xff])),
    ).toThrow("安装器编码无效");
    expect(() =>
      createSshRemotePackageBootstrapExecutor(
        openChannel,
        42 as unknown as Buffer,
      ),
    ).toThrow("安装器无效");
    expect(openChannel).not.toHaveBeenCalled();
    await expect(executor.prepare(candidate)).resolves.toMatchObject({
      prepared: true,
    });
  });

  it("requires only packaged Node and verifies the transferred installer before retaining it", () => {
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'node_count=$(unzip -Z1 "$archive"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).not.toContain(
      "installer_count=$(unzip -Z1",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).not.toContain(
      "agent/lib/package-installer.cjs",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'bytes.toString(\\"base64\\")!==input',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'createHash(\\"sha256\\").update(bytes).digest(\\"hex\\")',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'fs.writeFileSync(process.argv[1],bytes,{flag:\\"wx\\",mode:0o600})',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'chmod 0600 "$bootstrap/package-installer.mjs"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      '"$operation_root/bootstrap/package-installer.mjs"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "preserve_operation=1",
    );
  });

  it("emits executable POSIX parameter expansion without optional awk or printenv dependencies", () => {
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain("raw_home=${HOME:-}");
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain("actual_size=${1:-}");
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).not.toContain(
      String.raw`\${HOME:-}`,
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).not.toMatch(
      /\b(?:awk|printenv)\b/u,
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'if [ "$index" -lt "$url_count" ] || [ "$mode" = probe ]; then',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "--range 0-0 --max-filesize 1024",
    );
  });

  it("rejects injection, schemes, ports, hosts, redirects, sizes, and hashes before SSH", async () => {
    const channel = createChannel();
    const { executor, openChannel } = executorFor(channel);
    const invalid: SshRemotePackageCandidate[] = [
      { ...candidate, operationId: `${operationId};id` },
      {
        ...candidate,
        urls: ["https://github.com/package\n--output=/etc/passwd"],
      },
      {
        ...candidate,
        urls: ["http://github.com/package.gbagent"],
      },
      {
        ...candidate,
        urls: ["https://github.com:444/package.gbagent"],
      },
      {
        ...candidate,
        urls: ["https://evil.example/package.gbagent"],
      },
      {
        ...candidate,
        urls: [
          ...candidate.urls,
          "https://objects.githubusercontent.com/a",
          "https://objects.githubusercontent.com/b",
          "https://objects.githubusercontent.com/c",
        ],
      },
      { ...candidate, size: 512 * 1024 * 1024 + 1 },
      { ...candidate, sha256: `${"a".repeat(63)};` },
    ];

    for (const value of invalid) {
      await expect(executor.prepare(value)).rejects.toThrow();
    }
    expect(openChannel).not.toHaveBeenCalled();
  });

  it("returns sanitized missing-tool unavailability without throwing", async () => {
    const channel = createChannel((_payload, active) => {
      respond(active, [
        {
          type: "result",
          status: "unavailable",
          reason: "missing-curl",
        },
      ]);
    });
    const { executor } = executorFor(channel);

    await expect(executor.probe(candidate)).resolves.toEqual({
      available: false,
      reason: "missing-curl",
    });
  });

  it("creates only fixed upload staging paths without download tools", async () => {
    let request = "";
    const operationRoot = `/home/builder/.goodbuddy/agent/staging/op-${operationId}`;
    const channel = createChannel((payload, active) => {
      request = payload.toString("utf8");
      respond(active, [
        {
          type: "result",
          status: "upload-staging-created",
          operationId,
          archivePath: `${operationRoot}/package.gbagent`,
          bootstrapNodePath: `${operationRoot}/bootstrap/agent/node`,
        },
      ]);
    });
    const { executor } = executorFor(channel);

    await expect(executor.createUploadStaging(candidate)).resolves.toEqual({
      created: true,
      operationId,
      archivePath: `${operationRoot}/package.gbagent`,
      bootstrapNodePath: `${operationRoot}/bootstrap/agent/node`,
    });
    expect(request.split("\n").slice(0, 10)).toEqual([
      "GOODBUDDY_REMOTE_PACKAGE_BOOTSTRAP_V1",
      "create-upload-staging",
      operationId,
      String(candidate.size),
      candidate.sha256,
      "0",
      "0".repeat(64),
      "",
      "0",
      "",
    ]);
    const stagingOffset = SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.indexOf(
      'if [ "$action" = create-upload-staging ]; then',
    );
    expect(stagingOffset).toBeGreaterThan(-1);
    expect(
      SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.indexOf(
        "command -v curl",
        stagingOffset,
      ),
    ).toBeGreaterThan(stagingOffset);
    expect(
      SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.slice(
        stagingOffset,
        SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.indexOf(
          "run_prepare()",
          stagingOffset,
        ),
      ),
    ).not.toMatch(/\b(?:curl|sha256sum|unzip)\b/u);
  });

  it("rejects non-fixed upload paths returned by the Host", async () => {
    const channel = createChannel((_payload, active) => {
      respond(active, [
        {
          type: "result",
          status: "upload-staging-created",
          operationId,
          archivePath: "/tmp/package.gbagent",
          bootstrapNodePath: "/tmp/node",
        },
      ]);
    });

    await expect(
      executorFor(channel).executor.createUploadStaging(candidate),
    ).rejects.toThrow("无效结果");
  });

  it("validates uploaded archive size and packaged Node before prepare", () => {
    const uploadedOffset = SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.indexOf(
      'if [ "$action" = prepare-uploaded ]; then',
    );
    const downloadOffset = SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.indexOf(
      "command -v curl",
      uploadedOffset,
    );
    const uploadedBlock = SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.slice(
      uploadedOffset,
      downloadOffset,
    );

    expect(uploadedBlock).toContain(
      '[ "$actual_size" = "$expected_size" ] || stop failed size-mismatch',
    );
    expect(uploadedBlock).toContain('[ ! -f "$bootstrap/agent/node" ]');
    expect(uploadedBlock).toContain('[ -L "$bootstrap/agent/node" ]');
    expect(uploadedBlock).toContain('[ ! -x "$bootstrap/agent/node" ]');
    expect(uploadedBlock).toContain("run_prepare");
    expect(uploadedBlock).not.toMatch(/\b(?:curl|sha256sum|unzip)\b/u);
  });

  it("rejects empty installer terminal files for prepare and status", () => {
    expect(
      SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT.match(
        /\[ "\$installer_output_size" -gt 0 \]/gu,
      ),
    ).toHaveLength(4);
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      '[ "$installer_output_size" -le 49152 ]',
    );
  });

  it("parses bounded split NDJSON progress and a prepared result", async () => {
    const channel = createChannel((_payload, active) => {
      respond(active, [
        { type: "progress", phase: "downloading" },
        {
          type: "progress",
          command: "prepare",
          phase: "verifying-payload",
        },
        identityResult("prepare"),
      ]);
    });
    const { executor } = executorFor(channel);
    const phases: string[] = [];

    await expect(
      executor.prepare(candidate, {
        onProgress: ({ phase }) => phases.push(phase),
      }),
    ).resolves.toEqual({
      prepared: true,
      operationId,
      identity,
    });
    expect(phases).toEqual(["downloading", "verifying-payload"]);
  });

  it("returns a strictly validated committed package identity", async () => {
    const channel = createChannel((_payload, active) => {
      respond(active, [
        {
          type: "progress",
          command: "commit",
          phase: "publishing-content",
        },
        identityResult("commit"),
      ]);
    });
    const { executor } = executorFor(channel);

    await expect(executor.commit(candidate)).resolves.toEqual({
      committed: true,
      operationId,
      identity,
    });
  });

  it("rejects malformed and mismatched package identity records", async () => {
    const valid = identityResult("prepare");
    const invalidRecords: Record<string, unknown>[] = [
      { ...valid, extra: true },
      { ...valid, command: "commit" },
      { ...valid, status: "committed" },
      { ...valid, archiveSha256: "0".repeat(64) },
      {
        ...valid,
        agent: { ...identity.agent, installationId: "agent-other" },
      },
      {
        ...valid,
        agent: {
          ...identity.agent,
          binaryDigest: `sha256:${"0".repeat(64)}`,
        },
      },
      {
        ...valid,
        agent: { ...identity.agent, agentVersion: "01.2.3" },
      },
      {
        ...valid,
        agent: { ...identity.agent, platform: "darwin" },
      },
      {
        ...valid,
        agent: {
          ...identity.agent,
          protocol: { major: 1.5, minor: 2 },
        },
      },
      {
        ...valid,
        agent: {
          ...identity.agent,
          protocol: { major: 1, minor: 2, patch: 3 },
        },
      },
      {
        ...valid,
        agent: { ...identity.agent, supervisor: "systemd" },
      },
      {
        ...valid,
        runtime: { ...identity.runtime, runtimeId: "other" },
      },
      {
        ...valid,
        runtime: {
          ...identity.runtime,
          bundleDigest: "c".repeat(64),
        },
      },
      {
        ...valid,
        runtime: {
          ...identity.runtime,
          architecture: "arm64",
        },
      },
      {
        ...valid,
        runtime: {
          ...identity.runtime,
          unexpected: true,
        },
      },
    ];

    for (const record of invalidRecords) {
      const channel = createChannel((_payload, active) => {
        respond(active, [record]);
      });
      await expect(
        executorFor(channel).executor.prepare(candidate),
      ).rejects.toThrow("无效结果");
      expect(channel.destroy).toHaveBeenCalledOnce();
    }
  });

  it("reports redirect mismatch as a bounded failure reason", async () => {
    const channel = createChannel((_payload, active) => {
      respond(active, [
        {
          type: "result",
          status: "failed",
          reason: "redirect-mismatch",
        },
      ]);
    });
    const { executor } = executorFor(channel);

    await expect(executor.prepare(candidate)).resolves.toEqual({
      prepared: false,
      unavailable: false,
      reason: "redirect-mismatch",
    });
  });

  it("preserves bounded installer failure classifications", async () => {
    const prepareFailure = createChannel((_payload, active) => {
      respond(active, [{
        type: "error",
        command: "prepare",
        status: "failed",
        message: "archive verification failed",
      }]);
    });
    await expect(
      executorFor(prepareFailure).executor.prepare(candidate),
    ).resolves.toEqual({
      prepared: false,
      unavailable: false,
      reason: "installer-failed",
    });

    const rollbackFailure = createChannel((_payload, active) => {
      respond(active, [{
        type: "error",
        command: "commit",
        status: "rollback-incomplete",
        message: "managed destination restore failed",
      }]);
    });
    await expect(
      executorFor(rollbackFailure).executor.commit(candidate),
    ).resolves.toEqual({
      committed: false,
      reason: "installer-rollback-incomplete",
    });
  });

  it("accepts an URL-free candidate only for GoodBuddy upload actions", async () => {
    const localCandidate = { ...candidate, urls: [] };
    const staging = createChannel((_payload, active) => {
      respond(active, [{
        type: "result",
        status: "upload-staging-created",
        operationId,
        archivePath:
          `/home/goodbuddy/.goodbuddy/agent/staging/op-${operationId}/package.gbagent`,
        bootstrapNodePath:
          `/home/goodbuddy/.goodbuddy/agent/staging/op-${operationId}/bootstrap/agent/node`,
      }]);
    });

    await expect(
      executorFor(staging).executor.createUploadStaging(localCandidate),
    ).resolves.toMatchObject({ created: true });
    await expect(
      executorFor(createChannel()).executor.prepare(localCandidate),
    ).rejects.toThrow("下载链无效");
  });

  it("destroys channels on malformed or excessive output", async () => {
    const malformed = createChannel((_payload, active) => {
      queueMicrotask(() => active.emit("data", '{"secret":"leak"}\n'));
    });
    await expect(
      executorFor(malformed).executor.probe(candidate),
    ).rejects.toThrow("无效结果");
    expect(malformed.destroy).toHaveBeenCalledOnce();

    const excessive = createChannel((_payload, active) => {
      queueMicrotask(() => active.emit("data", Buffer.alloc(64 * 1024 + 1)));
    });
    await expect(
      executorFor(excessive).executor.probe(candidate),
    ).rejects.toThrow("超过安全限制");
    expect(excessive.destroy).toHaveBeenCalledOnce();

    const oversizedRecord = createChannel((_payload, active) => {
      queueMicrotask(() =>
        active.emit("data", Buffer.alloc(8 * 1024 + 1, 0x61)),
      );
    });
    await expect(
      executorFor(oversizedRecord).executor.prepare(candidate),
    ).rejects.toThrow("超过安全限制");
    expect(oversizedRecord.destroy).toHaveBeenCalledOnce();

    const channelError = createChannel((_payload, active) => {
      queueMicrotask(() =>
        active.emit("error", new Error("private remote diagnostic")),
      );
    });
    const channelErrorResult =
      executorFor(channelError).executor.probe(candidate);
    await expect(channelErrorResult).rejects.toThrow(
      "Agent 远程安装能力检查 SSH 通道异常中断",
    );
    await expect(channelErrorResult).rejects.not.toThrow(
      "private remote diagnostic",
    );
    expect(channelError.destroy).toHaveBeenCalledOnce();
  });

  it("distinguishes shell exit and incomplete protocol failures", async () => {
    const shellExit = createChannel((_payload, active) => {
      queueMicrotask(() => active.emit("close", 64));
    });
    await expect(
      executorFor(shellExit).executor.probe(candidate),
    ).rejects.toThrow("能力检查shell 退出状态 64");

    const missingResult = createChannel((_payload, active) => {
      queueMicrotask(() => active.emit("close", 0));
    });
    await expect(
      executorFor(missingResult).executor.probe(candidate),
    ).rejects.toThrow("能力检查通道在返回终态前关闭");

    const incompleteResult = createChannel((_payload, active) => {
      queueMicrotask(() => {
        active.emit("data", '{"type":"result"');
        active.emit("close", 0);
      });
    });
    await expect(
      executorFor(incompleteResult).executor.probe(candidate),
    ).rejects.toThrow("能力检查返回了不完整结果");
  });

  it("recovers a lost prepare terminal from retained operation status", async () => {
    const requests: string[] = [];
    const channels = [
      createChannel((payload, active) => {
        requests.push(payload.toString("utf8"));
        queueMicrotask(() => active.emit("close", 0));
      }),
      createChannel((payload, active) => {
        requests.push(payload.toString("utf8"));
        respond(active, [
          {
            type: "progress",
            command: "prepare",
            phase: "persisting-prepared-state",
          },
          identityResult("prepare"),
        ]);
      }),
    ];
    const openChannel = vi.fn(async () => {
      const channel = channels.shift();
      if (!channel) {
        throw new Error("unexpected channel");
      }
      return channel as unknown as ClientChannel;
    });
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );
    const progress = vi.fn();

    await expect(
      executor.prepare(candidate, { onProgress: progress }),
    ).resolves.toMatchObject({
      prepared: true,
      operationId,
    });
    expect(openChannel).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.split("\n")[1])).toEqual([
      "prepare",
      "prepare-status",
    ]);
    expect(requests[1]?.split("\n")).toEqual([
      "GOODBUDDY_REMOTE_PACKAGE_BOOTSTRAP_V1",
      "prepare-status",
      operationId,
      String(candidate.size),
      candidate.sha256,
      "0",
      "0".repeat(64),
      "",
      "0",
      "",
    ]);
    expect(progress).toHaveBeenCalledWith({
      phase: "persisting-prepared-state",
    });
  });

  it("preserves the original prepare error when status recovery is unavailable", async () => {
    const first = createChannel((_payload, active) => {
      queueMicrotask(() => active.emit("close", 0));
    });
    const status = createChannel((_payload, active) => {
      respond(active, [
        {
          type: "result",
          status: "failed",
          reason: "operation-unavailable",
        },
      ]);
    });
    const channels = [first, status];
    const openChannel = vi.fn(
      async () => channels.shift() as unknown as ClientChannel,
    );
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );

    await expect(executor.prepare(candidate)).rejects.toThrow(
      "准备通道在返回终态前关闭；尚未进入提交阶段，远端版本未切换，请重试",
    );
    expect(openChannel).toHaveBeenCalledTimes(2);
  });

  it("recovers prepare status after a channel closes without an exit code", async () => {
    const channels = [
      createChannel((_payload, active) => {
        queueMicrotask(() => active.emit("close", null));
      }),
      createChannel((_payload, active) => {
        respond(active, [identityResult("prepare")]);
      }),
    ];
    const openChannel = vi.fn(
      async () => channels.shift() as unknown as ClientChannel,
    );
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );

    await expect(executor.prepare(candidate)).resolves.toMatchObject({
      prepared: true,
      operationId,
    });
    expect(openChannel).toHaveBeenCalledTimes(2);
  });

  it("revalidates a received prepare terminal when the exit code is missing", async () => {
    const first = createChannel((_payload, active) => {
      queueMicrotask(() => {
        active.emit(
          "data",
          `${JSON.stringify(identityResult("prepare"))}\n`,
        );
        active.emit("close", null);
      });
    });
    const status = createChannel((_payload, active) => {
      respond(active, [identityResult("prepare")]);
    });
    const channels = [first, status];
    const openChannel = vi.fn(
      async () => channels.shift() as unknown as ClientChannel,
    );
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );

    await expect(executor.prepare(candidate)).resolves.toMatchObject({
      prepared: true,
      operationId,
    });
    expect(openChannel).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation while recovering prepare status", async () => {
    const first = createChannel((_payload, active) => {
      queueMicrotask(() => active.emit("close", 0));
    });
    const status = createChannel();
    const channels = [first, status];
    const openChannel = vi.fn(
      async () => channels.shift() as unknown as ClientChannel,
    );
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );
    const controller = new AbortController();
    const preparing = executor.prepare(candidate, {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(openChannel).toHaveBeenCalledTimes(2);
    });

    controller.abort();

    await expect(preparing).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(status.destroy).toHaveBeenCalledOnce();
  });

  it("recovers prepared status after the command timeout boundary", async () => {
    vi.useFakeTimers();
    try {
      const prepare = createChannel();
      const status = createChannel((_payload, active) => {
        respond(active, [identityResult("prepare")]);
      });
      const channels = [prepare, status];
      const openChannel = vi.fn(
        async () => channels.shift() as unknown as ClientChannel,
      );
      const executor = createSshRemotePackageBootstrapExecutor(
        openChannel,
        controlPlaneInstaller,
      );
      const preparing = executor.prepare(candidate);
      await vi.advanceTimersByTimeAsync(12 * 60_000);

      await expect(preparing).resolves.toMatchObject({
        prepared: true,
        operationId,
      });
      expect(openChannel).toHaveBeenCalledTimes(2);
      expect(prepare.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a lost commit result from commit status without replaying commit", async () => {
    const requests: string[] = [];
    const channels = [
      createChannel((payload, active) => {
        requests.push(payload.toString("utf8"));
        queueMicrotask(() => active.emit("close", 0));
      }),
      createChannel((payload, active) => {
        requests.push(payload.toString("utf8"));
        respond(active, [identityResult("commit")]);
      }),
    ];
    const openChannel = vi.fn(
      async () => channels.shift() as unknown as ClientChannel,
    );
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );

    await expect(executor.commit(candidate)).resolves.toEqual({
      committed: true,
      operationId,
      identity,
    });
    expect(openChannel).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.split("\n")[1])).toEqual([
      "commit",
      "commit-status",
    ]);
  });

  it("keeps a lost commit indeterminate when status is unknown", async () => {
    const requests: string[] = [];
    const channels = [
      createChannel((payload, active) => {
        requests.push(payload.toString("utf8"));
        queueMicrotask(() => active.emit("close", 0));
      }),
      createChannel((payload, active) => {
        requests.push(payload.toString("utf8"));
        respond(active, [
          {
            type: "result",
            status: "failed",
            reason: "operation-unavailable",
          },
        ]);
      }),
    ];
    const openChannel = vi.fn(
      async () => channels.shift() as unknown as ClientChannel,
    );
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );

    await expect(executor.commit(candidate)).rejects.toBeInstanceOf(
      SshRemotePackageCommitIndeterminateError,
    );
    expect(requests.map((request) => request.split("\n")[1])).toEqual([
      "commit",
      "commit-status",
    ]);
  });

  it("times out a stalled operation and destroys its channel", async () => {
    vi.useFakeTimers();
    try {
      const channel = createChannel();
      const promise = executorFor(channel).executor.probe(candidate);
      const expectation = expect(promise).rejects.toThrow("操作超时");
      await vi.advanceTimersByTimeAsync(45_000);

      await expectation;
      expect(channel.destroy).toHaveBeenCalledOnce();

      const commitChannel = createChannel();
      const statusChannel = createChannel();
      const channels = [commitChannel, statusChannel];
      const openChannel = vi.fn(
        async () => channels.shift() as unknown as ClientChannel,
      );
      const committing = createSshRemotePackageBootstrapExecutor(
        openChannel,
        controlPlaneInstaller,
      ).commit(candidate);
      const commitExpectation = expect(committing).rejects.toBeInstanceOf(
        SshRemotePackageCommitIndeterminateError,
      );
      await vi.advanceTimersByTimeAsync(12 * 60_000);
      await vi.advanceTimersByTimeAsync(15_000);

      await commitExpectation;
      expect(commitChannel.destroy).toHaveBeenCalledOnce();
      expect(statusChannel.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts preparation but marks an interrupted commit indeterminate", async () => {
    const prepareChannel = createChannel();
    const prepareController = new AbortController();
    const preparing = executorFor(prepareChannel).executor.prepare(candidate, {
      signal: prepareController.signal,
    });
    prepareController.abort();
    await expect(preparing).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(prepareChannel.destroy).toHaveBeenCalledOnce();

    const commitChannel = createChannel();
    const commitController = new AbortController();
    const committing = executorFor(commitChannel).executor.commit(candidate, {
      signal: commitController.signal,
    });
    await Promise.resolve();
    commitController.abort();
    await expect(committing).rejects.toBeInstanceOf(
      SshRemotePackageCommitIndeterminateError,
    );
    expect(commitChannel.destroy).toHaveBeenCalledOnce();
    const commitRequest = protocolPayload(
      Buffer.from(commitChannel.end.mock.calls[0]?.[0] as Buffer),
    ).toString("utf8");
    expect(commitRequest.split("\n")).toEqual([
      "GOODBUDDY_REMOTE_PACKAGE_BOOTSTRAP_V1",
      "commit",
      operationId,
      String(candidate.size),
      candidate.sha256,
      "0",
      "0".repeat(64),
      "",
      "0",
      "",
    ]);
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "trap cleanup_operation EXIT",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "trap 'exit 129' HUP",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "trap 'exit 130' INT",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "trap 'exit 143' TERM",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      '--archive "$operation_root/package.gbagent"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      '"$staging_root/op-"*',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'if [ "$action" = prepare-status ]; then',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      'preserve_operation=1\n  cat -- "$installer_output"',
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).toContain(
      "grep -Eq '^{\"type\":\"(result|error)\",'",
    );
  });

  it("requires explicit cleanup after a successful commit", async () => {
    const requests: string[] = [];
    const openChannel = vi.fn(async () => {
      const channel = createChannel((payload, active) => {
        const request = payload.toString("utf8");
        requests.push(request);
        respond(
          active,
          request.split("\n")[1] === "commit"
            ? [identityResult("commit")]
            : [{ type: "result", status: "cleaned" }],
        );
      });
      return channel as unknown as ClientChannel;
    });
    const executor = createSshRemotePackageBootstrapExecutor(
      openChannel,
      controlPlaneInstaller,
    );

    await expect(executor.commit(candidate)).resolves.toMatchObject({
      committed: true,
    });
    expect(requests).toHaveLength(1);
    await expect(executor.cleanup(operationId)).resolves.toEqual({
      cleaned: true,
      operationId,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain(`cleanup\n${operationId}\n0\n`);
    await expect(executor.cleanup("../../unrelated")).rejects.toThrow(
      "operation ID 无效",
    );
    expect(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT).not.toMatch(
      /rm -rf -- "\$managed_root"|rm -rf -- "\$home_value"/u,
    );
  });
});
