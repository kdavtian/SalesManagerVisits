# Usability impact and verification gate (every code change)

Why: the owner judges the work by what a rep, warehouse clerk or accountant SEES and DOES on a phone, and cannot read code. Green tests that
still let a rep double-submit a sale or lose a typed discount are a failure. This gate makes every change answer "who is affected, what
could go wrong for them, and what did we actually observe" in proportion to the risk.

One file, two homes: the master is `KADDev/references/usability-gate.md`; `kad-edit/references/usability-gate.md` is a byte-identical copy
written by `sync-repos.py` (KADDev rule 36). Edit the KADDev one only, then run the sync.

## 1. When it applies
- Every code change, whatever the wording: "fix this", "add this feature", "rename", "make it faster", a screenshot with no text. Docs-only or
  skills-only edits that change no behaviour: write "gate: n/a, docs only".
- It sets how much to test. It does not replace KADDev rules 6 / 20 / 24 / 30 / 41, the kad-edit review, `docs/governance/definition-of-done.md`
  or `deploy/ui-qa-checklist.md`; it tells you which of them to run in full.
- Class A needs only sections 2, 3 and 7 (a few lines). Questionnaires (SUS, UMUX-LITE, ...) belong to human testing of class C changes or a
  milestone release, never to every commit, and never ask the owner to fill one for an ordinary change.

## 2. Define success before changing code
Answer these in your notes (one line each; for class A one line in total):
1. **Affected user and goal**: which role (rep, warehouse, driver, accountant, management/admin, KAD OS customer, the CEO through the bot) and
   what they are trying to get done, in their words.
2. **Device and context**: iPhone Safari PWA, Android Chrome, Windows desktop, Telegram; one hand, bad signal, in front of a customer.
3. **Costliest plausible mistake**: wrong quantity or customer, a discount nobody saw, a double sale, a destructive tap. How does the screen
   prevent it, or let the user undo it?
4. **Observable success**: what the person sees AND what is saved (rows, totals, stock, notification). A check must be able to read both.
5. **Downstream effects**: related modules, permissions (enforced on the server), saved records (old rows, items queued by an old client),
   reports and the Excel reconcile, the other apps. Method: kad-edit Steps 3 and 3b, KADDev rules 24 and 52.
6. **Baseline**: for an existing flow capture today's behaviour BEFORE editing when feasible: number of taps/steps, screenshots at 320 and
   390 px (hy and en), the API response or DB rows it produces, the tests that pass now. Not feasible (new flow, cannot reproduce)? Say why.

## 3. Classify the change (take the highest class that applies; unsure = higher)
| Class | What | Required |
|---|---|---|
| **A. Internal, no user impact** | rename/move/refactor code, tooling, test-only, comments | One line saying why nobody is affected, **including indirect effects** on speed, data accuracy, permissions and error handling; run the relevant regression checks (lint, unit, the integration tests of the touched module). No human test, no questionnaire. |
| **B. User-facing** | anything a person can see or do: text, layout, field, filter, screen, validation, error message, notification or report wording | Test the affected task END TO END in a real browser at phone size, including the most likely mistake and the way back from it; design checks (section 4); existing automated suites; screenshots you looked at. |
| **C. High-risk or major workflow** | sales, payments, debt, discounts, orders, stock, permissions, destructive actions (delete, cancel, overwrite, bulk), or a redesign of a multi-step flow; always a change to the LOGIC of critical journeys 3, 4, 8 (`docs/governance/critical-user-journeys.md`) | All of B, plus: saved-data integrity (the stored business outcome reconciles, not only the toast), interruption and retry (double tap, offline then replay, app killed mid-save, Back mid-flow), the permission matrix on the server AND in the UI, and a realistic human test prepared (section 7). kad-edit size L. |

**Money screens, presentation only.** A change that only alters how a sales / payment / discount / order / stock screen LOOKS or is typed into (layout, wording, spacing, keypad type) is class B plus ONE extra check: the value entered is the value saved, and the totals shown match it. It becomes class C as soon as it touches calculation, defaults, the number or order of steps, submission, approval, permissions or what is saved.

A rename is class A while every reader of the name is in the code you are changing (a helper, a variable, a module-internal or exported function
whose importers `npm run lint` and `check-imports.mjs` resolve). Renaming something a party OUTSIDE the code reads (an API field, DB column,
setting key, i18n key, a payload of the bot / Lily / KAD OS, anything the old client in a phone's cache still sends) is a contract change:
classify by what it touches (B or C) and keep the old name accepted. Use the refactor tool for moves (KADDev rule 55).

## 4. Design for correct, effortless use (class B and C)
- **Clarity**: the next action is obvious. Staff vocabulary comes from the existing hy strings and `owner-model.md` 5.3, never a fresh
  translation; units written as the app writes them (`4 L`, `5,700 դր`, `4 հատ`); the same control for the same job everywhere (shared
  components); defaults from known data and VISIBLE where the user confirms.
- **Flow**: frequent actions within thumb reach (bottom sheet, fixed action bar). Going back or correcting a mistake keeps what was typed,
  the filters, the search and the scroll position. No redundant entry (WCAG 3.3.7), no extra steps; deliberate review stays wherever a wrong
  choice has business consequences (WCAG 3.3.4: reversible, checked or confirmed).
- **Environment**: smallest supported phone (320 px wide, which is also WCAG 1.4.10 Reflow) plus 390 and 440 px; Armenian and English; long
  product names and real-sized lists (hundreds of products; KAD OS 50k); the on-screen keyboard open (emulate with a viewport height of
  about 45 %: the focused field and the Save row stay visible; the real iOS keyboard is only provable on an iPhone, so list it under
  pending human validation when an input sits near a sticky footer); scrolling with no trap; sticky controls covering nothing.
- **Accessibility, the WCAG 2.2 AA criteria that apply**: 1.4.1 no meaning by colour alone (a selected control also shows a checkmark or
  weight change; a checkmark replaces a redundant "Selected" word); 1.4.3 text contrast 4.5:1 and 1.4.11 control/selected-state contrast 3:1;
  1.4.10 reflow; 2.1.1 keyboard operable and 2.4.3 sensible focus order (Tab, Enter, Esc on desktop); 2.4.7 focus visible (the owner wants it
  THIN, so thin but visible); 2.4.11 focus not hidden by a sticky bar or the keyboard; 2.5.3 label in name; 2.5.8 target size (the app's own
  floor is a 44 px hit area, rule 14; never below 24 CSS px); 3.3.1 / 3.3.3 errors named and fixable; 4.1.2 name/role/value (icon buttons
  have an `aria-label`); 4.1.3 save/error messages announced. Real VoiceOver/TalkBack cannot run in the sandbox: check names and roles in the
  accessibility tree and list the real screen-reader pass as pending human validation.
- **Owner decisions stand, they are not defects**: thin focus ring, KAD OS portrait lock on phones (the one place WCAG 1.3.4 is not met by
  choice; Field Visits' `ui-qa-checklist.md` also covers landscape), AMD whole numbers. Do not claim "fully WCAG AA"; claim the criteria you checked.

## 5. Choose the test that answers the question
| Question | Method | What to record |
|---|---|---|
| Does it work and did anything else break? | Automated: the existing suites (Field Visits `npm test`, `verify:ui`, `lint`, Playwright smoke + `iphone-webkit`, `idle-dom`, speed budget, `bash scripts/local-ci.sh`; KAD OS `npm test`, `shots`, `bench`, `qa`; bot `pytest`). Add a targeted regression test when a costly or recurring failure could come back. | counts: passed / failed / skipped |
| Can people finish the task? | **Observed task testing** with real users | unaided correct completion n/N, critical errors n, assists n, recovery n/N, median time of the successful attempts; plus the SAVED business outcome read from the DB/API, not the confirmation toast |
| Which step is hard? | **SEQ** (Single Ease Question), 1 (very difficult) to 7 (very easy), asked right after each task | median per task; a task below 6 points at its step |
| How usable is the whole app? | **SUS**: the standard 10 items, 5-point scale, after representative users tried a set of realistic tasks. Odd items contribute (answer - 1), even items (5 - answer); sum the ten contributions and multiply by 2.5 (0-100, not a percentage). All-best answers = 100, all-neutral = 50. | mean /100, sample size, user roles, build version; name the translation used. Use a validated translation if one exists; if none is known, use a back-translated wording reviewed by a bilingual colleague and label it "unvalidated Armenian wording". A small pilot is directional only. |
| Is an action unclear? | first-click test | where the first tap landed vs the intended control |
| Can people find things? | tree testing (menu and navigation structure) | success rate and directness per target |
| Why is a flow confusing? | think-aloud or cognitive walkthrough | the step, what the user expected, what happened |
| Who is blocked? | accessibility testing (keyboard only, screen reader, 200 % text) | the barrier and the criterion it breaks |
| Which of two designs wins? | A/B only when sample size and the decision justify it (KAD has few users: rarely) | n per arm, metric, decision rule set beforehand |
| Short periodic pulse / wider experience / effort / detailed satisfaction | UMUX-LITE / UEQ-S / NASA-TLX / PSSUQ or CSUQ: pick the one that answers the open question | keep each instrument's results separate; never average or compare them with SUS |

**Hard line**: never produce a SUS, SEQ or any satisfaction score from code, screenshots, AI personas or automated tests. Automation proves
behaviour and accessibility rules; only people can rate ease. A number nobody gave must not appear in a summary.

## 6. KAD acceptance scenarios (use when the change touches them; use TEST data, clean up after, KADDev rule 39)
**6.1 Mobile sales flow stays deliberate.** Today (since 1.334.0, `views/orderCreate.js`): products, then the "Your order" sheet (lines grouped
by brand, terms card with payment method, payment due days, discount, downpayment, total), then an explicit Save. Keep that shape: a review
step before the sale is saved, explicit submission, and no SILENT default of a money-affecting choice. A default is fine when it is shown on
the review step, editable, and nothing is committed until the explicit Save (the owner's defaults stand: method and due days from the
customer, downpayment 30 % first order / 15 % later, informational). Never auto-submit, never pre-mark a sale as paid, never apply a discount
the rep did not see. Adding or moving a step, or changing a default of a money-affecting choice, is a policy/trade-off decision for the owner
(KADDev rule 25), not a design detail.

**6.2 Regression scenario, split payment.** A rep finds two 4 L bottles, edits the discount, goes to payment, goes back to correct the
quantity, then records part of the total as paid and the balance as debt. Verify the FINAL stored values: line quantities, discount (kept in
the type typed, % or AMD), total after discount, paid amount, balance/debt, and the stock reservation/movement (exactly the final quantity,
not the first one). Map "paid" and "debt" to the fields that exist when you test: today the order holds an informational downpayment, payments
are separate records that go through approval, and debt is derived from the Excel/ERP balance with FIFO (`debtAge.js`), not stored on the
order; a change that adds a paid/debt split must verify its own new fields end to end and say how they relate to that Excel truth. Then: a double tap on Save and a retry after a lost network response
(offline queue replay with the same `client_ref`) must each produce exactly ONE sale and one stock movement, and the queue must end empty.

**6.3 Catalog.** With a long product list: scroll it, switch categories (Frequent, brands, Merch) while items are in the cart, open "Your
order" and come back, without a scroll trap and without losing selections, search text or filters. Cover stock units and pack sizes with an
oil (pack steps 12 / 4 / 3 / 1 on long press) AND a product where volume does not apply (an oil filter): no "0 L", NaN or litre total for it,
steps of 1, totals and reports still correct (`size_l x qty` only for litres). Tapping a line changes only that line (rule 41).

## 7. Completion rule, human tests, report
- **Fix and retest before "done"** any reproducible defect that (a) prevents completing the task, (b) records incorrect business data,
  (c) duplicates a transaction, (d) loses entered work unexpectedly, or (e) blocks a supported input method (touch, keyboard, paste,
  dictation, the on-screen keyboard). An unresolved blocker is reported as a blocker in the summary, never buried under "done".
- **Targets for human testing (proposed by the owner)**: SUS >= 85/100 and median SEQ >= 6/7. Track correct completion and critical errors
  separately: a high average can never outweigh a wrong payment or a duplicate sale. Compare with the previous build, using comparable
  users and tasks. These apply when people test; a code change alone never "reaches" them.
- **Human testing not available** (usual): write "pending human validation" with the exact task, short and in the owner's habit of "open X,
  expect Y":
  ```
  Pending human validation - <change>, build <version>
  Who: <roles; one person who did not build it>   Device: <iPhone Safari PWA | Android>   Data: test customer + test product (cleaned after)
  Task 1: "<the task in the rep's words>" - expect: <the saved outcome>
  Record per task: done unaided Y/N, critical error Y/N, assists, seconds, SEQ 1-7.   SUS after all tasks only when a handful of users took part.
  Fail the build on: any critical error (wrong payment, duplicate sale, lost data), whatever the averages.
  ```
- **Close every change summary with this block** as the LAST block (the `APP_VERSION` line, where the repo has one, stays the last line):
  ```
  Verification
  - Affected task and risk: <task>; class A|B|C; <costliest mistake or risk>
  - Checks run (observed): <check -> result with counts>; not run: <check, why>
  - Remaining: <issue> | pending human validation: <exact task>
  ```
  "Observed" means run in this task, with numbers ("tests 412 passed / 0 failed", "double-tap Save: 1 order of 2 taps", "screenshots viewed:
  320 and 390 px, hy and en"). "Should work" is not a result. Class A is three short lines.
