# DeepSeek Harness 实现进度

## 2026-10-22 Root Adoption of 0.2.1-rc.2

After the isolated evaluation below, the authorized migration was applied to the
actual root install. The original 23 DSH production dependencies and CLI are now
`0.2.1-rc.2`, Cordis is `4.0.5`, and the new direct production dependency
`dsh-working-directory@0.2.1-rc.2` is mounted after LocalFileSystem. Vite bundles
that service into the Host. The Host Skill test uses a real in-memory Session;
current Runtime, smoke, discovery, packaging and settings-panel version fixtures
were updated. Historical validation records retain their original versions.

Root OpenCode packages remain `1.19.3`, ACP SDK remains `0.25.1`, and pi-ai resolves
to `1.4.0`. The lockfile was compared with a snapshot taken after the OpenCode
agent's work and before DSH adoption: 567 package entries changed, all reachable
from the old or new DeepSeek dependency graph. No unrelated direct dependency,
devDependency or optional dependency changed its declared or installed version.
The DSH graph updates include provider SDKs, Sharp and nested Koffi dependencies;
this is not merely 24 top-level version substitutions.

Installation completed with
`npm.cmd install --prefer-offline --fetch-retries=0 --no-audit --no-fund`.
Two preceding attempts timed out while npm retried registry `ECONNREFUSED`.
Using cached metadata completed the install without changing registry settings.
Npm reported unapproved install scripts, including nested Koffi 3.1.1 and the
new Google SDK's no-op preinstall; no unrelated script approvals were added.
The Windows tests below exercised the installed native packages successfully.

### Actual Root Validation

Windows x64, Node 24.20.0. `TEMP` and `TMP` pointed to the task directory.

| Command or scenario | Result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run deepseek-harness goodbuddy-harness native-dsh-web-client runtime-discovery bundled-runtimes tests/build-release.test.ts tests/desktop-runtime-packaging.test.ts` | 14 files passed, 1 skipped; **181 passed, 4 skipped**, 27.94 s. The skips are 3 opt-in live-model tests and 1 marketplace-plugin test. |
| `npm.cmd run typecheck` | All node, Agent and web TypeScript projects passed. |
| `npm.cmd run build` | Typecheck, full Main/Preload/Renderer build and control-plane installer check passed. |
| `node build/run-deepseek-harness-utility-smoke.cjs` | Rebuilt Electron UtilityProcess returned `ready`. |
| Root `prepareNativeDshResources` with a task-local staging project | Copied the installed CLI graph, frontend assets and nested dependencies. Missing cached Koffi 3.1.4 archive was fetched from its lockfile URL and SHA-512 verified. Root `.runtime-resources` was not used for this probe. |
| Native Web suite with `NATIVE_DSH_TEST_CLI` pointing at that copied CLI | **7 passed, 0 skipped**, 15.93 s; actual official Web process, workspace/history, write/Skill/MCP model-bridge calls, failed-launch retry, cancellation and cleanup. This repeats the 7 Web tests in the 181-test run. |
| `node node_modules/vitest/vitest.mjs run src/renderer/src/SettingsPanel.test.tsx -t 'DeepSeek Harness'` | **1 passed**, 115 unrelated tests excluded by the name filter. |
| Built Main import inspection and `git diff --check` | No external DeepSeek package imports found; diff whitespace check passed. |
| ESLint on the 14 changed source, test and build JavaScript/TypeScript files | Passed. |

### Stored-Profile Live Request

Exactly **1 external model request**, to the stored compatible `deepseek-flash`
profile, returned HTTP 200 and exactly `DSH_UPGRADE_OK`. The current root Runtime
and utility launcher started the rebuilt Host. A task-local loopback probe
forwarded the request with the selected profile's credential in memory, removed
tools for this text-only check, limited output to 512 tokens, and rejected any
second dispatch. Settings were resolved from an isolated encrypted snapshot using
Electron safeStorage; the original settings file was byte-for-byte unchanged.
No credential or provider endpoint was written to reports or console output.

The first temporary Electron driver stalled before app readiness and made zero
provider requests; moving readiness out of top-level ESM evaluation fixed it.
The successful retry is the single request counted above. Registry fetches
inherited this environment's `NODE_TLS_REJECT_UNAUTHORIZED=0`; no strict-TLS
validation claim is made for those artifact downloads.

Whole-repository results and the OpenCode fixture fixes are recorded in
[the combined regression follow-up](../assistant-workbar/progress.md#combined-worktree-regression-follow-up).
Source lint passed after excluding generated VitePress output; the full run retains
an unrelated Obsidian temporary-directory assertion failure. This validation does
not cover installer/ASAR execution, browser-page interaction, Linux/macOS native
execution or upstream subagent flows. DSH is still local-only and no remote Agent
change or remote model call was made. Dirty supervisor, Droid and OpenCode changes
were preserved. The settings-panel file had no pre-existing edits and only its
three DSH version fixture strings changed.

Cleanup completed: no task-owned processes remained, and `temp/dsh-root-upgrade`
was removed, including encrypted settings snapshot, Electron profile, staged
native resources, archives, test spill files and scratch drivers. Root installed
dependencies and normal `out/` build output remain available for the parent task.
No commit, push or release was made.

## 2026-10-22 Candidate 0.2.1-rc.2 Evaluation

Verdict: **PASS as a viable migration with the patch below; FAIL as a version-only
upgrade.** Production DSH pins were not changed. Evaluation used an isolated
current-source snapshot and npm install under `temp/dsh-021-eval`, Windows x64,
Node 24.20.0. Root dependency files and node_modules are owned by the parallel
OpenCode upgrade task and were not edited by this evaluation.

Registry checks found `0.2.1-rc.2` for all 23 currently direct `dsh-*` dependencies
and the `dsh` CLI. None of those direct dependencies needs removal. Cordis was
pinned to `4.0.5`. The published candidate actually declares
`@earendil-works/pi-ai: ^1.1.0`, resolved here to `1.4.0`; the proposed `1.0.2`
description does not match this registry artifact. Keep the adopted lockfile's
resolved graph explicit. The evaluation retained the production ACP SDK pin
`0.25.1`; unconstrained peer installation initially selected a newer ACP SDK
and caused unrelated `plan_removed.id` type errors.

The current internal contracts remain usable: `AgentRegistry.create`, scoped
tools/Skills, Session events, assistant stream chunks, attachments, the
GoodBuddy credential provider, ACP transport, cancellation and session release.
No current integration imports the removed invariant exports. The controlled
graph does not mount subagent packages; upstream subagent session/wait changes
were not independently exercised. Native Web uses the official CLI graph and
the existing patch IDs (`llm-pi-ai`, `agent-default-model`, `sandbox-policy`,
`approval`, `ui-permission`) still work in the tested flows.

### Reachable Break and Minimal Migration

With unchanged source, the candidate produced 6 failures, 111 passes and 4 skips.
File writes did not create their output, the native tool snapshot was empty, and
Skill calls returned `Error: unknown tool "skill"`. Candidate file, shell and
Skill plugins now require `workingDirectory`; Cordis leaves these plugins
unactivated when the fixed Host graph lacks that service, despite Host readiness.

The tested production-source migration is:

```diff
--- a/src/main/deepseek-harness-host.ts
+++ b/src/main/deepseek-harness-host.ts
@@
 import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
+import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
@@
     { plugin: LocalFileSystem, config: { cwd: config.workspace } },
+    { plugin: WorkingDirectory, config: { defaultDirectory: config.workspace } },
```

Add `@deepseek-ai/dsh-working-directory: 0.2.1-rc.2` as a direct production
dependency and add it to `externalizeDepsPlugin.exclude` in
`electron.vite.config.ts`. Set the existing 23 DSH dependencies and CLI dev
dependency to `0.2.1-rc.2`, Cordis to `4.0.5`, and regenerate the root lockfile
without changing the ACP SDK pin. Update the subprocess-local `allowScripts`
version key, `bundledDeepSeekHarnessVersion`, and hard-coded smoke/fixture
versions. No removal of sandbox/approval packages was needed to obtain this
result. No change to native Web policy was needed.

The Host Skill unit test's hand-written session mock is insufficient for the
new working-directory projection (`snapshotEvents` and sequence state). Replace
its mock `session` object with the real store, as tested:

```ts
session: host.context.sessions.create(options.sessionId, {
  meta: { cwd: options.meta?.cwd ?? root }
}),
```

### Validation Evidence

All commands below ran in the isolated directory. Test environment `TEMP` and
`TMP` were redirected there after the initial run; initial tests cleaned their
own OS-temp fixtures through their existing teardown.

| Check | Result |
| --- | --- |
| `node ../../node_modules/vitest/vitest.mjs run --config vitest.config.mts` after migration | 10 files passed, 1 skipped; 117 tests passed, 4 skipped; 32.69 s |
| ACP production composition | 11 deterministic E2E tests passed, including 2/10-project shared Host file and shell execution, Skills, MCP, images, consecutive requests and error propagation |
| Candidate native Web CLI explicitly selected with `NATIVE_DSH_TEST_CLI` | 7/7 passed: workspace/history, coalesced starts, write/Skill/MCP calls through model bridge, failed-launch retry, cancellation and cleanup |
| Same Web suite pointed at `.runtime-resources/dsh-x64/node_modules/@deepseek-ai/dsh/lib/bin.js` | Passed as part of the final 117-test run |
| Additional temporary deterministic ACP/pi-ai credential test | 1 passed; exactly 1 local HTTP request used the Main-supplied key despite a conflicting environment key, retained the custom header, and returned `CANDIDATE_OK` |
| Focused current-source TypeScript | Passed for Host, Host test, Runtime, native Web client and their imported contracts |
| Focused Vite/Rollup Host bundle | Passed, 1,257 modules; existing main plugins/chunk rules, production external dependencies and isolated output; no external `@deepseek-ai` imports found |
| `node build/run-deepseek-harness-utility-smoke.cjs` | Actual Electron UtilityProcess returned `ready` with the migrated bundle |
| Existing `prepareNativeDshResources` | Copied candidate CLI graph successfully; target Sharp/Koffi artifacts used lock integrity checks |

The test config used Node environment, one worker, and selected
`src/main/**/*deepseek*.test.ts`, `src/main/**/*goodbuddy-harness*.test.ts`,
`src/main/agent/native-dsh-web-client.test.ts`, and
`src/shared/deepseek-harness-compatibility.test.ts`. The isolated install used
`npm.cmd install --ignore-scripts --no-audit --no-fund`; Windows shell execution
passed with the installed native packages. No Linux/macOS install-script or
cross-architecture execution claim is made.

The full copied node TypeScript project was not green: isolation mixed the root
MCP SDK with candidate Zod declarations in an unrelated knowledge MCP test, and
the copied perf test expected `vitest.config.ts` while the isolated config used
`.mts`. These are excluded from the focused pass, not hidden as upgrade success.
The first focused bundling driver externalized all dependencies and was rejected
as insufficient; its corrected fully bundled driver retained production native
externals before the successful utility smoke. No full application build,
installer/ASAR execution, renderer/browser interaction, marketplace live test,
or paid provider test was performed. Four opt-in tests remained skipped.

External model calls: **0**. The added credential probe used one loopback request;
existing native Web fixtures also used deterministic local responses. DSH remains
local-only: `create-runtime.ts` rejects its remote execution-space branch, and
`build/agent-bundle.cjs` has no DSH dependency. No remote code, resources, Host or
model was changed. Root adoption and final whole-application validation remain
with the parent task; the migration above is the concrete candidate handoff.

Cleanup completed: process inspection found no evaluation-owned processes, and
`temp/dsh-021-eval` was removed with its install, copied sources, native resources,
archives, fixtures and build output. Only this evidence document was changed in
the tracked worktree by this evaluation; no commit, push or release was made.

## 2026-09-26 真实模型与官方 Web 验证

本轮验证 `0.1.7-rc.2` 后台对话/工具路径与同版本官方 Web 的本地接入可行性，关联
[原生客户端方案](../assistant-workbar/runtime-native-client-proposal.md)的 FR-2、3、5，
US-2 和 P1/P2。快捷按钮与完整客户端集成本轮未实现。

环境：Windows x64，标准 Node `24.19.0`，Edge `154.0.4258.37`，官方
`@deepseek-ai/dsh@0.1.7-rc.2`，仓库 HEAD `51166136157a646530e1ad9f6a0242c1c6390e95`
加当前未提交修改。源码哈希记录在本机临时报告 `dsh-017-verify/source.json`。
供应商实际模型为当前 DS 配置中的 `deepseek-flash`，协议为 `openai-chat-completions`。

| 场景 | 实测结果 | HTTP dispatch |
| --- | --- | ---: |
| 后台 Ask | `read` 返回未出现在 prompt 中的随机校验码 | 2 |
| 同会话切 Execute | `write` 创建文件，实际内容为 `DSH_EXECUTE_OK` | 2 |
| Execute Shell | `pwsh` 执行 `Get-Content execute-marker.txt`，返回正确内容 | 2 |
| 官方 Web 页面提交 | 当前模型读工作区文件并返回另一随机校验码；刷新仍保留回答 | 3 |
| 本轮合计 | 9 次均请求 `deepseek-flash`，9 次均返回 HTTP 200 | 9 |

计数在 `AgentModelGateway` 向供应商执行 `fetch` 时记录，包含 Web 的 1 次无工具请求；
4 次用户提交实际产生 9 次供应商请求。后台 3 轮均收到 `done`、工具 `completed`
和每轮 2 个用量事件。调用经过现有 `createManagedModelBridge`、`AgentModelGateway`
和 `ModelBridgeLoopbackProxy`，由隔离 Electron profile 中的 safeStorage 解密配置副本。
供应商凭据未写入 Web 配置或报告；正式 `runtime-settings.json` 测前测后逐字节一致。
环境继承 `NODE_TLS_REJECT_UNAUTHORIZED=0`，本轮不证明严格 TLS 证书校验可用。

官方 Web 以标准 Node、独立 `DSH_HOME` 和回环随机端口启动。通过官方 patch 配置 provider
和默认模型，再调用 `workspace/create`；首次创建和已有目录复用均通过。根页面自动选中
测试工作区和当前模型，无需手动填供应商密钥。保留并通过官方“内测声明”的“继续”按钮，
真实页面输入、发送、回答、刷新及截图检查通过。配置/API 细节统一维护在方案第 6.3 节。

本轮驱动曾因缺少 `skillPackages` 默认值和临时目录动态模块解析失败退出，均为 0 次请求；
修正驱动后后台成功。首次 Web `fill` 后发送按钮未启用，没有发出 Web 模型请求；改为键盘
输入并仅重跑 Web 后成功，未重复后台调用。本轮 9 次 dispatch 逐次记录于同一 `calls.json`。

补查发现此前 `dsh-017-live/calls.json` 已有 7 次 HTTP 200 记录，其中后台 4 次、Web 3 次；
对应历史报告记录模型 `deepseek-flash`、工作区与模型选中、文件结果及配置未改。本轮保留
这些文件，未覆盖或重算为新增调用。该历史批次与本轮合计可核查 16 次，下面依赖升级阶段
“0 次”仅指升级回归本身。

定向命令使用标准 Node 执行 `node_modules/vitest/vitest.mjs run`，目标为
`src/main/agent/deepseek-harness-acp-e2e.test.ts`、
`src/main/agent/goodbuddy-harness-control-plane.test.ts` 和
`src/main/agent/deepseek-harness-runtime.test.ts`：3 个文件、52 项通过、3 项跳过，11.12 秒。
3 个环境开关 live case 未在 Vitest 中启用；上表为独立真实模型驱动结果，不把跳过项算通过。
确定性回归包含 Ask 写入拒绝和 Execute 工作区外写入，无需为验证重复调用真实模型。

本机证据位于临时 `dsh-017-verify/`：`calls.json`、`backend-result.json`、`result.json`、
`main-result.json`、`source.json` 和 `web-conversation.png`。报告保留首次 Web 驱动失败，
最终 Web 结果另见 `result.json`。桥接、worker、Web 和浏览器已关闭，进程检查未发现本轮
目录所属的残留进程；临时 profile、测试工作区和 DS home 清理后仅保留脚本及脱敏证据。
这些本机临时文件不作为仓库长期资源。

证据范围：后台运行真实 ACP/Host/控制面和供应商模型，Host 在测试进程内组合；Web 为
官方 CLI 子进程与真实浏览器页面。未重新验收 GoodBuddy Composer/Utility Process，
也未实现 Web 的 GoodBuddy Ask/Execute 适配。官方 Plan 只控制规划状态，默认
“工作区内修改”也不等同于 Execute；后续复用现有工具命令名判断，不增加权限层级、
目录限制或逐工具二次授权。Skills/MCP 承接、取消、产品生命周期及交付资源仍待验证。
未改远程源码；DS 仍不支持 SSH execution space，本轮没有远程模型调用或 Linux Host 验证。

## 2026-09-26 依赖升级至 0.1.7-rc.2

23 个直接引用的 `@deepseek-ai/dsh-*` 包统一锁定为 `0.1.7-rc.2`，Cordis
升级为上游要求的 `4.0.4`，同步更新依赖锁文件、Runtime 版本及打包测试夹具。
版本取自 npm 发布列表与 `next` 标签；查询时 `latest` 仍指向 `0.1.0-rc.6`。

控制面改为监听 `agent/assistant-stream` 的 chunk 帧，以转发文本、推理和用量；
工具结果从 message 层读取 `toolCallId` 和 `isError`。测试同步适配新版本的
Agent 配置、Shell 执行和系统消息接口。

- DS 定向回归：152 项通过、5 项跳过。
- 最终复跑 DS、Runtime discovery 和发布打包夹具：12 个文件通过、2 个跳过，
  170 项通过、5 项跳过，耗时 19 秒。
- 扩大至打包夹具和设置面板：196 项通过、5 项跳过；设置面板套件因并行
  Obsidian 修改缺少 `obsidian-tools` 模块而未能加载。
- `npm run smoke:deepseek-harness`：开发构建通过，真实 Electron Utility Host 返回 `ready`。
- 升级后的首次类型检查与 lint 通过；后续类型检查受到并行 Obsidian 修改中的
  模块缺失、项目文件列表和类型错误阻塞，不能将当前整个工作区标为检查通过。
- 全量测试两次运行分别在 200 秒、600 秒超时，期间出现 App、SupervisorActivity
  和 Electron UI 测试失败；未取得全量通过结果，未修改这些并行工作的文件。

本次依赖升级回归的真实供应商模型调用为 0 次；后续真实模型及 Web 实测见上节。上述升级验证不包含官方 Web 应用，
“打开DSH Web”入口仍按[原生客户端方案](../assistant-workbar/runtime-native-client-proposal.md)实施。
远程启动契约和资源打包仅支持 Continue、OpenCode，`create-runtime.ts` 拒绝 SSH
执行空间使用 DS，因此本次升级未改变远程 Runtime 路径，也未进行 Linux Host 验证。

## 2026-09-14 Windows 工作区路径修复

本机 Runtime 的 Host 启动与 `newSession.cwd` 已共用初始化时解析的 `realpath`，
规则见[技术设计](./technical-design.md#52-受控组合不启动用户-profile)。修复此前
`C:/...\workspace` 写法触发 ACP `-32602`，以及随后换成同目录规范写法仍复用
错误 Runtime 的问题。Host 严格比较与 execution-space 缓存规则保持原样。

新增 Windows 真目录回归，连接真实 ACP、Host 和控制面，分别用混合分隔符及规范
路径创建会话，断言共用同一 Runtime、只启动一次 Host、两次均完成。该自动化回归
使用内存模型；外部真实模型验证单独由完整 App 完成。

Windows 完整 App 使用当前源码构建的 Main、Preload、Renderer 和新建隔离配置。
正式配置只读，模型凭据由隔离配置中的 safeStorage 解密；真实 composer 输入请求，
由 `deepseek-v4-flash` 在 Ask 模式读取 `summary-probe.txt`，校验码未放入 prompt。

| 目录写法 | Composer 提交 | 真实模型 HTTP dispatch | 文件读取 | 结果 |
| --- | ---: | ---: | ---: | --- |
| Windows 混合分隔符 | 1 | 2 | 1 | 仅返回文件中校验码，任务完成 |
| 同目录规范路径 | 1 | 2 | 1 | 仅返回文件中校验码，任务完成 |
| 合计 | 2 | 4 | 2 | 两条会话均通过 |

两轮 dispatch 来自同一 DS Utility Host 进程，切换目录写法未新增 Host；ACP 会话
ID 不同。两条工具卡片均显示路径摘要，原生点击展开后可查看输入与输出；重载
Renderer 并重新选择项目后，已保存会话的摘要、详情和完成状态仍通过检查。四张
局部截图已逐张打开审阅。驱动曾返回不可克隆的监听器函数，以及在重载后默认项目
等待工具卡片超时；修正定位后通过，这两次驱动错误没有增加模型请求。

本机临时 `ds-windows-path-live/report.json`、`dispatch.jsonl` 与 `source.json`
记录结果、逐请求计数和构建哈希，原 `runtime-summary-live` 报告未覆盖。
本次 App 正常退出，退出前记录的 5 个所属进程均已停止；隔离 profile、数据库、
工作区、临时构建和私有日志已清理。正式模型配置与启动前逐字节一致，报告和截图
保留在本机临时目录，不作为长期可用的仓库资源。
测试沿用生产 HTTPS 与证书处理，未单独验证严格证书校验或 Main 重启。

专项 7 个测试文件通过，91 项通过、3 项跳过。`npm run typecheck` 与
`npm run lint` 通过。最初两个假时钟测试因异步目录解析尚未结束就推进启动时钟而
超时；调整为等待 launcher 启动后，DS Runtime 的 34 项测试全部通过。
最终全量 `vitest run`（`npm test` 的脚本入口）为 353 个文件通过、9 个跳过，
4155 项通过、66 项跳过、0 失败，耗时 602.00 秒。`git diff --check` 通过。

远端核查：Main 的 SSH 分支创建托管远程 Runtime，最终使用 `AcpRemoteRuntime`；
`create-runtime.ts` 的本机 DS 入口拒绝 SSH execution space。本次未改远端代码，
未调用远端模型，也未进行 Linux Host 实测。
