import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMonths,
  cancelCandidates,
  categoryBreakdown,
  convert,
  monthlyCost,
  normalizeSubscription,
  occurrencesInWindow,
  splitByMember,
  toCsv,
  totals,
  upcomingRenewals,
  validateSubscriptionInput,
} from "../logic.js";

const RATES = { asOf: "2026-10-01", base: "EUR", perEur: { EUR: 1, USD: 2, RSD: 100 } };
const anna = { uid: "a", name: "Аня" };
const sergey = { uid: "s", name: "Сергей" };

function sub(over) {
  return normalizeSubscription({
    name: "X",
    price: 10,
    currency: "EUR",
    category: "Видео",
    frequency: "monthly",
    nextChargeDate: "2026-11-01",
    cardName: "Card",
    cardLast4: "1234",
    createdBy: anna,
    ...over,
  });
}

test("normalize: legacy record defaults to USD / Другое; invalid rejected", () => {
  const legacy = normalizeSubscription({
    name: "Old", price: 5, frequency: "monthly", nextChargeDate: "2026-01-10", cardName: "C", cardLast4: "0000",
  });
  assert.equal(legacy.currency, "USD");
  assert.equal(legacy.category, "Другое");
  assert.equal(legacy.createdBy, null);
  assert.equal(normalizeSubscription({ ...legacy, cardLast4: "12" }), null);
  assert.equal(normalizeSubscription({ ...legacy, nextChargeDate: "2026-02-31" }), null);
  assert.equal(normalizeSubscription({ ...legacy, frequency: "custom-days", customDays: null }), null);
  assert.equal(normalizeSubscription({ ...legacy, currency: "XYZ" }).currency, "USD");
});

test("convert and monthly normalization", () => {
  assert.equal(convert(100, "RSD", "EUR", RATES), 1);
  assert.equal(convert(1, "EUR", "USD", RATES), 2);
  assert.equal(monthlyCost({ price: 120, frequency: "yearly" }), 10);
  assert.equal(monthlyCost({ price: 10, frequency: "monthly" }), 10);
  assert.ok(Math.abs(monthlyCost({ price: 30, frequency: "custom-days", customDays: 30 }) - 30.4167) < 0.001);
});

test("totals in one currency across mixed currencies", () => {
  const items = [
    sub({ price: 10, currency: "EUR" }),
    sub({ price: 1000, currency: "RSD" }), // 10 EUR
    sub({ price: 240, currency: "USD", frequency: "yearly" }), // 120 EUR / 12 = 10 EUR
  ];
  assert.deepEqual(totals(items, "EUR", RATES), { currency: "EUR", monthly: 30, yearly: 360 });
  assert.deepEqual(totals(items, "RSD", RATES), { currency: "RSD", monthly: 3000, yearly: 36000 });
  assert.deepEqual(totals([], "USD", RATES), { currency: "USD", monthly: 0, yearly: 0 });
});

test("addMonths clamps to month end", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
  assert.equal(addMonths("2024-02-29", 12), "2025-02-28");
});

test("occurrences: window bounds, rollover of past dates, endDate, custom days", () => {
  const today = "2026-10-29";
  assert.deepEqual(occurrencesInWindow(sub({ nextChargeDate: "2026-11-05" }), today, 7), ["2026-11-05"]);
  assert.deepEqual(occurrencesInWindow(sub({ nextChargeDate: "2026-11-06" }), today, 7), []);
  // прошедшая дата прокручивается на следующий месяц
  assert.deepEqual(occurrencesInWindow(sub({ nextChargeDate: "2026-09-30" }), today, 7), ["2026-10-30"]);
  // каждые 7 дней — несколько списаний в окне 30 дней
  const weekly = sub({ frequency: "custom-days", customDays: 7, nextChargeDate: "2026-10-29" });
  assert.equal(occurrencesInWindow(weekly, today, 30).length, 5);
  // endDate обрезает
  const ending = sub({ frequency: "custom-days", customDays: 7, nextChargeDate: "2026-10-29", endDate: "2026-11-10" });
  assert.deepEqual(occurrencesInWindow(ending, today, 30), ["2026-10-29", "2026-11-05"]);
});

test("upcomingRenewals sums converted amounts and sorts by date", () => {
  const today = "2026-10-29";
  const items = [
    sub({ name: "B", price: 500, currency: "RSD", nextChargeDate: "2026-11-03" }),
    sub({ name: "A", price: 4, currency: "USD", nextChargeDate: "2026-10-30" }),
    sub({ name: "Far", price: 99, nextChargeDate: "2027-01-01", frequency: "yearly" }),
  ];
  const r7 = upcomingRenewals(items, today, 7, "EUR", RATES);
  assert.deepEqual(r7.items.map((r) => r.sub.name), ["A", "B"]);
  assert.equal(r7.total, 7);
  assert.equal(r7.items[0].inDays, 1);
  assert.equal(upcomingRenewals(items, today, 30, "EUR", RATES).items.length, 2);
});

test("splitByMember and categoryBreakdown", () => {
  const items = [
    sub({ price: 30, createdBy: anna, category: "Видео" }),
    sub({ price: 10, createdBy: sergey, category: "Софт" }),
    sub({ price: 10, createdBy: anna, category: "Софт" }),
  ];
  const split = splitByMember(items, "EUR", RATES);
  assert.deepEqual(split.map((g) => [g.label, g.monthly, g.share, g.count]), [
    ["Аня", 40, 80, 2],
    ["Сергей", 10, 20, 1],
  ]);
  const cats = categoryBreakdown(items, "EUR", RATES);
  assert.deepEqual(cats.map((g) => [g.label, g.monthly]), [["Видео", 30], ["Софт", 20]]);
  assert.equal(splitByMember([sub({ createdBy: null })], "EUR", RATES)[0].label, "Не указан");
});

test("cancelCandidates: overlap, expensive, yearly-soon, stale", () => {
  const today = "2026-10-29";
  const items = [
    sub({ name: "Netflix", price: 10, category: "Видео", nextChargeDate: "2026-11-02" }),
    sub({ name: "Disney+", price: 120, frequency: "yearly", category: "Видео", nextChargeDate: "2026-11-20" }),
    sub({ name: "Gym", price: 60, category: "Спорт", nextChargeDate: "2026-11-10" }),
    sub({ name: "Old", price: 5, category: "Другое", nextChargeDate: "2026-10-01" }),
    sub({ name: "Misc", price: 5, category: "Другое", nextChargeDate: "2026-11-10" }),
  ];
  const hints = cancelCandidates(items, today, "EUR", RATES);
  const kinds = hints.map((h) => `${h.kind}:${h.subs.join("+")}`);
  assert.ok(kinds.includes("overlap:Netflix+Disney+"));
  assert.ok(kinds.includes("expensive:Gym"));
  assert.ok(kinds.includes("yearly-soon:Disney+"));
  assert.ok(kinds.includes("stale:Old"));
  assert.ok(!kinds.some((k) => k.startsWith("overlap:Old")), "«Другое» не считается пересечением");
  assert.deepEqual(cancelCandidates([], today, "EUR", RATES), []);
});

test("validateSubscriptionInput omits customDays for monthly (Firestore Rules) and checks extended fields", () => {
  const base = { name: "N", price: "9.99", frequency: "monthly", nextChargeDate: "2026-11-01", cardName: "C", cardLast4: "1234" };
  const { entry } = validateSubscriptionInput(base);
  assert.equal("customDays" in entry, false);
  assert.equal("currency" in entry, false);
  assert.equal(entry.price, 9.99);
  assert.equal(validateSubscriptionInput({ ...base, frequency: "custom-days", customDays: "14" }).entry.customDays, 14);
  assert.match(validateSubscriptionInput({ ...base, frequency: "custom-days", customDays: "0" }).error, /дней/);
  assert.match(validateSubscriptionInput({ ...base, price: "" }).error, /Цена/);
  assert.match(validateSubscriptionInput({ ...base, cardLast4: "12a4" }).error, /4 цифры/);
  assert.match(validateSubscriptionInput({ ...base, endDate: "2026-10-01" }).error, /окончания/);
  const ext = validateSubscriptionInput({ ...base, currency: "rsd", category: "Софт" }, { extendedFields: true });
  assert.equal(ext.entry.currency, "RSD");
  assert.match(validateSubscriptionInput({ ...base, currency: "GBP", category: "Софт" }, { extendedFields: true }).error, /валюту/);
});

test("toCsv: header, escaping and formula-injection guard", () => {
  const items = [sub({ name: '=HYPERLINK("x")', cardName: "Visa, gold", price: 7.5 })];
  const csv = toCsv(items, "EUR", RATES);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("name,category,price,currency"));
  assert.ok(lines[0].includes("monthly_EUR"));
  assert.ok(lines[1].startsWith(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines[1].includes('"Visa, gold"'));
  assert.ok(lines[1].endsWith(",2026-10-01"));
});
