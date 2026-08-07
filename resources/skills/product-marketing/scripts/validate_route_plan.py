#!/usr/bin/env python3
"""Validate product-marketing orchestration route plans."""

import argparse
import json
import re
import sys
from pathlib import Path, PurePosixPath


SKILL_ARTIFACT = {
    "product-evidence": "evidence",
    "product-feature-catalog": "feature-catalog",
    "tender-technical-spec": "technical-spec",
    "product-presentation": "presentation",
    "technical-proposal": "technical-proposal",
    "product-one-pager": "one-pager",
    "solution-whitepaper": "whitepaper",
    "tender-response-matrix": "tender-response",
    "sales-demo-kit": "sales-demo",
    "customer-case-study": "case-study",
    "competitive-positioning": "competitive-positioning",
}
STATUSES = {"pending", "running", "completed", "failed", "skipped"}
GATE_STATUSES = {"pending", "passed", "failed", "waived"}
CONFIDENTIALITY = {"public", "restricted", "internal"}
# Gates this suite can evaluate itself; they must actually pass.
CORE_GATES = {"evidence-validation", "cross-artifact-consistency"}
# Gates that depend on organizational policy; they may be waived with a reason.
POLICY_GATES = {"confidentiality-review", "human-approval"}
REQUIRED_GATES = CORE_GATES | POLICY_GATES
SECRET_PATTERN = re.compile(r"(?i)(?:token|api[_-]?key|secret|password)=")


def issue(path, message):
    return {"path": path, "message": message}


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def validate_output_path(value, path, errors):
    if not nonempty(value):
        errors.append(issue(path, "必须是非空字符串"))
        return
    normalized = value.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or ".." in pure.parts:
        errors.append(issue(path, "必须是工作目录内的相对路径"))
    if SECRET_PATTERN.search(value):
        errors.append(issue(path, "路径疑似包含密钥或令牌"))


def known_dependencies(node, nodes_by_id):
    return [
        dependency
        for dependency in node.get("depends_on", [])
        if isinstance(dependency, str) and dependency in nodes_by_id
    ]


def topological_order(nodes_by_id):
    """Return (order, cycle). Kahn's algorithm keeps deep graphs iterative."""
    dependents = {node_id: [] for node_id in nodes_by_id}
    remaining = {}
    for node_id, node in nodes_by_id.items():
        dependencies = set(known_dependencies(node, nodes_by_id)) - {node_id}
        remaining[node_id] = len(dependencies)
        for dependency in dependencies:
            dependents[dependency].append(node_id)

    queue = [node_id for node_id, count in remaining.items() if count == 0]
    order = []
    while queue:
        node_id = queue.pop()
        order.append(node_id)
        for dependent in dependents[node_id]:
            remaining[dependent] -= 1
            if remaining[dependent] == 0:
                queue.append(dependent)

    if len(order) == len(nodes_by_id):
        return order, None
    return order, sorted(node_id for node_id in nodes_by_id if remaining[node_id] > 0)


def evidence_reachability(order, nodes_by_id, evidence_id):
    reaches = {}
    for node_id in order:
        dependencies = known_dependencies(nodes_by_id[node_id], nodes_by_id)
        reaches[node_id] = any(
            dependency == evidence_id or reaches.get(dependency, False)
            for dependency in dependencies
        )
    return reaches


def validate_plan(data, phase="plan", output_root=None):
    errors = []
    warnings = []
    if not isinstance(data, dict):
        return [issue("$", "根节点必须是对象")], warnings
    if data.get("schema_version") != 1:
        errors.append(issue("schema_version", "当前仅支持整数 1"))

    request = data.get("request")
    if not isinstance(request, dict):
        errors.append(issue("request", "必须是对象"))
        request = {}
    for field in ("id", "objective", "channel", "evidence_ref", "product_version"):
        if not nonempty(request.get(field)):
            errors.append(issue(f"request.{field}", "必须是非空字符串"))
    if request.get("confidentiality") not in CONFIDENTIALITY:
        errors.append(
            issue(
                "request.confidentiality",
                f"必须是 {sorted(CONFIDENTIALITY)} 之一",
            )
        )
    if nonempty(request.get("evidence_ref")):
        validate_output_path(
            request["evidence_ref"],
            "request.evidence_ref",
            errors,
        )

    nodes = data.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        errors.append(issue("nodes", "必须是非空数组"))
        return errors, warnings

    nodes_by_id = {}
    all_outputs = {}
    evidence_nodes = []
    for index, node in enumerate(nodes):
        path = f"nodes[{index}]"
        if not isinstance(node, dict):
            errors.append(issue(path, "必须是对象"))
            continue
        node_id = node.get("id")
        if not nonempty(node_id):
            errors.append(issue(f"{path}.id", "必须是非空字符串"))
            continue
        if node_id in nodes_by_id:
            errors.append(issue(f"{path}.id", f"节点 ID 重复：{node_id}"))
            continue
        nodes_by_id[node_id] = node
        skill = node.get("skill")
        if skill not in SKILL_ARTIFACT:
            errors.append(issue(f"{path}.skill", f"未知技能：{skill!r}"))
        elif node.get("artifact_type") != SKILL_ARTIFACT[skill]:
            errors.append(
                issue(
                    f"{path}.artifact_type",
                    f"{skill} 应生成 {SKILL_ARTIFACT[skill]}",
                )
            )
        if skill == "product-evidence":
            evidence_nodes.append(node_id)
        dependencies = node.get("depends_on")
        if not isinstance(dependencies, list):
            errors.append(issue(f"{path}.depends_on", "必须是数组"))
        elif len(dependencies) != len(set(dependencies)):
            errors.append(issue(f"{path}.depends_on", "存在重复依赖"))
        if not isinstance(node.get("required"), bool):
            errors.append(issue(f"{path}.required", "必须是布尔值"))
        if node.get("status") not in STATUSES:
            errors.append(
                issue(
                    f"{path}.status",
                    f"必须是 {sorted(STATUSES)} 之一",
                )
            )
        if node.get("required") is True and node.get("status") == "skipped":
            errors.append(issue(f"{path}.status", "必需节点不能标记 skipped"))
        if not nonempty(node.get("reason")):
            errors.append(issue(f"{path}.reason", "必须说明选择理由"))
        outputs = node.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            errors.append(issue(f"{path}.outputs", "必须是非空数组"))
        else:
            for output_index, output in enumerate(outputs):
                output_path = f"{path}.outputs[{output_index}]"
                validate_output_path(output, output_path, errors)
                if output in all_outputs:
                    errors.append(
                        issue(
                            output_path,
                            f"输出与 {all_outputs[output]} 重复：{output}",
                        )
                    )
                else:
                    all_outputs[output] = node_id

    for node_id, node in nodes_by_id.items():
        for dependency in node.get("depends_on", []):
            if dependency == node_id:
                errors.append(
                    issue(f"nodes.{node_id}.depends_on", "不能依赖自身")
                )
            elif dependency not in nodes_by_id:
                errors.append(
                    issue(
                        f"nodes.{node_id}.depends_on",
                        f"依赖节点不存在：{dependency}",
                    )
                )

    order, cycle = topological_order(nodes_by_id)
    if cycle:
        errors.append(issue("nodes", f"依赖存在环：{'、'.join(cycle)}"))

    if len(evidence_nodes) != 1:
        errors.append(issue("nodes", "必须且只能有一个 product-evidence 节点"))
    elif not cycle:
        evidence_id = evidence_nodes[0]
        reaches = evidence_reachability(order, nodes_by_id, evidence_id)
        for node_id in nodes_by_id:
            if node_id != evidence_id and not reaches.get(node_id, False):
                errors.append(
                    issue(
                        f"nodes.{node_id}.depends_on",
                        "所有产物必须直接或间接依赖 product-evidence",
                    )
                )

    validate_execution(nodes_by_id, errors)
    validate_gates(data.get("final_gates"), errors, warnings, phase)
    if phase == "final":
        validate_final_phase(nodes_by_id, output_root, errors)

    if len(nodes_by_id) == 1:
        warnings.append(issue("nodes", "路由计划没有任何最终产物节点"))
    return errors, warnings


def validate_execution(nodes_by_id, errors):
    for node_id, node in nodes_by_id.items():
        status = node.get("status")
        if status not in ("running", "completed"):
            continue
        for dependency in known_dependencies(node, nodes_by_id):
            dependency_node = nodes_by_id[dependency]
            dependency_status = dependency_node.get("status")
            if dependency_status == "completed":
                continue
            if (
                dependency_status == "skipped"
                and dependency_node.get("required") is False
            ):
                continue
            errors.append(
                issue(
                    f"nodes.{node_id}.status",
                    f"依赖 {dependency} 状态为 {dependency_status}，"
                    f"不能标记 {status}",
                )
            )


def validate_gates(gates, errors, warnings, phase):
    if not isinstance(gates, list):
        errors.append(issue("final_gates", "必须是数组"))
        return {}
    resolved = {}
    for index, gate in enumerate(gates):
        path = f"final_gates[{index}]"
        if isinstance(gate, str):
            if not nonempty(gate):
                errors.append(issue(path, "门禁名称不能为空"))
                continue
            resolved[gate] = {"status": None, "waiver": None}
        elif isinstance(gate, dict):
            name = gate.get("name")
            if not nonempty(name):
                errors.append(issue(f"{path}.name", "门禁名称不能为空"))
                continue
            status = gate.get("status")
            if status not in GATE_STATUSES:
                errors.append(
                    issue(
                        f"{path}.status",
                        f"必须是 {sorted(GATE_STATUSES)} 之一",
                    )
                )
                continue
            waiver = gate.get("waiver")
            if status == "waived":
                if name not in POLICY_GATES:
                    errors.append(
                        issue(
                            f"{path}.status",
                            f"{name} 由本套件自行判定，不能豁免",
                        )
                    )
                    continue
                if not nonempty(waiver):
                    errors.append(
                        issue(f"{path}.waiver", "豁免必须写明责任人与理由")
                    )
                    continue
            resolved[name] = {"status": status, "waiver": waiver}
        else:
            errors.append(issue(path, "必须是字符串或对象"))
    missing = REQUIRED_GATES - set(resolved)
    if missing:
        errors.append(issue("final_gates", f"缺少门禁：{sorted(missing)}"))
    if phase == "final":
        for name in sorted(REQUIRED_GATES & set(resolved)):
            status = resolved[name]["status"]
            if status == "passed":
                continue
            if status == "waived":
                warnings.append(
                    issue(
                        "final_gates",
                        f"{name} 已豁免：{resolved[name]['waiver']}",
                    )
                )
                continue
            errors.append(
                issue(
                    "final_gates",
                    f"交付前门禁 {name} 必须记录 passed，当前为 "
                    f"{status or '未记录'}",
                )
            )
    return resolved


def validate_final_phase(nodes_by_id, output_root, errors):
    for node_id, node in nodes_by_id.items():
        status = node.get("status")
        if node.get("required") is True and status != "completed":
            errors.append(
                issue(
                    f"nodes.{node_id}.status",
                    f"交付前必需节点必须 completed，当前为 {status}",
                )
            )
        elif status not in ("completed", "skipped"):
            errors.append(
                issue(
                    f"nodes.{node_id}.status",
                    f"交付前可选节点必须 completed 或 skipped，当前为 {status}",
                )
            )
        if status != "completed" or output_root is None:
            continue
        outputs = node.get("outputs")
        if not isinstance(outputs, list):
            continue
        for output in outputs:
            if not nonempty(output):
                continue
            artifact = output_root / output
            if not artifact.is_file():
                errors.append(
                    issue(
                        f"nodes.{node_id}.outputs",
                        f"声明的产物不存在：{output}",
                    )
                )
            elif artifact.stat().st_size == 0:
                errors.append(
                    issue(
                        f"nodes.{node_id}.outputs",
                        f"产物为空文件：{output}",
                    )
                )


def parse_args():
    parser = argparse.ArgumentParser(description="验证产品市场技能路由计划")
    parser.add_argument("plan", help="route-plan.json")
    parser.add_argument(
        "--phase",
        choices=("plan", "final"),
        default="plan",
        help="plan 校验结构，final 追加交付前状态与产物核验",
    )
    parser.add_argument(
        "--output-root",
        help="final 阶段解析 outputs 相对路径的根目录",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    path = Path(args.plan).expanduser().resolve()
    output_root = (
        Path(args.output_root).expanduser().resolve() if args.output_root else None
    )
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    errors, warnings = validate_plan(data, phase=args.phase, output_root=output_root)
    report = {
        "file": str(path),
        "phase": args.phase,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "nodes": len(data.get("nodes", [])) if isinstance(data, dict) else 0,
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for level, items in (("错误", errors), ("警告", warnings)):
            for item in items:
                print(f"[{level}] {item['path']}：{item['message']}")
        print(
            f"路由核验（{args.phase}）：错误 {len(errors)}，警告 {len(warnings)}，"
            f"状态 {'通过' if report['valid'] else '失败'}"
        )
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
