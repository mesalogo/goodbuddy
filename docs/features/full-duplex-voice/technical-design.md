# GoodBuddy 全双工实时语音交互设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 跨功能技术与产品架构 |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-08-19 |
| 适用产品 | GoodBuddy 桌面端 |
| 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 相关基线 | [长期助手路线图](../../roadmap/long-term-assistant-roadmap.md)、[统一界面设计系统](../../../UI-DESIGN.md) |

本文定义 GoodBuddy 中类似自然通话的全双工实时语音能力，包括本地与云端语音引擎、
音频平面、会话状态、打断语义、工具审批、数据留存、失败恢复、跨平台交付和验收指标。

本文所称“支持本地与云端”是指用户可以显式配置并选择不同语音引擎，不代表系统可以在
它们之间自动切换。**GoodBuddy 不设计静默降级。**

---

## 1. 摘要与核心决策

1. 实时语音是独立的 `VoiceSession`，不把现有一次性语音听写改名后直接复用。
2. 系统支持三种显式引擎：
   - 本地模块化全双工：本地流式 ASR、所选 Agent Runtime、本地流式 TTS。
   - 本地原生全双工：一个本地端到端语音模型同时听、想和说。
   - 云端原生全双工：通过供应商 Realtime/Live API 进行双向流式音频交互。
3. 用户开始会话时冻结引擎、Provider、模型、版本、地域、数据位置、声音、能力和
   Turn Detection 配置。会话过程中不得静默替换。
4. 同一目标内允许有界重试、网络抖动恢复和语义等价的内部执行优化；任何会改变
   Provider、模型、数据位置、成本、隐私、能力、质量或可感知延迟的替代路径都必须显式。
5. 所选引擎不可用时，会话明确进入 `blocked` 或 `failed`，保留可恢复上下文，并提供
   “重试当前引擎”或“结束后选择其他引擎”。不自动切换本地/云端，不退回听写、纯文本或
   非全双工模式。
6. Renderer 负责麦克风采集、回声消除、低延迟播放和即时打断；Main 负责凭据、会话
   控制、Provider Adapter、工具权限、持久化和资源回收。
7. 音频帧不进入普通 `AgentEvent` 和聊天消息持久化通道。默认只保存最终文本、会话状态和
   有界诊断，不保存原始录音。
8. 语音不能成为新的授权通道。Ask 继续只读，Execute 的工具调用继续经过现有审批控件。

---

## 2. 背景与当前基础

GoodBuddy 当前已经具备：

- Renderer 中的麦克风入口、录音状态和取消操作。
- `getUserMedia` 的单声道采集、回声消除和噪声抑制。
- 将完整录音重采样为 16 kHz PCM 的能力。
- 基于 `sherpa-onnx` 的本地离线识别、模型下载、ZIP 迁移、选择和删除。
- Main 中受信任发送者校验、Zod IPC 输入校验、超时、取消和应用关闭回收。
- `AgentRuntime.run()` 的流式文本、工具事件、审批、取消和会话持久化。
- Renderer 中的流式聊天时间线、全局通知和可访问的输入控件。

当前链路仍是：

```text
点击麦克风
→ 最多录音 20 秒
→ 停止并一次性发送完整 PCM
→ 本地离线转写
→ 把文本插入输入框
→ 用户再次确认发送
```

该链路适合听写，但不具备：

- 连续流式识别和临时转写。
- 同时采集与播放。
- 自动轮次检测。
- 助手语音输出。
- 用户抢话和响应截断。
- 音频队列、背压和时钟同步。
- 实时语音 Provider 抽象。
- 语音会话快照和诊断。

因此实时语音必须新增会话层，而不是在现有 `SpeechTranscriptionService` 后面简单追加 TTS。

---

## 3. 目标

### 3.1 用户目标

- 用户可以像通话一样持续说话，不需要每轮点击开始和停止。
- 助手可以边生成边说，并显示与实际播放进度一致的文本。
- 用户开口时可以自然打断，助手在很短时间内停止出声并开始听取新内容。
- 用户始终知道当前使用本地还是云端、具体引擎是什么、音频或转写文本会去哪里。
- 本地或云端引擎失败时，用户能看到准确状态并决定下一步，不被系统暗中换模型。
- 语音对话继续拥有文本聊天中的项目、知识库、角色、Ask/Execute、工具审批和历史能力。

### 3.2 产品目标

- 在六个平台/架构目标上提供统一的上层会话契约。
- 先以现有 `sherpa-onnx` 和 Agent Runtime 构建可跨平台交付的本地模块化引擎。
- 允许云端 Provider 使用 WebRTC 或 WebSocket，但不把供应商协议泄漏到通用 UI。
- 允许高性能设备安装本地原生全双工模型，但按真实能力检测决定是否可选。
- 保持 Main-only 凭据、上下文隔离、沙箱、取消、超时、有界输出和关机回收。
- 为延迟、打断、回声、音频中断、Provider 错误和成本提供可诊断指标。

---

## 4. 非目标

首期不包含：

- 唤醒词、后台常驻监听或应用退出后的麦克风采集。
- 根据网络、负载、价格或“智能判断”自动选择语音引擎。
- 在一个会话内自动从云端切到本地，或从本地切到云端。
- 从原生全双工自动退到 ASR → LLM → TTS，或反向切换。
- 在实时语音失败后自动改成一次性听写、纯文本发送或系统 TTS。
- 默认保存、上传或训练用户原始音频。
- 声音克隆、未成年人声音模仿、电话呼入或多人会议。
- 使用口头“同意”替代工具审批按钮或键盘确认。
- 绕过当前 Agent Runtime 和权限边界的 Provider 直连工具、MCP 或 Connector。
- 保证所有本地原生语音模型都能在 CPU 或全部六个发布目标上运行。

---

## 5. 术语与全双工范围

| 术语 | 定义 |
| --- | --- |
| `VoiceEngineProfile` | 用户保存的语音引擎配置，包含类型、Provider、模型、地域、声音和能力 |
| `VoiceSession` | 一次从用户显式开始到结束的连续实时语音会话 |
| `VoiceTurn` | 用户输入和助手响应形成的一次可持久化对话轮次 |
| 系统级全双工 | 麦克风在助手播放期间继续采集，用户可以随时打断 |
| 原生模型全双工 | 同一个模型联合处理持续输入、轮次判断和持续语音输出 |
| 模块化全双工 | ASR、Agent Runtime 和 TTS 分离，但系统保持同时听说与可打断 |
| 临时文本 | 尚未确认的 ASR 或尚未实际播放的助手文本，不写入长期历史 |
| 已提交文本 | 用户轮次已确认，或助手对应音频已实际播放的文本 |
| Barge-in | 用户在助手说话时开口，触发立即静音、取消和上下文截断 |
| 引擎快照 | 会话开始时冻结的完整、无凭据配置及能力声明 |

“模块化”不等同于“回退”。当用户明确选择模块化本地引擎时，它就是该会话的唯一正式
执行路径。原生模型和模块化引擎之间没有隐式优先级。

---

## 6. 不静默降级产品契约

### 6.1 必须显式的变化

以下变化不得在活动会话中静默发生：

- 本地与云端之间切换。
- Provider、Endpoint、地域或账号切换。
- 模型 ID、模型版本、量化档位或语音角色切换。
- 原生全双工与模块化全双工之间切换。
- ASR、LLM 或 TTS 组件切换。
- 从音频输入改成仅文本输入，或从语音输出改成仅文本输出。
- 禁用原本声明可用的工具、知识库、角色或 Execute 能力后继续运行。
- 把原始音频改为上传，或改变云端数据地域和保留策略。
- 采用明显更慢、更低质量或成本不同的路径。

### 6.2 可自动进行的恢复

以下操作可以自动执行，但必须保持同一引擎快照：

- 同一连接内的丢包恢复、抖动缓冲和音频重排。
- 同一 Provider、模型、地域和配置的有限重连。
- 同一本地模型进程的有限重启。
- 不改变语义、隐私、成本和已声明性能级别的算子或执行 Provider 优化。

恢复在用户可感知前完成时可不打断界面；持续超过 500 ms、导致音频停顿或创建新远端
会话时，必须显示“正在重新连接当前引擎”。所有恢复都进入有界诊断记录。

### 6.3 失败后的用户决策

恢复预算耗尽后：

1. 停止采集上传和音频播放。
2. 将临时文本标记为未提交，不伪装成完整轮次。
3. 保存已提交文本和脱敏错误。
4. 显示当前失败的引擎、影响和建议。
5. 提供“重试当前引擎”和“结束语音会话”。
6. 用户结束后可以显式选择其他引擎并开始新会话。

首期不提供自动 Failover 列表。未来即使允许用户预先配置替代引擎，也必须在切换前获得
明确确认，并在会话中持续显示新的活动引擎。

### 6.4 产品级适用范围

本契约不仅适用于语音。GoodBuddy 中 Provider、模型、Runtime、数据处理位置、工作模式、
权限范围和质量档位等影响隐私、成本或能力的用户选择，都不得被静默替换。

用户明确选择名为“自动”的策略时，系统可以在该策略事先声明的范围内选择，但实际结果和
任何能力退化必须可见、可诊断，不能把空结果或不完整结果表示为正常成功。

---

## 7. 用户体验

### 7.1 入口

现有麦克风入口继续表示“语音输入/听写”，转写进入可编辑输入框，不自动发送。

实时语音使用独立的“开始语音对话”入口，避免用户误以为点击一次听写会开启持续监听。
入口只在以下条件满足时可用：

- 已选择并验证一个全双工语音引擎。
- 当前平台满足该引擎能力要求。
- 麦克风权限可申请。
- 当前 Conversation 没有冲突的活动请求。
- 当前工作模式和引擎能力兼容。

### 7.2 会话界面

活动会话显示一个持续可见的语音控制区：

- 当前状态：准备中、正在听、用户说话、正在思考、助手说话、正在打断、等待审批、
  正在重连、失败。
- 本地/云端徽标、引擎名称和数据去向。
- 实时用户转写和与播放同步的助手文本。
- 麦克风静音、结束会话和必要的设备入口。
- 输入音量与助手播放状态，但不得只用颜色表达。
- 云端会话的使用量或成本提示入口。

“结束语音会话”是活动状态下的唯一主操作。波形和头像动效遵守
`prefers-reduced-motion`，关闭动效后仍使用文字和图标表达状态。

### 7.3 打断

助手说话期间检测到用户有效语音：

1. 在 Renderer 立即对当前音频执行 20–40 ms 淡出。
2. 清空尚未播放的音频队列。
3. 向 Main 发送包含播放位置的 `interrupt`。
4. Main 取消当前 Agent/TTS 响应或向 Provider 发送截断事件。
5. 尚未播放的助手文本保持临时状态并从会话上下文中移除。
6. 输入状态切到用户说话，继续采集，不重新建立会话。

键盘点击“停止说话”与语音 Barge-in 使用相同取消和提交语义。

### 7.4 工具和审批

- Ask 模式继续在 Runtime 边界保持只读。
- Execute 模式的工具调用进入现有 Approval Broker。
- 等待审批时暂停新的助手音频，可播放一次确定性的短提示，例如“需要你确认一个操作”。
- 工具参数、风险、范围和确认操作使用现有可访问审批控件。
- 麦克风中的“同意”“确认”或相似内容只作为普通用户文本，不构成授权。
- 用户拒绝或取消后，结果作为结构化工具事件返回当前引擎，不私自换模型继续。

### 7.5 设置结构

长期设置结构使用一级“语音”分类，并以 `PageTabs` 组织：

1. **实时对话**：语音引擎列表、默认引擎、能力、数据位置、地域、声音和真实连接测试。
2. **语音输入**：现有本地 ASR 模型、一次性听写和麦克风设置。
3. **语音输出**：本地 TTS 模型、声音、语速和试听。

当前“模型连接”中的“语音输入”可在迁移阶段保留，之后移动现有模型管理组件时必须保存
已安装模型和选择，不创建第二份设置。

模型类型选择器当前已经包含四项，不增加第五个分段项来承载实时语音，以免违反
`SegmentedControl` 的 2–4 项约束。

语音引擎卡片必须持续显示：

- 本地或云端。
- Provider、模型和版本。
- 支持的语言。
- 系统级或原生模型全双工。
- 是否支持工具、图像和当前 Ask/Execute 模式。
- 所需硬件或云端地域。
- 音频和文本的数据去向。
- 安装、已验证、不可用或需要凭据状态。

实际生成能力只能通过一次真实、有界、由用户触发的会话测试确认。配置保存成功或只完成
握手不能证明麦克风输入、语音输出和打断均可工作。

---

## 8. 总体架构

```text
┌──────────────────────── Renderer ────────────────────────┐
│ VoiceSession UI                                           │
│ getUserMedia → AudioWorklet Capture → Fast VAD            │
│ AudioWorklet Playback ← Jitter/Playback Queue              │
└────────────── control IPC ─────── media MessagePort ───────┘
                              │
┌────────────────────────── Main ────────────────────────────┐
│ VoiceSessionController                                     │
│ ├─ Session snapshot and state                              │
│ ├─ Turn coordinator and interruption                      │
│ ├─ Tool/approval bridge                                    │
│ ├─ Transcript/message persistence                         │
│ ├─ Credential and provider policy                         │
│ └─ VoiceEngineAdapter                                      │
│      ├─ LocalModularAdapter                                │
│      ├─ LocalNativeDuplexAdapter                           │
│      └─ CloudRealtimeAdapter                               │
└───────────────┬──────────────────────┬─────────────────────┘
                │                      │
        Local managed sidecar     Cloud Realtime API
        or bounded worker         WebRTC / WebSocket
```

### 8.1 Renderer 音频平面

Renderer 负责需要接近音频设备的低延迟操作：

- 在用户操作后调用 `getUserMedia`。
- 请求单声道、回声消除、噪声抑制和受支持时的自动增益。
- 使用 `AudioWorklet`，不继续扩展 `ScriptProcessorNode`。
- 将音频切成 10–20 ms 有序帧，并按引擎格式重采样。
- 执行快速本地 VAD，用于 Barge-in，不独立提交最终轮次。
- 维护有界播放和抖动缓冲，记录实际播放采样位置。
- 在打断、设备变化、休眠或窗口销毁时立即静音和释放资源。

Renderer 不持有长期 API Key、不创建本地模型目录、不决定工具权限，也不持久化原始音频。

### 8.2 Preload 与 IPC

控制面使用显式、类型化的 preload 方法：

- `voice.getSnapshot()`
- `voice.startSession(input)`
- `voice.stopSession(sessionId)`
- `voice.setMuted(input)`
- `voice.interrupt(input)`
- `voice.respondApproval(...)` 继续复用现有审批接口
- `voice.onEvent(listener)`

音频帧不使用逐帧 `ipcRenderer.invoke`、JSON 或 Base64。Main 通过
`MessageChannelMain` 向可信主 Frame 传递专用 `MessagePort`，使用可转移
`ArrayBuffer` 和严格的帧头。控制事件和媒体帧分别限速、限长和验证。

### 8.3 Main 控制面

`VoiceSessionController` 负责：

- 每个窗口最多一个活动语音会话。
- 解析并冻结 `VoiceSessionSnapshot`。
- 建立所选 Adapter，不执行自动 Adapter 选择。
- 维护输入、输出和生命周期状态。
- 将 Barge-in 传播到 Provider、Agent Runtime、TTS 和播放队列。
- 桥接工具调用、审批、问题和取消。
- 只提交已经确认或实际播放的文本。
- 处理超时、重连预算、应用退出、系统休眠和窗口销毁。
- 对错误和诊断执行脱敏与边界限制。

### 8.4 本地进程边界

轻量 ONNX 能力可以运行在受控 Worker。需要 Python、CUDA、Metal/MLX 或独立依赖树的
原生模型运行在 GoodBuddy 管理的 Sidecar：

- 只绑定 loopback，不监听外部网卡。
- 使用随机端口和每次启动的短期认证值。
- 环境变量使用最小 allowlist。
- 不继承云端 Provider 密钥。
- 模型路径由 Main 从受管目录解析，不接受任意相对路径。
- 启动、健康检查、并发、输出、内存、超时和进程树有界。
- 应用退出时终止完整进程树。

Sidecar 不因本地模型启动失败而自行连接云端。

### 8.5 云端连接边界

供应商支持 WebRTC 时优先使用其媒体传输、编解码和抖动能力：

- Main 使用长期凭据创建受限、短时的会话描述或临时凭据。
- Renderer 只接收当前会话需要的短期材料。
- 工具和业务事件优先由 Main sideband 连接处理。
- Provider 不支持 sideband 时，由 Main 拥有 WebSocket，并通过媒体 `MessagePort`
  与 Renderer 交换音频。

长期凭据永不进入 Renderer、日志、诊断或会话快照。云端 Profile 必须固定可信 Endpoint、
地域和数据说明，不跟随重定向切换到未声明的主机。

---

## 9. 共享契约

建议新增 `src/shared/voice-contracts.ts`，核心结构如下：

```ts
type VoiceEngineKind =
  | 'local-modular'
  | 'local-native-duplex'
  | 'cloud-native-duplex'

type VoiceComponentRef = {
  providerId: string
  modelId: string
  modelVersion?: string
  endpoint?: string
  region?: string
  accountRef?: string
  credentialRef?: string
}

type VoiceEngineProfile = {
  id: string
  name: string
  kind: VoiceEngineKind
  locality: 'local' | 'cloud'
  voiceId: string
  components: {
    asr?: VoiceComponentRef
    tts?: VoiceComponentRef
    nativeDuplex?: VoiceComponentRef
  }
  dataPath: {
    audioDestination:
      | { kind: 'device' }
      | {
          kind: 'provider'
          providerId: string
          endpoint: string
          region?: string
        }
    transcriptDestination:
      | { kind: 'device' }
      | {
          kind: 'provider'
          providerId: string
          endpoint: string
          region?: string
        }
    retentionPolicyId?: string
  }
  capabilities: {
    nativeDuplex: boolean
    supportsTools: boolean
    supportsAsk: boolean
    supportsExecute: boolean
    inputLanguages: string[]
    outputLanguages: string[]
  }
}

type VoiceRuntimeSnapshot = {
  selection: Exclude<AgentRuntimeSelection, { provider: 'auto' }>
  profileRevision?: string
  configurationDigest: string
  workspacePath: string
}

type VoiceSessionSnapshot = {
  sessionId: string
  conversationId: string
  profile: VoiceEngineProfile
  profileRevision: string
  engineConfigurationDigest: string
  runtime?: VoiceRuntimeSnapshot
  workMode: 'ask' | 'execute'
  inputFormat: VoiceAudioFormat
  outputFormat: VoiceAudioFormat
  turnDetection: VoiceTurnDetectionConfig
  startedAt: string
}
```

`credentialRef` 和 `accountRef` 是不含凭据正文的稳定引用。Endpoint 写入 Profile 或快照前
必须规范化并删除用户名、密码、查询参数和 Fragment；供应商部署路径仍应保留，以便检测
Endpoint 是否发生变化。Profile 持久化时只引用 Main 加密设置，快照不包含长期或临时
Token。

模块化引擎分别记录 ASR 和 TTS 组件，原生引擎记录 `nativeDuplex` 组件；不能用一个
`modelId` 代表多组件链路。文本 Agent 使用独立 `VoiceRuntimeSnapshot`，记录已解析的明确
Runtime、模型 Profile 修订、配置摘要和工作区。`dataPath` 分别说明原始音频和转写文本
留在设备还是发送到哪个供应商。

### 9.1 Runtime Lease

语音会话不能在每轮请求时重新读取可变的全局 Runtime 设置。启动时必须：

1. 将 `auto` 解析为明确的 Runtime 和模型 Profile，并在会话界面显示实际结果。
2. 根据已解析配置创建或取得一个不可变的 `VoiceRuntimeLease`。
3. Lease 在整个 Voice Session 内引用同一个 Runtime 实例和配置摘要。
4. 全局设置变化只为新请求和新 Voice Session 创建 Runtime，不替换活动 Lease。
5. 用户删除或修改活动 Profile 时，界面说明“下次语音会话生效”；当前 Lease 继续运行。
6. 固定实例无法继续时，当前语音会话明确失败，不能取得新的全局 Runtime 继续。

现有 `AgentRuntimeController` 的可变 `current` Slot 会在 `replace()` 后中断活动请求，因此
不能直接作为长期 Voice Session Lease。实现前必须增加引用计数式 Pin/Lease，或由
`SelectedRuntimeManager` 为会话持有独立 Runtime Slot；会话结束后再
`releaseConversation()` 并释放 Lease。

### 9.2 事件

控制事件至少包括：

- `session-preparing`
- `session-ready`
- `session-reconnecting`
- `input-speech-started`
- `input-transcript-delta`
- `input-transcript-committed`
- `response-started`
- `response-transcript-delta`
- `response-audio-started`
- `response-interrupted`
- `response-completed`
- `approval-required`
- `tool-state`
- `usage`
- `error`
- `session-ended`

音频帧使用独立二进制协议，包含：

- `sessionId`
- `generationId`
- `sequence`
- `timestampSamples`
- `sampleRate`
- `channels`
- `encoding`
- `payload`

帧乱序、重复、跨会话或超过大小上限时直接拒绝，不尝试解释为其他格式。

---

## 10. 状态模型

全双工不能只用一个“正在听/正在说”枚举描述。会话使用三个正交状态：

```text
Lifecycle:
idle → preparing → active ↔ reconnecting → ended
                         └──────────────→ failed

Input:
muted ↔ listening ↔ speech

Output:
idle → generating → playing → interrupting → idle
```

用户可见状态由三个状态组合得出。合法示例：

- `input=listening + output=playing`：助手说话，同时继续监听。
- `input=speech + output=interrupting`：用户抢话，助手正在停止。
- `lifecycle=reconnecting + input=muted + output=idle`：当前引擎重连，停止上传。

`awaiting-approval` 是运行阻塞原因，不关闭会话；此时输入可以继续听取取消或补充文本，
但不能把口头内容解释成授权。

---

## 11. Turn、文本与播放提交

### 11.1 用户输入

- 流式 ASR Delta 只用于界面。
- Endpoint Detector 确认轮次后产生 committed transcript。
- 空白、纯噪音和低置信度片段不创建用户消息。
- 用户可在提交前通过键盘修正；修正结果而非原始猜测进入 Agent Runtime。

### 11.2 助手输出

模块化 TTS 可能落后于文本生成，因此助手文本分为：

- `generated`：模型已生成，尚未安排播放。
- `queued`：已生成音频，尚未播放。
- `played`：对应音频已从播放时钟确认输出。

助手消息需要区分“用户可见历史”和“下一轮模型上下文”：

- 所有已展示的有界文本和结构化内容都写入可见消息历史。
- 可朗读文本记录 `generated`、`queued`、`played` 边界；中断后的消息标记为
  `interrupted`，并保留用户已经看见的内容及已播放边界。
- 下一轮模型上下文只包含 `played` 可朗读文本，以及已经展示的 `visual-only` 内容。
- 尚未播放的可朗读尾部即使曾临时显示，也不回送模型，并在历史中显示“未播完”状态。

代码块、表格、URL、引用和工具结果等不适合逐字朗读的内容使用 `visual-only` Block。它们
一旦完整展示即可进入可见历史和下一轮上下文，不受语音播放边界裁切。这样既不会丢失用户
已经看到的详细成果，也不会让模型误以为用户听到了被打断的语音尾部。

云端 Provider 支持会话截断时，Main 使用实际播放位置截断远端 Conversation Item；
不支持时由 GoodBuddy 在下一轮上下文中只组装 `played` 和已展示的 `visual-only` 部分。
现有消息契约与上下文组装器需要增加对应 Block 状态，不能用删掉完整助手消息来模拟截断。

### 11.3 文本转语音规划

模块化引擎从流式文本中产生可取消的短语块：

- 优先在中文标点、英文句界和自然从句边界提交。
- 首个短语不等待完整回答，以降低首音频延迟。
- URL、Markdown 标记、代码块、表格、引用编号和工具 JSON 不逐字符朗读。
- 不能可靠口述的内容在界面展示，并使用确定性短提示说明“详细内容已显示在对话中”。
- 不调用第二个未选择的模型生成“语音摘要”。

---

## 12. 引擎设计

### 12.1 本地模块化全双工

首个跨平台本地基线复用现有 `sherpa-onnx`：

```text
AudioWorklet
→ Silero/TEN VAD
→ sherpa-onnx OnlineRecognizer
→ selected AgentRuntime
→ deterministic speech text planner
→ sherpa-onnx TTS callback
→ AudioWorklet playback
```

现有 `sherpa-onnx` Node Addon 已提供在线识别、VAD、本地 TTS 和 TTS 音频回调。当前已安装
的 SenseVoice、Paraformer 和 Whisper 目录主要用于离线识别；实时模式需要独立的在线
模型目录和能力声明，不能把离线模型误标成流式模型。

“本地模块化”只保证音频采集、ASR 和 TTS 在本机。中间 Agent Runtime 是否本地取决于
用户明确选择的模型连接：

- 连接到 loopback 本地模型时，完整链路可离线。
- 连接到云端文本模型时，原始音频留在本地，但最终转写文本和 Agent 上下文会发送到
  该模型。界面必须明确显示这一数据路径。

不得因当前文本 Runtime 不可用而替换为另一模型连接。

### 12.2 本地原生全双工

本地原生 Adapter 面向 MiniCPM-o、Moshi/PersonaPlex、BayLing-Duplex 等能够持续接收并
生成音频的模型。具体模型接入前必须逐个验证：

- 中文和目标语言质量。
- 真正的持续输入、Barge-in 和 Backchannel，而不只是流式输出。
- 首音频延迟和长期运行内存。
- Windows、macOS、Linux 及 x64/arm64 Runtime 可用性。
- NVIDIA CUDA、Apple Silicon 或 CPU 的真实硬件要求。
- 工具调用、系统指令、上下文长度和取消支持。
- 模型、声音、训练数据与商业分发许可。
- 权重下载、ZIP 迁移、校验和、磁盘占用和卸载。

本地原生模型不作为六平台默认能力。只有能力检测和一次真实会话测试通过后才允许选择。
缺少结构化工具能力的模型可以声明为 Ask-only；Execute 入口必须阻塞并说明原因，不能暗中
调用另一个文本模型补齐工具。

### 12.3 云端原生全双工

云端 Adapter 可以面向 OpenAI Realtime、Gemini Live、Qwen Realtime、Azure Voice Live
等正式配置。每个 Adapter 必须显式声明：

- WebRTC 或 WebSocket 传输。
- 输入输出音频格式。
- VAD、Semantic Turn Detection 和手动提交能力。
- 响应取消、音频截断和实际播放对齐能力。
- 输入与输出转写能力。
- 工具调用和 sideband 控制能力。
- 会话时长、上下文、速率限制和费用。
- 可用地域、数据处理与保留说明。

Provider 配置不使用泛化“OpenAI compatible”推断 Realtime 能力。普通 Chat Completions
Endpoint 不能因为 URL 相似就被标记为实时语音。

---

## 13. 音频处理

### 13.1 采集

- 浏览器设备通常以 44.1 或 48 kHz 采集，不能假定请求值就是实际值。
- 使用 `MediaStreamTrack.getSettings()` 记录实际声道、采样率和回声消除状态。
- AudioWorklet 以原始设备时钟采集，再按引擎要求转换为 16/24/48 kHz。
- 默认单声道 Float32 内部格式，边界处转换为 PCM16、Opus 或 Provider 指定格式。
- 每帧 10–20 ms，带序号和采样时间，不使用墙钟猜测播放位置。

### 13.2 回声与抢话

回声处理使用两层信号：

1. Chromium AEC/NS/AGC 处理后的麦克风流。
2. GoodBuddy 已知的播放活动、播放能量和 VAD 结果。

只有满足最短语音持续时间、能量和回声相关性条件时才触发 Barge-in。阈值必须可测试，
不能仅依赖一个 Provider 的 `speech_started` 事件。Provider 事件作为权威轮次信号之一，
本地快速 VAD 负责先静音。

### 13.3 播放与背压

- 每个响应使用独立 `generationId`，旧响应帧不得进入新队列。
- 播放队列按采样时钟排序，禁止无限积压。
- 达到高水位时对上游施加背压；无法背压的 Provider 丢弃会话并报告协议错误，不能持续
  增长内存。
- 音频缺口使用短静音或 Provider 编解码恢复，不重复上一段语音。
- 切换输出设备、设备丢失或系统休眠时暂停提交时钟，避免把未播放文本标记为已听到。

---

## 14. 数据与持久化

### 14.1 默认保存

- Voice Session ID、Conversation ID 和时间。
- 无凭据的引擎快照及其摘要哈希。
- 最终用户文本、已展示的助手消息、`visual-only` Block、实际播放边界和中断状态。
- 中断、失败、取消和完成状态。
- 有界延迟、音频中断和用量指标。
- 工具与审批事件继续进入现有任务和活动记录。

### 14.2 默认不保存

- 原始麦克风音频。
- Provider 返回但尚未播放的音频。
- 临时 ASR Delta。
- 长期或临时 API Key、Cookie、会话 Token。
- Provider 原始错误正文和可能包含用户内容的网络帧。
- 回声参考信号、设备唯一标识和完整声学特征。

未来若提供录音留存，必须是独立、默认关闭的功能，说明保存位置、期限、大小、导出和删除，
并与“改进模型”授权分离。

### 14.3 崩溃恢复

应用启动时将未结束的 Voice Session 标记为 `interrupted`。恢复文本 Conversation，
但不自动重新打开麦克风、不自动连接 Provider，也不重播未完成音频。

---

## 15. 错误、重连与资源回收

| 场景 | 行为 |
| --- | --- |
| 麦克风权限拒绝 | 阻塞启动，保留引擎选择，提供系统权限说明 |
| 输入/输出设备消失 | 立即静音或暂停，要求用户处理设备，不改用未选择设备 |
| 本地模型缺失或损坏 | 阻塞启动，进入模型管理，不连接云端 |
| 本地 Runtime 启动失败 | 在有界预算内重启同一 Runtime，之后明确失败 |
| 云端认证或地域错误 | 明确失败，保留配置，不尝试其他 Provider/地域 |
| 短暂断网 | 同一引擎有界重连，超过 500 ms 显示状态 |
| Provider 限流或余额不足 | 结束生成并显示原因，不切本地模型 |
| Agent Runtime 失败 | 终止当前轮次，允许重试同一 Runtime，不换连接 |
| TTS 失败 | 当前轮次失败，不静默改成系统 TTS 或仅文本成功 |
| 工具等待审批 | 暂停响应，保留会话；拒绝后把结果返回当前引擎 |
| 应用退出/窗口销毁 | 取消请求、停止 Track、关闭 Port/PeerConnection、终止 Sidecar |
| 系统休眠/锁屏 | 停止采集和上传；恢复后要求用户显式继续 |

每个会话必须有最大时长、最大连续无声时间、最大媒体队列、最大临时文本、最大重连次数和
最大诊断大小。取消优先于重连和重试。

---

## 16. 安全与隐私

1. 只允许可信主窗口主 Frame 创建和控制 Voice Session。
2. 麦克风权限只放行音频，不因实时语音放开视频。
3. 任何音频采集都需要用户操作；活动期间持续显示应用内状态和系统麦克风指示。
4. 云端会话在开始前显示 Provider、地域、发送内容和可能费用。
5. API Key 只在 Main 的加密设置或受控环境变量中使用。
6. 临时 Provider 凭据具有最短可行期限、最小能力和单会话作用域。
7. Provider 工具调用必须回到 Main 的白名单、Schema、Ask/Execute 和审批边界。
8. 本地 Sidecar 只监听 loopback，使用短期认证，不开放外部端口。
9. 模型权重按受信任目录、固定来源、大小和 SHA-256 校验，导入 ZIP 防止路径穿越和压缩炸弹。
10. 日志只记录状态、耗时、错误分类和匿名引擎 ID，不记录语音正文和音频。
11. 窗口隐藏时若会话仍活动，托盘必须持续显示麦克风状态和停止入口；首期可以选择隐藏即
    暂停，但不能隐藏后无提示继续采集。
12. Voice Session 不扩大项目、知识库、文件、浏览器或桌面控制范围。

---

## 17. 性能与质量指标

### 17.1 交互指标

| 指标 | 目标 |
| --- | --- |
| 用户开口到本地 VAD 检出 | P95 ≤ 100 ms |
| Barge-in 检出到扬声器静音 | P95 ≤ 150 ms |
| 播放队列常态深度 | 100–400 ms |
| 用户轮次结束到临时文本稳定 | P50 ≤ 300 ms |
| 用户轮次结束到首段助手音频 | 云端/原生引擎 P50 ≤ 800 ms；模块化引擎 P50 ≤ 1,200 ms |
| 已提交文本与实际播放偏差 | ≤ 100 ms 或一个最小短语块 |
| 连续 30 分钟会话 | 无未界定内存增长、重复播放或资源泄漏 |

本地指标必须注明测试硬件，不能把高端 GPU 结果宣传为 CPU 基线。未达到所选引擎声明的
实时系数时，能力检测应标记为不满足实时要求，而不是静默切到更小模型。

### 17.2 质量指标

- 中文普通话、英文和中英混合词的 ASR 错误率。
- 长停顿、语气词、短回答和自我修正的轮次准确率。
- 扬声器回声、键盘声、音乐和旁人说话下的误打断率。
- 真正用户抢话的漏检率和停止延迟。
- TTS 首段延迟、断句、数字、日期、英文缩写和代码术语可懂度。
- 中断后下一轮上下文不包含未播放内容。
- Provider、模型、数据位置和能力从不发生未声明变化。

---

## 18. 测试策略

### 18.1 自动化

- Voice Contract Schema、大小边界和迁移测试。
- 三组正交状态及非法状态组合测试。
- 有序、乱序、重复、迟到和跨 Session 音频帧测试。
- Barge-in 对播放、Provider、Agent、TTS 和持久化的取消传播测试。
- 临时文本、已提交文本和播放位置对齐测试。
- 同一引擎重连预算与超时测试。
- “禁止静默降级”矩阵测试：任何 Adapter、Provider、模型、地域或 Runtime 变化都必须失败。
- Ask 只读和 Execute 审批测试。
- 窗口销毁、应用退出、休眠和设备丢失的资源释放测试。
- 不持久化音频、临时 Token 和 Provider 原始正文的数据库测试。

### 18.2 模拟与声学测试

建立确定性 Fake Voice Engine，能够注入：

- 固定节奏的输入、文本和音频。
- 网络抖动、丢包、重复和断开。
- 超前文本、迟到音频和错误播放位置。
- 用户抢话、回声、短噪音和长停顿。
- 工具调用、审批、拒绝和取消。

真实声学测试使用预录双声道夹具，一路作为助手扬声器参考，一路作为用户麦克风输入。
不能只通过静态单段 WAV 验证全双工。

### 18.3 手动与外部调用

- 六个发布目标分别验证麦克风权限、采集、播放、设备拔插和应用退出。
- 本地模型在声明的最低硬件上完成 30 分钟稳定性和实时系数测试。
- 云端 Provider 测试会产生外部调用和费用，只在明确授权的 gated 测试中运行。
- 每个云端 Adapter 至少验证一次真实音频输入、真实音频输出、打断和工具审批。
- 真实测试失败时不使用配置握手成功替代生成验证。

---

## 19. 跨平台交付

### 19.1 基线

- 本地模块化引擎作为 Windows、macOS、Linux x64/arm64 的统一功能基线。
- 在线 ASR、VAD 和轻量 TTS 权重不内置，继续使用按需下载和 ZIP 离线迁移。
- GoodBuddy 托管模型的下载遵守
  [平台功能页签与模型下载源设计](../../architecture/model-download-source-design.md)，使用用户显式选择的
  ModelScope 或 Hugging Face，失败时不切换来源。
- 云端 Adapter 在六个平台复用同一契约，并分别验证 Electron WebRTC/WebSocket 行为。
- 本地原生引擎按 Adapter 声明平台与硬件，不伪装成全平台能力。

### 19.2 硬件能力等级

| 等级 | 目标 |
| --- | --- |
| CPU 基线 | 本地模块化 ASR/TTS；文本 Runtime 可以本地或云端 |
| Apple Silicon | 可增加 MLX/Metal 本地原生 Adapter，必须单独验证 |
| NVIDIA GPU | 可增加 CUDA 本地原生 Adapter，按显存和驱动验证 |
| 不满足要求 | 引擎卡片显示不可用与原因，不自动选择其他引擎 |

安装包继续保持轻量。大模型权重、CUDA Runtime 和独立 Python 环境不得无条件加入全部
发布包。

---

## 20. 分阶段实施

### 阶段 0：契约与模拟器

- 新增 Voice Contracts、状态机和 Fake Voice Engine。
- 建立禁止静默降级测试矩阵。
- 建立会话快照、事件和诊断结构。

### 阶段 1：Renderer 音频平面

- AudioWorklet 采集与播放。
- 媒体 `MessagePort`、背压和播放时钟。
- 快速 VAD、回声关联、Barge-in 和设备生命周期。
- 实时语音控制区和可访问状态。

### 阶段 2：本地模块化基线

- 在线 ASR 和 VAD 模型管理。
- Agent Runtime 流式文本桥。
- 本地 TTS 模型管理、短语规划、音频回调和取消。
- 最终文本持久化与工具审批。
- 六个平台/架构验证。

### 阶段 3：首个云端原生 Adapter

- Main-only 凭据和引擎 Profile。
- WebRTC 或 WebSocket 会话。
- 转写、音频、截断、用量和 Provider 错误。
- sideband 工具与审批。
- 真实有费用的 gated 验证。

### 阶段 4：本地原生全双工 Adapter

- 选择一个中文质量、许可和硬件要求已验证的模型。
- 建立受管 Sidecar、能力检测和真实会话测试。
- 验证原生 Barge-in、文本提交、工具能力和长期稳定性。

### 阶段 5：扩展与质量

- 增加经过验证的云端和本地 Adapter。
- 输出设备选择和企业语音策略。
- 声学基准、延迟仪表盘和成本诊断。
- 评估是否允许用户预配置仍需确认的显式替代策略。

---

## 21. 首个垂直切片

首个可合并实现应使用 Fake Voice Engine，不立即绑定某个云端 Provider：

1. 用户显式开始会话。
2. AudioWorklet 持续采集和播放模拟流。
3. Fake Engine 产生临时转写、助手文本和音频。
4. 用户开口触发 150 ms 内静音和响应取消。
5. 持久化已提交用户文本、已展示助手内容、`visual-only` Block 和实际播放边界；下一轮
   模型上下文只使用已播放文本与完整显示的 `visual-only` Block。
6. 模拟工具审批时暂停语音，拒绝口头授权。
7. 注入 Adapter 失败后明确结束，不切换任何引擎。
8. 关闭窗口后所有 Track、Port、计时器和模拟任务归零。

该切片先验证最难改变的会话、音频、提交和安全契约，再分别接入本地和云端实现。

---

## 22. 验收标准

- 用户可以明确选择本地模块化、本地原生或云端原生引擎，界面持续显示当前选择。
- 会话快照冻结 Provider、模型、地域、声音、数据位置和能力。
- 任何引擎、Provider、模型、地域、Runtime 或模式变化都不能在测试中静默发生。
- 助手播放期间继续采集麦克风，用户可在 P95 150 ms 内打断。
- 中断后未播放音频与文本不进入下一轮上下文。
- Ask 和 Execute 在语音中与文本中使用同一权限和审批边界。
- 语音口令不能批准工具。
- 云端长期凭据不进入 Renderer，本地 Sidecar 不监听外部地址。
- 默认数据库、日志和 Artifact 中没有原始音频。
- 本地引擎失败不连接云端，云端引擎失败不启动本地模型。
- 重连只针对同一引擎快照，并在可感知时显示状态。
- 六个平台目标完成各自声明能力的真实采集、播放、取消和资源回收验证。
- `npm test`、`npm run typecheck`、`npm run lint` 和生产构建全部通过。

---

## 23. 参考

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)：本地在线/离线 ASR、VAD 与 TTS。
- [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime)：云端实时音频会话与 WebRTC/WebSocket。
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)：云端双向实时音频与多模态会话。
- [Qwen Realtime](https://help.aliyun.com/zh/model-studio/realtime)：云端实时音视频输入与音频/文本输出。
- [MiniCPM-o](https://github.com/OpenBMB/MiniCPM-V)：本地端到端多模态与全双工候选。
- [Moshi](https://github.com/kyutai-labs/moshi)：本地原生全双工语音模型框架。
- [PersonaPlex](https://github.com/NVIDIA/personaplex)：本地可控角色与声音的全双工候选。
- [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)：Renderer 低延迟音频处理基础。
