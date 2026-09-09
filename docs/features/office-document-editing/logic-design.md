# Office 协同编辑功能逻辑设计

## 1. 核心不变量

1. 一个文档页签只绑定一个 `DocumentEditSession`，不会随当前项目或会话切换目标。
2. 源文件路径和替换权限只由 Desktop Main 持有。
3. ShareServer 是服务端工作副本和保存检查点的权威，Desktop 是源文件回写结果的权威。
4. ONLYOFFICE 报告已保存不等于源文件已经回写成功。
5. 没有稳定保存检查点时，任何界面都不能显示“修改可恢复”。
6. 源文件基准版本不匹配时禁止静默覆盖。
7. 一次 AI 请求要么作为一个编辑事务完整应用，要么不产生修改。

## 2. 状态维度

编辑会话不是一个布尔状态，至少包含以下独立维度：

```ts
type DocumentEditState = {
  connection: 'connecting' | 'online' | 'offline' | 'expired'
  editor: 'loading' | 'ready' | 'failed'
  checkpoint: 'clean' | 'dirty' | 'saving' | 'available' | 'failed' | 'unknown'
  source: 'unchanged' | 'writing' | 'saved' | 'conflict' | 'unavailable'
  access: 'edit' | 'read-only' | 'revoked'
}
```

`checkpoint=available` 只表示 ShareServer 有可下载版本；只有 `source=saved` 才表示本机或远程
源文件已经更新。

## 3. 打开流程

```text
用户选择文件
-> Desktop 验证来源、格式、大小和 ShareServer 连接
-> Desktop 冻结源文件 identity、大小和 SHA-256
-> ShareServer 创建空编辑会话并返回一次性上传授权
-> Desktop 流式上传工作副本并校验 SHA-256
-> ShareServer 创建 ONLYOFFICE 配置和一次性启动授权
-> Desktop 创建文档页签并加载编辑器
-> ONLYOFFICE 读取 ShareServer 工作副本
-> ready
```

任一步失败都进入确定失败状态。ShareServer 对未完成上传和未启动会话按短期限清理。

## 4. 保存流程

```text
编辑器提交保存
-> ShareServer 接收 ONLYOFFICE 回调
-> 校验会话、状态、大小、格式和内容摘要
-> 原子发布新保存检查点
-> Desktop 得到 checkpoint available 事件
-> Desktop 重新读取源文件 identity 和 SHA-256
-> 未变化：下载、复核、写临时文件、原子替换
-> 已变化：进入 conflict，不覆盖
-> Desktop 回报 source saved 或 conflict
```

相同检查点回写使用幂等键。网络超时但替换结果不确定时，Desktop 重新读取源文件摘要确认，
不能直接重复写入或声称失败。

## 5. 冲突决策

| 条件 | 结果 |
| --- | --- |
| 源文件与基准一致 | 允许原子回写 |
| 源文件不存在 | 显示来源不可用，允许另存为 |
| 源文件摘要变化 | 冲突，禁止自动覆盖 |
| 源文件只读或授权失效 | 保留检查点，允许重新授权或另存为 |
| ShareServer 检查点过期 | 不能回写，说明修改不可恢复 |

首期冲突操作只有“打开外部版本”“另存当前编辑版本”“放弃编辑版本”和经二次确认的“替换
外部版本”。不提供自动 OOXML 合并。

## 6. AI 编辑流程

1. 用户在编辑器内发起 AI 编辑，插件冻结当前文档 revision 和选区锚点。
2. 选区为空、过大、包含不支持对象或会话非编辑态时拒绝发送。
3. Desktop 将有界选区作为用户明确提供的上下文交给当前 Conversation。
4. Agent 返回受限结构化编辑操作，不返回可执行脚本。
5. 应用前再次比较文档 revision；已变化时要求用户重新选择或重新生成。
6. ONLYOFFICE 插件在一个撤销上下文中执行全部操作。
7. 任一操作失败则回滚整个事务；成功后高亮修改并使检查点变为 `dirty`。

AI 编辑继承发起请求的 Ask/Execute 模式。Ask 只生成建议，不调用编辑器写入；Execute 才能
应用结构化修改。用户在编辑器中发起操作只授权当前文档和冻结选区，不授予 Agent 其他文件或
系统能力。

## 7. 页签与关闭

- 每次打开创建新实例；相同源文件可以存在多个编辑会话，但第二个及后续实例默认只读，避免
  两个独立保存链路互相覆盖。用户关闭原编辑会话后可以将只读实例提升为编辑。
- 同名文件使用显示序号区分，序号只属于当前工作栏布局，不写入文件或服务端标题。
- 关闭 clean 页签直接结束会话。
- 关闭 dirty、saving、available、failed 或 unknown 页签必须根据可恢复事实给出对应选择。
- 应用退出复用同一判断；不能等待无限期保存。超时后保留 ShareServer 已确认检查点，并在下次
  启动显示恢复入口。

## 8. 断线与撤销

- Desktop 断线不主动销毁服务端会话；在保留期内可以使用同一会话 ID 重新认证恢复。
- ShareServer 与 ONLYOFFICE 断线时禁止新编辑，保留最后稳定检查点和明确错误阶段。
- 权限被撤销后立即停止新读取、保存和 AI 操作；已经下载到 Desktop 的本地源文件不由服务端
  删除。
- 撤销只作用于编辑器当前撤销栈。已经回写源文件后执行撤销会产生新的 dirty revision，仍需
  再次保存才能更新源文件。

## 9. 需求映射

| 逻辑 | PRD | 用户故事 |
| --- | --- | --- |
| 打开和会话创建 | FR-1、FR-2、FR-7、FR-12 | US-A1、US-A2、US-D2 |
| 检查点和源文件回写 | FR-4、FR-5 | US-B1 |
| 冲突和关闭 | FR-8、FR-10 | US-B2、US-B3 |
| AI 编辑事务与模式 | FR-6 | US-C1、US-C2 |
| 断线、撤销和保留 | FR-9、FR-11 | US-D1、US-E1 |
