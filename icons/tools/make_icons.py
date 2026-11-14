"""Compatibility entry point for the shared desktop and website icon generator."""
from pathlib import Path
import subprocess


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    subprocess.run(["node", str(root / "build" / "generate-icons.mjs")],
                   cwd=root, check=True)
