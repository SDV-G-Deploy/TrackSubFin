// Тесты PRODUCTION firestore.rules (то, что задеплоено в Firebase) против записей, которые
// реально отправляет приложение в режиме Firebase. Ключевая проверка безопасности мержа:
// если тут что-то падает — сайт после деплоя на Pages сломается на живых rules.
//
// Запуск только против эмулятора (offline-проект demo-*):
//   npm run test:rules:emulator
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import { buildSubscriptionDoc, buildSubscriptionPatch, validateSubscriptionInput } from "../logic.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rules = await fs.readFile(path.resolve(__dirname, "../firestore.rules"), "utf8");

// firebase-service.js импортирует SDK с gstatic и в Node не грузится — читаем флаг из исходника,
// чтобы тест проверял ровно ту конфигурацию, которая уйдёт на сайт.
const serviceSrc = await fs.readFile(path.resolve(__dirname, "../firebase-service.js"), "utf8");
const flag = serviceSrc.match(/export const capabilities = \{[^}]*extendedFields:\s*(true|false)/);
if (!flag) throw new Error("не найден capabilities.extendedFields в firebase-service.js");
const REAL_MODE_EXTENDED = flag[1] === "true";

const { serverTimestamp, delete: deleteField, increment } = firebase.firestore.FieldValue;

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
// Пользователь как его отдаёт Firebase Auth (displayName, а не name).
const ownerUser = { uid: "owner-uid", email: "owner@example.com", displayName: "Owner" };
const partnerUser = { uid: "partner-uid", email: null, displayName: null };

// Сырые значения формы (FormData → Object.fromEntries): все поля — строки, скрытые поля тоже
// присутствуют (customDays: "" для monthly/yearly, currency/category из скрытых select).
const FORM = {
  monthly: {
    name: "Netflix", price: "9.99", currency: "EUR", category: "Видео", frequency: "monthly",
    customDays: "", nextChargeDate: "2026-11-01", cardName: "Visa", cardLast4: "1234", endDate: "",
  },
  yearly: {
    name: "iCloud", price: "29", currency: "USD", category: "Облако", frequency: "yearly",
    customDays: "", nextChargeDate: "2027-02-15", cardName: "Master", cardLast4: "0042", endDate: "2028-02-15",
  },
  custom: {
    name: "Gym", price: "1290", currency: "RSD", category: "Спорт", frequency: "custom-days",
    customDays: "28", nextChargeDate: "2026-11-05", cardName: "Dina", cardLast4: "9876", endDate: "",
  },
};

function realEntry(input) {
  const { entry, error } = validateSubscriptionInput(input, { extendedFields: REAL_MODE_EXTENDED });
  if (error) throw new Error(`validateSubscriptionInput: ${error}`);
  return entry;
}

async function run() {
  await testEnv.clearFirestore();

  const owner = testEnv.authenticatedContext("owner-uid").firestore();
  const partner = testEnv.authenticatedContext("partner-uid").firestore();
  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();

  await check("real mode does not send currency/category (extendedFields=false)", async () => {
    if (REAL_MODE_EXTENDED) throw new Error("extendedFields=true, но production rules не принимают currency/category");
    for (const input of Object.values(FORM)) {
      const entry = realEntry(input);
      if ("currency" in entry || "category" in entry) throw new Error("лишние ключи в payload");
    }
  });

  await check("real mode monthly/yearly payload has no customDays key", async () => {
    for (const k of ["monthly", "yearly"]) {
      if ("customDays" in realEntry(FORM[k])) throw new Error(`${k}: customDays в payload`);
    }
  });

  // --- membership flow как в firebase-service.js (bootstrapSpaceOwner) ---

  await check("app: owner bootstrap meta/access", () =>
    assertSucceeds(owner.doc(`${SPACE}/meta/access`).set({ ownerUid: "owner-uid", createdAt: serverTimestamp() }))
  );
  await check("app: owner bootstrap member doc", () =>
    assertSucceeds(
      owner.doc(`${SPACE}/members/owner-uid`).set({
        uid: "owner-uid",
        email: ownerUser.email,
        name: ownerUser.displayName,
        inviteCode: "OWNER_BOOTSTRAP",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    )
  );
  await check("app: touchMembership update", () =>
    assertSucceeds(
      owner.doc(`${SPACE}/members/owner-uid`).update({
        email: ownerUser.email,
        name: ownerUser.displayName,
        updatedAt: serverTimestamp(),
      })
    )
  );

  // --- invite flow (createInvite + consumeInviteAndJoinFamily) ---

  const INVITE = "ABCDEFGHJK12";
  await check("app: createInvite", () =>
    assertSucceeds(
      owner.doc(`${SPACE}/invites/${INVITE}`).set({
        createdAt: serverTimestamp(),
        createdBy: { uid: "owner-uid", email: ownerUser.email, name: ownerUser.displayName },
        expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
        maxUses: 1,
        usedCount: 0,
        usedBy: null,
        usedAt: null,
      })
    )
  );
  await check("app: partner joins via invite (batch)", () => {
    const batch = partner.batch();
    batch.set(partner.doc(`${SPACE}/members/partner-uid`), {
      uid: "partner-uid",
      email: null,
      name: null,
      inviteCode: INVITE,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.update(partner.doc(`${SPACE}/invites/${INVITE}`), {
      usedCount: increment(1),
      usedBy: "partner-uid",
      usedAt: serverTimestamp(),
    });
    return assertSucceeds(batch.commit());
  });

  // --- subscriptions: create (createSubscription → addDoc(buildSubscriptionDoc(...))) ---

  const ids = {};
  for (const [kind, input] of Object.entries(FORM)) {
    await check(`app create ${kind} accepted by production rules`, async () => {
      const ref = await assertSucceeds(
        owner.collection(`${SPACE}/subscriptions`).add(buildSubscriptionDoc(realEntry(input), ownerUser, serverTimestamp()))
      );
      ids[kind] = ref.id;
    });
  }
  await check("app create by partner (null email/name) accepted", () =>
    assertSucceeds(
      partner
        .collection(`${SPACE}/subscriptions`)
        .add(buildSubscriptionDoc(realEntry(FORM.monthly), partnerUser, serverTimestamp()))
    )
  );
  await check("member reads subscriptions", () => assertSucceeds(partner.collection(`${SPACE}/subscriptions`).get()));

  // --- subscriptions: edit (updateSubscription → updateDoc(buildSubscriptionPatch(...))) ---

  const edit = (db, id, input) =>
    db.doc(`${SPACE}/subscriptions/${id}`).update(buildSubscriptionPatch(realEntry(input), deleteField()));

  await check("app edit monthly: change price/name accepted", () =>
    assertSucceeds(edit(owner, ids.monthly, { ...FORM.monthly, name: "Netflix Premium", price: "15.49" }))
  );
  await check("app edit monthly → custom-days accepted", () =>
    assertSucceeds(edit(owner, ids.monthly, { ...FORM.monthly, frequency: "custom-days", customDays: "30" }))
  );
  await check("app edit custom-days → monthly (customDays deleted) accepted", () =>
    assertSucceeds(edit(owner, ids.monthly, { ...FORM.monthly, frequency: "monthly", customDays: "30" }))
  );
  await check("app edit custom → yearly accepted", () =>
    assertSucceeds(edit(owner, ids.custom, { ...FORM.custom, frequency: "yearly" }))
  );
  await check("app edit yearly: set/clear endDate accepted", async () => {
    await assertSucceeds(edit(owner, ids.yearly, { ...FORM.yearly, endDate: "" }));
    await assertSucceeds(edit(owner, ids.yearly, { ...FORM.yearly, endDate: "2030-01-01" }));
  });
  await check("app edit of someone else's subscription rejected (UI hides the button)", () =>
    assertFails(edit(partner, ids.yearly, FORM.yearly))
  );
  await check("non-member cannot edit", () => assertFails(edit(stranger, ids.yearly, FORM.yearly)));

  // --- почему extendedFields должен быть false, пока не задеплоен firestore.rules.next ---

  const extended = validateSubscriptionInput(FORM.monthly, { extendedFields: true }).entry;
  await check("production rules reject currency/category on create", () =>
    assertFails(owner.collection(`${SPACE}/subscriptions`).add(buildSubscriptionDoc(extended, ownerUser, serverTimestamp())))
  );
  await check("production rules reject currency/category on edit", () =>
    assertFails(owner.doc(`${SPACE}/subscriptions/${ids.yearly}`).update({ currency: "EUR" }))
  );
  await check("production rules reject customDays: null for monthly (old client bug)", () =>
    assertFails(
      owner
        .collection(`${SPACE}/subscriptions`)
        .add(buildSubscriptionDoc({ ...realEntry(FORM.monthly), customDays: null }, ownerUser, serverTimestamp()))
    )
  );
  await check("non-member cannot create", () =>
    assertFails(
      stranger
        .collection(`${SPACE}/subscriptions`)
        .add(buildSubscriptionDoc(realEntry(FORM.monthly), { uid: "stranger-uid" }, serverTimestamp()))
    )
  );

  // --- delete ---

  await check("non-member cannot delete", () => assertFails(stranger.doc(`${SPACE}/subscriptions/${ids.custom}`).delete()));
  await check("member deletes", () => assertSucceeds(partner.doc(`${SPACE}/subscriptions/${ids.custom}`).delete()));

  await testEnv.cleanup();
}

run().then(
  () => {
    for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      for (const f of failed) console.error(`\n${f.name}:\n`, f.error?.message || f.error);
      console.error(`\n${failed.length}/${results.length} production rules tests failed`);
      process.exit(1);
    }
    console.log(`\nall ${results.length} production rules tests passed (firestore.rules)`);
  },
  async (err) => {
    console.error(err);
    await testEnv.cleanup();
    process.exit(1);
  }
);
