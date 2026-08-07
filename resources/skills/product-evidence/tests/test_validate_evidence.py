import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_DIR / "scripts" / "validate_evidence.py"
SPEC = importlib.util.spec_from_file_location("validate_evidence", SCRIPT)
validate_evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validate_evidence)


class ProductEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        template = SKILL_DIR / "templates" / "product-evidence.example.json"
        cls.valid_data = json.loads(template.read_text(encoding="utf-8"))

    def test_example_manifest_is_valid(self):
        errors, warnings = validate_evidence.validate_manifest(self.valid_data)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_rejects_duplicate_ids_and_unknown_references(self):
        data = copy.deepcopy(self.valid_data)
        data["parameters"][0]["id"] = "FEAT-001"
        data["claims"][0]["evidence_ids"] = ["EVD-MISSING"]
        errors, _ = validate_evidence.validate_manifest(data)
        messages = "\n".join(item["message"] for item in errors)
        self.assertIn("重复", messages)
        self.assertIn("引用不存在", messages)

    def test_rejects_secret_in_evidence_source(self):
        data = copy.deepcopy(self.valid_data)
        data["evidence"][0]["source"] = "https://example.test/doc?token=secret"
        errors, _ = validate_evidence.validate_manifest(data)
        self.assertTrue(
            any("密钥" in item["message"] for item in errors)
        )

    def test_placeholder_is_warning(self):
        data = copy.deepcopy(self.valid_data)
        data["product"]["summary"] = "TODO"
        errors, warnings = validate_evidence.validate_manifest(data)
        self.assertEqual(errors, [])
        self.assertTrue(warnings)

    def test_rejects_record_more_public_than_evidence(self):
        data = copy.deepcopy(self.valid_data)
        for record in data["evidence"]:
            if record["id"] == "EVD-001":
                record["disclosure"] = "restricted"
        errors, _ = validate_evidence.validate_manifest(data)
        self.assertTrue(
            any("仅为 restricted" in item["message"] for item in errors)
        )

    def test_restricted_parameter_is_not_a_public_channel_warning(self):
        data = copy.deepcopy(self.valid_data)
        data["parameters"][0]["disclosure"] = "restricted"
        for record in data["evidence"]:
            if record["id"] in data["parameters"][0]["evidence_ids"]:
                record["disclosure"] = "restricted"
        data["claims"][0]["evidence_ids"] = []
        data["claims"][0]["type"] = "goal"
        errors, warnings = validate_evidence.validate_manifest(
            data, channel="public"
        )
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_public_channel_rejects_internal_evidence(self):
        data = copy.deepcopy(self.valid_data)
        claim = data["claims"][0]
        claim["allowed_outputs"] = ["one-pager"]
        evidence_id = claim["evidence_ids"][0]
        for record in data["evidence"]:
            if record["id"] == evidence_id:
                record["disclosure"] = "internal"
        for parameter in data["parameters"]:
            if evidence_id in parameter.get("evidence_ids", []):
                parameter["disclosure"] = "internal"
        errors, _ = validate_evidence.validate_manifest(data, channel="public")
        self.assertTrue(
            any("不足以支撑 public" in item["message"] for item in errors)
        )
        errors, _ = validate_evidence.validate_manifest(data, channel="internal")
        self.assertEqual(errors, [])

    def test_cli_json_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "product-evidence.json"
            manifest.write_text(
                json.dumps(self.valid_data, ensure_ascii=False),
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(manifest), "--json"],
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(result.stdout)
            self.assertTrue(report["valid"])


if __name__ == "__main__":
    unittest.main()
