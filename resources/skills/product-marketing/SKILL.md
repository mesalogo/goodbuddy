---
name: product-marketing
version: 1.1.0
description: |
  编排产品事实、功能列表、招标参数、产品 PPT、技术方案、一页纸、白皮书、招标响应、
  演示套件、客户案例和竞品定位。用于一次请求需要选择或组合多种产品市场产物，
  并确保它们共享同一事实版本、术语和承诺边界。
allowed-tools:
  - Read
  - Grep
  - Glob
  - Execute
compatibility: 内置九种文档工作流；事实校验和 PPT 构建需要对应独立 Skill
---

# 产品市场总编排

本技能负责需求澄清、路由、依赖、门禁和跨产物一致性。九种文档产物的方法与模板
内置在 `workflows/`；需要哪种产物才读取对应 `WORKFLOW.md`，不要一次加载全部。

## 内置工作流

| 路由标识 | 工作流文件 | 唯一职责 |
|---|---|---|
| `product-feature-catalog` | `workflows/product-feature-catalog/WORKFLOW.md` | 功能目录和版本矩阵 |
| `tender-technical-spec` | `workflows/tender-technical-spec/WORKFLOW.md` | 可采购、可验收的招标技术规格 |
| `technical-proposal` | `workflows/technical-proposal/WORKFLOW.md` | 客户或投标技术方案 |
| `product-one-pager` | `workflows/product-one-pager/WORKFLOW.md` | 一页纸产品概览和彩页文案 |
| `solution-whitepaper` | `workflows/solution-whitepaper/WORKFLOW.md` | 原理、架构、证据和边界白皮书 |
| `tender-response-matrix` | `workflows/tender-response-matrix/WORKFLOW.md` | 招标要求逐条响应、缺口和偏离 |
| `sales-demo-kit` | `workflows/sales-demo-kit/WORKFLOW.md` | 可执行演示套件、回退和演练材料 |
| `customer-case-study` | `workflows/customer-case-study/WORKFLOW.md` | 经授权且可复核的客户案例 |
| `competitive-positioning` | `workflows/competitive-positioning/WORKFLOW.md` | 有来源的竞品矩阵和定位 |

`product-evidence` 负责冻结产品事实、状态、证据和限制；`product-presentation`
负责产品 PPT 与讲稿构建。两者保留为独立 Skill，使用前必须确认已启用。
`deai-writing` 和 `longdoc-docx` 也是独立的质量与导出 Skill，不承担产品事实判断。

## 第一步：形成任务简报

必须确认：

- 产品和版本。
- 目标受众、决策目标和发布渠道。
- 需要的产物、格式、篇幅、语言和截止时间。
- 公开级别、客户信息和竞品信息的使用权限。
- 原始事实材料、招标文件、客户需求和品牌资产。
- 最终审批人。

信息不足时把缺口写入计划，不默认补齐。

## 第二步：生成路由计划

复制 `templates/route-plan.example.json`，只选择完成请求所需节点：

先探测可用的 Python 3 解释器：Windows 优先使用 `python`，macOS/Linux
优先使用 `python3`。下文 `<python>` 表示探测成功的解释器命令。

```bash
<python> "<skill-dir>/scripts/validate_route_plan.py" ./route-plan.json
```

所有产物必须直接或间接依赖唯一的 `product-evidence` 节点。路由计划 v1 继续用
`skill` 字段记录工作流或独立 Skill 标识，避免破坏已有计划。缺少或未启用
`product-evidence`、`product-presentation` 时明确报告，不允许静默生成替代物。

`depends_on` 表示硬依赖：被依赖节点未 `completed` 时，本节点不能进入 `running`
或 `completed`。可选输入（例如尚无授权的客户案例）不要写进 `depends_on`，而是
在 `reason` 中说明“可用则引用，不可用则不提及”。

## 推荐路由

### 投标响应（我方应标）

```text
product-evidence
  → tender-response-matrix（提取要求与缺口）
  → technical-proposal
  → tender-response-matrix（回填方案章节和证明材料）
```

### 招标文件编制（采购方）

```text
product-evidence → product-feature-catalog → tender-technical-spec
```

`tender-technical-spec` 面向采购参数编写，不参与我方符合性判定，两条路由不要
混用。

### 客户方案

```text
product-evidence
  → product-feature-catalog
  → technical-proposal
  → [product-presentation, product-one-pager]
```

PPT 和一页纸从已批准方案摘要派生，避免重新解释范围。

### 产品发布与销售

```text
product-evidence
  → product-feature-catalog
  → [competitive-positioning, customer-case-study]
  → product-one-pager
  → product-presentation
  → sales-demo-kit
```

客户案例没有授权时把该节点标记 `skipped` 且 `required` 为 false，其他节点可
继续，但不得引用该案例。

### 白皮书

```text
product-evidence → product-feature-catalog → solution-whitepaper
```

## 第三步：执行门禁

每个节点开始前检查依赖是否通过；失败节点的下游必须阻断，不能标记成功。执行
过程中更新 `status`，交付前用 final 阶段复核：

```bash
<python> "<skill-dir>/scripts/validate_route_plan.py" ./route-plan.json \
  --phase final --output-root .
```

final 阶段要求必需节点全部 `completed`、依赖链无未完成节点，并核验每个声明产物
文件存在且非空。

门禁分两类：

- `evidence-validation`、`cross-artifact-consistency` 由本套件自行判定，必须
  `passed`，不能豁免。
- `confidentiality-review`、`human-approval` 取决于组织流程。需要评审时记为
  `passed`；组织不要求时记为 `waived` 并在 `waiver` 写明责任人与理由，校验通过
  但会输出警告，保留豁免记录。

最终统一核对：

- 产品名称、版本、功能状态和术语一致。
- 相同参数的数值、单位、条件和统计口径一致。
- `planned`、`beta`、`released` 没有跨产物变形。
- 客户案例、Logo、引语和竞品结论权限一致。
- 技术方案、PPT、一页纸和演示套件使用相同架构与工作流。
- 所有对外主张可追溯到同一版 `product-evidence.json`。
- 不含密钥、私有地址、内部证据路径和未批准承诺。

## 第四步：质量与导出

中文叙事产物可调用 `deai-writing`；长文可调用 `longdoc-docx`；PPT 使用
`product-presentation` 自带构建器。质量工具只能修正表达和排版，不能更改事实、
成熟度、参数或授权边界。

### 交付物形态

Markdown 与 JSON 是中间产物，不是交付物。除非用户另有指定，交付物为：

| 产物 | 交付格式 |
| --- | --- |
| 文档类（技术方案、白皮书、功能列表、响应矩阵、招标规格、一页纸、演示套件、竞争定位） | DOCX |
| 产品 PPT | PPTX |

PDF 只作为排版核验中间件，核验后删除，不放入交付目录；用户明确要求时才交付。

### 目录与密级

中间产物与交付物必须分离，交付目录按各产物自身声明的密级分区：

```text
build/          # 事实清单、路由计划、Markdown、构建配置
  check/        # 核验用 PDF、核验报告、页面 PNG
deliverables/
  public/       # 可公开
  restricted/   # 受控客户交流与投标
  internal/     # 仅内部
```

各工作流的 `output` 一律指向 `deliverables/<密级>/`，核验产物一律写入
`build/check/`。交付目录内只允许出现 DOCX 与 PPTX。

单文件产物直接放 `build/<产物名>.md`。技术方案、白皮书等需要分章节的长文，改用
`build/<产物名>/` 子目录，内部按 `longdoc-docx` 的 `chapters/`、`assets/`、
`drafts/` 分层，避免多个长文的章节文件在 `build/` 根目录互相混淆。

密级以产物自身标注为准，不得由编排者主观下调。分区后须扫描公开级产物，确认
未夹带受控结论、内部路径与凭据。

路由计划节点的 `outputs` 必须声明真实交付物路径，Markdown 与 JSON 记入
`intermediates`。若 `outputs` 指向中间产物，交付门禁将只校验中间产物而放行缺失
的真实交付物。

## 完成标准

路由计划通过校验；所有必需节点完成；无失败依赖被忽略；各产物共享同一事实版本；
跨产物一致性、保密审查和人工审批全部通过，并保留选择、跳过和阻断理由；交付目录
中每个产物都以约定格式实际存在，且已按密级分区。
