---
name: product-presentation
version: 1.0.0
description: |
  生成面向特定受众的产品介绍 PPT、逐页叙事和演讲备注。用于产品发布、客户宣讲、
  售前交流或内部汇报；不负责现场产品操作步骤，操作型演示应使用 sales-demo-kit。
allowed-tools:
  - Read
  - Grep
  - Glob
  - Execute
compatibility: 生成 PPTX 需 python-pptx 1.0+
---

# 产品介绍 PPT

## 必要输入

- 已核验的产品事实、功能、参数、案例授权和适用边界。
- 受众角色、演示目标、场合、时长、页数和品牌要求。
- 可用图片、架构图、截图及其授权范围。

先写一句演示目标，例如“让技术负责人理解部署边界并同意进入 POC”，再决定页序。

## 推荐叙事

按任务选择，不机械套用全部页面：

1. 封面与本次议题。
2. 受众当前面临的具体问题。
3. 产品定位和适用范围。
4. 核心工作流或架构。
5. 关键能力，按场景组织，不按后台菜单朗读。
6. 已核验参数、兼容性或安全边界。
7. 获准公开的案例或验证结果。
8. 部署、交付和下一步。

## 页面纪律

- 一页只有一个结论，标题直接写该页内容。
- 正文优先 3 至 5 个要点，每个要点只表达一个信息。
- 数字必须带条件和来源，不使用无依据的百分比。
- 规划能力、试用能力和当前能力使用不同标识。
- 讲稿可以补充上下文，但不能引入幻灯片中没有依据的新事实。
- 不把产品介绍写成按钮操作手册，也不使用满页功能清单。

## 生成 PPTX

先探测可用的 Python 3 解释器：Windows 优先使用 `python`，macOS/Linux
优先使用 `python3`。下文 `<python>` 表示探测成功的解释器命令。

复制并填写 `templates/deck.example.json`：

```bash
<python> -m pip install -r "<skill-dir>/requirements.txt"
<python> "<skill-dir>/scripts/build_pptx.py" \
  --input ./build/deck.json \
  --output ./dist/product-presentation.pptx
```

`deck.json` 与配图是中间产物，放在 `build/`；交付物 PPTX 放在 `dist/`。复核用
PDF 和页面截图一律写入 `build/check/`，不得与 PPTX 同目录。

构建器支持封面、章节页、要点页、双栏页、指标页、图片页和收尾页。它负责稳定
排版，不负责补写内容；`deck.json` 中的文字必须先通过事实审查。

除章节页外每页必须提供非空 `notes`，否则构建失败。图片必须放在 `deck.json`
所在目录内，超过 40MB 或 8000 万像素会被拒绝；其余图片按版面尺寸和 150 DPI
重采样后嵌入，避免生成超大文件。

## 视觉复核

1. 使用 LibreOffice 或 PowerPoint 打开并导出 PDF；该 PDF 仅用于复核，交付物是
   PPTX，复核后应删除。LibreOffice 需安装 Impress 组件，仅装 Writer 时无法转换。
2. 检查文字溢出、孤行、图片拉伸、低清截图和字号过小。
3. 快速朗读全套讲稿，确认时间预算和页面转场自然。
4. 核对所有数字、版本、案例名称和产品状态与事实清单一致。

## 完成标准

PPTX 可打开；页数和时长符合简报；每页目标明确；视觉层级统一；备注完整；无
未经授权的客户信息、竞品结论或内部证据路径。
