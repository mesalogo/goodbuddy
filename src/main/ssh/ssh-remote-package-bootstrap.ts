import type { ClientChannel } from "ssh2";
import { createHash } from "node:crypto";

const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_CONTROL_PLANE_INSTALLER_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URL_BYTES = 4_096;
const MAX_INPUT_BYTES = 384 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_MESSAGES = 128;
const PROBE_TIMEOUT_MS = 45_000;
const PREPARE_TIMEOUT_MS = 12 * 60_000;
const COMMIT_TIMEOUT_MS = 12 * 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const MAX_REMOTE_PATH_BYTES = 4_096;
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const MAX_VERSION_LENGTH = 128;
const MAX_PROTOCOL_COMPONENT = 65_535;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "goodbuddy.oss-cn-beijing.aliyuncs.com",
]);

const progressPhases = [
  "checking",
  "downloading",
  "verifying",
  "extracting",
  "preparing",
  "prepared",
  "committing",
  "committed",
  "cleaning",
  "validating",
  "hashing-archive",
  "verifying-zip",
  "verifying-payload",
  "persisting-prepared-state",
  "validating-prepared-state",
  "extracting-payload",
  "publishing-content",
  "publishing-metadata",
] as const;

const unavailableReasons = [
  "missing-curl",
  "missing-sha256sum",
  "missing-unzip",
  "bootstrap-tools-unavailable",
  "managed-path-unavailable",
  "insufficient-disk-space",
  "download-unavailable",
] as const;

const failureReasons = [
  "operation-conflict",
  "download-failed",
  "redirect-mismatch",
  "size-mismatch",
  "sha256-mismatch",
  "archive-invalid",
  "installer-failed",
  "installer-rollback-incomplete",
  "operation-unavailable",
  "cleanup-failed",
] as const;

type BootstrapAction =
  | "probe"
  | "create-upload-staging"
  | "prepare"
  | "prepare-uploaded"
  | "prepare-status"
  | "commit"
  | "commit-status"
  | "cleanup";

export type SshRemotePackageCandidate = {
  operationId: string;
  /**
   * The exact Main-approved request sequence. Each non-final response must
   * redirect to the next URL; curl is never allowed to follow redirects.
   */
  urls: readonly string[];
  size: number;
  sha256: string;
};

export type SshRemotePackageBootstrapProgress = {
  phase: (typeof progressPhases)[number];
};

export type SshRemotePackageBootstrapOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: SshRemotePackageBootstrapProgress) => void;
};

export type SshRemotePackageBootstrapUnavailableReason =
  (typeof unavailableReasons)[number];

export type SshRemotePackageBootstrapFailureReason =
  (typeof failureReasons)[number];

export type SshRemotePackageBootstrapProbeResult =
  | { available: true }
  | {
      available: false;
      reason: SshRemotePackageBootstrapUnavailableReason;
    };

export type SshRemotePackageProtocol = {
  major: number;
  minor: number;
};

export type SshRemotePackageAgentIdentity = {
  installationId: string;
  agentVersion: string;
  manifestSha256: string;
  binaryDigest: string;
  platform: "linux";
  architecture: "x64" | "arm64";
  protocol: SshRemotePackageProtocol;
  supervisor: "detached-on-demand";
};

export type SshRemotePackageRuntimeIdentity = {
  runtimeId: "opencode";
  runtimeVersion: string;
  bundleDigest: string;
  manifestDigest: string;
  runtimeAdapterDigest: string;
  acpCapabilitiesDigest: string;
  platform: "linux";
  architecture: "x64" | "arm64";
  protocol: SshRemotePackageProtocol;
};

export type SshRemotePackageIdentity = {
  archiveSha256: string;
  agent: SshRemotePackageAgentIdentity;
  runtime: SshRemotePackageRuntimeIdentity;
};

export type SshRemotePackageBootstrapPrepareResult =
  | {
      prepared: true;
      operationId: string;
      identity: SshRemotePackageIdentity;
    }
  | {
      prepared: false;
      unavailable: true;
      reason: SshRemotePackageBootstrapUnavailableReason;
    }
  | {
      prepared: false;
      unavailable: false;
      reason: SshRemotePackageBootstrapFailureReason;
      detail?: string;
    };

export type SshRemotePackageUploadStagingResult =
  | {
      created: true;
      operationId: string;
      archivePath: string;
      bootstrapNodePath: string;
    }
  | {
      created: false;
      unavailable: true;
      reason: SshRemotePackageBootstrapUnavailableReason;
    }
  | {
      created: false;
      unavailable: false;
      reason: SshRemotePackageBootstrapFailureReason;
    };

export type SshRemotePackageBootstrapCommitResult =
  | {
      committed: true;
      operationId: string;
      identity: SshRemotePackageIdentity;
    }
  | {
      committed: false;
      reason: SshRemotePackageBootstrapFailureReason;
      detail?: string;
    };

export type SshRemotePackageBootstrapCleanupResult =
  | { cleaned: true; operationId: string }
  | {
      cleaned: false;
      reason: "operation-unavailable" | "cleanup-failed";
    };

export interface SshRemotePackageBootstrapExecutor {
  probe(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapProbeResult>;
  createUploadStaging(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageUploadStagingResult>;
  prepare(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapPrepareResult>;
  prepareUploaded(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapPrepareResult>;
  /**
   * Main must recheck the pinned Host identity immediately before this call.
   * If this call is canceled or times out after opening its SSH channel, the
   * commit outcome is deliberately reported as indeterminate and operation
   * staging is retained for a subsequent identity/status inspection.
   */
  commit(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapCommitResult>;
  commitStatus(
    candidate: SshRemotePackageCandidate,
    options?: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapCommitResult>;
  cleanup(
    operationId: string,
    options?: Pick<SshRemotePackageBootstrapOptions, "signal">,
  ): Promise<SshRemotePackageBootstrapCleanupResult>;
}

export class SshRemotePackageCommitIndeterminateError extends Error {
  readonly commitMayHaveSucceeded = true;

  constructor(message = "Agent 安装提交结果不确定，请重新检查 Host 状态") {
    super(message);
    this.name = "SshRemotePackageCommitIndeterminateError";
  }
}

class SshRemotePackagePrepareResultLostError extends Error {
  constructor(readonly originalError: unknown) {
    super("Agent 远程安装准备结果丢失");
    this.name = "SshRemotePackagePrepareResultLostError";
  }
}

type TerminalMessage =
  | { type: "result"; status: "available" }
  | {
      type: "result";
      status: "unavailable";
      reason: SshRemotePackageBootstrapUnavailableReason;
    }
  | {
      type: "result";
      status: "failed";
      reason: SshRemotePackageBootstrapFailureReason;
      detail?: string;
    }
  | {
      type: "result";
      command: "prepare" | "commit";
      status: "prepared" | "committed";
      archiveSha256: string;
      agent: SshRemotePackageAgentIdentity;
      runtime: SshRemotePackageRuntimeIdentity;
    }
  | {
      type: "result";
      status: "upload-staging-created";
      operationId: string;
      archivePath: string;
      bootstrapNodePath: string;
    }
  | { type: "result"; status: "cleaned" };

type OpenBootstrapChannel = (signal?: AbortSignal) => Promise<ClientChannel>;

const SHELL_HOME_OR_EMPTY = "${HOME:-}";
const SHELL_FIRST_POSITIONAL_OR_EMPTY = "${1:-}";
const SHELL_FOURTH_POSITIONAL_OR_EMPTY = "${4:-}";
const BOOTSTRAP_INPUT_DELIMITER = "GOODBUDDY_REMOTE_PACKAGE_INPUT_V1";

/*
 * The fixed command has no dynamic shell syntax and stays far below SSH
 * command-length limits. Main sends the fixed script plus a bounded here-doc
 * containing candidate data; the script reads that data only from fd 3.
 */
export const SSH_REMOTE_PACKAGE_BOOTSTRAP_COMMAND = "exec sh -s";

export const SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT = String.raw`
set -u
umask 077
operation_created=0
preserve_operation=0
operation_root=
home_value=
staging_root=
emit_progress() { printf "{\"type\":\"progress\",\"phase\":\"%s\"}\n" "$1"; }
emit_result() {
  if [ "$2" = "" ]; then
    printf "{\"type\":\"result\",\"status\":\"%s\"}\n" "$1"
  else
    printf "{\"type\":\"result\",\"status\":\"%s\",\"reason\":\"%s\"}\n" "$1" "$2"
  fi
}
cleanup_operation() {
  if [ "$operation_created" = 1 ] && [ "$preserve_operation" = 0 ] &&
     [ -n "$operation_root" ]; then
    case "$operation_root" in
      "$staging_root/op-"*) rm -rf -- "$operation_root" ;;
    esac
  fi
}
stop() {
  emit_result "$1" "$2"
  cleanup_operation
  exit 0
}
trap cleanup_operation EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
IFS= read -r magic <&3 || exit 64
IFS= read -r action <&3 || exit 64
IFS= read -r operation_id <&3 || exit 64
IFS= read -r expected_size <&3 || exit 64
IFS= read -r expected_sha256 <&3 || exit 64
IFS= read -r installer_size <&3 || exit 64
IFS= read -r installer_sha256 <&3 || exit 64
IFS= read -r installer_base64 <&3 || exit 64
IFS= read -r url_count <&3 || exit 64
[ "$magic" = GOODBUDDY_REMOTE_PACKAGE_BOOTSTRAP_V1 ] || exit 64
case "$action" in probe|create-upload-staging|prepare|prepare-uploaded|prepare-status|commit|commit-status|cleanup) ;; *) exit 64 ;; esac
case "$operation_id" in
  ????????-????-????-????-????????????) ;;
  *) exit 64 ;;
esac
case "$operation_id" in *[!0-9a-f-]*) exit 64 ;; esac
case "$expected_size" in ""|*[!0-9]*) exit 64 ;; esac
case "$expected_sha256" in
  ????????????????????????????????????????????????????????????????) ;;
  *) exit 64 ;;
esac
case "$expected_sha256" in *[!0-9a-f]*) exit 64 ;; esac
case "$installer_size" in ""|*[!0-9]*) exit 64 ;; esac
case "$installer_sha256" in
  ????????????????????????????????????????????????????????????????) ;;
  *) exit 64 ;;
esac
case "$installer_sha256" in *[!0-9a-f]*) exit 64 ;; esac
case "$installer_base64" in *[!A-Za-z0-9+/=]*) exit 64 ;; esac
case "$url_count" in 0|1|2|3|4) ;; *) exit 64 ;; esac
url1= url2= url3= url4=
i=1
while [ "$i" -le "$url_count" ]; do
  IFS= read -r url <&3 || exit 64
  case "$url" in
    https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*|https://goodbuddy.oss-cn-beijing.aliyuncs.com/*) ;;
    *) exit 64 ;;
  esac
  case "$i" in
    1) url1=$url ;;
    2) url2=$url ;;
    3) url3=$url ;;
    4) url4=$url ;;
  esac
  i=$((i + 1))
done
if IFS= read -r unexpected <&3; then exit 64; fi
exec 3<&-
if [ "$action" = probe ] || [ "$action" = prepare ]; then
  [ "$url_count" -ge 1 ] || exit 64
  [ "$expected_size" -ge 1 ] || exit 64
else
  [ "$url_count" = 0 ] || exit 64
fi
if [ "$action" = prepare ] || [ "$action" = prepare-uploaded ]; then
  [ "$installer_size" -ge 1 ] && [ "$installer_size" -le 262144 ] ||
    exit 64
  [ -n "$installer_base64" ] || exit 64
else
  [ "$installer_size" = 0 ] || exit 64
  [ "$installer_sha256" = "0000000000000000000000000000000000000000000000000000000000000000" ] ||
    exit 64
  [ -z "$installer_base64" ] || exit 64
fi
raw_home=${SHELL_HOME_OR_EMPTY}
home_value=$(cd "$raw_home" 2>/dev/null && pwd -P)
case "$home_value" in /*) ;; *) stop unavailable managed-path-unavailable ;; esac
if [ "$home_value" = / ]; then
  goodbuddy_root=/.goodbuddy
else
  goodbuddy_root="$home_value/.goodbuddy"
fi
managed_root="$goodbuddy_root/agent"
staging_root="$managed_root/staging"
operation_root="$staging_root/op-$operation_id"
if [ -L "$goodbuddy_root" ] || [ -L "$managed_root" ] ||
   [ -L "$staging_root" ]; then
  if [ "$action" = probe ] || [ "$action" = prepare ] ||
     [ "$action" = create-upload-staging ] ||
     [ "$action" = prepare-uploaded ]; then
    stop unavailable managed-path-unavailable
  else
    stop failed operation-unavailable
  fi
fi
if [ "$action" = cleanup ]; then
  emit_progress cleaning
  if [ ! -e "$operation_root" ]; then stop failed operation-unavailable; fi
  operation_created=1
  if rm -rf -- "$operation_root" && [ ! -e "$operation_root" ]; then
    operation_created=0
    emit_result cleaned ""
  else
    stop failed cleanup-failed
  fi
  exit 0
fi
emit_progress checking
for tool in cat chmod cut df grep mkdir mv rm sed tail wc; do
  command -v "$tool" >/dev/null 2>&1 ||
    stop unavailable bootstrap-tools-unavailable
done
home_bytes=$(printf %s "$home_value" | wc -c 2>/dev/null) ||
  stop unavailable managed-path-unavailable
set -- $home_bytes
home_bytes=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
case "$home_bytes" in ""|*[!0-9]*) stop unavailable managed-path-unavailable ;; esac
[ "$home_bytes" -le 3800 ] || stop unavailable managed-path-unavailable
if printf %s "$home_value" |
   LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
  stop unavailable managed-path-unavailable
fi
if [ "$action" = prepare-status ]; then
  installer_output="$operation_root/installer-prepare.ndjson"
  if [ ! -d "$operation_root" ] || [ -L "$operation_root" ] ||
     [ ! -f "$installer_output" ] || [ -L "$installer_output" ]; then
    stop failed operation-unavailable
  fi
  installer_output_size=$(wc -c < "$installer_output" 2>/dev/null) ||
    stop failed operation-unavailable
  set -- $installer_output_size
  installer_output_size=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
  case "$installer_output_size" in
    ""|*[!0-9]*) stop failed operation-unavailable ;;
  esac
  [ "$installer_output_size" -gt 0 ] ||
    stop failed operation-unavailable
  [ "$installer_output_size" -le 49152 ] ||
    stop failed operation-unavailable
  cat -- "$installer_output" || stop failed operation-unavailable
  exit 0
fi
if [ "$action" = commit-status ]; then
  installer_output="$operation_root/installer-commit.ndjson"
  if [ -d "$operation_root" ] && [ ! -L "$operation_root" ] &&
     [ -f "$installer_output" ] && [ ! -L "$installer_output" ]; then
    installer_output_size=$(wc -c < "$installer_output" 2>/dev/null) ||
      stop failed operation-unavailable
    set -- $installer_output_size
    installer_output_size=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
    case "$installer_output_size" in
      ""|*[!0-9]*) stop failed operation-unavailable ;;
    esac
    [ "$installer_output_size" -le 49152 ] ||
      stop failed operation-unavailable
    terminal_line=$(tail -n 1 "$installer_output" 2>/dev/null) ||
      stop failed operation-unavailable
    if printf %s "$terminal_line" | grep '"type":"result"' >/dev/null 2>&1 ||
       printf %s "$terminal_line" | grep '"type":"error"' >/dev/null 2>&1; then
      cat -- "$installer_output" || stop failed operation-unavailable
      exit 0
    fi
  fi
  # A process or channel loss may leave a partial publication without a
  # terminal line. The installer commit is idempotent and completes it from
  # the authenticated prepared state.
  action=commit
fi
if [ "$action" = commit ]; then
  if [ ! -d "$operation_root" ] || [ -L "$operation_root" ] ||
     [ ! -x "$operation_root/bootstrap/agent/node" ] ||
     [ ! -f "$operation_root/bootstrap/package-installer.mjs" ] ||
     [ -L "$operation_root/bootstrap/agent/node" ] ||
     [ -L "$operation_root/bootstrap/package-installer.mjs" ]; then
    stop failed operation-unavailable
  fi
  emit_progress committing
  installer_output="$operation_root/installer-commit.ndjson"
  rm -f -- "$installer_output"
  "$operation_root/bootstrap/agent/node" \
    "$operation_root/bootstrap/package-installer.mjs" \
    commit --operation-root "$operation_root" \
    --archive "$operation_root/package.gbagent" \
    --expected-sha256 "$expected_sha256" \
    >"$installer_output" 2>/dev/null || true
  installer_output_size=$(wc -c < "$installer_output" 2>/dev/null) ||
    stop failed installer-failed
  set -- $installer_output_size
  installer_output_size=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
  case "$installer_output_size" in
    ""|*[!0-9]*) stop failed installer-failed ;;
  esac
  [ "$installer_output_size" -gt 0 ] || stop failed installer-failed
  [ "$installer_output_size" -le 49152 ] || stop failed installer-failed
  tail -n 1 "$installer_output" |
    grep -Eq '^{"type":"(result|error)",' ||
    stop failed installer-failed
  cat -- "$installer_output" || stop failed installer-failed
  exit 0
fi
if [ "$action" = create-upload-staging ]; then
  if ! mkdir -p -- "$staging_root"; then
    stop unavailable managed-path-unavailable
  fi
  if [ -L "$goodbuddy_root" ] || [ -L "$managed_root" ] ||
     [ -L "$staging_root" ]; then
    stop unavailable managed-path-unavailable
  fi
  if ! mkdir -- "$operation_root"; then stop failed operation-conflict; fi
  operation_created=1
  if ! mkdir -p -- "$operation_root/bootstrap/agent"; then
    stop unavailable managed-path-unavailable
  fi
  available_line=$(df -Pk "$managed_root" 2>/dev/null | tail -n 1)
  set -- $available_line
  available_kb=${SHELL_FOURTH_POSITIONAL_OR_EMPTY}
  case "$available_kb" in
    ""|*[!0-9]*) stop unavailable managed-path-unavailable ;;
  esac
  required_bytes=$((expected_size * 3 + 67108864))
  available_bytes=$((available_kb * 1024))
  [ "$available_bytes" -ge "$required_bytes" ] ||
    stop unavailable insufficient-disk-space
  escaped_operation_root=$(printf %s "$operation_root" |
    sed 's/\\/\\\\/g;s/"/\\"/g') ||
    stop unavailable managed-path-unavailable
  preserve_operation=1
  printf '{"type":"result","status":"upload-staging-created","operationId":"%s","archivePath":"%s/package.gbagent","bootstrapNodePath":"%s/bootstrap/agent/node"}\n' \
    "$operation_id" "$escaped_operation_root" "$escaped_operation_root"
  exit 0
fi
run_prepare() {
  printf %s "$installer_base64" |
    "$bootstrap/agent/node" -e \
    "const fs=require(\"fs\"),crypto=require(\"crypto\");const input=fs.readFileSync(0,\"ascii\"),size=Number(process.argv[2]);if(!Number.isSafeInteger(size)||size<1||size>262144||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input))process.exit(1);const bytes=Buffer.from(input,\"base64\");if(bytes.length!==size||bytes.toString(\"base64\")!==input||crypto.createHash(\"sha256\").update(bytes).digest(\"hex\")!==process.argv[3])process.exit(1);fs.writeFileSync(process.argv[1],bytes,{flag:\"wx\",mode:0o600});" \
    "$bootstrap/package-installer.mjs" "$installer_size" \
    "$installer_sha256" ||
    stop failed installer-failed
  chmod 0600 "$bootstrap/package-installer.mjs" ||
    stop failed archive-invalid
  emit_progress preparing
  installer_output="$operation_root/installer-prepare.ndjson"
  rm -f -- "$installer_output"
  "$bootstrap/agent/node" "$bootstrap/package-installer.mjs" \
    prepare --operation-root "$operation_root" --archive "$archive" \
    --expected-sha256 "$expected_sha256" \
    >"$installer_output" 2>/dev/null || true
  installer_output_size=$(wc -c < "$installer_output" 2>/dev/null) ||
    stop failed installer-failed
  set -- $installer_output_size
  installer_output_size=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
  case "$installer_output_size" in
    ""|*[!0-9]*) stop failed installer-failed ;;
  esac
  [ "$installer_output_size" -gt 0 ] || stop failed installer-failed
  [ "$installer_output_size" -le 49152 ] || stop failed installer-failed
  tail -n 1 "$installer_output" |
    grep -Eq '^{"type":"(result|error)",' ||
    stop failed installer-failed
  preserve_operation=1
  cat -- "$installer_output" || stop failed installer-failed
  exit 0
}
if [ "$action" = prepare-uploaded ]; then
  archive="$operation_root/package.gbagent"
  bootstrap="$operation_root/bootstrap"
  if [ ! -d "$operation_root" ] || [ -L "$operation_root" ] ||
     [ ! -d "$bootstrap" ] || [ -L "$bootstrap" ] ||
     [ ! -d "$bootstrap/agent" ] || [ -L "$bootstrap/agent" ] ||
     [ ! -f "$archive" ] || [ -L "$archive" ]; then
    stop failed operation-unavailable
  fi
  actual_size=$(wc -c < "$archive" 2>/dev/null) ||
    stop failed size-mismatch
  set -- $actual_size
  actual_size=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
  [ "$actual_size" = "$expected_size" ] || stop failed size-mismatch
  if [ ! -f "$bootstrap/agent/node" ] ||
     [ -L "$bootstrap/agent/node" ] ||
     [ ! -x "$bootstrap/agent/node" ]; then
    stop failed archive-invalid
  fi
  node_size=$(wc -c < "$bootstrap/agent/node" 2>/dev/null) ||
    stop failed archive-invalid
  set -- $node_size
  node_size=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
  case "$node_size" in ""|*[!0-9]*) stop failed archive-invalid ;; esac
  [ "$node_size" -gt 0 ] || stop failed archive-invalid
  run_prepare
fi
command -v curl >/dev/null 2>&1 || stop unavailable missing-curl
command -v sha256sum >/dev/null 2>&1 || stop unavailable missing-sha256sum
command -v unzip >/dev/null 2>&1 || stop unavailable missing-unzip
printf test | sha256sum >/dev/null 2>&1 || stop unavailable missing-sha256sum
unzip -v >/dev/null 2>&1 || stop unavailable missing-unzip
if ! mkdir -p -- "$staging_root"; then stop unavailable managed-path-unavailable; fi
if [ -L "$goodbuddy_root" ] || [ -L "$managed_root" ] ||
   [ -L "$staging_root" ]; then
  stop unavailable managed-path-unavailable
fi
if ! mkdir -- "$operation_root"; then stop failed operation-conflict; fi
operation_created=1
available_line=$(df -Pk "$managed_root" 2>/dev/null | tail -n 1)
set -- $available_line
available_kb=${SHELL_FOURTH_POSITIONAL_OR_EMPTY}
case "$available_kb" in ""|*[!0-9]*) stop unavailable managed-path-unavailable ;; esac
required_bytes=$((expected_size * 3 + 67108864))
available_bytes=$((available_kb * 1024))
[ "$available_bytes" -ge "$required_bytes" ] ||
  stop unavailable insufficient-disk-space
header_file="$operation_root/headers"
response_file="$operation_root/response"
get_url() {
  case "$1" in 1) printf %s "$url1" ;; 2) printf %s "$url2" ;;
    3) printf %s "$url3" ;; 4) printf %s "$url4" ;; esac
}
request_chain() {
  mode=$1
  index=1
  while [ "$index" -le "$url_count" ]; do
    current_url=$(get_url "$index")
    rm -f -- "$header_file" "$response_file"
    if [ "$index" -lt "$url_count" ]; then
      request_timeout=20
    elif [ "$mode" = probe ]; then
      request_timeout=30
    else
      request_timeout=480
    fi
    if [ "$index" -lt "$url_count" ] || [ "$mode" = probe ]; then
      curl_status=$(curl --silent --show-error \
        --max-redirs 0 --proto "=https" --proto-redir "=https" \
        --connect-timeout 10 --max-time "$request_timeout" \
        --range 0-0 --max-filesize 1024 \
        --output "$response_file" --dump-header "$header_file" \
        --write-out "%{http_code}" --url "$current_url" 2>/dev/null) ||
        return 10
    else
      curl_status=$(curl --silent --show-error \
        --max-redirs 0 --proto "=https" --proto-redir "=https" \
        --connect-timeout 15 --max-time "$request_timeout" \
        --max-filesize "$expected_size" \
        --output "$response_file" --dump-header "$header_file" \
        --write-out "%{http_code}" --url "$current_url" 2>/dev/null) ||
        return 10
    fi
    if [ "$index" -lt "$url_count" ]; then
      case "$curl_status" in 301|302|303|307|308) ;; *) return 11 ;; esac
      location_count=$(grep -ic "^location:" "$header_file" 2>/dev/null || true)
      [ "$location_count" = 1 ] || return 11
      location=$(grep -i "^location:" "$header_file" | tail -n 1 |
        cut -d: -f2- | sed "s/^ *//;s/\r$//")
      next_index=$((index + 1))
      [ "$location" = "$(get_url "$next_index")" ] || return 11
    else
      case "$curl_status" in 200|206) ;; *) return 10 ;; esac
    fi
    index=$((index + 1))
  done
  return 0
}
if [ "$action" = probe ]; then
  request_chain probe
  request_result=$?
  case "$request_result" in
    0) stop available "" ;;
    11) stop unavailable download-unavailable ;;
    *) stop unavailable download-unavailable ;;
  esac
fi
emit_progress downloading
request_chain download
request_result=$?
case "$request_result" in
  0) ;;
  11) stop failed redirect-mismatch ;;
  *) stop failed download-failed ;;
esac
archive="$operation_root/package.gbagent"
mv -- "$response_file" "$archive" || stop failed download-failed
actual_size=$(wc -c < "$archive" 2>/dev/null) || stop failed size-mismatch
set -- $actual_size
actual_size=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
[ "$actual_size" = "$expected_size" ] || stop failed size-mismatch
emit_progress verifying
actual_sha256=$(sha256sum "$archive" 2>/dev/null) || stop failed sha256-mismatch
set -- $actual_sha256
actual_sha256=${SHELL_FIRST_POSITIONAL_OR_EMPTY}
[ "$actual_sha256" = "$expected_sha256" ] || stop failed sha256-mismatch
node_count=$(unzip -Z1 "$archive" 2>/dev/null | grep -cx "agent/node" || true)
[ "$node_count" = 1 ] || stop failed archive-invalid
emit_progress extracting
bootstrap="$operation_root/bootstrap"
mkdir -p -- "$bootstrap/agent" || stop failed archive-invalid
unzip -p "$archive" agent/node > "$bootstrap/agent/node" ||
  stop failed archive-invalid
chmod 0755 "$bootstrap/agent/node" || stop failed archive-invalid
run_prepare
`;

function createAbortError(signal?: AbortSignal): unknown {
  return (
    signal?.reason ??
    new DOMException("The operation was aborted", "AbortError")
  );
}

function validateOperationId(operationId: string): string {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Agent 远程安装 operation ID 无效");
  }
  return operationId;
}

function validateCandidate(
  candidate: SshRemotePackageCandidate,
  requireUrls = false,
): SshRemotePackageCandidate {
  validateOperationId(candidate.operationId);
  if (
    !Number.isSafeInteger(candidate.size) ||
    candidate.size <= 0 ||
    candidate.size > MAX_PACKAGE_BYTES
  ) {
    throw new Error("Agent 远程安装包大小无效");
  }
  if (!SHA256_PATTERN.test(candidate.sha256)) {
    throw new Error("Agent 远程安装包 SHA-256 无效");
  }
  if (
    (requireUrls && candidate.urls.length === 0) ||
    candidate.urls.length > MAX_REDIRECTS + 1
  ) {
    throw new Error("Agent 远程安装下载链无效");
  }
  const seen = new Set<string>();
  for (const value of candidate.urls) {
    if (
      Buffer.byteLength(value, "utf8") > MAX_URL_BYTES ||
      /[\p{Cc}\p{Cs}\s\u2028\u2029\ufffd]/u.test(value)
    ) {
      throw new Error("Agent 远程安装下载地址无效");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Agent 远程安装下载地址无效");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.href !== value ||
      !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname) ||
      seen.has(value)
    ) {
      throw new Error("Agent 远程安装下载地址不受信任");
    }
    seen.add(value);
  }
  return candidate;
}

function serializeRequest(
  action: BootstrapAction,
  operationId: string,
  candidate?: SshRemotePackageCandidate,
  includeUrls = true,
  installer?: ControlPlaneInstaller,
): Buffer {
  validateOperationId(operationId);
  if (candidate) {
    validateCandidate(candidate, includeUrls);
  }
  const urls = candidate && includeUrls ? candidate.urls : [];
  const lines = [
    "GOODBUDDY_REMOTE_PACKAGE_BOOTSTRAP_V1",
    action,
    operationId,
    String(candidate?.size ?? 0),
    candidate?.sha256 ?? "0".repeat(64),
    String(installer?.size ?? 0),
    installer?.sha256 ?? "0".repeat(64),
    installer?.base64 ?? "",
    String(urls.length),
    ...urls,
  ];
  const payload = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  if (payload.byteLength > MAX_INPUT_BYTES) {
    throw new Error("Agent 远程安装输入超过安全限制");
  }
  return payload;
}

function buildBootstrapProgram(payload: Buffer): Buffer {
  const delimiter = Buffer.from(BOOTSTRAP_INPUT_DELIMITER, "ascii");
  if (payload.includes(delimiter)) {
    throw new Error("Agent 远程安装输入包含保留分隔符");
  }
  return Buffer.concat([
    Buffer.from(`exec 3<<'${BOOTSTRAP_INPUT_DELIMITER}'\n`, "ascii"),
    payload,
    Buffer.from(`${BOOTSTRAP_INPUT_DELIMITER}\n`, "ascii"),
    Buffer.from(SSH_REMOTE_PACKAGE_BOOTSTRAP_SCRIPT, "utf8"),
  ]);
}

type ControlPlaneInstaller = {
  size: number;
  sha256: string;
  base64: string;
};

function validateControlPlaneInstaller(
  value: Buffer | string,
): ControlPlaneInstaller {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) {
    throw new Error("Agent 远程控制面安装器无效");
  }
  const bytes =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_CONTROL_PLANE_INSTALLER_BYTES
  ) {
    throw new Error("Agent 远程控制面安装器大小无效");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new Error("Agent 远程控制面安装器编码无效");
  }
  if (typeof value === "string" && decoded !== value) {
    throw new Error("Agent 远程控制面安装器编码无效");
  }
  return {
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseProtocol(value: unknown): SshRemotePackageProtocol | undefined {
  const protocol = asRecord(value);
  if (
    !protocol ||
    !hasExactKeys(protocol, ["major", "minor"]) ||
    !Number.isSafeInteger(protocol.major) ||
    !Number.isSafeInteger(protocol.minor) ||
    Number(protocol.major) < 0 ||
    Number(protocol.major) > MAX_PROTOCOL_COMPONENT ||
    Number(protocol.minor) < 0 ||
    Number(protocol.minor) > MAX_PROTOCOL_COMPONENT
  ) {
    return undefined;
  }
  return {
    major: Number(protocol.major),
    minor: Number(protocol.minor),
  };
}

function isVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_VERSION_LENGTH &&
    VERSION_PATTERN.test(value)
  );
}

function parsePackageIdentity(
  message: Record<string, unknown>,
  action: "prepare" | "commit",
  candidate: SshRemotePackageCandidate,
): TerminalMessage | undefined {
  const expectedStatus = action === "prepare" ? "prepared" : "committed";
  if (
    !hasExactKeys(message, [
      "type",
      "command",
      "status",
      "archiveSha256",
      "agent",
      "runtime",
    ]) ||
    message.type !== "result" ||
    message.command !== action ||
    message.status !== expectedStatus ||
    message.archiveSha256 !== candidate.sha256
  ) {
    return undefined;
  }
  const agent = asRecord(message.agent);
  const runtime = asRecord(message.runtime);
  if (
    !agent ||
    !runtime ||
    !hasExactKeys(agent, [
      "installationId",
      "agentVersion",
      "manifestSha256",
      "binaryDigest",
      "platform",
      "architecture",
      "protocol",
      "supervisor",
    ]) ||
    !hasExactKeys(runtime, [
      "runtimeId",
      "runtimeVersion",
      "bundleDigest",
      "manifestDigest",
      "runtimeAdapterDigest",
      "acpCapabilitiesDigest",
      "platform",
      "architecture",
      "protocol",
    ])
  ) {
    return undefined;
  }
  const agentProtocol = parseProtocol(agent.protocol);
  const runtimeProtocol = parseProtocol(runtime.protocol);
  const architecture = agent.architecture;
  if (
    typeof agent.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(agent.manifestSha256) ||
    agent.installationId !== `agent-${agent.manifestSha256}` ||
    agent.binaryDigest !== `sha256:${agent.manifestSha256}` ||
    !isVersion(agent.agentVersion) ||
    agent.platform !== "linux" ||
    (architecture !== "x64" && architecture !== "arm64") ||
    !agentProtocol ||
    agent.supervisor !== "detached-on-demand" ||
    runtime.runtimeId !== "opencode" ||
    !isVersion(runtime.runtimeVersion) ||
    typeof runtime.bundleDigest !== "string" ||
    !DIGEST_PATTERN.test(runtime.bundleDigest) ||
    typeof runtime.manifestDigest !== "string" ||
    !DIGEST_PATTERN.test(runtime.manifestDigest) ||
    typeof runtime.runtimeAdapterDigest !== "string" ||
    !DIGEST_PATTERN.test(runtime.runtimeAdapterDigest) ||
    typeof runtime.acpCapabilitiesDigest !== "string" ||
    !DIGEST_PATTERN.test(runtime.acpCapabilitiesDigest) ||
    runtime.platform !== "linux" ||
    runtime.architecture !== architecture ||
    !runtimeProtocol
  ) {
    return undefined;
  }
  return {
    type: "result",
    command: action,
    status: expectedStatus,
    archiveSha256: candidate.sha256,
    agent: {
      installationId: agent.installationId,
      agentVersion: agent.agentVersion,
      manifestSha256: agent.manifestSha256,
      binaryDigest: agent.binaryDigest,
      platform: "linux",
      architecture,
      protocol: agentProtocol,
      supervisor: "detached-on-demand",
    },
    runtime: {
      runtimeId: "opencode",
      runtimeVersion: runtime.runtimeVersion,
      bundleDigest: runtime.bundleDigest,
      manifestDigest: runtime.manifestDigest,
      runtimeAdapterDigest: runtime.runtimeAdapterDigest,
      acpCapabilitiesDigest: runtime.acpCapabilitiesDigest,
      platform: "linux",
      architecture,
      protocol: runtimeProtocol,
    },
  };
}

function parseUploadStagingResult(
  message: Record<string, unknown>,
  candidate: SshRemotePackageCandidate,
): TerminalMessage | undefined {
  if (
    !hasExactKeys(message, [
      "type",
      "status",
      "operationId",
      "archivePath",
      "bootstrapNodePath",
    ]) ||
    message.type !== "result" ||
    message.status !== "upload-staging-created" ||
    message.operationId !== candidate.operationId ||
    typeof message.archivePath !== "string" ||
    typeof message.bootstrapNodePath !== "string" ||
    Buffer.byteLength(message.archivePath, "utf8") > MAX_REMOTE_PATH_BYTES ||
    Buffer.byteLength(message.bootstrapNodePath, "utf8") > MAX_REMOTE_PATH_BYTES
  ) {
    return undefined;
  }
  const suffix = `/.goodbuddy/agent/staging/op-${candidate.operationId}`;
  const operationRoot = message.archivePath.endsWith(
    `${suffix}/package.gbagent`,
  )
    ? message.archivePath.slice(0, -"/package.gbagent".length)
    : undefined;
  if (
    !operationRoot ||
    !operationRoot.startsWith("/") ||
    message.bootstrapNodePath !== `${operationRoot}/bootstrap/agent/node`
  ) {
    return undefined;
  }
  return {
    type: "result",
    status: "upload-staging-created",
    operationId: candidate.operationId,
    archivePath: message.archivePath,
    bootstrapNodePath: message.bootstrapNodePath,
  };
}

function parseMessage(
  line: string,
  action: BootstrapAction,
  candidate?: SshRemotePackageCandidate,
): {
  progress?: SshRemotePackageBootstrapProgress;
  terminal?: TerminalMessage;
} {
  const packageAction =
    action === "prepare-status" || action === "prepare-uploaded"
      ? "prepare"
      : action === "commit-status"
        ? "commit"
        : action;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Agent 远程安装返回了无效结果");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Agent 远程安装返回了无效结果");
  }
  const message = value as Record<string, unknown>;
  if (
    (packageAction === "prepare" || packageAction === "commit") &&
    message.type === "error" &&
    message.command === packageAction &&
    (message.status === "failed" ||
      message.status === "rollback-incomplete") &&
    typeof message.message === "string" &&
    message.message.length > 0 &&
    message.message.length <= 2_000 &&
    !/[\r\n\0]/u.test(message.message) &&
    hasExactKeys(message, [
      "type",
      "command",
      "status",
      "message",
    ])
  ) {
    return {
      terminal: {
        type: "result",
        status: "failed",
        reason:
          message.status === "rollback-incomplete"
            ? "installer-rollback-incomplete"
            : "installer-failed",
        detail: message.message,
      },
    };
  }
  if (action === "create-upload-staging" && candidate) {
    const uploadStaging = parseUploadStagingResult(message, candidate);
    if (uploadStaging) {
      return { terminal: uploadStaging };
    }
  }
  if (
    message.type === "progress" &&
    typeof message.phase === "string" &&
    (progressPhases as readonly string[]).includes(message.phase) &&
    (hasExactKeys(message, ["type", "phase"]) ||
      ((packageAction === "prepare" || packageAction === "commit") &&
        message.command === packageAction &&
        hasExactKeys(message, ["type", "command", "phase"])))
  ) {
    return {
      progress: {
        phase: message.phase as SshRemotePackageBootstrapProgress["phase"],
      },
    };
  }
  if (
    (packageAction === "prepare" || packageAction === "commit") &&
    candidate
  ) {
    const packageIdentity = parsePackageIdentity(
      message,
      packageAction,
      candidate,
    );
    if (packageIdentity) {
      return { terminal: packageIdentity };
    }
  }
  if (message.type !== "result" || typeof message.status !== "string") {
    throw new Error("Agent 远程安装返回了无效结果");
  }
  if (
    (message.status === "available" || message.status === "cleaned") &&
    hasExactKeys(message, ["type", "status"])
  ) {
    return { terminal: message as TerminalMessage };
  }
  if (
    message.status === "unavailable" &&
    typeof message.reason === "string" &&
    (unavailableReasons as readonly string[]).includes(message.reason) &&
    hasExactKeys(message, ["type", "status", "reason"])
  ) {
    return { terminal: message as TerminalMessage };
  }
  if (
    message.status === "failed" &&
    typeof message.reason === "string" &&
    (failureReasons as readonly string[]).includes(message.reason) &&
    hasExactKeys(message, ["type", "status", "reason"])
  ) {
    return { terminal: message as TerminalMessage };
  }
  throw new Error("Agent 远程安装返回了无效结果");
}

async function runBootstrapCommand(
  openChannel: OpenBootstrapChannel,
  action: BootstrapAction,
  payload: Buffer,
  timeoutMs: number,
  options: SshRemotePackageBootstrapOptions = {},
  candidate?: SshRemotePackageCandidate,
): Promise<TerminalMessage> {
  const { signal, onProgress } = options;
  const channel = await openChannel(signal);
  if (signal?.aborted) {
    channel.destroy();
    throw createAbortError(signal);
  }
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let outputBytes = 0;
    let messages = 0;
    let terminal: TerminalMessage | undefined;
    let settled = false;
    let commandStarted = false;
    const actionLabel =
      action === "probe"
        ? "能力检查"
        : action === "create-upload-staging"
          ? "创建上传暂存区"
          : action === "prepare" ||
              action === "prepare-uploaded" ||
              action === "prepare-status"
            ? "准备"
            : action === "commit" || action === "commit-status"
              ? "提交"
              : "清理";

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      channel.destroy();
      reject(error);
    };
    const indeterminate = (): SshRemotePackageCommitIndeterminateError =>
      new SshRemotePackageCommitIndeterminateError();
    const failCommand = (
      error: unknown,
      prepareResultMayExist = false,
    ): void => {
      fail(
        action === "commit" && commandStarted
          ? indeterminate()
          : (action === "prepare" || action === "prepare-uploaded") &&
              commandStarted &&
              prepareResultMayExist
            ? new SshRemotePackagePrepareResultLostError(error)
            : error,
      );
    };
    const abort = (): void => {
      fail(
        action === "commit" && commandStarted
          ? indeterminate()
          : createAbortError(signal),
      );
    };
    const timeout = setTimeout(() => {
      failCommand(
        new Error("Agent 远程安装操作超时"),
        (action === "prepare" || action === "prepare-uploaded") &&
          commandStarted,
      );
    }, timeoutMs);
    timeout.unref?.();

    const acceptLine = (lineBytes: Buffer): void => {
      if (
        lineBytes.byteLength === 0 ||
        lineBytes.byteLength > MAX_LINE_BYTES ||
        lineBytes.includes(0x0d)
      ) {
        throw new Error("Agent 远程安装返回了无效结果");
      }
      messages += 1;
      if (messages > MAX_MESSAGES || terminal) {
        throw new Error("Agent 远程安装返回了过多结果");
      }
      const parsed = parseMessage(
        new TextDecoder("utf-8", { fatal: true }).decode(lineBytes),
        action,
        candidate,
      );
      if (parsed.progress) {
        onProgress?.(parsed.progress);
      } else {
        terminal = parsed.terminal;
      }
    };
    const collect = (chunk: Buffer | string): void => {
      try {
        const bytes = Buffer.from(chunk);
        outputBytes += bytes.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          throw new Error("Agent 远程安装输出超过安全限制");
        }
        pending = Buffer.concat([pending, bytes]);
        while (true) {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) {
            if (pending.byteLength > MAX_LINE_BYTES) {
              throw new Error("Agent 远程安装输出超过安全限制");
            }
            return;
          }
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          acceptLine(line);
        }
      } catch (error) {
        failCommand(error);
      }
    };

    signal?.addEventListener("abort", abort, { once: true });
    channel.on("data", collect);
    channel.stderr.on("data", (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        failCommand(new Error("Agent 远程安装输出超过安全限制"));
      }
    });
    channel.once("error", (error: Error) => {
      void error;
      failCommand(
        new Error(`Agent 远程安装${actionLabel} SSH 通道异常中断`),
        true,
      );
    });
    channel.once("close", (code: number | null) => {
      if (settled) {
        return;
      }
      if (
        pending.byteLength !== 0 ||
        typeof code !== "number" ||
        code !== 0 ||
        !terminal
      ) {
        const detail =
          typeof code === "number" && code !== 0
            ? `shell 退出状态 ${code}`
            : pending.byteLength !== 0
              ? "返回了不完整结果"
              : !terminal
                ? "通道在返回终态前关闭"
                : "命令执行失败";
        failCommand(
          new Error(
            `Agent 远程安装${actionLabel}${detail}${
              !terminal &&
              (action === "prepare" || action === "prepare-uploaded")
                ? "；尚未进入提交阶段，远端版本未切换，请重试"
                : ""
            }`,
          ),
          typeof code !== "number" ||
            (code === 0 &&
              (pending.byteLength !== 0 || !terminal)),
        );
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(terminal);
    });
    try {
      commandStarted = true;
      channel.end(buildBootstrapProgram(payload));
    } catch (error) {
      failCommand(error);
    }
  });
}

export function createSshRemotePackageBootstrapExecutor(
  openChannel: OpenBootstrapChannel,
  controlPlaneInstaller: Buffer | string,
): SshRemotePackageBootstrapExecutor {
  const installer = validateControlPlaneInstaller(controlPlaneInstaller);
  const prepareCandidate = async (
    action: "prepare" | "prepare-uploaded",
    candidate: SshRemotePackageCandidate,
    options: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapPrepareResult> => {
    const verified = validateCandidate(
      candidate,
      action === "prepare",
    );
    let result: TerminalMessage;
    try {
      result = await runBootstrapCommand(
        openChannel,
        action,
        serializeRequest(
          action,
          verified.operationId,
          verified,
          action === "prepare",
          installer,
        ),
        PREPARE_TIMEOUT_MS,
        options,
        verified,
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw createAbortError(options.signal);
      }
      if (!(error instanceof SshRemotePackagePrepareResultLostError)) {
        throw error;
      }
      try {
        result = await runBootstrapCommand(
          openChannel,
          "prepare-status",
          serializeRequest(
            "prepare-status",
            verified.operationId,
            verified,
            false,
          ),
          STATUS_TIMEOUT_MS,
          options,
          verified,
        );
      } catch {
        if (options.signal?.aborted) {
          throw createAbortError(options.signal);
        }
        throw error.originalError;
      }
      if (result.status !== "prepared") {
        throw error.originalError;
      }
    }
    if (result.status === "prepared") {
      return {
        prepared: true,
        operationId: verified.operationId,
        identity: {
          archiveSha256: result.archiveSha256,
          agent: result.agent,
          runtime: result.runtime,
        },
      };
    }
    if (result.status === "unavailable") {
      return {
        prepared: false,
        unavailable: true,
        reason: result.reason,
      };
    }
    if (result.status === "failed") {
      return {
        prepared: false,
        unavailable: false,
        reason: result.reason,
        ...(result.detail === undefined
          ? {}
          : { detail: result.detail }),
      };
    }
    throw new Error("Agent 远程安装准备返回了无效结果");
  };
  const readCommitStatus = async (
    candidate: SshRemotePackageCandidate,
    options: SshRemotePackageBootstrapOptions,
  ): Promise<SshRemotePackageBootstrapCommitResult> => {
    const verified = validateCandidate(candidate);
    const result = await runBootstrapCommand(
      openChannel,
      "commit-status",
      serializeRequest("commit-status", verified.operationId, verified, false),
      STATUS_TIMEOUT_MS,
      options,
      verified,
    );
    if (result.status === "committed") {
      return {
        committed: true,
        operationId: verified.operationId,
        identity: {
          archiveSha256: result.archiveSha256,
          agent: result.agent,
          runtime: result.runtime,
        },
      };
    }
    if (result.status === "failed") {
      return {
        committed: false,
        reason: result.reason,
        ...(result.detail === undefined
          ? {}
          : { detail: result.detail }),
      };
    }
    throw new Error("Agent 远程安装提交状态返回了无效结果");
  };
  return {
    async probe(candidate, options = {}) {
      const verified = validateCandidate(candidate, true);
      const result = await runBootstrapCommand(
        openChannel,
        "probe",
        serializeRequest("probe", verified.operationId, verified),
        PROBE_TIMEOUT_MS,
        options,
      );
      if (result.status === "available") {
        return { available: true };
      }
      if (result.status === "unavailable") {
        return { available: false, reason: result.reason };
      }
      throw new Error("Agent 远程安装探针返回了无效结果");
    },
    async createUploadStaging(candidate, options = {}) {
      const verified = validateCandidate(candidate);
      const result = await runBootstrapCommand(
        openChannel,
        "create-upload-staging",
        serializeRequest(
          "create-upload-staging",
          verified.operationId,
          verified,
          false,
        ),
        PROBE_TIMEOUT_MS,
        options,
        verified,
      );
      if (result.status === "upload-staging-created") {
        return {
          created: true,
          operationId: verified.operationId,
          archivePath: result.archivePath,
          bootstrapNodePath: result.bootstrapNodePath,
        };
      }
      if (result.status === "unavailable") {
        return {
          created: false,
          unavailable: true,
          reason: result.reason,
        };
      }
      if (result.status === "failed") {
        return {
          created: false,
          unavailable: false,
          reason: result.reason,
        };
      }
      throw new Error("Agent 远程安装上传暂存返回了无效结果");
    },
    prepare(candidate, options = {}) {
      return prepareCandidate("prepare", candidate, options);
    },
    prepareUploaded(candidate, options = {}) {
      return prepareCandidate("prepare-uploaded", candidate, options);
    },
    async commit(candidate, options = {}) {
      const verified = validateCandidate(candidate);
      let result: TerminalMessage;
      try {
        result = await runBootstrapCommand(
          openChannel,
          "commit",
          serializeRequest("commit", verified.operationId, verified, false),
          COMMIT_TIMEOUT_MS,
          options,
          verified,
        );
      } catch (error) {
        if (
          !(error instanceof SshRemotePackageCommitIndeterminateError) ||
          options.signal?.aborted
        ) {
          throw error;
        }
        try {
          const status = await readCommitStatus(verified, options);
          if (status.committed) {
            return status;
          }
        } catch {
          // The commit remains indeterminate when its persisted result
          // cannot be read and validated exactly.
        }
        throw error;
      }
      if (result.status === "committed") {
        return {
          committed: true,
          operationId: verified.operationId,
          identity: {
            archiveSha256: result.archiveSha256,
            agent: result.agent,
            runtime: result.runtime,
          },
        };
      }
      if (result.status === "failed") {
        return {
          committed: false,
          reason: result.reason,
          ...(result.detail === undefined
            ? {}
            : { detail: result.detail }),
        };
      }
      throw new Error("Agent 远程安装提交返回了无效结果");
    },
    commitStatus(candidate, options = {}) {
      return readCommitStatus(candidate, options);
    },
    async cleanup(operationId, options = {}) {
      const verifiedOperationId = validateOperationId(operationId);
      const result = await runBootstrapCommand(
        openChannel,
        "cleanup",
        serializeRequest("cleanup", verifiedOperationId),
        CLEANUP_TIMEOUT_MS,
        options,
      );
      if (result.status === "cleaned") {
        return { cleaned: true, operationId: verifiedOperationId };
      }
      if (
        result.status === "failed" &&
        (result.reason === "operation-unavailable" ||
          result.reason === "cleanup-failed")
      ) {
        return { cleaned: false, reason: result.reason };
      }
      throw new Error("Agent 远程安装清理返回了无效结果");
    },
  };
}
