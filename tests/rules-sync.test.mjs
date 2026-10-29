// Списки валют и категорий в firestore.rules.next (будущие rules) должны совпадать с logic.js,
// иначе форма отправит значение, которое rules отклонят (или наоборот).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CATEGORIES, CURRENCIES } from "../logic.js";

const rules = fs.readFileSync(new URL("../firestore.rules.next", import.meta.url), "utf8");

function listAfter(marker) {
  const re = new RegExp(`${marker.replace(/\./g, "\\.")}\\s+in\\s+\\[([^\\]]*)\\]`);
  const m = rules.match(re);
  assert.ok(m, `в firestore.rules.next нет "${marker} in [...]"`);
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

// Защита от поломки живого сайта: Pages деплоится при мерже, а rules — вручную.
// firestore.rules = то, что задеплоено. Если клиент шлёт currency/category, rules обязаны их принимать.
const prodRules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const serviceSrc = fs.readFileSync(new URL("../firebase-service.js", import.meta.url), "utf8");

test("firebase-service extendedFields matches deployed firestore.rules", () => {
  const m = serviceSrc.match(/export const capabilities = \{[^}]*extendedFields:\s*(true|false)/);
  assert.ok(m, "не найден capabilities.extendedFields в firebase-service.js");
  const rulesAcceptExtended = /'currency', 'category'/.test(prodRules);
  if (m[1] === "true") {
    assert.ok(rulesAcceptExtended, "extendedFields=true, но firestore.rules не принимает currency/category");
  } else {
    assert.ok(!rulesAcceptExtended, "firestore.rules уже принимает currency/category — можно включить extendedFields");
  }
});
