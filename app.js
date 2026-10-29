import {
  CATEGORIES,
  CURRENCIES,
  DEFAULT_CATEGORY,
  EXCHANGE_RATES,
  cancelCandidates,
  categoryBreakdown,
  daysBetween,
  formatMoney,
  frequencyLabel,
  memberLabel,
  monthlyForecast,
  monthlyIn,
  normalizeSubscriptions,
  splitByMember,
  toCsv,
  todayIso,
  totals,
  upcomingRenewals,
  validateSubscriptionInput,
} from "./logic.js";

const DEMO = new URLSearchParams(window.location.search).get("demo") === "1";

// В демо-режиме ключи UI отделены, чтобы демо не трогало (и не стирало) данные реального режима.
const KEY_PREFIX = DEMO ? "tracksubfin.demoui" : "tracksubfin";
const CACHE_KEY = `${KEY_PREFIX}.cache.v3`;
const FAMILY_CODE_KEY = `${KEY_PREFIX}.familyCode.v2`;
const DISPLAY_CURRENCY_KEY = `${KEY_PREFIX}.displayCurrency`;
const FAMILY_CODE_RE = /^[A-Za-z0-9]{4,12}$/;
const INVITE_CODE_RE = /^[A-Za-z0-9]{10,14}$/;

const $ = (id) => document.getElementById(id);

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // приватный режим / заблокированное хранилище — не критично
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // не критично
  }
}

function describeFirebaseError(error) {
  const appMessage = error?.message || "";
  const code = error?.code || "";

  if (appMessage === "INVITE_NOT_FOUND") return "Инвайт не найден. Проверьте код.";
  if (appMessage === "INVITE_EXPIRED") return "Инвайт просрочен. Попросите новый.";
  if (appMessage === "INVITE_LIMIT") return "Лимит инвайта исчерпан. Попросите новый.";
  if (appMessage === "BOOTSTRAP_NOT_ALLOWED") {
    return "Это пространство уже занято. Для подключения нужен валидный инвайт.";
  }
  if (appMessage === "INVITE_RACE_OR_INVALID") {
    return "Инвайт уже использован/истёк или недействителен. Попросите новый.";
  }

  if (code === "permission-denied" && error?.extended) {
    return "Недостаточно прав (permission-denied). Изменять подписку может только её автор; если ошибка при добавлении — владельцу проекта нужно задеплоить актуальные Firestore Rules (поля валюты и категории).";
  }
  if (code === "permission-denied") {
    return "Недостаточно прав (permission-denied). Проверьте Firestore Rules и корректность инвайта.";
  }
  if (code === "failed-precondition") {
    return "Операция не выполнена (failed-precondition). Обычно это конфликт правил или состояния данных.";
  }
  if (code === "unavailable") return "Firestore временно недоступен. Попробуйте ещё раз.";
  if (code === "invalid-argument") return "Данные подписки некорректны.";

  return `Неизвестная ошибка${code ? ` (${code})` : ""}${appMessage ? `: ${appMessage}` : ""}.`;
}

const firebaseSetupNotice = $("firebaseSetupNotice");
const bootErrorNotice = $("bootErrorNotice");
const demoBanner = $("demoBanner");
const resetDemoBtn = $("resetDemoBtn");
const form = $("subscriptionForm");
const frequencySelect = $("frequency");
const customDaysField = $("customDaysField");
const listEl = $("subscriptionsList");
const subsCountEl = $("subsCount");
const timelineEl = $("timeline");
const timelineTotalEl = $("timelineTotal");
const hintsListEl = $("hintsList");
const cardTemplate = $("subscriptionCardTemplate");
const addSubscriptionBtn = $("addSubscriptionBtn");
const formError = $("formError");
const formHint = $("formHint");
const formTitle = $("formTitle");
const cancelEditBtn = $("cancelEditBtn");
const forecastChartEl = $("forecastChart");
const forecastNoteEl = $("forecastNote");
const forecastTableBody = document.querySelector("#forecastTable tbody");
const toastEl = $("toast");

const displayCurrencySelect = $("displayCurrency");
const exportCsvBtn = $("exportCsvBtn");
const kpi = {
  monthly: $("kpiMonthly"),
  yearly: $("kpiYearly"),
  next7: $("kpiNext7"),
  next7Count: $("kpiNext7Count"),
  next30: $("kpiNext30"),
  next30Count: $("kpiNext30Count"),
};
const ratesNote = $("ratesNote");
const memberSplitEl = $("memberSplit");
const categoryBreakdownEl = $("categoryBreakdown");
const windowButtons = [...document.querySelectorAll(".seg-btn")];

const authStateBadge = $("authStateBadge");
const userInfoEl = $("userInfo");
const userAvatarEl = $("userAvatar");
const userInitialEl = $("userInitial");
const userNameEl = $("userName");
const userEmailEl = $("userEmail");
const googleSignInBtn = $("googleSignInBtn");
const signOutBtn = $("signOutBtn");
const tryDemoLink = $("tryDemoLink");
const demoMemberField = $("demoMemberField");
const demoMemberSelect = $("demoMemberSelect");

const joinForm = $("joinForm");
const joinError = $("joinError");
const familyCodeInput = $("familyCodeInput");
const inviteCodeInput = $("inviteCodeInput");
const connectFamilyBtn = $("connectFamilyBtn");
const generateFamilyBtn = $("generateFamilyBtn");
const createInviteBtn = $("createInviteBtn");
const createdInviteBox = $("createdInviteBox");
const createdInviteCode = $("createdInviteCode");
const createdShareCode = $("createdShareCode");
const spaceBadge = $("spaceBadge");
const spaceStatusText = $("spaceStatusText");

let service = null;
let currentUser = null;
let currentFamilyCode = (safeGet(FAMILY_CODE_KEY) || "").toUpperCase();
let subscriptions = [];
let stopSubscriptionsWatcher = null;
let serviceReady = false;
let renewalWindow = 30;
let editingId = null;
let displayCurrency = CURRENCIES.includes(safeGet(DISPLAY_CURRENCY_KEY))
  ? safeGet(DISPLAY_CURRENCY_KEY)
  : DEMO
    ? "EUR"
    : "USD";

// ---------- сообщения ----------

let toastTimer = null;
function notify(message, type = "ok") {
  toastEl.textContent = message;
  toastEl.className = `toast ${type === "error" ? "toast-error" : ""}`.trim();
  toastEl.setAttribute("role", type === "error" ? "alert" : "status");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), type === "error" ? 7000 : 3500);
}

function showInlineError(el, message) {
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

// ---------- хранение ----------

function cacheKeyForUserSpace(uid, familyCode) {
  return `${CACHE_KEY}:${uid}:${familyCode}`;
}

function saveCache() {
  if (!currentUser || !currentFamilyCode) return;
  safeSet(cacheKeyForUserSpace(currentUser.uid, currentFamilyCode), JSON.stringify(subscriptions));
}

function clearSensitiveLocalState() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(`${CACHE_KEY}:`))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    // нет доступа к хранилищу
  }

  safeRemove(FAMILY_CODE_KEY);
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

// ---------- даты/формат ----------

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("ru-RU");
}

function daysUntil(iso) {
  return daysBetween(todayIso(), iso);
}

function statusByDays(days) {
  if (days <= 3) return "alert";
  if (days <= 7) return "warning";
  return "normal";
}

function humanRemaining(days) {
  if (days < 0) return `просрочено на ${Math.abs(days)} дн.`;
  if (days === 0) return "сегодня";
  if (days === 1) return "завтра";
  return `через ${days} дн.`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// ---------- состояние UI ----------

function setAuthUiLoggedOut() {
  authStateBadge.textContent = "Не вошли";
  authStateBadge.className = "sync-badge muted";
  userInfoEl.classList.add("hidden");
  googleSignInBtn.disabled = !serviceReady;
  signOutBtn.disabled = true;
  connectFamilyBtn.disabled = true;
  generateFamilyBtn.disabled = true;
  createInviteBtn.disabled = true;
  addSubscriptionBtn.disabled = true;
}

function setAuthUiLoggedIn(user) {
  authStateBadge.textContent = DEMO ? "Демо-участник" : "Вошли";
  authStateBadge.className = DEMO ? "sync-badge warn" : "sync-badge ok";
  userInfoEl.classList.remove("hidden");
  const name = user.displayName || "Пользователь";
  if (user.photoURL) {
    userAvatarEl.src = user.photoURL;
    userAvatarEl.alt = `Аватар: ${name}`;
    userAvatarEl.classList.remove("hidden");
    userInitialEl.classList.add("hidden");
  } else {
    userAvatarEl.removeAttribute("src");
    userAvatarEl.classList.add("hidden");
    userInitialEl.textContent = name.slice(0, 1).toUpperCase();
    userInitialEl.classList.remove("hidden");
  }
  userNameEl.textContent = name;
  userEmailEl.textContent = user.email || "";
  googleSignInBtn.disabled = true;
  signOutBtn.disabled = false;
  connectFamilyBtn.disabled = false;
  generateFamilyBtn.disabled = false;
  if (DEMO) demoMemberSelect.value = user.uid;
}

function setSpaceDisconnected() {
  spaceBadge.textContent = "Не подключено";
  spaceBadge.className = "sync-badge muted";
  spaceStatusText.textContent = currentUser
    ? "Введите код пространства и инвайт-код, или создайте новое пространство."
    : "Сначала войдите, затем подключите пространство.";
  addSubscriptionBtn.disabled = true;
  createInviteBtn.disabled = true;
  updateFormHint();
}

function setSpaceConnected(familyCode) {
  spaceBadge.textContent = `Пространство: ${familyCode}`;
  spaceBadge.className = "sync-badge ok";
  spaceStatusText.textContent = DEMO
    ? "Демо-пространство. Данные видны только в этом браузере."
    : "Синхронизация активна. Данные видны только участникам пространства.";
  addSubscriptionBtn.disabled = !currentUser;
  createInviteBtn.disabled = !currentUser;
  updateFormHint();
}

function updateFormHint() {
  const connected = Boolean(currentUser && currentFamilyCode && stopSubscriptionsWatcher);
  if (connected) {
    formHint.classList.add("hidden");
    return;
  }
  formHint.textContent = "Чтобы добавлять подписки, войдите и подключите пространство.";
  formHint.classList.remove("hidden");
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

// ---------- рендер ----------

function emptyNote(text) {
  const p = document.createElement("p");
  p.className = "empty-state";
  p.textContent = text;
  return p;
}

function emptyListText() {
  if (!currentUser) return "Войдите и подключите пространство, чтобы увидеть подписки.";
  if (!currentFamilyCode || !stopSubscriptionsWatcher) return "Подключите пространство, чтобы увидеть подписки.";
  return "Подписок пока нет. Добавьте первую через форму ниже.";
}

function renderSummary(items) {
  const t = totals(items, displayCurrency);
  const today = todayIso();
  const r7 = upcomingRenewals(items, today, 7, displayCurrency);
  const r30 = upcomingRenewals(items, today, 30, displayCurrency);

  kpi.monthly.textContent = formatMoney(t.monthly, displayCurrency);
  kpi.yearly.textContent = formatMoney(t.yearly, displayCurrency);
  kpi.next7.textContent = formatMoney(r7.total, displayCurrency);
  kpi.next30.textContent = formatMoney(r30.total, displayCurrency);
  kpi.next7Count.textContent = `${r7.items.length} ${plural(r7.items.length, "списание", "списания", "списаний")}`;
  kpi.next30Count.textContent = `${r30.items.length} ${plural(r30.items.length, "списание", "списания", "списаний")}`;

  const rates = EXCHANGE_RATES.perEur;
  ratesNote.textContent = `Пересчёт по фиксированным курсам на ${fmtDate(EXCHANGE_RATES.asOf)} (не live): 1 EUR = ${rates.USD} USD = ${rates.RSD} RSD. Годовые и «каждые N дней» приведены к месяцу.`;

  renderBars(memberSplitEl, splitByMember(items, displayCurrency), "Нет данных по участникам.");
  renderBars(categoryBreakdownEl, categoryBreakdown(items, displayCurrency), "Нет данных по категориям.");
  exportCsvBtn.disabled = items.length === 0;
}

function renderBars(container, groups, emptyText) {
  container.innerHTML = "";
  if (!groups.length) {
    const li = document.createElement("li");
    li.append(emptyNote(emptyText));
    container.append(li);
    return;
  }
  const max = Math.max(...groups.map((g) => g.monthly), 0.0001);
  for (const g of groups) {
    const li = document.createElement("li");
    li.className = "bar-row";
    const head = document.createElement("div");
    head.className = "bar-head";
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = `${g.label} · ${g.count}`;
    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = `${formatMoney(g.monthly, displayCurrency)} / мес · ${g.share}%`;
    head.append(label, value);
    const track = document.createElement("div");
    track.className = "bar-track";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(2, (g.monthly / max) * 100)}%`;
    track.append(fill);
    li.append(head, track);
    container.append(li);
  }
}

const MONTH_SHORT = new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "UTC" });
const MONTH_LONG = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

function monthDate(ym) {
  return new Date(`${ym}-01T00:00:00Z`);
}

function monthLong(ym) {
  const text = MONTH_LONG.format(monthDate(ym));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderForecast(items) {
  forecastChartEl.innerHTML = "";
  forecastTableBody.innerHTML = "";
  const months = monthlyForecast(items, todayIso(), 12, displayCurrency);
  const max = Math.max(...months.map((m) => m.total), 0);
  if (!items.length || max === 0) {
    forecastNoteEl.textContent = "";
    forecastChartEl.append(emptyNote(items.length ? "Списаний в ближайшие 12 месяцев нет." : emptyListText()));
    return;
  }
  const sum = months.reduce((a, m) => a + m.total, 0);
  const avg = sum / months.length;
  const peak = months.reduce((a, m) => (m.total > a.total ? m : a), months[0]);
  forecastNoteEl.textContent = `Итого ${formatMoney(sum, displayCurrency)} · в среднем ${formatMoney(
    avg,
    displayCurrency
  )} / мес · пик — ${MONTH_LONG.format(monthDate(peak.month))} Текущий месяц считается с сегодняшнего дня.`;

  const plot = document.createElement("div");
  plot.className = "fc-plot";
  const avgLine = document.createElement("div");
  avgLine.className = "fc-avg";
  avgLine.style.bottom = `${(avg / max) * 100}%`;
  avgLine.setAttribute("aria-hidden", "true");
  const avgLabel = document.createElement("span");
  avgLabel.textContent = "среднее";
  avgLine.append(avgLabel);
  plot.append(avgLine);

  months.forEach((m, i) => {
    const col = document.createElement("div");
    col.className = "fc-col";
    col.tabIndex = 0;
    const label = `${monthLong(m.month)}: ${formatMoney(m.total, displayCurrency)}, ${m.count} ${plural(
      m.count,
      "списание",
      "списания",
      "списаний"
    )}`;
    col.setAttribute("aria-label", label);
    const tip = document.createElement("span");
    tip.className = "fc-tip";
    tip.textContent = label;
    if (i > 8) tip.classList.add("fc-tip-left");
    const bar = document.createElement("div");
    bar.className = "fc-bar";
    bar.style.height = m.total > 0 ? `${Math.max(2, (m.total / max) * 100)}%` : "0";
    if (m.month === peak.month) {
      col.classList.add("is-peak");
      const v = document.createElement("span");
      v.className = "fc-peak-value";
      v.textContent = formatMoney(m.total, displayCurrency);
      bar.append(v);
    }
    col.append(bar, tip);
    plot.append(col);

    const tr = document.createElement("tr");
    for (const text of [monthLong(m.month), formatMoney(m.total, displayCurrency), String(m.count)]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    forecastTableBody.append(tr);
  });

  const axis = document.createElement("div");
  axis.className = "fc-axis";
  axis.setAttribute("aria-hidden", "true");
  months.forEach((m, i) => {
    const t = document.createElement("span");
    const d = monthDate(m.month);
    const mon = document.createElement("span");
    mon.className = "fc-mon";
    mon.textContent = MONTH_SHORT.format(d).replace(".", "");
    if (i % 2 === 1) t.classList.add("fc-odd");
    t.append(mon);
    if (d.getUTCMonth() === 0) {
      const year = document.createElement("small");
      year.className = "fc-year";
      year.textContent = String(d.getUTCFullYear());
      t.append(year);
    }
    axis.append(t);
  });

  forecastChartEl.append(plot, axis);
}

// ---------- редактирование ----------

function canEdit(sub) {
  return Boolean(
    currentUser &&
      currentFamilyCode &&
      typeof service?.updateSubscription === "function" &&
      sub.createdBy?.uid === currentUser.uid
  );
}

function setCustomDaysVisible(show) {
  customDaysField.classList.toggle("hidden", !show);
  customDaysField.querySelector("input").required = show;
}

function startEdit(sub) {
  editingId = sub.id;
  showInlineError(formError, "");
  const f = form.elements;
  f.name.value = sub.name;
  f.price.value = String(sub.price);
  f.currency.value = sub.currency;
  f.category.value = sub.category;
  f.frequency.value = sub.frequency;
  f.customDays.value = sub.customDays ?? "";
  setCustomDaysVisible(sub.frequency === "custom-days");
  f.nextChargeDate.value = sub.nextChargeDate;
  f.cardName.value = sub.cardName;
  f.cardLast4.value = sub.cardLast4;
  f.endDate.value = sub.endDate || "";
  formTitle.textContent = `Изменить: ${sub.name}`;
  addSubscriptionBtn.textContent = "Сохранить изменения";
  cancelEditBtn.classList.remove("hidden");
  form.closest(".panel").classList.add("is-editing");
  form.closest(".panel").scrollIntoView({ behavior: "smooth", block: "start" });
  f.name.focus({ preventScroll: true });
}

function stopEdit() {
  editingId = null;
  form.reset();
  setCustomDaysVisible(false);
  formTitle.textContent = "Новая подписка";
  addSubscriptionBtn.textContent = "Добавить подписку";
  cancelEditBtn.classList.add("hidden");
  form.closest(".panel").classList.remove("is-editing");
}

function renderTimeline(items) {
  timelineEl.innerHTML = "";
  const r = upcomingRenewals(items, todayIso(), renewalWindow, displayCurrency);
  timelineTotalEl.textContent = items.length
    ? `${r.items.length} ${plural(r.items.length, "списание", "списания", "списаний")} на ${formatMoney(
        r.total,
        displayCurrency
      )} за ${renewalWindow} дней`
    : "";

  if (!r.items.length) {
    const li = document.createElement("li");
    li.className = "timeline-empty";
    li.append(
      emptyNote(items.length ? `В ближайшие ${renewalWindow} дней списаний нет.` : emptyListText())
    );
    timelineEl.appendChild(li);
    return;
  }

  for (const occ of r.items) {
    const status = statusByDays(occ.inDays);
    const el = document.createElement("li");
    el.className = `timeline-item ${status === "normal" ? "" : status}`.trim();

    const title = document.createElement("strong");
    title.textContent = occ.sub.name;

    const price = document.createElement("p");
    price.className = "sub-meta";
    price.textContent = formatMoney(occ.amount, occ.sub.currency);
    if (occ.sub.currency !== displayCurrency) {
      price.textContent += ` ≈ ${formatMoney(occ.converted, displayCurrency)}`;
    }

    const chargeDate = document.createElement("p");
    chargeDate.className = "sub-meta";
    chargeDate.textContent = fmtDate(occ.date);

    const remaining = document.createElement("p");
    remaining.className = "sub-meta remaining";
    remaining.textContent = humanRemaining(occ.inDays);

    el.append(title, price, chargeDate, remaining);
    timelineEl.appendChild(el);
  }
}

const HINT_LABELS = {
  overlap: "Пересечение",
  expensive: "Дорого",
  "yearly-soon": "Годовое продление",
  stale: "Устарело",
};

function renderHints(items) {
  hintsListEl.innerHTML = "";
  const hints = cancelCandidates(items, todayIso(), displayCurrency);
  if (!hints.length) {
    const li = document.createElement("li");
    li.append(emptyNote(items.length ? "Явных кандидатов на отмену нет." : emptyListText()));
    hintsListEl.append(li);
    return;
  }
  for (const h of hints) {
    const li = document.createElement("li");
    li.className = `hint-item hint-${h.kind}`;
    const tag = document.createElement("span");
    tag.className = "hint-tag";
    tag.textContent = HINT_LABELS[h.kind] || h.kind;
    const text = document.createElement("span");
    text.className = "hint-text";
    text.textContent = h.text;
    const money = document.createElement("span");
    money.className = "hint-money";
    money.textContent = `≈ ${formatMoney(h.monthly, displayCurrency)} / мес`;
    li.append(tag, text, money);
    hintsListEl.append(li);
  }
}

function renderList(items) {
  listEl.innerHTML = "";
  subsCountEl.textContent = String(items.length);
  if (!items.length) {
    listEl.append(emptyNote(emptyListText()));
    return;
  }

  items
    .slice()
    .sort((a, b) => (a.nextChargeDate < b.nextChargeDate ? -1 : a.nextChargeDate > b.nextChargeDate ? 1 : 0))
    .forEach((sub) => {
      const node = cardTemplate.content.cloneNode(true);
      const card = node.querySelector(".sub-card");
      const daysToCharge = daysUntil(sub.nextChargeDate);
      const daysToEnd = sub.endDate ? daysUntil(sub.endDate) : null;
      const status = statusByDays(daysToCharge);

      if (status !== "normal") card.classList.add(status);

      node.querySelector(".sub-name").textContent = sub.name;

      const tags = node.querySelector(".sub-tags");
      const cat = document.createElement("span");
      cat.className = "chip";
      cat.textContent = sub.category || DEFAULT_CATEGORY;
      const who = document.createElement("span");
      who.className = "chip chip-muted";
      who.textContent = memberLabel(sub.createdBy);
      tags.append(cat, who);

      node.querySelector(".sub-meta").textContent = `${frequencyLabel(sub)} • ${sub.cardName} • **** ${sub.cardLast4}`;

      node.querySelector(".sub-dates").textContent = `Следующее списание: ${fmtDate(sub.nextChargeDate)} (${humanRemaining(
        daysToCharge
      )})${sub.endDate ? ` • Окончание: ${fmtDate(sub.endDate)} (${humanRemaining(daysToEnd)})` : ""}`;

      node.querySelector(".sub-price").textContent = formatMoney(sub.price, sub.currency);
      const converted = node.querySelector(".sub-converted");
      converted.textContent = `≈ ${formatMoney(monthlyIn(sub, displayCurrency), displayCurrency)} / мес`;

      const editBtn = node.querySelector(".btn-edit");
      if (canEdit(sub)) {
        editBtn.classList.remove("hidden");
        editBtn.setAttribute("aria-label", `Изменить подписку ${sub.name}`);
        editBtn.addEventListener("click", () => startEdit(sub));
      }

      const removeBtn = node.querySelector(".btn-danger");
      removeBtn.setAttribute("aria-label", `Удалить подписку ${sub.name}`);
      removeBtn.disabled = !currentUser || !currentFamilyCode;
      removeBtn.addEventListener("click", async () => {
        if (!currentUser || !currentFamilyCode) return;
        if (!window.confirm(`Удалить подписку «${sub.name}»? Она пропадёт у всех участников пространства.`)) return;
        removeBtn.disabled = true;
        try {
          await service.removeSubscription(currentFamilyCode, sub.id);
          if (editingId === sub.id) stopEdit();
          notify(`Подписка «${sub.name}» удалена.`);
        } catch (error) {
          notify(`Не удалось удалить подписку. ${describeFirebaseError(error)}`, "error");
          removeBtn.disabled = false;
        }
      });

      listEl.appendChild(node);
    });
}

function render() {
  if (editingId && !subscriptions.some((s) => s.id === editingId && canEdit(s))) {
    stopEdit();
    notify("Редактируемая подписка удалена или больше недоступна.", "error");
  }
  renderSummary(subscriptions);
  renderForecast(subscriptions);
  renderTimeline(subscriptions);
  renderHints(subscriptions);
  renderList(subscriptions);
}

// ---------- realtime ----------

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

  await service.touchMembership(familyCode, currentUser);

  stopSubscriptionsWatcher = service.watchSubscriptions(
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
  setSpaceConnected(familyCode);
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
    showInlineError(joinError, "Код пространства: 4–12 символов, только латиница и цифры.");
    familyCodeInput.focus();
    return false;
  }

  try {
    if (!inviteCode) {
      await service.bootstrapSpaceOwner(familyCode, currentUser);
    } else {
      if (!INVITE_CODE_RE.test(inviteCode)) {
        showInlineError(joinError, "Для подключения нужен инвайт-код (10–14 символов).");
        inviteCodeInput.focus();
        return false;
      }
      await service.consumeInviteAndJoinFamily(familyCode, inviteCode, currentUser);
    }
  } catch (error) {
    showInlineError(joinError, describeFirebaseError(error));
    return false;
  }

  currentFamilyCode = familyCode;
  safeSet(FAMILY_CODE_KEY, familyCode);
  familyCodeInput.value = familyCode;

  try {
    await startRealtimeForFamilyCode(familyCode);
    notify(`Подключено к пространству ${familyCode}.`);
    return true;
  } catch (error) {
    showInlineError(joinError, describeFirebaseError(error));
    return false;
  }
}

function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < length; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

// ---------- обработчики ----------

function fillSelect(select, values, selected) {
  select.innerHTML = "";
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    if (v === selected) opt.selected = true;
    select.append(opt);
  }
}

fillSelect(displayCurrencySelect, CURRENCIES, displayCurrency);
fillSelect($("currencySelect"), CURRENCIES, DEMO ? "EUR" : "USD");
fillSelect($("categorySelect"), CATEGORIES, DEFAULT_CATEGORY);

displayCurrencySelect.addEventListener("change", () => {
  displayCurrency = displayCurrencySelect.value;
  safeSet(DISPLAY_CURRENCY_KEY, displayCurrency);
  render();
});

windowButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    renewalWindow = Number(btn.dataset.window);
    windowButtons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    renderTimeline(subscriptions);
  });
});

cancelEditBtn.addEventListener("click", () => {
  stopEdit();
  showInlineError(formError, "");
});

exportCsvBtn.addEventListener("click", () => {
  if (!subscriptions.length) return;
  const csv = toCsv(subscriptions, displayCurrency);
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tracksubfin-${DEMO ? "demo-" : ""}${todayIso()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`CSV выгружен: ${subscriptions.length} ${plural(subscriptions.length, "подписка", "подписки", "подписок")}.`);
});

frequencySelect.addEventListener("change", (e) => {
  setCustomDaysVisible(e.target.value === "custom-days");
});

googleSignInBtn.addEventListener("click", async () => {
  googleSignInBtn.disabled = true;
  try {
    await service.loginWithGoogle();
  } catch (error) {
    const code = error?.code || "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      notify("Вход отменён.");
    } else if (code === "auth/popup-blocked") {
      notify("Браузер заблокировал всплывающее окно входа. Разрешите pop-up для сайта.", "error");
    } else {
      notify("Не удалось войти через Google. Проверьте Authorized domains.", "error");
    }
    googleSignInBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  try {
    await service.logout();
  } catch {
    notify("Не удалось выйти из аккаунта.", "error");
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showInlineError(joinError, "");
  if (!currentUser) {
    showInlineError(joinError, "Сначала войдите через Google.");
    return;
  }

  connectFamilyBtn.disabled = true;
  try {
    await connectToSpace(familyCodeInput.value, inviteCodeInput.value);
  } finally {
    connectFamilyBtn.disabled = false;
  }
});

generateFamilyBtn.addEventListener("click", () => {
  familyCodeInput.value = randomCode(6);
  inviteCodeInput.value = "";
  showInlineError(joinError, "");
  spaceStatusText.textContent = "Код создан. Нажмите «Подключить» — пространство создастся и вы станете первым участником.";
});

createInviteBtn.addEventListener("click", async () => {
  if (!currentUser || !currentFamilyCode) return;

  const inviteCode = randomCode(12);
  createInviteBtn.disabled = true;
  try {
    await service.createInvite(currentFamilyCode, currentUser, inviteCode, 1, 72);
    showCreatedInvite(currentFamilyCode, inviteCode);
  } catch (error) {
    showInlineError(joinError, describeFirebaseError(error));
  } finally {
    createInviteBtn.disabled = false;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showInlineError(formError, "");

  if (!currentUser || !currentFamilyCode) {
    showInlineError(formError, "Сначала войдите и подключите пространство.");
    return;
  }

  const fd = new FormData(form);
  const input = Object.fromEntries(fd.entries());
  const { entry, error } = validateSubscriptionInput(input, {
    extendedFields: Boolean(service.capabilities?.extendedFields),
  });
  if (error) {
    showInlineError(formError, error);
    return;
  }

  const extended = Boolean(service.capabilities?.extendedFields);
  addSubscriptionBtn.disabled = true;
  try {
    if (editingId) {
      await service.updateSubscription(currentFamilyCode, editingId, entry);
      stopEdit();
      notify(`Подписка «${entry.name}» сохранена.`);
    } else {
      await service.createSubscription(currentFamilyCode, entry, currentUser);
      form.reset();
      setCustomDaysVisible(false);
      notify(`Подписка «${entry.name}» добавлена.`);
    }
  } catch (err) {
    if (err && extended) err.extended = true;
    showInlineError(formError, describeFirebaseError(err));
  } finally {
    addSubscriptionBtn.disabled = !currentUser || !currentFamilyCode;
  }
});

// ---------- запуск ----------

async function onAuthChanged(user) {
  if (editingId && user?.uid !== currentUser?.uid) stopEdit();
  currentUser = user;

  if (user) {
    setAuthUiLoggedIn(user);
    hideCreatedInvite();

    if (currentFamilyCode) {
      try {
        await startRealtimeForFamilyCode(currentFamilyCode);
      } catch (error) {
        stopRealtime();
        clearSubscriptionsView();
        setSpaceDisconnected();
        spaceBadge.textContent = `Пространство: ${currentFamilyCode}`;
        spaceBadge.className = "sync-badge warn";
        spaceStatusText.textContent = describeFirebaseError(error);
      }
    } else {
      setSpaceDisconnected();
      render();
    }
  } else {
    stopRealtime();
    setAuthUiLoggedOut();
    clearSensitiveLocalState();
  }
}

function setupDemoUi(demo) {
  document.body.classList.add("is-demo");
  document.title = "TrackSubFin — демо";
  demoBanner.classList.remove("hidden");
  googleSignInBtn.classList.add("hidden");
  signOutBtn.classList.add("hidden");
  tryDemoLink.classList.add("hidden");
  demoMemberField.classList.remove("hidden");

  demoMemberSelect.innerHTML = "";
  for (const m of demo.members) {
    const opt = document.createElement("option");
    opt.value = m.uid;
    opt.textContent = m.displayName;
    demoMemberSelect.append(opt);
  }
  demoMemberSelect.addEventListener("change", () => demo.switchUser(demoMemberSelect.value));

  if (!currentFamilyCode) currentFamilyCode = demo.familyCode;
  familyCodeInput.value = currentFamilyCode;

  resetDemoBtn.addEventListener("click", async () => {
    if (!window.confirm("Сбросить демо-данные к исходному набору? Ваши изменения в демо пропадут.")) return;
    stopRealtime();
    safeRemove(FAMILY_CODE_KEY);
    currentFamilyCode = demo.familyCode;
    familyCodeInput.value = currentFamilyCode;
    inviteCodeInput.value = "";
    hideCreatedInvite();
    showInlineError(joinError, "");
    await demo.resetDemo();
    notify("Демо-данные сброшены.");
  });
}

async function boot() {
  familyCodeInput.value = currentFamilyCode;
  render();

  if (DEMO) {
    const mod = await import("./demo-service.js");
    service = mod.default;
    setupDemoUi(service);
  } else {
    if (!window.TRACKSUBFIN_FIREBASE_CONFIG) {
      firebaseSetupNotice.classList.remove("hidden");
      setAuthUiLoggedOut();
      setSpaceDisconnected();
      return;
    }
    try {
      service = await import("./firebase-service.js");
    } catch (error) {
      console.warn("Firebase SDK load failed", error);
      bootErrorNotice.classList.remove("hidden");
      setAuthUiLoggedOut();
      setSpaceDisconnected();
      return;
    }
    if (!service.hasFirebaseConfig()) {
      firebaseSetupNotice.classList.remove("hidden");
      setAuthUiLoggedOut();
      setSpaceDisconnected();
      return;
    }
  }

  if (service.capabilities?.extendedFields) {
    document.querySelectorAll(".ext-field").forEach((el) => el.classList.remove("hidden"));
  }
  service.initFirebase();
  serviceReady = true;
  setAuthUiLoggedOut();
  setSpaceDisconnected();
  service.watchAuth(onAuthChanged);
}

boot();
