# Working notes for Claude

- After shipping a change (bumping `client/public/js/version.js`), state the new `APP_VERSION` at the end of the task summary.
- Every ship that touches anything under `client/public/` bumps `APP_VERSION` (`client/public/js/version.js`) AND `CACHE_VERSION` (`client/public/sw.js`): the service worker only updates phones when sw.js bytes change. CI `check:version` enforces it.
- Code structure and speed work follows `docs/architecture-roadmap.md` (owner, 2026-10-28): one step per PR, tick its box and add a Done-log line when it merges; new code already follows the target structure there (rules in their own module, no SQL piled into route files, no screen patching another screen's DOM).
- Every change, improvement or new feature goes through the `kad-edit` skill (`.claude/skills/kad-edit`, owner 2026-11-02): design pass before code (size S/M/L, blast radius, 13-lens review, five-block verdict, acceptance checks), diff pass before "done". It decides whether and how to change; KADDev decides how to ship.
- Skills in `.claude/skills/` are generated COPIES; the master of every skill is `kdavtian/KD-Mozg` (owner 2026-11-07): change a skill there and run its `sync-skills.py`, never here only (KADDev rule 36).
- One feature per PR; independent features run as parallel cloud sessions; M/L or money/permission changes get an independent review before merge (KADDev rules 62-63).
