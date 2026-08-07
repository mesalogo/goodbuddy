import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_DIR / "scripts" / "validate_route_plan.py"
SPEC = importlib.util.spec_from_file_location("validate_route_plan", SCRIPT)
validate_route_plan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validate_route_plan)


class RoutePlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        template = SKILL_DIR / "templates" / "route-plan.example.json"
        cls.plan = json.loads(template.read_text(encoding="utf-8"))

    def test_example_plan_is_valid(self):
        errors, warnings = validate_route_plan.validate_plan(self.plan)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_rejects_cycle(self):
        plan = copy.deepcopy(self.plan)
        plan["nodes"][0]["depends_on"] = ["presentation"]
        errors, _ = validate_route_plan.validate_plan(plan)
        self.assertTrue(any("依赖存在环" in item["message"] for item in errors))

    def test_rejects_artifact_without_evidence_dependency(self):
        plan = copy.deepcopy(self.plan)
        plan["nodes"][1]["depends_on"] = []
        errors, _ = validate_route_plan.validate_plan(plan)
        self.assertTrue(
            any("product-evidence" in item["message"] for item in errors)
        )

    def test_rejects_duplicate_output(self):
        plan = copy.deepcopy(self.plan)
        plan["nodes"][2]["outputs"] = ["feature-catalog.md"]
        errors, _ = validate_route_plan.validate_plan(plan)
        self.assertTrue(any("输出与" in item["message"] for item in errors))

    def test_rejects_completed_node_with_unfinished_dependency(self):
        plan = copy.deepcopy(self.plan)
        plan["nodes"][1]["status"] = "completed"
        errors, _ = validate_route_plan.validate_plan(plan)
        self.assertTrue(
            any("不能标记 completed" in item["message"] for item in errors)
        )

    def test_final_phase_requires_completion_and_artifacts(self):
        plan = copy.deepcopy(self.plan)
        errors, _ = validate_route_plan.validate_plan(plan, phase="final")
        self.assertTrue(
            any("必须 completed" in item["message"] for item in errors)
        )
        self.assertTrue(
            any("必须记录 passed" in item["message"] for item in errors)
        )

    def test_policy_gate_can_be_waived_with_reason(self):
        plan = copy.deepcopy(self.plan)
        for node in plan["nodes"]:
            node["status"] = "completed"
        for gate in plan["final_gates"]:
            gate["status"] = "passed"
        approval = next(
            g for g in plan["final_gates"] if g["name"] == "human-approval"
        )
        approval["status"] = "waived"
        errors, _ = validate_route_plan.validate_plan(plan, phase="final")
        self.assertTrue(any("豁免必须写明" in i["message"] for i in errors))

        approval["waiver"] = "内部草稿，责任人张三，2026-08-01"
        errors, warnings = validate_route_plan.validate_plan(plan, phase="final")
        self.assertEqual(errors, [])
        self.assertTrue(any("已豁免" in i["message"] for i in warnings))

    def test_core_gate_cannot_be_waived(self):
        plan = copy.deepcopy(self.plan)
        for node in plan["nodes"]:
            node["status"] = "completed"
        for gate in plan["final_gates"]:
            gate["status"] = "passed"
        core = next(
            g for g in plan["final_gates"] if g["name"] == "evidence-validation"
        )
        core["status"] = "waived"
        core["waiver"] = "跳过"
        errors, _ = validate_route_plan.validate_plan(plan, phase="final")
        self.assertTrue(any("不能豁免" in i["message"] for i in errors))

    def test_final_phase_accepts_completed_plan_with_outputs(self):
        plan = copy.deepcopy(self.plan)
        for node in plan["nodes"]:
            node["status"] = "completed"
        for gate in plan["final_gates"]:
            gate["status"] = "passed"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for node in plan["nodes"]:
                for output in node["outputs"]:
                    (root / output).write_text("content", encoding="utf-8")
            errors, _ = validate_route_plan.validate_plan(
                plan, phase="final", output_root=root
            )
            self.assertEqual(errors, [])
            missing = copy.deepcopy(plan)
            (root / missing["nodes"][-1]["outputs"][0]).unlink()
            errors, _ = validate_route_plan.validate_plan(
                missing, phase="final", output_root=root
            )
            self.assertTrue(
                any("产物不存在" in item["message"] for item in errors)
            )

    def test_deep_chain_does_not_recurse(self):
        nodes = [
            {
                "id": "evidence",
                "skill": "product-evidence",
                "artifact_type": "evidence",
                "depends_on": [],
                "required": True,
                "status": "pending",
                "outputs": ["product-evidence.json"],
                "reason": "基线",
            }
        ]
        previous = "evidence"
        for index in range(1500):
            node_id = f"catalog-{index}"
            nodes.append(
                {
                    "id": node_id,
                    "skill": "product-feature-catalog",
                    "artifact_type": "feature-catalog",
                    "depends_on": [previous],
                    "required": True,
                    "status": "pending",
                    "outputs": [f"feature-catalog-{index}.md"],
                    "reason": "链式依赖",
                }
            )
            previous = node_id
        plan = copy.deepcopy(self.plan)
        plan["nodes"] = list(reversed(nodes))
        errors, _ = validate_route_plan.validate_plan(plan)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
