// Owner's wording rules for Vaghinak (2026-10-27, chose A1 B1 C1 D1; see the header of phrases.js). Every line of the bank is checked, so
// a new wording that breaks a rule fails here before it reaches a rep.
import test from "node:test";
import assert from "node:assert/strict";
import { pickVariant, variantCount } from "../src/team/vaghinak/phrases.js";

const BANK_SHAPE = {
  late_start: { 1: ["rep"] },
  not_started: { 1: ["rep"], 2: ["rep"] },
  office_long: { 1: ["rep"], 2: ["rep"] },
  stopped_early: { 1: ["rep"], 2: ["rep"] },
  day_wrap_high: { 1: ["rep"] },
  day_wrap_mid: { 1: ["rep"] },
  day_wrap_low: { 1: ["rep"] },
  day_wrap_free: { 1: ["rep"] },
  data_chase: { 1: ["rep"] },
  data_chase_owner: { 1: ["management"] },
  downpayment_due: { 1: ["rep"] },
  downpayment_overdue: { 1: ["management"] },
  order_waiting_confirm: { 1: ["management"] },
  order_waiting_pack: { 1: ["management"] },
  order_waiting_escalation: { 1: ["management"] },
  cluster_skip: { 1: ["rep"], 2: ["rep"] },
  week_high: { 1: ["rep"] },
  week_mid: { 1: ["rep"] },
  week_low: { 1: ["rep"] },
  week_free: { 1: ["rep"] },
  week_mgmt_quiet: { 1: ["management"] },
  week_mgmt_issues: { 1: ["management"] },
  mgmt_brief_quiet: { 1: ["management"] },
  mgmt_brief_issues: { 1: ["management"] },
};
const ctx = { addr: "Արտակ", late: "20 րոպե", time: "11:30", dur: "2 ժամ", n: 3, idle: "1 ժամ", done: 4, planned: 8, pct: 50, days: 4, k: 2, names: "", items: "", stats: "", list: "", lateNote: "" };

// Every template of the bank, with (kind, level, audience).
function* everyLine() {
  for (const [kind, levels] of Object.entries(BANK_SHAPE)) {
    for (const [level, audiences] of Object.entries(levels)) {
      for (const audience of audiences) {
        const total = variantCount(kind, Number(level), audience);
        assert.ok(total > 0, `${kind}/${level}/${audience} has wordings`);
        const used = [];
        for (let i = 0; i < total; i++) {
          const { text, variant } = pickVariant(kind, Number(level), audience, ctx, used);
          used.push(variant);
          yield { kind, level: Number(level), audience, text };
        }
      }
    }
  }
}
// The sentences of a message: what stands before the list part (a {names}/{items}/{stats}/{list} placeholder goes under a newline).
const sentencesOf = (text) =>
  text
    .split("\n")[0]
    .split(/[։]/)
    .map((s) => s.trim())
    .filter(Boolean);

test("A1: 'խնդրում եմ' only in the level-2 (insisting) lines", () => {
  for (const l of everyLine()) {
    if (l.level === 1) assert.ok(!/խնդրում եմ/i.test(l.text), `${l.kind}/1: "${l.text}"`);
  }
});

test("B1: low results state the fact and one step, without mood words", () => {
  const mood = /վատ չէր|հեշտ չէր|քիչ է|միասին կլուծենք|կփորձենք/;
  for (const l of everyLine()) {
    if (["day_wrap_low", "week_low", "day_wrap_mid", "week_mid"].includes(l.kind)) assert.ok(!mood.test(l.text), `${l.kind}: "${l.text}"`);
  }
});

test("C1: at most two sentences per message (the list part goes below)", () => {
  for (const l of everyLine()) {
    const n = sentencesOf(l.text).length;
    assert.ok(n <= 2, `${l.kind}/${l.level}/${l.audience} has ${n} sentences: "${l.text}"`);
  }
});

test("D1: the Monday opener is 'Բարի շաբաթ' wherever a greeting is used", () => {
  for (const l of everyLine()) {
    if (/շաբաթ է,|Նոր շաբաթ/.test(l.text)) assert.fail(`${l.kind}: "${l.text}"`);
    if (l.kind.startsWith("week_") && l.audience === "rep" && /^Բարի/.test(l.text)) assert.ok(l.text.startsWith("Բարի շաբաթ, "), l.text);
  }
});
