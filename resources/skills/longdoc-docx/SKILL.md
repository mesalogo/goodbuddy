---
name: longdoc-docx
version: 1.0.0
description: |
  将多章节 Markdown 构建为排版规范的 Word 长文，并通过临时 PDF 核验排版。用于
  投标方案、技术方案、白皮书、验收报告等包含封面、目录、表格、图片、代码块和
  分页规则的中文正式文档。不要用于只需简单复制文本的短文档。
allowed-tools:
  - Read
  - Grep
  - Glob
  - Execute
compatibility: Python 3.9+；DOCX 构建需 requirements.txt，PDF 核验需 LibreOffice Writer
---

# Markdown 长文转 Word

以 Markdown 和图表生成脚本为唯一信源。不要手工修改生成的 DOCX/PDF，修订应回到
源文件后重新构建，避免正文、图表、编号和交叉引用失去同步。

`<skill-dir>` 指本 `SKILL.md` 所在目录，不要假定技能安装在固定路径。

## 首次准备

先探测可用的 Python 3 解释器：Windows 优先使用 `python`，macOS/Linux
优先使用 `python3`。下文 `<python>` 表示探测成功的解释器命令。

```bash
<python> -m pip install -r "<skill-dir>/requirements.txt"
cp "<skill-dir>/templates/document.example.json" ./document.json
```

编辑 `document.json`，至少填写：

- `title`、`subtitle`、`author`、`date`
- `output`，生成的 DOCX 路径
- `chapters`，按最终顺序显式列出 Markdown 文件
- 每章的 `page_break_before`，只在真正的一级章节前设为 `true`

不得依赖目录排序自动拼接正文。大纲、README、评审记录等内部文件不要加入
`chapters`。

## 目录约定

交付物与核验中间产物必须分处不同目录，避免整目录拷贝时把中间产物一并发出：

```text
build/                 # 草稿与中间产物，可随时重建
  document.json        # 构建配置
  chapters/            # 正文章节，按 01- 02- 前缀命名
    01-overview.md
    02-design.md
  assets/              # 图片与图表脚本产出的 PNG
  drafts/              # 大纲、评审记录、废弃稿，永不进入 chapters
  check/               # 核验用 PDF、verification.json、页面 PNG
dist/                  # 交付物，只存放 DOCX
  document.docx
```

`output` 指向 `dist/`；PDF、`--json`、`--render-dir` 一律指向 `build/check/`。
目录名可随项目调整，但交付物目录内不得出现 PDF、PNG 和核验报告。

分章节时另有三条约束：

- 图片路径相对**引用它的 Markdown 文件**解析，不是相对 `document.json`。章节在
  `chapters/` 而图片在 `assets/` 时，需回退一级再进入 assets 目录。
- 章节文件名前缀只用于人工排序，构建顺序完全由 `chapters` 数组决定。改动章节
  顺序必须改数组，重命名文件不会生效。
- `drafts/` 与 `chapters/` 必须分开存放。混在一起时，评审记录和废弃稿极易被
  误加入 `chapters`，且无法通过目视区分。

## 标准工作流

### 1. 核对源文件

1. 固定标题层级和编号体系，再开始合并。
2. 检查 Markdown 图片路径都相对当前 Markdown 文件所在目录可解析。
3. 搜索残留 ASCII 流程图和重复代码块，已有正式图片时删除旧占位图。
4. 关键设计变化后同步修改图表生成脚本。
5. 逐条比对 `chapters` 数组与 `chapters/` 内的实际文件：数组遗漏会静默少章，
   多余路径会直接构建失败。章节数和顺序都要与目录核对一次。

如需脚本化绘制中文架构图，可导入 `diagram_kit.py`；先检查字体：

```bash
<python> "<skill-dir>/diagram_kit.py" --check-font
```

### 2. 构建 DOCX

```bash
<python> "<skill-dir>/scripts/build_docx.py" --config ./document.json
```

构建器支持标题、普通段落、粗体/斜体/行内代码、嵌套列表、表格、图片、图注、
围栏代码块、引用块、封面、目录域和页脚页码。表格按各列内容长度分配宽度，避免
长文本列过窄导致页数异常增长。

目录由 Word 域生成。首次在 Microsoft Word 或 LibreOffice Writer 中打开后需更新
目录域，未更新时看到提示文字属于正常情况。

### 3. 转换 PDF（仅用于核验）

PDF 是校验中间件，不是交付物。交付物为 DOCX；PDF 只用于第 4、5 步的乱码、
空白页和视觉复核，核验通过后应删除，除非用户明确要求交付 PDF。

```bash
soffice --headless --convert-to pdf --outdir ./build/check ./dist/document.docx
```

如果目标路径中已有同名 PDF，先确认它是可重建产物，再由 Agent 按当前工具安全
规则处理。不要覆盖用户手工维护的文件。

### 4. 程序化核验

```bash
<python> "<skill-dir>/scripts/verify_pdf.py" ./build/check/document.pdf \
  --forbid "我方" "我们" \
  --json ./build/check/verification.json \
  --render-dir ./build/check/pages
```

核验器检查页数、乱码替换符、禁用词和疑似空白页，并可按 300 DPI 渲染逐页 PNG。
程序化文本抽取不能证明视觉排版正确，跨页表格尤其可能出现抽取顺序异常。

### 5. 人工门禁

- 逐页检查标题孤行、表格跨页、图片清晰度、图注和异常留白。
- 可疑文字必须查看 300 DPI 页面图，必要时裁剪放大，不能依据缩略图判断错字。
- 核对标题编号、图号、表号、交叉引用和正文设计是否一致。
- 检查事实边界、责任主体和前后逻辑，关键词清零不代表内容正确。
- 如安装了 `deai-writing` 技能，在 Markdown 源文件上完成扫描和定向改写后，
  重新走完整构建链路。

## 完成标准

只有以下条件全部满足才可交付：

1. DOCX 可打开，标题、表格、图片和代码块数量符合源文件。
2. 核验用 PDF 转换成功，无非预期空白页和 `\ufffd` 乱码。
3. 禁用词与项目质量门禁通过。
4. 300 DPI 视觉复核通过，图文、编号和交叉引用一致。
5. 所有修改已回写 Markdown 或图表脚本，生成产物可重复构建。
6. 交付目录只有 DOCX，核验 PDF、报告和页面 PNG 都在中间产物目录内。

## 文件构成

```text
longdoc-docx/
  SKILL.md
  requirements.txt
  diagram_kit.py
  scripts/
    build_docx.py
    verify_pdf.py
  templates/
    document.example.json
    chapter.example.md
  tests/
    test_build_docx.py
    test_verify_pdf.py
```

## 验证技能

```bash
<python> -m unittest discover -s "<skill-dir>/tests" -p "test_*.py"
```
