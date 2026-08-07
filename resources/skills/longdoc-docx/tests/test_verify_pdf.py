import importlib.util
import tempfile
import unittest
from pathlib import Path

import fitz


SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT_PATH = SKILL_DIR / "scripts" / "verify_pdf.py"
SPEC = importlib.util.spec_from_file_location("verify_pdf", SCRIPT_PATH)
verify_pdf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_pdf)


class VerifyPdfTests(unittest.TestCase):
    def create_pdf(self, path):
        document = fitz.open()
        text_page = document.new_page()
        text_page.insert_text(
            (72, 72),
            "This page contains enough verification text and a forbidden term.",
        )
        document.new_page()
        document.save(path)
        document.close()

    def test_reports_forbidden_terms_and_blank_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "sample.pdf"
            self.create_pdf(pdf)
            report = verify_pdf.inspect_pdf(
                pdf,
                forbidden=["forbidden"],
                min_text_chars=30,
            )
            self.assertEqual(report["page_count"], 2)
            self.assertEqual(report["forbidden"]["forbidden"]["pages"], [1])
            self.assertEqual(report["suspicious_blank_pages"], [2])
            self.assertTrue(verify_pdf.has_failures(report))

    def test_allows_known_blank_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "sample.pdf"
            self.create_pdf(pdf)
            report = verify_pdf.inspect_pdf(
                pdf,
                min_text_chars=30,
                allowed_blank_pages=[2],
            )
            self.assertEqual(report["suspicious_blank_pages"], [])
            self.assertFalse(verify_pdf.has_failures(report))

    def test_renders_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "sample.pdf"
            self.create_pdf(pdf)
            rendered = verify_pdf.render_pages(pdf, root / "pages", dpi=72)
            self.assertEqual(len(rendered), 2)
            self.assertTrue(all(Path(path).is_file() for path in rendered))

    def test_rejects_render_directory_with_old_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "sample.pdf"
            pages = root / "pages"
            pages.mkdir()
            (pages / "page-999.png").write_bytes(b"old")
            self.create_pdf(pdf)
            with self.assertRaisesRegex(FileExistsError, "空目录"):
                verify_pdf.render_pages(pdf, pages, dpi=72)


if __name__ == "__main__":
    unittest.main()
