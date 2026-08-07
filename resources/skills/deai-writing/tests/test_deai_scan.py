import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))

import deai_scan


class DeaiScanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.block, cls.review, cls.structure = deai_scan.load_rules()

    def scan(self, text, suffix=".md"):
        return deai_scan.scan_text(
            text,
            f"sample{suffix}",
            self.block,
            self.review,
            self.structure,
        )

    def test_reports_block_and_review_findings(self):
        findings = self.scan("综上所述，方案提供一站式服务。\n当前基线需要人工复核。")
        levels = {finding["level"] for finding in findings}
        self.assertEqual(levels, {deai_scan.LEVEL_BLOCK, deai_scan.LEVEL_REVIEW})

    def test_masks_markdown_code(self):
        findings = self.scan("正文没有问题。\n```text\n综上所述，打造闭环。\n```\n")
        self.assertEqual(findings, [])

    def test_masks_html_code_and_attributes(self):
        findings = self.scan(
            '<div data-note="综上所述">正常正文</div>'
            "<script>const text = '一站式';</script>",
            ".html",
        )
        self.assertEqual(findings, [])

    def test_matches_sentence_across_markdown_line_break(self):
        findings = self.scan("这不是普通说明，\n而是固定对照模板。")
        self.assertTrue(
            any(finding["category"] == "对照模板" for finding in findings)
        )
        self.assertEqual(findings[0]["line"], 1)

    def test_loads_custom_rule_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            rules = Path(tmp) / "custom.py"
            rules.write_text(
                'AI_SMELL = {"自定义": ["专属阻断词"]}\n'
                'REVIEW_ONLY = {"自定义复核": ["专属复核词"]}\n',
                encoding="utf-8",
            )
            block, review, _ = deai_scan.load_rules(str(rules))
            self.assertIn("专属阻断词", block["自定义"])
            self.assertIn("专属复核词", review["自定义复核"])

    def test_project_rules_cannot_execute_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            rules = Path(tmp) / "custom.py"
            rules.write_text(
                'AI_SMELL = {}\nopen("/tmp/should-not-exist", "w")\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "不可执行"):
                deai_scan.load_rules(str(rules))

    def test_cli_json_and_failure_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "sample.md"
            target.write_text("综上所述，本方案必将提供卓越的服务。", encoding="utf-8")
            command = [sys.executable, str(SKILL_DIR / "deai_scan.py"), str(target), "--json"]
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            report = json.loads(result.stdout)
            self.assertGreater(report["block"], 0)

            failed = subprocess.run(
                command + ["--fail-on-block"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(failed.returncode, 1)

    def test_cli_fails_when_text_file_cannot_be_decoded(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "sample.md"
            target.write_bytes(b"\xff\xfe\x00")
            result = subprocess.run(
                [sys.executable, str(SKILL_DIR / "deai_scan.py"), str(target), "--json"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(len(json.loads(result.stdout)["errors"]), 1)


if __name__ == "__main__":
    unittest.main()
