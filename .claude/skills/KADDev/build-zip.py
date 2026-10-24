#!/usr/bin/env python3
"""Build the upload file for claude.ai (Customize -> Skills): `kaddev-skill.zip` = SKILL.md + references/, inside one folder `kaddev/`.
Rebuilds references/INDEX.md first, so the zip never carries a stale index. The scripts (build-*.py) stay in the repo, they are not part of the upload.
Run from anywhere:  python3 .claude/skills/KADDev/build-zip.py [output-dir]     (default: <repo>/dist, which git ignores)
Upload: on claude.ai delete the old `kaddev` skill, then upload this zip. Prints the path, size and file count."""
import subprocess, sys, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parents[2]
out_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / "dist"
out_dir.mkdir(parents=True, exist_ok=True)

subprocess.run([sys.executable, str(root / "build-index.py")], check=True, stdout=subprocess.DEVNULL)

files = [root / "SKILL.md"] + sorted((root / "references").glob("*.md"))
target = out_dir / "kaddev-skill.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f"kaddev/{f.relative_to(root).as_posix()}")

with zipfile.ZipFile(target) as z:
    assert z.testzip() is None and "kaddev/SKILL.md" in z.namelist(), "zip is not valid"
    n = len(z.namelist())
print(f"{target}  {target.stat().st_size // 1024} KB  {n} files")
