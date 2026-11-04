#!/usr/bin/env python3
"""Copy this KADDev skill (the MASTER copy, kdavtian/SalesManagerVisits .claude/skills/KADDev) into every other KAD repo checked out
next to this one, so a session in ANY repo loads the same, current skill (owner, 2026-11-04: "use it with all repos").
Repos: KAD-GMM (KAD OS), castrol_ceo_report (CEO bot), KAD-Motors-Platform (website). A repo that is not checked out is skipped.
Each copy is replaced whole (old files removed) and gets the same files; then commit + PR in each repo (docs only, CI is quick).
  python3 .claude/skills/KADDev/sync-repos.py           copy
  python3 .claude/skills/KADDev/sync-repos.py --check   only report which copies differ (exit 1 if any)"""
import filecmp, shutil, subprocess, sys
from pathlib import Path

root = Path(__file__).resolve().parent
parent = root.parents[3]  # the folder that holds the repo checkouts
REPOS = ["KAD-GMM", "castrol_ceo_report", "KAD-Motors-Platform"]
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "dist")

subprocess.run([sys.executable, str(root / "build-index.py")], check=True, stdout=subprocess.DEVNULL)


def differs(a: Path, b: Path) -> bool:
    if not b.exists():
        return True
    c = filecmp.dircmp(a, b, ignore=["__pycache__", "dist"])
    stack = [c]
    while stack:
        d = stack.pop()
        if d.left_only or d.right_only or d.diff_files or d.funny_files:
            return True
        stack.extend(d.subdirs.values())
    return False


check = "--check" in sys.argv
bad = 0
for name in REPOS:
    repo = parent / name
    if not (repo / ".git").exists():
        print(f"{name}: not checked out, skipped")
        continue
    target = repo / ".claude" / "skills" / "KADDev"
    if not differs(root, target):
        print(f"{name}: up to date")
        continue
    if check:
        print(f"{name}: DIFFERS from the master copy")
        bad += 1
        continue
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(root, target, ignore=IGNORE)
    print(f"{name}: copied")
sys.exit(1 if bad else 0)
