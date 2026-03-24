import {
  bootstrapSpaceOwner,
  consumeInviteAndJoinFamily,
  createInvite,
  createSubscription,
  hasFirebaseConfig,
  initFirebase,
  isFamilyMember,
  loginWithGoogle,
  logout,
  removeSubscription,
  touchMembership,
  watchAuth,
  watchSubscriptions,
} from "./firebase-service.js";

const CACHE_KEY = "tracksubfin.cache.v3";
const FAMILY_CODE_KEY = "tracksubfin.familyCode.v2";
const FAMILY_CODE_RE = /^[A-Za-z0-9]{4,12}$/;
const INVITE_CODE_RE = /^[A-Za-z0-9]{10,14}$/;
const ALLOWED_FREQUENCIES = new Set(["monthly", "yearly", "custom-days"]);

const firebaseSetupNotice = document.getElementById("firebaseSetupNotice");
const form = document.getElementById("subscriptionForm");
const frequencySelect = document.getElementById("frequency");
const customDaysField = document.getElementById("customDaysField");
const listEl = document.getElementById("subscriptionsList");
const timelineEl = document.getElementById("timeline");
const totalMonthlyEl = document.getElementById("totalMonthly");
const cardTemplate = document.getElementById("subscriptionCardTemplate");
const addSubscriptionBtn = document.getElementById("addSubscriptionBtn");

const authStateBadge = document.getElementById("authStateBadge");
const userInfoEl = document.getElementById("userInfo");
const userAvatarEl = document.getElementById("userAvatar");
const userNameEl = document.getElementById("userName");
const userEmailEl = document.getElementById("userEmail");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const signOutBtn = document.getElementById("signOutBtn");

const joinForm = document.getElementById("joinForm");
const familyCodeInput = document.getElementById("familyCodeInput");
const inviteCodeInput = document.getElementById("inviteCodeInput");
const connectFamilyBtn = document.getElementById("connectFamilyBtn");
const generateFamilyBtn = document.getElementById("generateFamilyBtn");
const createInviteBtn = document.getElementById("createInviteBtn");
const createdInviteBox = document.getElementById("createdInviteBox");
const createdInviteCode = document.getElementById("createdInviteCode");
const createdShareCode = document.getElementById("createdShareCode");
const spaceBadge = document.getElementById("spaceBadge");
const spaceStatusText = document.getElementById("spaceStatusText");

let currentUser = null;
let currentFamilyCode = (localStorage.getItem(FAMILY_CODE_KEY) || "").toUpperCase();
let subscriptions = [];
let stopSubscriptionsWatcher = null;
let firebaseReady = false;

function parseIsoDateOrNull(value) {
  const str = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const date = new Date(`${str}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : str;
}

function normalizeSubscription(raw) {
  if (!raw || typeof raw !== "object") return null;

  const name = String(raw.name || "").trim();
  const cardName = String(raw.cardName || "").trim();
  const cardLast4 = String(raw.cardLast4 || "").trim();
  const frequency = String(raw.frequency || "").trim();
  const price = Number(raw.price);
  const nextChargeDate = parseIsoDateOrNull(raw.nextChargeDate);
  const endDate = raw.endDate ? parseIsoDateOrNull(raw.endDate) : null;
  const customDaysRaw = raw.customDays == null ? null : Number(raw.customDays);
  const customDays = Number.isInteger(customDaysRaw) && customDaysRaw >= 1 ? customDaysRaw : null;

  if (!name || !cardName || !/^\d{4}$/.test(cardLast4)) return null;
  if (!ALLOWED_FREQUENCIES.has(frequency)) return null;
  if (!Number.isFinite(price) || price < 0) return null;
  if (!nextChargeDate) return null;
  if (frequency === "custom-days" && customDays == null) return null;
  if (frequency !== "custom-days" && customDays != null) return null;
  if (endDate && endDate < nextChargeDate) return null;

  return {
    id: raw.id ? String(raw.id) : undefined,
    name,
    price,
    frequency,
    customDays,
    nextChargeDate,
    cardName,
    cardLast4,
    endDate,
  };
}

function normalizeSubscriptions(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map(normalizeSubscription).filter(Boolean);
}

function cacheKeyForUserSpace(uid, familyCode) {
  return `${CACHE_KEY}:${uid}:${familyCode}`;
}

function saveCache() {
  if (!currentUser || !currentFamilyCode) return;
  localStorage.setItem(cacheKeyForUserSpace(currentUser.uid, currentFamilyCode), JSON.stringify(subscriptions));
}

function clearSensitiveLocalState() {
  Object.keys(localStorage)
    .filter((k) => k.startsWith(`${CACHE_KEY}:`))
    .forEach((k) => localStorage.removeItem(k));

  localStorage.removeItem(FAMILY_CODE_KEY);
  subscriptions = [];
  currentFamilyCode = "";
  familyCodeInput.value = "";
  inviteCodeInput.value = "";
  hideCreatedInvite();
  stopRealtime();
  setSpaceDisconnected();
  render();
}

function clearSubscriptionsView() {
  subscriptions = [];
  render();
}

function daysUntil(dateStr) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

function statusByDays(days) {
  if (days <= 3) return "alert";
  if (days <= 7) return "warning";
  return "normal";
}

function humanRemaining(days) {
  if (days < 0) return `просрочено на ${Math.abs(days)} дн.`;
  if (days === 0) return "сегодня";
  if (days === 1) return "1 день";
  return `${days} дн.`;
}

function toMonthly(sub) {
  const price = Number(sub.price || 0);
  if (sub.frequency === "yearly") return price / 12;
  if (sub.frequency === "custom-days") {
    const days = Number(sub.customDays || 30);
    return days > 0 ? price * (30 / days) : 0;
  }
  return price;
}

function fmtCurrency(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function setAuthUiLoggedOut() {
  authStateBadge.textContent = "Не вошли";
  authStateBadge.className = "sync-badge muted";
  userInfoEl.classList.add("hidden");
  googleSignInBtn.disabled = false;
  signOutBtn.disabled = true;
  connectFamilyBtn.disabled = true;
  generateFamilyBtn.disabled = true;
  createInviteBtn.disabled = true;
  addSubscriptionBtn.disabled = true;
}

function setAuthUiLoggedIn(user) {
  authStateBadge.textContent = "Вошли";
  authStateBadge.className = "sync-badge ok";
  userInfoEl.classList.remove("hidden");
  userAvatarEl.src = user.photoURL || "";
  userAvatarEl.style.visibility = user.photoURL ? "visible" : "hidden";
  userNameEl.textContent = user.displayName || "Пользователь";
  userEmailEl.textContent = user.email || "";
  googleSignInBtn.disabled = true;
  signOutBtn.disabled = false;
  connectFamilyBtn.disabled = false;
  generateFamilyBtn.disabled = false;
}

function setSpaceDisconnected() {
  spaceBadge.textContent = "Не подключено";
  spaceBadge.className = "sync-badge muted";
  spaceStatusText.textContent = "Введите код пространства и инвайт-код.";
  addSubscriptionBtn.disabled = true;
  createInviteBtn.disabled = true;
}

function setSpaceConnected(familyCode) {
  spaceBadge.textContent = `Пространство: ${familyCode}`;
  spaceBadge.className = "sync-badge ok";
  spaceStatusText.textContent = "Синхронизация активна. Данные видны только участникам пространства.";
  addSubscriptionBtn.disabled = !currentUser;
  createInviteBtn.disabled = !currentUser;
}

function showCreatedInvite(familyCode, inviteCode) {
  createdInviteCode.textContent = inviteCode;
  createdShareCode.textContent = `${familyCode}-${inviteCode}`;
  createdInviteBox.classList.remove("hidden");
}

function hideCreatedInvite() {
  createdInviteBox.classList.add("hidden");
  createdInviteCode.textContent = "";
  createdShareCode.textContent = "";
}

function renderTimeline(items) {
  timelineEl.innerHTML = "";
  if (!items.length) {
    const emptyText = document.createElement("p");
    emptyText.className = "sub-meta";
    emptyText.textContent = "Подписок пока нет.";
    timelineEl.appendChild(emptyText);
    return;
  }

  items
    .slice()
    .sort((a, b) => daysUntil(a.nextChargeDate) - daysUntil(b.nextChargeDate))
    .forEach((sub) => {
      const days = daysUntil(sub.nextChargeDate);
      const status = statusByDays(days);
      const el = document.createElement("div");
      el.className = `timeline-item ${status === "normal" ? "" : status}`.trim();

      const title = document.createElement("strong");
      title.textContent = sub.name;

      const price = document.createElement("p");
      price.className = "sub-meta";
      price.textContent = fmtCurrency(sub.price);

      const chargeDate = document.createElement("p");
      chargeDate.className = "sub-meta";
      chargeDate.textContent = new Date(sub.nextChargeDate).toLocaleDateString("ru-RU");

      const remaining = document.createElement("p");
      remaining.className = "sub-meta";
      remaining.textContent = `Через: ${humanRemaining(days)}`;

      el.append(title, price, chargeDate, remaining);
      timelineEl.appendChild(el);
    });
}

function renderList(items) {
  listEl.innerHTML = "";
  if (!items.length) {
    listEl.innerHTML = '<p class="sub-meta">Добавьте первую подписку через форму выше.</p>';
    return;
  }

  items
    .slice()
    .sort((a, b) => daysUntil(a.nextChargeDate) - daysUntil(b.nextChargeDate))
    .forEach((sub) => {
      const node = cardTemplate.content.cloneNode(true);
      const card = node.querySelector(".sub-card");
      const daysToCharge = daysUntil(sub.nextChargeDate);
      const daysToEnd = sub.endDate ? daysUntil(sub.endDate) : null;
      const status = statusByDays(daysToCharge);

      if (status !== "normal") card.classList.add(status);

      node.querySelector(".sub-name").textContent = sub.name;
      node.querySelector(".sub-meta").textContent = `${sub.frequency}${
        sub.frequency === "custom-days" ? ` (${sub.customDays} дн.)` : ""
      } • ${sub.cardName} • **** ${sub.cardLast4}`;

      node.querySelector(".sub-dates").textContent = `Следующее списание: ${new Date(
        sub.nextChargeDate
      ).toLocaleDateString("ru-RU")} (через ${humanRemaining(daysToCharge)})${
        sub.endDate
          ? ` • Окончание: ${new Date(sub.endDate).toLocaleDateString("ru-RU")} (${humanRemaining(
              daysToEnd
            )})`
          : ""
      }`;

      node.querySelector(".sub-price").textContent = fmtCurrency(sub.price);

      const removeBtn = node.querySelector(".btn-danger");
      removeBtn.disabled = !currentUser || !currentFamilyCode;
      removeBtn.addEventListener("click", async () => {
        if (!currentUser || !currentFamilyCode) return;
        removeBtn.disabled = true;
        try {
          await removeSubscription(currentFamilyCode, sub.id);
        } catch {
          alert("Не удалось удалить подписку. Проверьте подключение к интернету.");
          removeBtn.disabled = false;
        }
      });

      listEl.appendChild(node);
    });
}

function renderTotal(items) {
  const sum = items.reduce((acc, item) => acc + toMonthly(item), 0);
  totalMonthlyEl.textContent = `${fmtCurrency(sum)} / мес`;
}

function render() {
  renderTimeline(subscriptions);
  renderList(subscriptions);
  renderTotal(subscriptions);
}

function stopRealtime() {
  if (stopSubscriptionsWatcher) {
    stopSubscriptionsWatcher();
    stopSubscriptionsWatcher = null;
  }
}

async function startRealtimeForFamilyCode(familyCode) {
  if (!currentUser) return;

  stopRealtime();
  clearSubscriptionsView();

  await touchMembership(familyCode, currentUser);
  setSpaceConnected(familyCode);

  stopSubscriptionsWatcher = watchSubscriptions(
    familyCode,
    (items) => {
      subscriptions = normalizeSubscriptions(items);
      saveCache();
      render();
    },
    () => {
      spaceStatusText.textContent = "Нет связи. Переподключитесь к пространству.";
      render();
    }
  );
}

function parseJoinInput(familyRaw, inviteRaw) {
  const familyCode = String(familyRaw || "").trim().toUpperCase();
  const inviteCodeRaw = String(inviteRaw || "").trim().toUpperCase();

  if (inviteCodeRaw.includes("-")) {
    const [space, invite] = inviteCodeRaw.split("-");
    return {
      familyCode: (space || "").trim().toUpperCase(),
      inviteCode: (invite || "").trim().toUpperCase(),
    };
  }

  return { familyCode, inviteCode: inviteCodeRaw };
}

async function connectToSpace(rawFamilyCode, rawInviteCode) {
  const parsed = parseJoinInput(rawFamilyCode, rawInviteCode);
  const familyCode = parsed.familyCode;
  const inviteCode = parsed.inviteCode;

  if (!FAMILY_CODE_RE.test(familyCode)) {
    alert("Код пространства: 4–12 символов, только латиница и цифры.");
    return false;
  }

  const alreadyMember = await isFamilyMember(familyCode, currentUser.uid);

  if (!alreadyMember) {
    if (!inviteCode) {
      try {
        await bootstrapSpaceOwner(familyCode, currentUser);
      } catch {
        alert("Для входа в существующее пространство нужен инвайт-код.");
        return false;
      }
    } else {
      if (!INVITE_CODE_RE.test(inviteCode)) {
        alert("Для подключения нужен инвайт-код (10–14 символов).");
        return false;
      }

      try {
        await consumeInviteAndJoinFamily(familyCode, inviteCode, currentUser);
      } catch (error) {
        if (error?.message === "INVITE_NOT_FOUND") {
          alert("Инвайт не найден. Проверьте код.");
        } else if (error?.message === "INVITE_EXPIRED") {
          alert("Инвайт просрочен. Попросите новый.");
        } else if (error?.message === "INVITE_LIMIT") {
          alert("Лимит инвайта исчерпан. Попросите новый.");
        } else {
          alert("Не удалось подключиться. Проверьте правила Firestore и интернет.");
        }
        return false;
      }
    }
  }

  currentFamilyCode = familyCode;
  localStorage.setItem(FAMILY_CODE_KEY, familyCode);
  familyCodeInput.value = familyCode;

  await startRealtimeForFamilyCode(familyCode);
  return true;
}

function randomFamilyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function randomInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const length = 12;
  let code = "";
  for (let i = 0; i < length; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

frequencySelect.addEventListener("change", (e) => {
  const show = e.target.value === "custom-days";
  customDaysField.classList.toggle("hidden", !show);
  customDaysField.querySelector("input").required = show;
});

googleSignInBtn.addEventListener("click", async () => {
  googleSignInBtn.disabled = true;
  try {
    await loginWithGoogle();
  } catch {
    alert("Не удалось войти через Google. Проверьте Authorized domains.");
    googleSignInBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  try {
    await logout();
  } catch {
    alert("Не удалось выйти из аккаунта.");
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) {
    alert("Сначала войдите через Google.");
    return;
  }

  connectFamilyBtn.disabled = true;
  try {
    await connectToSpace(familyCodeInput.value, inviteCodeInput.value);
  } finally {
    connectFamilyBtn.disabled = false;
  }
});

generateFamilyBtn.addEventListener("click", async () => {
  const code = randomFamilyCode();
  familyCodeInput.value = code;
  inviteCodeInput.value = "";
  spaceStatusText.textContent = "Код создан. Нажмите «Подключить» — пространство создастся и вы станете первым участником.";
});

createInviteBtn.addEventListener("click", async () => {
  if (!currentUser || !currentFamilyCode) return;

  const inviteCode = randomInviteCode();
  createInviteBtn.disabled = true;
  try {
    await createInvite(currentFamilyCode, currentUser, inviteCode, 1, 72);
    showCreatedInvite(currentFamilyCode, inviteCode);
  } catch {
    alert("Не удалось создать инвайт. Проверьте права и интернет.");
  } finally {
    createInviteBtn.disabled = false;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!currentUser || !currentFamilyCode) {
    alert("Сначала войдите и подключите пространство.");
    return;
  }

  const fd = new FormData(form);
  const frequency = String(fd.get("frequency") || "").trim();
  const price = Number(fd.get("price"));
  const customDaysValue = Number(fd.get("customDays"));
  const nextChargeDate = parseIsoDateOrNull(fd.get("nextChargeDate"));
  const endDate = fd.get("endDate") ? parseIsoDateOrNull(fd.get("endDate")) : null;

  if (!ALLOWED_FREQUENCIES.has(frequency)) return alert("Некорректная периодичность.");
  if (!Number.isFinite(price) || price < 0) return alert("Цена должна быть числом не меньше 0.");
  if (frequency === "custom-days" && !(Number.isInteger(customDaysValue) && customDaysValue >= 1)) {
    return alert("Для «Каждые N дней» укажите целое количество дней (минимум 1).");
  }
  if (!nextChargeDate) return alert("Укажите корректную дату следующего списания.");
  if (fd.get("endDate") && !endDate) return alert("Укажите корректную дату окончания.");
  if (endDate && endDate < nextChargeDate) return alert("Дата окончания не может быть раньше списания.");

  const entry = {
    name: String(fd.get("name") || "").trim(),
    price,
    frequency,
    customDays: frequency === "custom-days" ? customDaysValue : null,
    nextChargeDate,
    cardName: String(fd.get("cardName") || "").trim(),
    cardLast4: String(fd.get("cardLast4") || "").trim(),
    endDate,
  };

  addSubscriptionBtn.disabled = true;
  try {
    await createSubscription(currentFamilyCode, entry, currentUser);
    form.reset();
    customDaysField.classList.add("hidden");
    customDaysField.querySelector("input").required = false;
  } catch {
    alert("Не удалось сохранить подписку. Проверьте интернет и правила Firestore.");
  } finally {
    addSubscriptionBtn.disabled = !currentUser || !currentFamilyCode;
  }
});

render();
familyCodeInput.value = currentFamilyCode;

if (!hasFirebaseConfig()) {
  firebaseSetupNotice.classList.remove("hidden");
  setAuthUiLoggedOut();
  setSpaceDisconnected();
} else {
  initFirebase();
  firebaseReady = true;
  watchAuth(async (user) => {
    currentUser = user;

    if (!firebaseReady) return;

    if (user) {
      setAuthUiLoggedIn(user);
      hideCreatedInvite();

      if (currentFamilyCode) {
        try {
          const hasMembership = await isFamilyMember(currentFamilyCode, user.uid);
          if (hasMembership) {
            await startRealtimeForFamilyCode(currentFamilyCode);
          } else {
            stopRealtime();
            clearSubscriptionsView();
            setSpaceDisconnected();
            spaceBadge.textContent = `Пространство: ${currentFamilyCode}`;
            spaceBadge.className = "sync-badge warn";
            spaceStatusText.textContent = "Нужен инвайт-код для входа в это пространство.";
          }
        } catch {
          stopRealtime();
          clearSubscriptionsView();
          setSpaceDisconnected();
        }
      } else {
        setSpaceDisconnected();
      }
    } else {
      stopRealtime();
      setAuthUiLoggedOut();
      clearSensitiveLocalState();
    }
  });
}
