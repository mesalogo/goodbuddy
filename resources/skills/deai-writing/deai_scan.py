#!/usr/bin/env python3
"""中文正式文档「AI 味」扫描器。

用法：
    python3 deai_scan.py 方案.md
    python3 deai_scan.py docs/ --ext .md .html
    python3 deai_scan.py public/index.html --rules my_site
    python3 deai_scan.py 方案.md --json          # 机器可读，供 agent 二次处理
    python3 deai_scan.py 方案.md --fail-on-block # 阻断项非零时退出码 1，可做门禁

Markdown 的代码块（``` 围栏与缩进块）和 HTML 的 <script>/<style>/<pre>/<code>
默认跳过，避免把代码里的英文关键字误判成 AI 味。用 --no-skip-code 关闭。
"""
import argparse
import ast
import bisect
import importlib.util
import json
import os
import re
import sys

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
RULES_DIR = os.path.join(SKILL_DIR, "project_rules")

LEVEL_BLOCK = "阻断"
LEVEL_REVIEW = "复核"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_project_rule_data(path):
    """Read project rules as literals without executing repository code."""
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    allowed = {"AI_SMELL", "REVIEW_ONLY", "REVIEW_LOG"}
    data = {}
    for node in tree.body:
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            continue
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id in allowed
        ):
            try:
                data[node.targets[0].id] = ast.literal_eval(node.value)
            except (ValueError, SyntaxError) as exc:
                raise ValueError(
                    f"项目词典仅允许字面量：{path}"
                ) from exc
            continue
        raise ValueError(
            f"项目词典包含不可执行的语句：{path}:{getattr(node, 'lineno', '?')}"
        )
    return data


def load_rules(project_rules=None):
    """载入通用词典，可选叠加一个项目词典（同名分类合并，不覆盖）。"""
    base = _load_module(os.path.join(SKILL_DIR, "ai_smell_dict.py"), "ai_smell_dict")
    block = {k: list(v) for k, v in base.AI_SMELL.items()}
    review = {k: list(v) for k, v in base.REVIEW_ONLY.items()}
    structure = dict(getattr(base, "STRUCTURE_CHECKS", {}))

    if project_rules:
        path = project_rules
        if not os.path.exists(path):
            path = os.path.join(RULES_DIR, f"{project_rules}.py")
        if not os.path.exists(path):
            available = [f[:-3] for f in sorted(os.listdir(RULES_DIR))
                         if f.endswith(".py") and not f.startswith("_")]
            sys.exit(f"找不到项目词典 {project_rules!r}；可用：{available or '（无）'}")
        proj = _load_project_rule_data(path)
        for cat, words in proj.get("AI_SMELL", {}).items():
            block.setdefault(cat, []).extend(words)
        for cat, words in proj.get("REVIEW_ONLY", {}).items():
            review.setdefault(cat, []).extend(words)

    return block, review, structure


def compile_rule_groups(groups):
    """Compile rule groups once so directory scans do not recompile per file."""
    compiled = []
    for category, rules in groups.items():
        for rule in rules:
            try:
                pattern = re.compile(rule, re.I | re.M | re.S)
            except re.error as exc:
                raise ValueError(
                    f"无效正则 {rule!r}（{category}）：{exc}"
                ) from exc
            compiled.append((category, rule, pattern))
    return compiled


# ---------------------------------------------------------------------------
# 代码区屏蔽：把不参与扫描的区间用空格替换，保持行号与列偏移不变
# ---------------------------------------------------------------------------

def _blank_out(text, pattern, flags=re.S | re.I):
    def repl(m):
        return re.sub(r"[^\n]", " ", m.group(0))
    return re.sub(pattern, repl, text, flags=flags)


def mask_code(text, path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".md", ".markdown"):
        text = _blank_out(text, r"```.*?```")
        text = _blank_out(text, r"~~~.*?~~~")
        text = _blank_out(text, r"(?m)^(?: {4}|\t).*$", flags=re.M)
        text = _blank_out(text, r"`[^`\n]+`", flags=0)
    elif ext in (".html", ".htm", ".xhtml"):
        for tag in ("script", "style", "pre", "code"):
            text = _blank_out(text, rf"<{tag}\b.*?</{tag}>")
        text = _blank_out(text, r"<!--.*?-->")
    return text


def strip_html_tags(text):
    """HTML 文件里把标签本身抹掉，只留可见文本，避免属性名命中词条。"""
    return _blank_out(text, r"<[^>]+>", flags=re.S)


# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------

def scan_text(
    text,
    path,
    block,
    review,
    structure,
    skip_code=True,
    compiled_block=None,
    compiled_review=None,
):
    scan_src = mask_code(text, path) if skip_code else text
    if os.path.splitext(path)[1].lower() in (".html", ".htm", ".xhtml"):
        scan_src = strip_html_tags(scan_src)

    lines = scan_src.splitlines()
    raw_lines = text.splitlines()
    line_starts = [0]
    line_starts.extend(match.end() for match in re.finditer("\n", scan_src))
    findings = []

    compiled_sets = (
        (LEVEL_BLOCK, compiled_block or compile_rule_groups(block)),
        (LEVEL_REVIEW, compiled_review or compile_rule_groups(review)),
    )
    for level, compiled in compiled_sets:
        for category, rule, pattern in compiled:
            for match in pattern.finditer(scan_src):
                line_number = bisect.bisect_right(line_starts, match.start())
                raw = (
                    raw_lines[line_number - 1]
                    if line_number <= len(raw_lines)
                    else ""
                )
                findings.append({
                    "file": path,
                    "line": line_number,
                    "level": level,
                    "category": category,
                    "rule": rule,
                    "match": match.group(0),
                    "excerpt": raw.strip()[:120],
                })

    for cat, cfg in structure.items():
        rx = re.compile(cfg["pattern"])
        for i, line in enumerate(lines, 1):
            s = line.strip()
            if not s:
                continue
            if len(rx.findall(s)) >= cfg.get("min_count", 4) and len(s) <= cfg.get("max_line_len", 60):
                findings.append({
                    "file": path,
                    "line": i,
                    "level": LEVEL_REVIEW,
                    "category": cat,
                    "rule": cfg["pattern"],
                    "match": "",
                    "excerpt": s[:120],
                })

    findings.sort(key=lambda f: (f["line"], f["level"] != LEVEL_BLOCK, f["category"]))
    return findings


def collect_files(targets, exts):
    out = []
    for t in targets:
        if os.path.isdir(t):
            for root, _dirs, files in os.walk(t):
                _dirs[:] = [d for d in _dirs if d not in
                            {".git", "node_modules", ".venv", "__pycache__", "dist", "build"}]
                for f in sorted(files):
                    if os.path.splitext(f)[1].lower() in exts:
                        out.append(os.path.join(root, f))
        elif os.path.exists(t):
            out.append(t)
        else:
            print(f"跳过不存在的路径：{t}", file=sys.stderr)
    return list(dict.fromkeys(out))


def summarize_findings(findings):
    """Count findings by level and category for CI and agent consumers."""
    counts = {LEVEL_BLOCK: {}, LEVEL_REVIEW: {}}
    for finding in findings:
        level_counts = counts[finding["level"]]
        category = finding["category"]
        level_counts[category] = level_counts.get(category, 0) + 1
    return {
        level: dict(sorted(category_counts.items()))
        for level, category_counts in counts.items()
    }


def main():
    ap = argparse.ArgumentParser(description="中文正式文档 AI 味扫描")
    ap.add_argument("targets", nargs="+", help="待扫描的文件或目录")
    ap.add_argument("--rules", help="项目词典名（project_rules/ 下的模块名）或路径")
    ap.add_argument("--ext", nargs="+", default=[".md", ".markdown", ".txt", ".html", ".htm"],
                    help="目录递归时纳入的扩展名")
    ap.add_argument("--json", action="store_true", help="输出 JSON，供 agent 二次处理")
    ap.add_argument("--block-only", action="store_true", help="只报阻断项")
    ap.add_argument("--no-skip-code", action="store_true", help="不跳过代码块")
    ap.add_argument("--fail-on-block", action="store_true", help="存在阻断项时退出码 1")
    args = ap.parse_args()

    try:
        block, review, structure = load_rules(args.rules)
        compiled_block = compile_rule_groups(block)
        compiled_review = compile_rule_groups(review)
    except ValueError as exc:
        sys.exit(str(exc))
    exts = {e if e.startswith(".") else "." + e for e in args.ext}
    files = collect_files(args.targets, exts)
    if not files:
        sys.exit("没有可扫描的文件")

    all_findings = []
    errors = []
    scanned_files = 0
    for path in files:
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except (UnicodeDecodeError, OSError) as e:
            errors.append({"file": path, "error": str(e)})
            continue
        scanned_files += 1
        all_findings.extend(
            scan_text(
                text,
                path,
                block,
                review,
                structure,
                skip_code=not args.no_skip_code,
                compiled_block=compiled_block,
                compiled_review=compiled_review,
            )
        )

    if args.block_only:
        all_findings = [f for f in all_findings if f["level"] == LEVEL_BLOCK]

    n_block = sum(1 for f in all_findings if f["level"] == LEVEL_BLOCK)
    n_review = len(all_findings) - n_block
    by_category = summarize_findings(all_findings)

    if args.json:
        print(json.dumps({
            "files": scanned_files,
            "requested_files": len(files),
            "block": n_block,
            "review": n_review,
            "by_category": by_category,
            "errors": errors,
            "findings": all_findings,
        }, ensure_ascii=False, indent=2))
    else:
        cur = None
        for f in all_findings:
            if f["file"] != cur:
                cur = f["file"]
                print(f"\n=== {cur} ===")
            hit = f"  ← {f['match']}" if f["match"] else ""
            print(f"[{f['level']}·{f['category']}] L{f['line']}: {f['excerpt']}{hit}")
        for error in errors:
            print(f"[读取失败] {error['file']}：{error['error']}", file=sys.stderr)
        print(f"\n扫描 {scanned_files}/{len(files)} 个文件：阻断项 {n_block}，人工复核项 {n_review}")
        if n_block:
            print("阻断项须改写到接近 0；复核项结合页面类型与专业语境逐条判断，不机械清零。")

    if errors:
        sys.exit(2)
    if args.fail_on_block and n_block:
        sys.exit(1)


if __name__ == "__main__":
    main()
