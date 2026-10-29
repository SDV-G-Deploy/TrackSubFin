// Тесты Firestore Rules. Запуск только против эмулятора (offline-проект demo-*):
//   npm run test:rules:emulator
// или вручную:
//   firebase emulators:exec --only firestore --project demo-tracksubfin "npm run test:rules"
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rules = await fs.readFile(path.resolve(__dirname, "../firestore.rules"), "utf8");

const testEnv = await initializeTestEnvironment({
  projectId: "demo-tracksubfin",
  firestore: { rules },
});

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

const SPACE = "spaces/FAM123";
const ownerBy = { uid: "owner-uid", email: "owner@example.com", name: "Owner" };
const partnerBy = { uid: "partner-uid", email: "partner@example.com", name: "Partner" };

// Форма, которую отправляет клиент без расширенных полей (старые записи).
const baseSub = {
  name: "Netflix",
  price: 9.99,
  frequency: "monthly",
  nextChargeDate: "2026-11-01",
  cardName: "Visa",
  cardLast4: "1234",
  endDate: null,
  createdAt: new Date(),
  createdBy: ownerBy,
};
const extSub = { ...baseSub, currency: "EUR", category: "Видео" };

async function run() {
  await testEnv.clearFirestore();

  const owner = testEnv.authenticatedContext("owner-uid").firestore();
  const partner = testEnv.authenticatedContext("partner-uid").firestore();
  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();
  const anon = testEnv.unauthenticatedContext().firestore();

  // --- membership / bootstrap ---

  await check("owner bootstraps meta/access for a new space", () =>
    assertSucceeds(owner.doc(`${SPACE}/meta/access`).set({ ownerUid: "owner-uid", createdAt: new Date() }))
  );

  await check("owner creates own member doc with OWNER_BOOTSTRAP", () =>
    assertSucceeds(
      owner.doc(`${SPACE}/members/owner-uid`).set({
        uid: "owner-uid",
        email: "owner@example.com",
        name: "Owner",
        inviteCode: "OWNER_BOOTSTRAP",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    )
  );

  await check("stranger cannot self-join by familyCode only", () =>
    assertFails(
      stranger.doc(`${SPACE}/members/stranger-uid`).set({
        uid: "stranger-uid",
        email: "x@example.com",
        name: "X",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    )
  );

  await check("stranger cannot claim OWNER_BOOTSTRAP for someone else's space", () =>
    assertFails(
      stranger.doc(`${SPACE}/members/stranger-uid`).set({
        uid: "stranger-uid",
        email: null,
        name: null,
        inviteCode: "OWNER_BOOTSTRAP",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    )
  );

  // partner — второй участник (как будто вошёл по инвайту); сидируем в обход правил
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`${SPACE}/members/partner-uid`).set({
      uid: "partner-uid",
      email: "partner@example.com",
      name: "Partner",
      inviteCode: "SEEDEDINVITE1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  // --- subscriptions: create ---

  await check("non-member cannot read subscriptions", () =>
    assertFails(stranger.doc(`${SPACE}/subscriptions/ok1`).get())
  );
  await check("unauthenticated cannot read subscriptions", () =>
    assertFails(anon.collection(`${SPACE}/subscriptions`).get())
  );

  await check("member creates legacy subscription without currency/category", () =>
    assertSucceeds(owner.doc(`${SPACE}/subscriptions/ok1`).set(baseSub))
  );

  await check("member creates subscription with valid currency + category", () =>
    assertSucceeds(owner.doc(`${SPACE}/subscriptions/ok2`).set(extSub))
  );

  for (const currency of ["USD", "RSD"]) {
    await check(`currency ${currency} accepted`, () =>
      assertSucceeds(owner.doc(`${SPACE}/subscriptions/cur-${currency}`).set({ ...baseSub, currency }))
    );
  }

  await check("only currency (no category) accepted", () =>
    assertSucceeds(owner.doc(`${SPACE}/subscriptions/ok3`).set({ ...baseSub, currency: "RSD" }))
  );
  await check("only category (no currency) accepted", () =>
    assertSucceeds(owner.doc(`${SPACE}/subscriptions/ok4`).set({ ...baseSub, category: "Другое" }))
  );

  await check("member can read subscriptions", () =>
    assertSucceeds(partner.doc(`${SPACE}/subscriptions/ok2`).get())
  );

  const invalidCurrencies = [["GBP"], ["eur"], [""], [null], [978], [["EUR"]]];
  for (const [currency] of invalidCurrencies) {
    await check(`invalid currency ${JSON.stringify(currency)} rejected`, () =>
      assertFails(owner.doc(`${SPACE}/subscriptions/badcur`).set({ ...extSub, currency }))
    );
  }

  const invalidCategories = [["Games"], ["видео"], ["Видео "], [""], [null], [1]];
  for (const [category] of invalidCategories) {
    await check(`invalid category ${JSON.stringify(category)} rejected`, () =>
      assertFails(owner.doc(`${SPACE}/subscriptions/badcat`).set({ ...extSub, category }))
    );
  }

  await check("extra top-level field rejected", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/extra1`).set({ ...extSub, notes: "hi" }))
  );
  await check("extra field next to legacy shape rejected", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/extra2`).set({ ...baseSub, isAdmin: true }))
  );
  await check("extra field in createdBy rejected", () =>
    assertFails(
      owner.doc(`${SPACE}/subscriptions/extra3`).set({ ...extSub, createdBy: { ...ownerBy, role: "admin" } })
    )
  );

  await check("customDays: null for monthly rejected (client must omit the key)", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/bad1`).set({ ...extSub, customDays: null }))
  );
  await check("custom-days with customDays accepted", () =>
    assertSucceeds(
      owner.doc(`${SPACE}/subscriptions/ok5`).set({ ...extSub, frequency: "custom-days", customDays: 28 })
    )
  );

  await check("member cannot spoof createdBy.uid", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/spoof`).set({ ...extSub, createdBy: partnerBy }))
  );

  await check("non-member cannot create even a valid extended subscription", () =>
    assertFails(
      stranger.doc(`${SPACE}/subscriptions/bad3`).set({
        ...extSub,
        createdBy: { uid: "stranger-uid", email: null, name: null },
      })
    )
  );

  // --- subscriptions: update ---

  await check("creator updates currency/category on legacy doc", () =>
    assertSucceeds(owner.doc(`${SPACE}/subscriptions/ok1`).update({ currency: "RSD", category: "Видео", price: 1290 }))
  );
  await check("creator update with invalid currency rejected", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/ok1`).update({ currency: "BTC" }))
  );
  await check("creator update with invalid category rejected", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/ok1`).update({ category: "Crypto" }))
  );
  await check("creator update adding extra field rejected", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/ok1`).update({ shared: true }))
  );
  await check("update cannot change createdAt", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/ok1`).update({ createdAt: new Date(2000, 0, 1) }))
  );
  await check("other member cannot edit someone else's subscription", () =>
    assertFails(partner.doc(`${SPACE}/subscriptions/ok1`).update({ category: "Музыка" }))
  );
  await check("non-member cannot update", () =>
    assertFails(stranger.doc(`${SPACE}/subscriptions/ok1`).update({ category: "Музыка" }))
  );

  // --- subscriptions: delete ---

  await check("non-member cannot delete", () => assertFails(stranger.doc(`${SPACE}/subscriptions/ok2`).delete()));
  await check("member can delete", () => assertSucceeds(partner.doc(`${SPACE}/subscriptions/ok2`).delete()));

  await testEnv.cleanup();
}

run().then(
  () => {
    for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      for (const f of failed) console.error(`\n${f.name}:\n`, f.error?.message || f.error);
      console.error(`\n${failed.length}/${results.length} rules tests failed`);
      process.exit(1);
    }
    console.log(`\nall ${results.length} rules tests passed`);
  },
  async (err) => {
    console.error(err);
    await testEnv.cleanup();
    process.exit(1);
  }
);
