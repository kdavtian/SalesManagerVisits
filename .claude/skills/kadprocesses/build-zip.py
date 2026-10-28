#!/usr/bin/env python3
"""Build the upload file for claude.ai (Customize -> Skills): `kadprocesses-skill.zip` = SKILL.md + references/ inside one folder `kadprocesses/`.
Run from anywhere:  python3 .claude/skills/kadprocesses/build-zip.py [output-dir]   (default: <repo>/dist, git-ignored)
Upload: on claude.ai delete the old `kadprocesses` skill (if any), then upload this zip."""
import sys, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parents[2]
out_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / "dist"
out_dir.mkdir(parents=True, exist_ok=True)
files = [root / "SKILL.md"] + sorted((root / "references").glob("*.md"))
target = out_dir / "kadprocesses-skill.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f"kadprocesses/{f.relative_to(root).as_posix()}")
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None and "kadprocesses/SKILL.md" in z.namelist(), "zip is not valid"
    n = len(z.namelist())
print(f"{target}  {target.stat().st_size // 1024} KB  {n} files")
