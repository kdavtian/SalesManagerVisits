#!/usr/bin/env python3
"""Build the upload file for claude.ai (Customize -> Skills): `kad-edit-skill.zip` = SKILL.md + references/ inside one folder `kad-edit/`.
Run from anywhere:  python3 .claude/skills/kad-edit/build-zip.py [output-dir]   (default: <repo>/dist, git-ignored)
Upload: on claude.ai delete the old `kad-edit` skill (if any), then upload this zip."""
import sys, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parents[2]
# The usability gate is authored once (KADDev) and bundled identically in kad-edit; never upload a zip whose two copies differ.
_a, _b = root.parent / "KADDev" / "references" / "usability-gate.md", root.parent / "kad-edit" / "references" / "usability-gate.md"
if _a.exists() and _b.exists() and _a.read_bytes() != _b.read_bytes():
    sys.exit("usability-gate.md differs between KADDev and kad-edit: run `python3 sync-skills.py` in KD-Mozg first")
out_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / "dist"
out_dir.mkdir(parents=True, exist_ok=True)
files = [root / "SKILL.md"] + sorted((root / "references").glob("*.md"))
target = out_dir / "kad-edit-skill.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f"kad-edit/{f.relative_to(root).as_posix()}")
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None and "kad-edit/SKILL.md" in z.namelist(), "zip is not valid"
    n = len(z.namelist())
print(f"{target}  {target.stat().st_size // 1024} KB  {n} files")
