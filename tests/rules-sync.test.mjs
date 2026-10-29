// Списки валют и категорий в firestore.rules должны совпадать с logic.js,
// иначе форма отправит значение, которое rules отклонят (или наоборот).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CATEGORIES, CURRENCIES } from "../logic.js";

const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");

function listAfter(marker) {
  const re = new RegExp(`${marker.replace(/\./g, "\\.")}\\s+in\\s+\\[([^\\]]*)\\]`);
  const m = rules.match(re);
  assert.ok(m, `в firestore.rules нет "${marker} in [...]"`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

test("rules currency enum matches logic.CURRENCIES", () => {
  assert.deepEqual(listAfter("data.currency"), CURRENCIES);
});

test("rules category enum matches logic.CATEGORIES", () => {
  assert.deepEqual(listAfter("data.category"), CATEGORIES);
});

test("rules allow currency/category keys", () => {
  assert.match(rules, /'currency', 'category'/);
});
