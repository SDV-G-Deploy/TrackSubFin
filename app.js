import {
  createSubscription,
  hasFirebaseConfig,
  initFirebase,
  loginWithGoogle,
  logout,
  removeSubscription,
  watchAuth,
  watchSubscriptions,
} from "./firebase-service.js";

const CACHE_KEY = "tracksubfin.cache.v2";
const FAMILY_CODE_KEY = "tracksubfin.familyCode.v1";
const FAMILY_CODE_RE = /^[A-Za-z0-9]{4,12}$/;

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

const familyCodeForm = document.getElementById("familyCodeForm");
const familyCodeInput = document.getElementById("familyCodeInput");
const connectFamilyBtn = document.getElementById("connectFamilyBtn");
const generateFamilyBtn = document.getElementById("generateFamilyBtn");
const spaceBadge = document.getElementById("spaceBadge");
const spaceStatusText = document.getElementById("spaceStatusText");

let currentUser = null;
let currentFamilyCode = (localStorage.getItem(FAMILY_CODE_KEY) || "").toUpperCase();
let subscriptions = loadCachedSubscriptions();
let stopSubscriptionsWatcher = null;
let firebaseReady = false;

function loadCachedSubscriptions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCache() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(subscriptions));
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
  addSubscriptionBtn.disabled = !currentFamilyCode;
}

function setSpaceDisconnected() {
  spaceBadge.textContent = "Не подключено";
  spaceBadge.className = "sync-badge muted";
  spaceStatusText.textContent = "Введите код пары, чтобы подключиться к общим подпискам.";
  addSubscriptionBtn.disabled = true;
}

function setSpaceConnected(familyCode) {
  spaceBadge.textContent = `Код пары: ${familyCode}`;
  spaceBadge.className = "sync-badge ok";
  spaceStatusText.textContent = "Синхронизация активна. Изменения сразу видны на других устройствах.";
  addSubscriptionBtn.disabled = !currentUser;
}

function renderTimeline(items) {
  timelineEl.innerHTML = "";
  if (!items.length) {
    timelineEl.innerHTML = '<p class="sub-meta">Подписок пока нет.</p>';
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
      el.innerHTML = `
        <strong>${sub.name}</strong>
        <p class="sub-meta">${fmtCurrency(sub.price)}</p>
        <p class="sub-meta">${new Date(sub.nextChargeDate).toLocaleDateString("ru-RU")}</p>
        <p class="sub-meta">Через: ${humanRemaining(days)}</p>
      `;
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

function startRealtimeForFamilyCode(familyCode) {
  if (!currentUser) return;

  stopRealtime();
  setSpaceConnected(familyCode);

  stopSubscriptionsWatcher = watchSubscriptions(
    familyCode,
    (items) => {
      subscriptions = items;
      saveCache();
      render();
    },
    () => {
      spaceStatusText.textContent = "Нет связи. Показан последний локальный кэш.";
      render();
    }
  );
}

function connectFamilyCode(rawCode) {
  const code = String(rawCode || "")
    .trim()
    .toUpperCase();

  if (!FAMILY_CODE_RE.test(code)) {
    alert("Код пары: 4–12 символов, только латинские буквы и цифры.");
    return;
  }

  currentFamilyCode = code;
  localStorage.setItem(FAMILY_CODE_KEY, code);
  familyCodeInput.value = code;

  if (currentUser) {
    startRealtimeForFamilyCode(code);
  }
}

function randomFamilyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
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
    alert("Не удалось войти через Google. Проверьте, что домен добавлен в Authorized domains.");
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

familyCodeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connectFamilyCode(familyCodeInput.value);
});

generateFamilyBtn.addEventListener("click", () => {
  const code = randomFamilyCode();
  familyCodeInput.value = code;
  connectFamilyCode(code);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!currentUser || !currentFamilyCode) {
    alert("Сначала войдите через Google и подключите код пары.");
    return;
  }

  const fd = new FormData(form);
  const frequency = fd.get("frequency");

  const entry = {
    name: String(fd.get("name") || "").trim(),
    price: Number(fd.get("price") || 0),
    frequency,
    customDays: frequency === "custom-days" ? Number(fd.get("customDays") || 0) : null,
    nextChargeDate: String(fd.get("nextChargeDate") || ""),
    cardName: String(fd.get("cardName") || "").trim(),
    cardLast4: String(fd.get("cardLast4") || "").trim(),
    endDate: fd.get("endDate") ? String(fd.get("endDate")) : null,
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
  watchAuth((user) => {
    currentUser = user;

    if (!firebaseReady) return;

    if (user) {
      setAuthUiLoggedIn(user);
      if (currentFamilyCode) {
        startRealtimeForFamilyCode(currentFamilyCode);
      } else {
        setSpaceDisconnected();
      }
    } else {
      stopRealtime();
      setAuthUiLoggedOut();
      if (currentFamilyCode) {
        spaceBadge.textContent = `Код пары: ${currentFamilyCode}`;
        spaceBadge.className = "sync-badge warn";
        spaceStatusText.textContent = "Войдите через Google, чтобы открыть общее пространство.";
      } else {
        setSpaceDisconnected();
      }
    }
  });
}
