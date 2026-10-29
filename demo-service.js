// Демо-адаптер данных: тот же интерфейс, что у firebase-service.js,
// но всё хранится в localStorage этого браузера. Никаких сетевых запросов.
import { addDays, normalizeSubscription, todayIso } from "./logic.js";

export const DEMO_STORAGE_KEY = "tracksubfin.demo.v1";
export const DEMO_FAMILY_CODE = "DEMO01";

export const DEMO_MEMBERS = [
  { uid: "demo-sergey", displayName: "Сергей", email: "sergey@demo.local", photoURL: null },
  { uid: "demo-anya", displayName: "Аня", email: "anya@demo.local", photoURL: null },
];

export const capabilities = { mode: "demo", extendedFields: true };

function appError(message, code = null) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function by(member) {
  return { uid: member.uid, email: member.email, name: member.displayName };
}

/** Набор демо-подписок; даты считаются от today, чтобы «ближайшие списания» всегда были заполнены. */
export function buildSeedSubscriptions(today) {
  const [sergey, anya] = DEMO_MEMBERS;
  const d = (n) => addDays(today, n);
  const raiff = { cardName: "Raiffeisen Visa", cardLast4: "4821" };
  const revolut = { cardName: "Revolut", cardLast4: "1093" };
  const intesa = { cardName: "Intesa Mastercard", cardLast4: "5530" };
  const list = [
    { name: "Netflix Standard", price: 13.49, currency: "EUR", category: "Видео", frequency: "monthly", nextChargeDate: d(2), ...revolut, createdBy: by(anya) },
    { name: "Wolt+", price: 449, currency: "RSD", category: "Доставка", frequency: "custom-days", customDays: 28, nextChargeDate: d(3), ...intesa, createdBy: by(anya) },
    { name: "YouTube Premium Family", price: 1199, currency: "RSD", category: "Видео", frequency: "monthly", nextChargeDate: d(5), ...raiff, createdBy: by(sergey) },
    { name: "iCloud+ 200 GB", price: 2.99, currency: "USD", category: "Облако", frequency: "monthly", nextChargeDate: d(9), ...revolut, createdBy: by(sergey) },
    { name: "Spotify Duo", price: 7.99, currency: "EUR", category: "Музыка", frequency: "monthly", nextChargeDate: d(12), ...revolut, createdBy: by(anya) },
    { name: "ChatGPT Plus", price: 20, currency: "USD", category: "Софт", frequency: "monthly", nextChargeDate: d(18), ...revolut, createdBy: by(sergey) },
    { name: "Мобильный тариф Yettel", price: 2499, currency: "RSD", category: "Связь", frequency: "monthly", nextChargeDate: d(21), ...intesa, createdBy: by(anya) },
    { name: "Disney+", price: 89.9, currency: "EUR", category: "Видео", frequency: "yearly", nextChargeDate: d(24), ...revolut, createdBy: by(anya) },
    { name: "Фитнес-клуб", price: 4900, currency: "RSD", category: "Спорт", frequency: "monthly", nextChargeDate: d(26), ...intesa, createdBy: by(anya) },
    { name: "Adobe Lightroom", price: 11.99, currency: "USD", category: "Софт", frequency: "monthly", nextChargeDate: d(14), endDate: d(75), ...raiff, createdBy: by(sergey) },
    { name: "JetBrains All Products", price: 289, currency: "USD", category: "Софт", frequency: "yearly", nextChargeDate: d(140), ...raiff, createdBy: by(sergey) },
    { name: "1Password Families", price: 59.88, currency: "USD", category: "Софт", frequency: "yearly", nextChargeDate: d(201), ...raiff, createdBy: by(sergey) },
  ];
  return list.map((s, i) => ({
    id: `demo-${String(i + 1).padStart(2, "0")}`,
    customDays: null,
    endDate: null,
    createdAt: `${today}T09:00:00.000Z`,
    ...s,
  }));
}

export function buildSeedState(today) {
  const [sergey, anya] = DEMO_MEMBERS;
  const member = (m, inviteCode) => ({
    uid: m.uid,
    email: m.email,
    name: m.displayName,
    inviteCode,
    createdAt: `${today}T09:00:00.000Z`,
  });
  return {
    version: 1,
    seededOn: today,
    activeUid: sergey.uid,
    signedIn: true,
    seq: 100,
    spaces: {
      [DEMO_FAMILY_CODE]: {
        ownerUid: sergey.uid,
        members: { [sergey.uid]: member(sergey, "OWNER_BOOTSTRAP"), [anya.uid]: member(anya, "DEMOINVITE01") },
        invites: {},
        subscriptions: buildSeedSubscriptions(today),
      },
    },
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/**
 * Фабрика адаптера. storage — объект с getItem/setItem/removeItem (localStorage в браузере),
 * now — функция текущего времени (для тестов).
 */
export function createDemoService({ storage, now = () => new Date(), eventTarget = null } = {}) {
  const store = storage || memoryStorage();
  const authListeners = new Set();
  const subListeners = new Set(); // { familyCode, callback }

  function load() {
    let state = null;
    try {
      state = JSON.parse(store.getItem(DEMO_STORAGE_KEY) || "null");
    } catch {
      state = null;
    }
    if (!state || state.version !== 1 || typeof state.spaces !== "object") {
      state = buildSeedState(todayIso(now()));
      persist(state);
    }
    return state;
  }

  function persist(state) {
    store.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  }

  function currentUser(state = load()) {
    if (!state.signedIn) return null;
    return DEMO_MEMBERS.find((m) => m.uid === state.activeUid) || DEMO_MEMBERS[0];
  }

  function emitAuth() {
    const user = currentUser();
    authListeners.forEach((cb) => cb(user));
  }

  function sortedSubs(space) {
    return (space?.subscriptions || [])
      .slice()
      .sort((a, b) => (a.nextChargeDate < b.nextChargeDate ? -1 : a.nextChargeDate > b.nextChargeDate ? 1 : 0))
      .map((s) => ({ ...s }));
  }

  function emitSubs() {
    const state = load();
    subListeners.forEach(({ familyCode, callback }) => callback(sortedSubs(state.spaces[familyCode])));
  }

  function requireMember(state, familyCode, user) {
    const space = state.spaces[familyCode];
    if (!user || !space || !space.members[user.uid]) {
      throw appError("PERMISSION_DENIED", "permission-denied");
    }
    return space;
  }

  // синхронизация между вкладками: две вкладки = два участника «в реальном времени»
  if (eventTarget) {
    eventTarget.addEventListener("storage", (e) => {
      if (e.key !== DEMO_STORAGE_KEY) return;
      emitSubs();
    });
  }

  const api = {
    capabilities,
    hasFirebaseConfig: () => true,
    initFirebase: () => {
      load();
      return { app: null, auth: null, db: null };
    },

    watchAuth(callback) {
      authListeners.add(callback);
      queueMicrotask(() => callback(currentUser()));
      return () => authListeners.delete(callback);
    },

    async loginWithGoogle() {
      const state = load();
      state.signedIn = true;
      persist(state);
      emitAuth();
      return { user: currentUser(state) };
    },

    async logout() {
      const state = load();
      state.signedIn = false;
      persist(state);
      emitAuth();
    },

    async isFamilyMember(familyCode, uid) {
      const space = load().spaces[familyCode];
      return Boolean(space && space.members[uid]);
    },

    async createInvite(familyCode, user, inviteCode, maxUses = 1, ttlHours = 72) {
      const state = load();
      const space = requireMember(state, familyCode, user);
      const expiresAt = new Date(now().getTime() + ttlHours * 60 * 60 * 1000);
      space.invites[inviteCode] = {
        createdBy: { uid: user.uid, email: user.email || null, name: user.displayName || null },
        expiresAt: expiresAt.toISOString(),
        maxUses,
        usedCount: 0,
        usedBy: null,
      };
      persist(state);
      return { inviteCode, expiresAt };
    },

    async bootstrapSpaceOwner(familyCode, user) {
      const state = load();
      const space = state.spaces[familyCode];
      if (space && space.members[user.uid]) return;
      if (space) throw appError("BOOTSTRAP_NOT_ALLOWED", "permission-denied");
      state.spaces[familyCode] = {
        ownerUid: user.uid,
        members: {
          [user.uid]: {
            uid: user.uid,
            email: user.email || null,
            name: user.displayName || null,
            inviteCode: "OWNER_BOOTSTRAP",
            createdAt: now().toISOString(),
          },
        },
        invites: {},
        subscriptions: [],
      };
      persist(state);
    },

    async consumeInviteAndJoinFamily(familyCode, inviteCode, user) {
      const state = load();
      const space = state.spaces[familyCode];
      if (space && space.members[user.uid]) return;
      const invite = space?.invites?.[inviteCode];
      if (!invite) throw appError("INVITE_NOT_FOUND");
      if (Date.parse(invite.expiresAt) <= now().getTime()) throw appError("INVITE_EXPIRED");
      if (invite.usedCount >= invite.maxUses) throw appError("INVITE_LIMIT");
      invite.usedCount += 1;
      invite.usedBy = user.uid;
      space.members[user.uid] = {
        uid: user.uid,
        email: user.email || null,
        name: user.displayName || null,
        inviteCode,
        createdAt: now().toISOString(),
      };
      persist(state);
    },

    async touchMembership(familyCode, user) {
      requireMember(load(), familyCode, user);
    },

    watchSubscriptions(familyCode, callback) {
      const entry = { familyCode, callback };
      subListeners.add(entry);
      queueMicrotask(() => {
        if (subListeners.has(entry)) callback(sortedSubs(load().spaces[familyCode]));
      });
      return () => subListeners.delete(entry);
    },

    async createSubscription(familyCode, payload, user) {
      const state = load();
      const space = requireMember(state, familyCode, user);
      state.seq = (state.seq || 0) + 1;
      const doc = {
        ...payload,
        id: `demo-${state.seq}`,
        createdAt: now().toISOString(),
        createdBy: { uid: user.uid, email: user.email || null, name: user.displayName || null },
      };
      if (!normalizeSubscription(doc)) throw appError("INVALID_SUBSCRIPTION", "invalid-argument");
      space.subscriptions.push(doc);
      persist(state);
      emitSubs();
    },

    async removeSubscription(familyCode, subscriptionId) {
      const state = load();
      const space = requireMember(state, familyCode, currentUser(state));
      space.subscriptions = space.subscriptions.filter((s) => s.id !== subscriptionId);
      persist(state);
      emitSubs();
    },

    // --- только для демо ---
    members: DEMO_MEMBERS,
    familyCode: DEMO_FAMILY_CODE,

    async switchUser(uid) {
      const state = load();
      if (!DEMO_MEMBERS.some((m) => m.uid === uid)) return;
      state.activeUid = uid;
      state.signedIn = true;
      persist(state);
      emitAuth();
    },

    async resetDemo() {
      persist(buildSeedState(todayIso(now())));
      emitAuth();
      emitSubs();
    },

    getState: () => load(),
  };

  return api;
}

const browserStorage = (() => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
})();

const defaultService = createDemoService({
  storage: browserStorage,
  eventTarget: typeof window !== "undefined" ? window : null,
});

export const {
  hasFirebaseConfig,
  initFirebase,
  watchAuth,
  loginWithGoogle,
  logout,
  isFamilyMember,
  createInvite,
  bootstrapSpaceOwner,
  consumeInviteAndJoinFamily,
  touchMembership,
  watchSubscriptions,
  createSubscription,
  removeSubscription,
  switchUser,
  resetDemo,
} = defaultService;

export default defaultService;
