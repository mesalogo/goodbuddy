#!/usr/bin/env python3
"""Validate the shared product evidence manifest used by marketing skills."""

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path


COLLECTIONS = (
    "features",
    "parameters",
    "claims",
    "use_cases",
    "differentiators",
    "limitations",
    "evidence",
)
REQUIRED_FIELDS = {
    "features": ("id", "name", "summary", "status"),
    "parameters": ("id", "name", "value", "conditions", "disclosure"),
    "claims": ("id", "text", "type", "status"),
    "use_cases": ("id", "name", "audience", "problem", "workflow", "outcome"),
    "differentiators": ("id", "statement", "comparison_scope"),
    "limitations": ("id", "text", "applies_to"),
    "evidence": (
        "id",
        "type",
        "title",
        "source",
        "locator",
        "verified_on",
        "owner",
        "disclosure",
    ),
}
ALLOWED = {
    "product.maturity": {"released", "beta", "planned", "deprecated"},
    "features.status": {"released", "beta", "planned", "deprecated"},
    "claims.type": {"fact", "goal", "comparison"},
    "claims.status": {"approved", "draft", "rejected"},
    "disclosure": {"public", "restricted", "internal"},
}
OUTPUT_TYPES = {
    "feature-catalog",
    "technical-spec",
    "presentation",
    "technical-proposal",
    "one-pager",
    "whitepaper",
    "tender-response",
    "sales-demo",
    "case-study",
    "competitive-positioning",
}
DISCLOSURE_RANK = {"internal": 0, "restricted": 1, "public": 2}
PLACEHOLDERS = re.compile(
    r"(?i)(?:\bTBD\b|\bTODO\b|待补充|待确认|placeholder|changeme)"
)
SECRET_QUERY = re.compile(r"(?i)(?:token|api[_-]?key|secret|password)=")


def issue(path, message):
    return {"path": path, "message": message}


def is_nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def validate_record_shape(collection, index, record, errors):
    path = f"{collection}[{index}]"
    if not isinstance(record, dict):
        errors.append(issue(path, "必须是对象"))
        return False
    for field in REQUIRED_FIELDS[collection]:
        value = record.get(field)
        if field in ("applies_to",):
            if not isinstance(value, list) or not value:
                errors.append(issue(f"{path}.{field}", "必须是非空数组"))
        elif not is_nonempty_string(value):
            errors.append(issue(f"{path}.{field}", "必须是非空字符串"))
    return True


def evidence_disclosure_map(records):
    return {
        record.get("id"): record.get("disclosure")
        for record in records["evidence"]
        if isinstance(record, dict)
    }


def validate_disclosure_chain(records, errors):
    """A record must not be more public than the evidence backing it."""
    evidence_disclosure = evidence_disclosure_map(records)
    for collection in ("parameters", "claims"):
        for index, record in enumerate(records[collection]):
            if not isinstance(record, dict):
                continue
            own = record.get("disclosure")
            if own not in DISCLOSURE_RANK:
                continue
            for ref in record.get("evidence_ids", []) or []:
                backing = evidence_disclosure.get(ref)
                if backing not in DISCLOSURE_RANK:
                    continue
                if DISCLOSURE_RANK[backing] < DISCLOSURE_RANK[own]:
                    errors.append(
                        issue(
                            f"{collection}[{index}].disclosure",
                            f"标记为 {own}，但证据 {ref} 仅为 {backing}",
                        )
                    )


def validate_channel(records, channel, errors):
    """Reject claims cleared for delivery whose evidence is too restricted."""
    target = DISCLOSURE_RANK[channel]
    evidence_disclosure = evidence_disclosure_map(records)
    for index, claim in enumerate(records["claims"]):
        if not isinstance(claim, dict) or claim.get("status") != "approved":
            continue
        if not claim.get("allowed_outputs"):
            continue
        for ref in claim.get("evidence_ids", []) or []:
            disclosure = evidence_disclosure.get(ref)
            if disclosure not in DISCLOSURE_RANK:
                continue
            if DISCLOSURE_RANK[disclosure] < target:
                errors.append(
                    issue(
                        f"claims[{index}].evidence_ids",
                        f"证据 {ref} 为 {disclosure}，不足以支撑 {channel} 渠道",
                    )
                )


def validate_manifest(data, channel=None):
    errors = []
    warnings = []
    if not isinstance(data, dict):
        return [issue("$", "根节点必须是对象")], warnings
    if data.get("schema_version") != 1:
        errors.append(issue("schema_version", "当前仅支持整数 1"))

    product = data.get("product")
    if not isinstance(product, dict):
        errors.append(issue("product", "必须是对象"))
        product = {}
    for field in ("name", "version", "category", "summary", "maturity"):
        if not is_nonempty_string(product.get(field)):
            errors.append(issue(f"product.{field}", "必须是非空字符串"))
    if product.get("maturity") not in ALLOWED["product.maturity"]:
        errors.append(
            issue(
                "product.maturity",
                f"必须是 {sorted(ALLOWED['product.maturity'])} 之一",
            )
        )

    records = {}
    all_ids = {}
    for collection in COLLECTIONS:
        values = data.get(collection, [])
        if not isinstance(values, list):
            errors.append(issue(collection, "必须是数组"))
            values = []
        records[collection] = values
        for index, record in enumerate(values):
            if not validate_record_shape(collection, index, record, errors):
                continue
            record_id = record.get("id")
            if is_nonempty_string(record_id):
                if record_id in all_ids:
                    errors.append(
                        issue(
                            f"{collection}[{index}].id",
                            f"ID 与 {all_ids[record_id]} 重复：{record_id}",
                        )
                    )
                else:
                    all_ids[record_id] = f"{collection}[{index}]"

    evidence_ids = {
        record.get("id")
        for record in records["evidence"]
        if isinstance(record, dict) and is_nonempty_string(record.get("id"))
    }
    feature_ids = {
        record.get("id")
        for record in records["features"]
        if isinstance(record, dict) and is_nonempty_string(record.get("id"))
    }
    use_case_ids = {
        record.get("id")
        for record in records["use_cases"]
        if isinstance(record, dict) and is_nonempty_string(record.get("id"))
    }

    for collection in COLLECTIONS:
        for index, record in enumerate(records[collection]):
            if not isinstance(record, dict):
                continue
            path = f"{collection}[{index}]"
            refs = record.get("evidence_ids", [])
            if refs is not None and not isinstance(refs, list):
                errors.append(issue(f"{path}.evidence_ids", "必须是数组"))
                refs = []
            for ref in refs or []:
                if ref not in evidence_ids:
                    errors.append(
                        issue(f"{path}.evidence_ids", f"引用不存在：{ref}")
                    )
            for ref in record.get("use_case_ids", []) or []:
                if ref not in use_case_ids:
                    errors.append(
                        issue(f"{path}.use_case_ids", f"引用不存在：{ref}")
                    )

    for index, limitation in enumerate(records["limitations"]):
        if not isinstance(limitation, dict):
            continue
        for ref in limitation.get("applies_to", []) or []:
            if ref not in feature_ids and ref not in all_ids:
                errors.append(
                    issue(
                        f"limitations[{index}].applies_to",
                        f"引用不存在：{ref}",
                    )
                )

    for index, feature in enumerate(records["features"]):
        if not isinstance(feature, dict):
            continue
        status = feature.get("status")
        if status not in ALLOWED["features.status"]:
            errors.append(
                issue(
                    f"features[{index}].status",
                    f"必须是 {sorted(ALLOWED['features.status'])} 之一",
                )
            )
        if status in {"released", "beta"} and not feature.get("evidence_ids"):
            warnings.append(
                issue(
                    f"features[{index}].evidence_ids",
                    "已发布或 beta 功能缺少证据",
                )
            )

    for index, parameter in enumerate(records["parameters"]):
        if not isinstance(parameter, dict):
            continue
        disclosure = parameter.get("disclosure")
        if disclosure not in ALLOWED["disclosure"]:
            errors.append(
                issue(
                    f"parameters[{index}].disclosure",
                    f"必须是 {sorted(ALLOWED['disclosure'])} 之一",
                )
            )
        if not parameter.get("evidence_ids"):
            warnings.append(
                issue(
                    f"parameters[{index}].evidence_ids",
                    "技术参数缺少证据",
                )
            )

    for index, claim in enumerate(records["claims"]):
        if not isinstance(claim, dict):
            continue
        if claim.get("type") not in ALLOWED["claims.type"]:
            errors.append(
                issue(
                    f"claims[{index}].type",
                    f"必须是 {sorted(ALLOWED['claims.type'])} 之一",
                )
            )
        if claim.get("status") not in ALLOWED["claims.status"]:
            errors.append(
                issue(
                    f"claims[{index}].status",
                    f"必须是 {sorted(ALLOWED['claims.status'])} 之一",
                )
            )
        if (
            claim.get("type") in {"fact", "comparison"}
            and claim.get("status") == "approved"
            and not claim.get("evidence_ids")
        ):
            errors.append(
                issue(
                    f"claims[{index}].evidence_ids",
                    "已批准的事实或比较主张必须有证据",
                )
            )
        outputs = claim.get("allowed_outputs", [])
        if outputs is not None and not isinstance(outputs, list):
            errors.append(
                issue(f"claims[{index}].allowed_outputs", "必须是数组")
            )
        for output in outputs or []:
            if output not in OUTPUT_TYPES:
                errors.append(
                    issue(
                        f"claims[{index}].allowed_outputs",
                        f"未知产物类型：{output}",
                    )
                )

    for index, evidence in enumerate(records["evidence"]):
        if not isinstance(evidence, dict):
            continue
        disclosure = evidence.get("disclosure")
        if disclosure not in ALLOWED["disclosure"]:
            errors.append(
                issue(
                    f"evidence[{index}].disclosure",
                    f"必须是 {sorted(ALLOWED['disclosure'])} 之一",
                )
            )
        verified_on = evidence.get("verified_on")
        if is_nonempty_string(verified_on):
            try:
                dt.date.fromisoformat(verified_on)
            except ValueError:
                errors.append(
                    issue(
                        f"evidence[{index}].verified_on",
                        "必须使用 YYYY-MM-DD",
                    )
                )
        source = evidence.get("source", "")
        if is_nonempty_string(source) and SECRET_QUERY.search(source):
            errors.append(
                issue(
                    f"evidence[{index}].source",
                    "来源中疑似包含密钥或令牌参数",
                )
            )

    for index, differentiator in enumerate(records["differentiators"]):
        if isinstance(differentiator, dict) and not differentiator.get(
            "evidence_ids"
        ):
            warnings.append(
                issue(
                    f"differentiators[{index}].evidence_ids",
                    "差异点缺少证据",
                )
            )

    validate_disclosure_chain(records, errors)
    if channel in DISCLOSURE_RANK:
        validate_channel(records, channel, errors)

    for path, value in walk_strings(data):
        if PLACEHOLDERS.search(value):
            warnings.append(issue(path, f"包含占位内容：{value[:60]}"))

    if not evidence_ids:
        warnings.append(issue("evidence", "没有任何证据记录"))
    return errors, warnings


def walk_strings(value, path="$"):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from walk_strings(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from walk_strings(item, f"{path}[{index}]")
    elif isinstance(value, str):
        yield path, value


def parse_args():
    parser = argparse.ArgumentParser(description="验证产品事实与证据清单")
    parser.add_argument("manifest", help="product-evidence.json")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="存在占位符、缺证据等警告时也失败",
    )
    parser.add_argument(
        "--channel",
        choices=sorted(DISCLOSURE_RANK),
        help="目标发布渠道，校验主张引用证据的公开级别是否足够",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    path = Path(args.manifest).expanduser().resolve()
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    errors, warnings = validate_manifest(data, channel=args.channel)
    report = {
        "file": str(path),
        "channel": args.channel,
        "valid": not errors and (not args.strict or not warnings),
        "errors": errors,
        "warnings": warnings,
        "stats": {
            collection: len(data.get(collection, []))
            if isinstance(data, dict) and isinstance(data.get(collection, []), list)
            else 0
            for collection in COLLECTIONS
        },
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for level, items in (("错误", errors), ("警告", warnings)):
            for item in items:
                print(f"[{level}] {item['path']}：{item['message']}")
        print(
            f"核验完成：错误 {len(errors)}，警告 {len(warnings)}，"
            f"状态 {'通过' if report['valid'] else '失败'}"
        )
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
