# The owner model: how to know what they want before they say it

Built 2026-10-18 from ~250 owner messages and the 350+ shipped changes (app 1.353.0). The other references say WHAT was built and WHICH rules exist; this file says HOW THE OWNER THINKS, so a three-word request can be answered the way they would have written a three-page one. Read it at the start of every task (SKILL.md rule 32) and run the pre-flight (section 4) before saying "done".

## 1. Who they are, in one paragraph
A hands-on distributor owner (Castrol/Lotos/Royal/Orlen, Armenia) who runs the company from the app on an iPhone and wants to be No. 1 in volume, sales AND profit (target ~1M litres/year, ~10% of the market). They are not a programmer but they see everything: a 3 px misalignment, a stale hint, a wrong Armenian word, a number that is 20,000 off. They test on the real phone minutes after deploying and report exactly what they saw ("I am on 1.220.0", img1). They think in business loops (data -> decision -> action -> check), judge every feature by "does this make a person do the right thing faster", and treat the app as the company's operating system for reps, warehouse, drivers, accountant (Lily) and management. They want the product to feel like it was designed by one careful person: one pattern per problem, everywhere.

## 2. The eleven things they always want and almost never say

1. **Consistency over novelty.** "Same icon, same feature." "Apply same change everywhere." "Fix such kind of bugs." "Detect such cases in app." Every fix is a pattern: grep for siblings, fix all, list them under "also fixed". A one-off fix that leaves its twin broken (the Back button fixed on one screen, the same-height fields only on one form, the calendar icon only on Activity) is a miss. Use the shared component (tri-state sheet, `filterIcons.js`, `openInfoPopup`, `bindStepperButton`, `.activity-tab` pattern) instead of inventing one.
2. **Fewer steps, fewer rows, less scrolling.** They want a rep to place an order faster than on paper, "even a 70-year-old". Count taps. Merge steps (View order + Payment terms became one sheet). Choose defaults from data already known: payment method/terms from the customer, AMD preselected, first-order down payment 30% / later 15%, "Automatic" print layout preselected, name autofill `Ajapnyak / Yuxman ket1`, select-all on focus so the old value is replaced by typing. Card lists with fewer rows ("fit more cards on the phone screen"). Short fixed lists must not scroll (`scrollHeight == clientHeight`).
3. **Nothing blocks the first paint.** A menu/sheet whose buttons need no data opens instantly and loads after the choice (order long-press menu: "without any calculations"). Skeletons, not spinners; stale-while-revalidate; no loading flash on tab switch. A slow screen is reported as "loads too slow" and they expect you to MEASURE and name the cause (they got: JIT, missing index, mutation loops, batching).
4. **Automate the human out of the loop.** Typed tasks close themselves from payments/orders/check-ins; ERP rows move orders to Delivered and payments to Approved with a "From ERP" chip; notifications consolidate ("5 packed orders waiting", once a day at 19:00, not at night); Vaghinak chases missing data instead of making fields mandatory. Whenever they describe a manual routine, propose and build the trigger that does it, plus the notification to the right person and the chip that shows it happened automatically.
5. **Excel/ERP is the truth; the app never silently disagrees.** They doubt numbers out loud ("net costs show false values", "price 530,000 but it sold for 550,000", "debt not due yet but a task was created"). Trace the number to its source column and formula, say which side was wrong, fix the source, add a test. Show corrected values, not explanations. When the app holds something the ERP does not yet (unrecorded payments), show it separately and never subtract it.
6. **Hide the explanation, show the decision.** Secondary text lives behind a small "!" (`openInfoPopup`); no redundant sentences, no "showing first 200"; chips and counts instead of paragraphs; bullet lines instead of comma lists in notifications. If a hint paragraph appears under a card, it moves behind a "!" on that card's header.
7. **Pixel-level craft, not just function.** Header aligned with the X; arrow aligned with the other arrows; two fields the same height; equal-width split buttons; amounts right-aligned with thousands separators everywhere (57,000); due chips right under the amount; no dark left-edge outlines on cards ("you forgot how many times I made you change this" -> gentle fill only); thin focus ring only; print button round like the add button; floating action rows pinned to the bottom with the same `--sheet-pad-bottom`; pressed state visible on every tap target (`:active`); 44 px targets with an invisible hit area for small icons so only the icon reacts. Look at screenshots at 390 and 440 px, Armenian first, long labels, dark mode.
8. **Armenian is the product language, and wording is a feature.** They correct single words (see 5.3). Armenian colon `՝` after labels, Armenian short months, "Հիմա" not "Ներկա պահին", "Ուշացում՝ N օր" not "Ուշացած", "ղեկավարություն" not "գործադիր տնօրեն կամ ադմին", "Էկոնոմ ռեժիմ". Formats: phones `+374 91 007 019` (stored as digits), amounts `5,700 դր`, sizes `4 L`, quantities `4 հատ`, durations `3ժ 20ր`, dates `23 Օգս, 15:06`. Every key in en AND hy; never leave English leaking.
9. **People and roles are part of every feature.** Ask silently: who sees it (rep only own; warehouse must see invoices to release goods; accountant may approve credit/payments; admin is management and is the owner's own account), who is notified (only the creator, the warehouse manager at working hours), who may approve (auto up to 3%, director up to net cost, CEO/admin unlimited), what is quiet at night. Server-side RBAC, not just hidden UI. Channels that are not visited (KF, CAS, OEM) never produce visit delays, plans or reminders.
10. **Every rule is a setting, with On/Off and a unit.** "You forgot to place that setting in App configuration. I want to set meters and also On/Off." New threshold, allowance, window or default -> a row in Settings > App configuration with a switch and the unit, with the default visible, plus Armenian copy.
11. **Close the loop and measure it.** For any feature say which of volume / sales / profit / cash it moves and how we will see it worked (they asked for tap/second measurement per order "only if it does not slow the app", and for Vaghinak to "keep a hand on the pulse"). Prefer number + recommended action + one-tap way to do it over a chart nobody acts on.

## 3. How they decide and how they talk

- **Numbered lists in, numbered answers out.** Mirror their numbering exactly, one line per point, "already existed since 1.3xx" when true. When they answer your suggestions with "Implement 2, 3, 4, 6" the skipped numbers are NO (do not do them, do not re-offer). "Implement also 8 10 11 12" continues the same list. Keep suggestion numbers stable across messages.
- **They answer fast and short; questions must stand alone.** They said "Ask me full questions again, I don't remember them": a question asked hours earlier is gone from their head. Every question (AskUserQuestion or in text) must carry its whole context: what, why it matters, each option's consequence, your recommendation. Never "Q2" or "as discussed". If they answer with contradictory choices (all day + Vaghinak uses it + build neither), build nothing, say which answers conflict, record the preferences.
- **Mandate words.** "Fix" = fix + hunt siblings. "Improve" / "make more user friendly" / "reshape" = you own the design: redo it properly, then show it (offer 2-3 variants only when the choice is genuinely theirs). "Detect ... and fix" = audit the whole app, list what was found even if little. "Suggest" / "What else" / "ideas" = suggestions only, numbered, with a recommendation, no code. "No changes, just answer" = zero code. "Implement" + numbers = build exactly those. "Make some more changes and fixes" = open mandate within the topic. "If you don't understand, ask" = ask (AskUserQuestion, 2-4 concrete options); otherwise decide and state the assumption. "ALWAYS ask me about anything that hurts speed, smoothness or friendliness" = trade-off gate (SKILL.md rule 25).
- **Short status words.** "Done?", "Ready?", "Not ready?", "Not updated" mean: is it merged and deployable, which version, what must I run. Answer in one or two lines with the PR/merge state, APP_VERSION and the deploy command (fast vs FULL with migration). "Not updated" usually means they deployed before the merge or the service worker did not reinstall: check version bump + PR state first. "Continue from where you left off" after an interrupt = resume silently, no recap. "." = go on. "merge it when CI is green" = standing order; merge, unsubscribe, report version.
- **Arithmetic and examples can be off by a little** (11:30-17:44 is 6.25 h): implement the rule, show the correct number, say so.
- **They re-send earlier lists inside new messages.** Diff against what shipped (`git log`, code), say which items existed and since which version, fix only what is truly wrong.
- **They explain with a real case** (customer 10167, 10001, "45 days is not due yet"). Reproduce that exact case in the data/test, explain in two sentences why the system acted that way, then fix the rule, not the single row, and add the case as a test.
- **They want to be taught the vocabulary** (sticky header, bottom sheet, scrim, skeleton, FAB, stepper...). Use the right UI term and one plain-language gloss the first time.
- **They sometimes paste secrets and screenshots.** Never echo secrets; say rotate. If an attached image is not visible, say so and work from the description.
- **Decisions about taste are theirs; correctness is yours.** When they pick from mock-ups or options, record the choice in the references so it is never re-asked. Things they removed stay removed (Favorites stars). Things they said "no" to (44 px everywhere, 2-row customer buttons, filter behind one button) are closed.

## 4. Pre-flight checklist before you say "done" (run silently, mention only findings)

UI detail
- [ ] Screenshot at 390 and 440 px, hy and en, light and dark: no overflow, no wrapped dates, nothing clipped, long Armenian labels wrap sensibly.
- [ ] Alignment: baselines, equal heights/widths, right-aligned amounts, header vs X, chevrons, columns line up across cards.
- [ ] Targets >= 44 px, only the icon reacts, visible pressed state, thin focus ring, no stray lines/outlines.
- [ ] Same component/icon/wording as the sibling screens; search the app for the same pattern and fix twins.
- [ ] Rows per card minimal; fixed short lists do not scroll; floating action bars not covering content.
UX/flow
- [ ] Count taps vs before; defaults prefilled; keyboard opens on the right field; select-all on focus; no confirm() for undoable actions; Back and swipe-back land where expected.
- [ ] First paint instant; no request needed to open a menu; skeleton not spinner; no flash on tab switch; idle DOM quiet (idle-dom spec).
- [ ] Offline/queued state is calm and visible; service worker: new modules in `APP_SHELL`, CACHE_VERSION bumped.
Business/data
- [ ] Source of every number traced (Excel column / DB column); Excel stays truth; ERP id matching, never names.
- [ ] Roles: rep sees own only (server enforced), admin included in "management", accountant/warehouse/driver rights, notifications to the right person and hour.
- [ ] Automation: what should happen by itself now, and who is told? Chip showing "from ERP"/auto where applicable.
- [ ] New rule has an App-configuration switch + unit; new list has search/filter/export where its siblings do; new text in en+hy.
Ship
- [ ] Tests (server + e2e + idle-dom where relevant), `node --check i18n.js`, versions bumped, docs/skill updated, PR merged, branch reset, summary with numbered answers, what to check on the iPhone, deploy command, goal metric, `APP_VERSION` + `CACHE_VERSION`.

## 5. Evidence base (so the rules above are not folklore)

### 5.1 Where the same lesson came back several times
- Cards: "no dark outline on the left" (asked again after being forgotten) -> gentle fill only. Overlapping text ("Պատվեր-ներ"), buttons overlapping fields, labels under the header, filter bars covering "All". -> overlap hunt is part of every UI change.
- Back navigation: one-step back, then 5, then 10 screens on iOS, double-tap tab restarts the tab, back from customer orders looped, swipe-back should show the page behind (animation only). -> navigation bugs are reported as "goes back to the wrong page"; test Back AND swipe.
- Map: blank/frozen/forgetful for months ("I need the final solution") -> they want root cause + a guard test, never "restart the app".
- Not updating: language change not refreshing Home, badges stale, orders list stale, "Not updated" after deploy -> every screen must refresh on language change/focus/online; version bump discipline.
- Dialogs: confirmation pages removed (task cancel), "!" tap area triggering the whole row, X buttons missing on photo/PDF/check-in/file sheets -> every overlay has a visible X and a Back route.
- Printing: Armenian-first documents judged visually (logos balanced, units, page n/m, phones right-aligned, delivery address, TIN/legal name, totals in L and pcs, payment terms and down payment printed because customers sign the blank). Print icon round, replaces order icons by check circles, floating bottom bar, progress bar animation, Automatic layout by default, half-A4 to save paper.
- Lists: filters consolidated into ONE tri-state tree (channel > rep), icons standardised, counts that reflect the other filters, chips for multi-select, search combined with icon dropdowns (Activity pattern), tabs with counts.

### 5.2 Their business logic, as decisions already made
- Debt: FIFO against opening balance (Balance0), due chips = days past due minus credit term ("Ուշացում՝ 71 օր" / "մնաց՝ 7 օր"), total + overdue + not-in-Excel, credit limit per customer, over limit needs management/director/accountant approval. A debt task is created only for an overdue amount and closes itself on any matching payment (app or ERP/bank).
- Discounts: auto-approve <= 3%; director up to net cost; CEO/admin unlimited; below-cost lines wait for "ղեկավարություն". Gold customers get individual prices and a special pricelist; bronze/silver only a total discount.
- Orders: reps may delete their own until management approves; ERP-recorded means delivered; accountant may submit/confirm and request invoice/waybill; warehouse sees invoices; Orders have "Accounting requests"; down payment 30% first order, 15% later; payment terms remembered per customer.
- Visits: only field reps' check-ins count as visits (management check-ins never change the plan); far check-ins still count but are flagged; allowance 300 m is a setting with On/Off; pin corrections by reps auto-approve; "Pin review" lists likely wrong pins; Castrol Office (10000) is check-in-able by everyone; non-visit channels (KF, CAS, OEM) skipped.
- Fuel: pay reps by real driving distance (city vs highway consumption, home leg only outside Yerevan, one price per month).
- Notifications: bullet lines, consolidated, once-a-day summary at 19:00, nothing to the warehouse manager at night, ERP-sync notices consolidated.
- Vaghinak: lives in Quick actions with a badge, talks differently per role (formal to CEO, warm slang to reps), never repeats wording, tolerates 30 min late, asks mandatory questions, owns all automatic tasks, reports Monday; hours shown as `3h 20m`.
- Money rounding: AMD whole numbers; hours worked rounded UP to 0.25 h.

### 5.3 Armenian wording the owner corrected (keep; apply everywhere)
`Ուշացած՝` -> `Ուշացում՝`; `Ներկա պահին`/`Այսօր կենդանի` -> `Հիմա` (header) ; `Վճարման ժամկետ (օր): 45` -> `Վճարման ժամկետ՝ 45 օր`; `ԱՄԴ` -> `դրամ`; `Կրկնվող հաճախորդ` -> `Մշտական հաճախորդ`; `+ Ավելացնել ևս ապրանքներ` -> `+ Ավելացնել ապրանքներ`; `... գործադիր տնօրենի կամ ադմինի հաստատմանը` -> `... ղեկավարության հաստատմանը`; `Լիլին անջատված է` -> `Լիլին կապի մեջ չէ`; `Ապրանքագրեր` -> `Հաշիվներ`; `Խնայողական ռեժիմ` -> `Էկոնոմ ռեժիմ`; `Համաժամացման` -> `Թարմացման`; `Օֆլայն պահեստ` -> `Օֆլայն հիշողություն`; `Bonuses` -> `Բոնուսներ`; `Այլ երկրից ներմուծված` -> `Առանց QR/ակցիզ`. Pattern: shorter, warmer, everyday words; no bureaucratic or machine-translated Armenian; "management" is always `ղեկավարություն`.

### 5.4 What they asked to be removed or never repeated
Favorites/stars (no decision value); Reorder button on undelivered orders (too many buttons); confirm dialogs; payment method on the first bottom sheet; the second green location banner (merged); Aral logo; hint paragraphs under cards; duplicated search fields; sticky customer cards; thick focus outlines; "Add products from another brand" duplicates once filters existed. Rule: when something is dropped, remove the module, API, i18n, CSS, tests and migration usage with it.

## 6. Proactive moves that always land well
- After a numbered list, add "Suggestions" (numbered, with recommendation) only if you saw something real while working; they usually reply "Implement 1, 2, 4".
- Offer a mock-up/variants only for genuine taste choices (they picked the Vaghinak page layout from 3 mock-ups).
- When you touch a screen, scan it for the owner's known pet peeves (section 5.1) and fix them in the same release, listed as "also fixed".
- When a request implies a new data flow, say which role is notified, what the automatic follow-up is, and which setting controls it.
- Offer the on-phone verification checklist ("Check on the iPhone: open X, expect Y") and the exact deploy command; mention whether a migration needs the FULL deploy.
- Tell the truth about gaps: what you could not test (real iPhone), what was already there, what you judged not worth building and why, and where your earlier claim was wrong.

## 7. Mistakes I made that cost them time (do not repeat)
- Claiming sheets "load before showing" without reading them (Add payment and the customer pickers already painted first): verify before you list.
- AskUserQuestion allows 4 options: a fifth candidate must be asked in a second call, not silently dropped.
- Asking questions that rely on earlier context ("Q3"): they forgot; restate everything.
- Forgetting that a new setting needs its App-configuration row, or that a new module needs `APP_SHELL`, or that a new i18n key needs `hy`.
- Fixing one instance of a pattern and leaving its siblings.
- Leaving the owner to discover a design rule I already knew (dark left outline, 44 px, "!" hints, right-aligned amounts).
