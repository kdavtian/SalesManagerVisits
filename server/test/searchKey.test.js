// Search in both scripts (client/public/js/shared/searchKey.js; owner, 2026-10-29): Armenian and Latin spellings of one name find each other,
// a word of 5+ letters with one letter wrong still finds it, and the exact text ranks above the other kinds.
import test from "node:test";
import assert from "node:assert/strict";
import { soundKey, prepareSearchText, matchKind, TYPO_MIN_LETTERS } from "../../client/public/js/shared/searchKey.js";

test("the owner's examples and common names sound the same in both scripts", () => {
  const pairs = [
    ["jrvej", "ջրվեժ"], ["artak", "արտակ"], ["kastrol", "կաստրոլ"], ["castrol", "կաստրոլ"], ["qastrol", "Կաստրոլ"],
    ["yerevan", "Երևան"], ["shirak", "Շիրակ"], ["tsaghkadzor", "Ծաղկաձոր"], ["gyumri", "Գյումրի"], ["zhora", "Ժորա"],
    ["khachatryan", "Խաչատրյան"], ["Hovhannisyan", "Հովհաննիսյան"], ["Gevorg", "Գևորգ"], ["chaykovski", "Չայկովսկի"],
  ];
  for (const [latin, armenian] of pairs) assert.equal(soundKey(latin), soundKey(armenian), `${latin} = ${armenian}`);
  assert.notEqual(soundKey("sar"), soundKey("շար"), "s and sh stay apart");
});

test("match kinds: exact 3, the other script 2, one letter off 1, none 0", () => {
  const text = prepareSearchText("Castrol Point Komitas Ջրվեժ Ավտո");
  assert.equal(matchKind(text, "castrol"), 3);
  assert.equal(matchKind(text, "ջրվեժ"), 3);
  assert.equal(matchKind(text, "կաստրոլ"), 2);
  assert.equal(matchKind(text, "jrvezh"), 2);
  assert.equal(matchKind(text, "kastrl"), 1, "a missing letter");
  assert.equal(matchKind(text, "komitaz"), 1, "a wrong letter");
  assert.equal(matchKind(text, "castrol jrvej"), 2, "every word must match; the weakest decides");
  assert.equal(matchKind(text, "castrol nothing"), 0);
  assert.equal(matchKind(text, ""), 3);
});

test("short words never match with a typo (too many false hits)", () => {
  const text = prepareSearchText("Arpi Avtoservis");
  assert.equal(TYPO_MIN_LETTERS, 5);
  assert.equal(matchKind(text, "arpa"), 0);
  assert.equal(matchKind(text, "avtosrvis"), 1, "a missing letter in a long word");
});
