import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_FAMILY_CODE, DEMO_MEMBERS, DEMO_STORAGE_KEY, createDemoService } from "../demo-service.js";
import * as firebaseLikeExports from "../demo-service.js";
import { CURRENCIES, normalizeSubscriptions, upcomingRenewals } from "../logic.js";

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

const NOW = () => new Date("2026-10-29T10:00:00Z");
const tick = () => new Promise((r) => setTimeout(r, 0));

test("exposes the same interface as firebase-service.js", () => {
  const required = [
    "hasFirebaseConfig", "initFirebase", "watchAuth", "loginWithGoogle", "logout", "isFamilyMember",
    "createInvite", "bootstrapSpaceOwner", "consumeInviteAndJoinFamily", "touchMembership",
    "watchSubscriptions", "createSubscription", "removeSubscription", "capabilities",
  ];
  for (const name of required) assert.ok(name in firebaseLikeExports, `missing export ${name}`);
});

test("seeds realistic data: mixed currencies, both members, renewals in 7 and 30 days", async () => {
  const svc = createDemoService({ storage: memStorage(), now: NOW });
  svc.initFirebase();
  let items = null;
  svc.watchSubscriptions(DEMO_FAMILY_CODE, (x) => (items = x));
  await tick();
  const subs = normalizeSubscriptions(items);
  assert.equal(subs.length, items.length, "все seed-подписки валидны");
  assert.ok(subs.length >= 10);
  assert.deepEqual([...new Set(subs.map((s) => s.currency))].sort(), [...CURRENCIES].sort());
  assert.deepEqual(new Set(subs.map((s) => s.frequency)), new Set(["monthly", "yearly", "custom-days"]));
  assert.equal(new Set(subs.map((s) => s.createdBy.uid)).size, 2);
  assert.ok(upcomingRenewals(subs, "2026-10-29", 7, "EUR").items.length >= 2);
  assert.ok(upcomingRenewals(subs, "2026-10-29", 30, "EUR").items.length >= 8);
  // отсортировано по дате
  const dates = items.map((s) => s.nextChargeDate);
  assert.deepEqual(dates, [...dates].sort());
});

test("auth: signed in as first member, switchUser and logout notify listeners", async () => {
  const svc = createDemoService({ storage: memStorage(), now: NOW });
  const seen = [];
  svc.watchAuth((u) => seen.push(u ? u.uid : null));
  await tick();
  await svc.switchUser(DEMO_MEMBERS[1].uid);
  await svc.logout();
  await svc.loginWithGoogle();
  assert.deepEqual(seen, ["demo-sergey", "demo-anya", null, "demo-anya"]);
});

test("create/remove subscription persist to storage and notify watchers", async () => {
  const storage = memStorage();
  const svc = createDemoService({ storage, now: NOW });
  const user = DEMO_MEMBERS[1];
  let last = [];
  svc.watchSubscriptions(DEMO_FAMILY_CODE, (x) => (last = x));
  await tick();
  const before = last.length;
  await svc.createSubscription(DEMO_FAMILY_CODE, {
    name: "Test", price: 1, currency: "RSD", category: "Другое", frequency: "monthly",
    nextChargeDate: "2026-11-01", cardName: "C", cardLast4: "1111", endDate: null,
  }, user);
  assert.equal(last.length, before + 1);
  const created = last.find((s) => s.name === "Test");
  assert.equal(created.createdBy.uid, user.uid);

  // новый экземпляр с тем же storage видит данные (persist)
  const svc2 = createDemoService({ storage, now: NOW });
  let reloaded = [];
  svc2.watchSubscriptions(DEMO_FAMILY_CODE, (x) => (reloaded = x));
  await tick();
  assert.equal(reloaded.length, before + 1);

  await svc.removeSubscription(DEMO_FAMILY_CODE, created.id);
  assert.equal(last.length, before);

  await assert.rejects(
    svc.createSubscription(DEMO_FAMILY_CODE, { name: "", price: 1, frequency: "monthly" }, user),
    (e) => e.code === "invalid-argument"
  );
});

test("unsubscribe stops notifications", async () => {
  const svc = createDemoService({ storage: memStorage(), now: NOW });
  let calls = 0;
  const stop = svc.watchSubscriptions(DEMO_FAMILY_CODE, () => (calls += 1));
  await tick();
  stop();
  await svc.removeSubscription(DEMO_FAMILY_CODE, "demo-01");
  assert.equal(calls, 1);
});

test("spaces and invites mirror the real flow (bootstrap, invite, limits, membership)", async () => {
  const svc = createDemoService({ storage: memStorage(), now: NOW });
  const [sergey, anya] = DEMO_MEMBERS;
  await svc.bootstrapSpaceOwner("NEWSPC", sergey);
  assert.equal(await svc.isFamilyMember("NEWSPC", sergey.uid), true);
  await assert.rejects(svc.bootstrapSpaceOwner("NEWSPC", anya), /BOOTSTRAP_NOT_ALLOWED/);
  await assert.rejects(svc.touchMembership("NEWSPC", anya), (e) => e.code === "permission-denied");
  await assert.rejects(
    svc.createSubscription("NEWSPC", { name: "x" }, anya),
    (e) => e.code === "permission-denied"
  );
  await assert.rejects(svc.consumeInviteAndJoinFamily("NEWSPC", "NOPE000000", anya), /INVITE_NOT_FOUND/);
  await svc.createInvite("NEWSPC", sergey, "INVITE00001", 1, 72);
  await svc.consumeInviteAndJoinFamily("NEWSPC", "INVITE00001", anya);
  assert.equal(await svc.isFamilyMember("NEWSPC", anya.uid), true);
  const stranger = { uid: "x", displayName: "X" };
  await assert.rejects(svc.consumeInviteAndJoinFamily("NEWSPC", "INVITE00001", stranger), /INVITE_LIMIT/);
});

test("expired invite is rejected", async () => {
  const storage = memStorage();
  const svc = createDemoService({ storage, now: NOW });
  const [sergey] = DEMO_MEMBERS;
  await svc.createInvite(DEMO_FAMILY_CODE, sergey, "INVITE00009", 1, 1);
  const later = createDemoService({ storage, now: () => new Date("2026-10-30T12:00:00Z") });
  await assert.rejects(later.consumeInviteAndJoinFamily(DEMO_FAMILY_CODE, "INVITE00009", { uid: "x" }), /INVITE_EXPIRED/);
});

test("resetDemo restores seed; corrupted storage is reseeded", async () => {
  const storage = memStorage();
  const svc = createDemoService({ storage, now: NOW });
  await svc.removeSubscription(DEMO_FAMILY_CODE, "demo-01");
  await svc.resetDemo();
  assert.ok(svc.getState().spaces[DEMO_FAMILY_CODE].subscriptions.some((s) => s.id === "demo-01"));
  storage.setItem(DEMO_STORAGE_KEY, "{not json");
  assert.equal(createDemoService({ storage, now: NOW }).getState().version, 1);
});
