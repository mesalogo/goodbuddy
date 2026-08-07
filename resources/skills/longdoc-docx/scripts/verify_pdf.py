#!/usr/bin/env python3
"""Verify PDF text gates, blank pages, and optionally render page previews."""

import argparse
import json
import sys
from pathlib import Path

import fitz


def parse_args():
    parser = argparse.ArgumentParser(description="核验长文 PDF 产物")
    parser.add_argument("pdf", help="待核验 PDF")
    parser.add_argument("--forbid", nargs="*", default=[], help="禁用关键词")
    parser.add_argument(
        "--allow-blank-page",
        action="append",
        type=int,
        default=[],
        help="允许为空白的页码，可重复指定",
    )
    parser.add_argument(
        "--min-text-chars",
        type=int,
        default=30,
        help="无图片页面低于该文本长度时视为疑似空白",
    )
    parser.add_argument("--json", dest="json_path", help="JSON 报告输出路径")
    parser.add_argument("--render-dir", help="逐页 PNG 输出目录")
    parser.add_argument("--dpi", type=int, default=300, help="页面渲染 DPI")
    parser.add_argument(
        "--no-fail",
        action="store_true",
        help="发现乱码、禁用词或非豁免空白页时仍返回 0",
    )
    return parser.parse_args()


def inspect_document(
    document,
    path,
    forbidden=(),
    min_text_chars=30,
    allowed_blank_pages=(),
):
    allowed = set(allowed_blank_pages)
    terms = [term for term in dict.fromkeys(forbidden) if term]
    forbidden_hits = {term: {"count": 0, "pages": []} for term in terms}
    pages = []
    replacement_characters = 0
    suspicious_blank_pages = []
    for index, page in enumerate(document):
        page_number = index + 1
        text = page.get_text().strip()
        image_count = len(page.get_images(full=True))
        pages.append(
            {
                "page": page_number,
                "text_chars": len(text),
                "images": image_count,
            }
        )
        replacement_characters += text.count("\ufffd")
        if (
            len(text) < min_text_chars
            and image_count == 0
            and page_number not in allowed
        ):
            suspicious_blank_pages.append(page_number)
        for term in terms:
            count = text.count(term)
            if count:
                forbidden_hits[term]["count"] += count
                forbidden_hits[term]["pages"].append(page_number)

    return {
        "file": str(path),
        "page_count": len(document),
        "replacement_characters": replacement_characters,
        "forbidden": {
            term: result
            for term, result in forbidden_hits.items()
            if result["count"]
        },
        "suspicious_blank_pages": suspicious_blank_pages,
        "allowed_blank_pages": sorted(allowed),
        "pages": pages,
    }


def inspect_pdf(pdf_path, forbidden=(), min_text_chars=30, allowed_blank_pages=()):
    path = Path(pdf_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"PDF 不存在：{path}")
    document = fitz.open(path)
    try:
        return inspect_document(
            document,
            path,
            forbidden=forbidden,
            min_text_chars=min_text_chars,
            allowed_blank_pages=allowed_blank_pages,
        )
    finally:
        document.close()


def render_document(document, output_dir, dpi=300):
    if dpi < 72:
        raise ValueError("dpi 不能低于 72")
    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    existing = sorted(output.glob("page-*.png"))
    if existing:
        raise FileExistsError(
            f"渲染目录已有页面图，请改用空目录：{output}"
        )
    scale = dpi / 72
    matrix = fitz.Matrix(scale, scale)
    digits = max(3, len(str(len(document))))
    rendered = []
    for index, page in enumerate(document):
        target = output / f"page-{index + 1:0{digits}d}.png"
        page.get_pixmap(matrix=matrix, alpha=False).save(target)
        rendered.append(str(target))
    return rendered


def render_pages(pdf_path, output_dir, dpi=300):
    document = fitz.open(Path(pdf_path).expanduser().resolve())
    try:
        return render_document(document, output_dir, dpi=dpi)
    finally:
        document.close()


def has_failures(report):
    return bool(
        report["replacement_characters"]
        or report["forbidden"]
        or report["suspicious_blank_pages"]
    )


def main():
    args = parse_args()
    pdf_path = Path(args.pdf).expanduser().resolve()
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF 不存在：{pdf_path}")
    json_path = (
        Path(args.json_path).expanduser().resolve()
        if args.json_path
        else None
    )
    render_dir = (
        Path(args.render_dir).expanduser().resolve()
        if args.render_dir
        else None
    )
    if json_path == pdf_path:
        raise ValueError("JSON 报告路径不能覆盖输入 PDF")
    if render_dir == pdf_path:
        raise ValueError("渲染目录不能与输入 PDF 同路径")

    document = fitz.open(pdf_path)
    try:
        report = inspect_document(
            document,
            pdf_path,
            forbidden=args.forbid,
            min_text_chars=args.min_text_chars,
            allowed_blank_pages=args.allow_blank_page,
        )
        if render_dir:
            report["rendered_pages"] = render_document(
                document,
                render_dir,
                args.dpi,
            )
    finally:
        document.close()

    output = json.dumps(report, ensure_ascii=False, indent=2)
    if json_path:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(output + "\n", encoding="utf-8")
        print(f"report: {json_path}")
    else:
        print(output)

    if has_failures(report) and not args.no_fail:
        print("PDF 核验失败：存在乱码、禁用词或疑似空白页。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
