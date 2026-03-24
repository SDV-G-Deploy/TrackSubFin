const STORAGE_KEY = "tracksubfin.subscriptions.v1";
const SYNC_STORAGE_KEY = "tracksubfin.sync.v1";
const GIST_FILENAME = "tracksubfin-data.json";
const ARCHIVE_CODE_RE = /^[A-Za-z0-9-]{6,24}$/;

const form = document.getElementById("subscriptionForm");
const frequencySelect = document.getElementById("frequency");
const customDaysField = document.getElementById("customDaysField");
const listEl = document.getElementById("subscriptionsList");
const timelineEl = document.getElementById("timeline");
const totalMonthlyEl = document.getElementById("totalMonthly");
const cardTemplate = document.getElementById("subscriptionCardTemplate");

const openSyncModalBtn = document.getElementById("openSyncModalBtn");
const closeSyncModalBtn = document.getElementById("closeSyncModalBtn");
const syncModal = document.getElementById("syncModal");
const syncConnectForm = document.getElementById("syncConnectForm");
const archiveCodeInput = document.getElementById("archiveCodeInput");
const githubTokenInput = document.getElementById("githubTokenInput");
const toggleTokenBtn = document.getElementById("toggleTokenBtn");
const syncFormError = document.getElementById("syncFormError");
const syncNowBtn = document.getElementById("syncNowBtn");
const disconnectSyncBtn = document.getElementById("disconnectSyncBtn");
const syncStateBadge = document.getElementById("syncStateBadge");
const syncStatusText = document.getElementById("syncStatusText");

/** @type {Array<any>} */
let subscriptions = loadSubscriptions();
let syncConfig = loadSyncConfig();
let autosaveTimeout = null;

function loadSubscriptions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function loadSyncConfig() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_STORAGE_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveSyncConfig() {
  if (!syncConfig) {
    localStorage.removeItem(SYNC_STORAGE_KEY);
    return;
  }
  localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(syncConfig));
}

function saveSubscriptions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(subscriptions));
  scheduleAutosave();
}

function gistDescription(code) {
  return `TrackSubFin Sync ${code}`;
}

function getHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function syncPayload() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    subscriptions,
  };
}

async function githubFetch(url, options, token) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...getHeaders(token),
        ...(options?.headers || {}),
      },
    });
  } catch {
    throw new Error("Проблема сети: не удалось связаться с GitHub.");
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("401: токен недействителен или без доступа к gist.");
    }
    if (response.status === 403) {
      const resetAt = response.headers.get("x-ratelimit-reset");
      const rateMsg = resetAt
        ? ` Попробуйте после ${new Date(Number(resetAt) * 1000).toLocaleTimeString("ru-RU")}.`
        : "";
      throw new Error(`403: лимит GitHub API или нет прав.${rateMsg}`);
    }
    throw new Error(`${response.status}: ошибка GitHub API.`);
  }

  return response;
}

async function findGistByCode(code, token) {
  const response = await githubFetch("https://api.github.com/gists?per_page=100", { method: "GET" }, token);
  const gists = await response.json();
  const description = gistDescription(code);
  return gists.find((g) => g.description === description && g.files && g.files[GIST_FILENAME]);
}

async function createGist(code, token) {
  const payload = {
    description: gistDescription(code),
    public: false,
    files: {
      [GIST_FILENAME]: {
        content: JSON.stringify(syncPayload(), null, 2),
      },
    },
  };

  const response = await githubFetch(
    "https://api.github.com/gists",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token
  );

  return response.json();
}

function parseGistSubscriptions(gist) {
  const file = gist?.files?.[GIST_FILENAME];
  if (!file?.content) return [];

  try {
    const parsed = JSON.parse(file.content);
    return Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  } catch {
    return [];
  }
}

async function loadFullGist(gistId, token) {
  const response = await githubFetch(`https://api.github.com/gists/${gistId}`, { method: "GET" }, token);
  return response.json();
}

async function pushToCloud(statusText = "Синхронизация выполнена") {
  if (!syncConfig?.token || !syncConfig?.gistId) return;

  const response = await githubFetch(
    `https://api.github.com/gists/${syncConfig.gistId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: {
            content: JSON.stringify(syncPayload(), null, 2),
          },
        },
      }),
    },
    syncConfig.token
  );

  await response.json();
  syncConfig.lastSyncAt = new Date().toISOString();
  syncConfig.lastSyncStatus = statusText;
  saveSyncConfig();
  renderSyncState();
}

function scheduleAutosave() {
  if (!syncConfig?.gistId || !syncConfig?.token) return;
  if (autosaveTimeout) clearTimeout(autosaveTimeout);

  autosaveTimeout = setTimeout(async () => {
    try {
      await pushToCloud("Автосинхронизация выполнена");
    } catch (err) {
      syncConfig.lastSyncStatus = `Ошибка автосинхронизации: ${err.message}`;
      saveSyncConfig();
      renderSyncState();
    }
  }, 900);
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
  return `$${value.toFixed(2)}`;
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
        <p class="sub-meta">${fmtCurrency(Number(sub.price))}</p>
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

      node.querySelector(".sub-price").textContent = `${fmtCurrency(Number(sub.price))}`;

      const removeBtn = node.querySelector(".btn-danger");
      removeBtn.addEventListener("click", () => {
        subscriptions = subscriptions.filter((s) => s.id !== sub.id);
        saveSubscriptions();
        render();
      });

      listEl.appendChild(node);
    });
}

function renderTotal(items) {
  const sum = items.reduce((acc, item) => acc + toMonthly(item), 0);
  totalMonthlyEl.textContent = `${fmtCurrency(sum)} / мес`;
}

function renderSyncState() {
  if (!syncConfig?.gistId) {
    syncStateBadge.textContent = "Не подключено";
    syncStateBadge.className = "sync-badge muted";
    syncStatusText.textContent = "Подключите GitHub Gist, чтобы видеть одни и те же данные на разных устройствах.";
    syncNowBtn.disabled = true;
    disconnectSyncBtn.disabled = true;
    return;
  }

  syncStateBadge.textContent = `Подключено: ${syncConfig.archiveCode}`;
  syncStateBadge.className = "sync-badge ok";

  const syncAt = syncConfig.lastSyncAt
    ? ` Последняя синхра: ${new Date(syncConfig.lastSyncAt).toLocaleString("ru-RU")}.`
    : "";
  syncStatusText.textContent = `${syncConfig.lastSyncStatus || "Готово"}.${syncAt}`;

  syncNowBtn.disabled = false;
  disconnectSyncBtn.disabled = false;
}

function render() {
  renderTimeline(subscriptions);
  renderList(subscriptions);
  renderTotal(subscriptions);
  renderSyncState();
}

function showSyncError(message) {
  syncFormError.textContent = message;
  syncFormError.classList.remove("hidden");
}

function clearSyncError() {
  syncFormError.textContent = "";
  syncFormError.classList.add("hidden");
}

function openModal() {
  syncModal.classList.remove("hidden");
}

function closeModal() {
  syncModal.classList.add("hidden");
  clearSyncError();
}

openSyncModalBtn.addEventListener("click", () => {
  archiveCodeInput.value = syncConfig?.archiveCode || "";
  githubTokenInput.value = syncConfig?.token || "";
  githubTokenInput.type = "password";
  toggleTokenBtn.textContent = "Показать";
  openModal();
});

closeSyncModalBtn.addEventListener("click", closeModal);
syncModal.addEventListener("click", (event) => {
  if (event.target === syncModal) closeModal();
});

toggleTokenBtn.addEventListener("click", () => {
  const show = githubTokenInput.type === "password";
  githubTokenInput.type = show ? "text" : "password";
  toggleTokenBtn.textContent = show ? "Скрыть" : "Показать";
});

frequencySelect.addEventListener("change", (e) => {
  const show = e.target.value === "custom-days";
  customDaysField.classList.toggle("hidden", !show);
  customDaysField.querySelector("input").required = show;
});

syncConnectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSyncError();

  const archiveCode = archiveCodeInput.value.trim();
  const token = githubTokenInput.value.trim();

  if (!ARCHIVE_CODE_RE.test(archiveCode)) {
    showSyncError("Archive Code: 6-24 символов, только латиница/цифры/дефис.");
    return;
  }

  if (!token) {
    showSyncError("Введите GitHub Token.");
    return;
  }

  const connectBtn = document.getElementById("connectSyncBtn");
  connectBtn.disabled = true;
  connectBtn.textContent = "Подключение...";

  try {
    let gist = await findGistByCode(archiveCode, token);
    const gistExisted = Boolean(gist);

    if (!gist) {
      gist = await createGist(archiveCode, token);
    } else {
      gist = await loadFullGist(gist.id, token);
      subscriptions = parseGistSubscriptions(gist);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(subscriptions));
    }

    syncConfig = {
      archiveCode,
      token,
      gistId: gist.id,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: gistExisted ? "Подключено. Облако загружено." : "Подключено. Создано новое облако.",
    };

    saveSyncConfig();

    await pushToCloud("Синхронизация после подключения выполнена");
    render();
    closeModal();
  } catch (err) {
    showSyncError(err.message || "Не удалось подключиться к GitHub Gist.");
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = "Подключить";
  }
});

syncNowBtn.addEventListener("click", async () => {
  if (!syncConfig?.gistId) return;

  syncNowBtn.disabled = true;
  syncNowBtn.textContent = "Синхронизация...";
  try {
    await pushToCloud("Ручная синхронизация выполнена");
  } catch (err) {
    syncConfig.lastSyncStatus = `Ошибка ручной синхры: ${err.message}`;
    saveSyncConfig();
    renderSyncState();
  } finally {
    syncNowBtn.disabled = false;
    syncNowBtn.textContent = "Синхронизировать сейчас";
  }
});

disconnectSyncBtn.addEventListener("click", () => {
  syncConfig = null;
  saveSyncConfig();
  renderSyncState();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData(form);

  const nextChargeDate = fd.get("nextChargeDate");
  const endDate = fd.get("endDate");
  const frequency = fd.get("frequency");
  const customDays = fd.get("customDays");

  const entry = {
    id: crypto.randomUUID(),
    name: String(fd.get("name") || "").trim(),
    price: Number(fd.get("price") || 0),
    frequency,
    customDays: frequency === "custom-days" ? Number(customDays || 0) : null,
    nextChargeDate,
    cardName: String(fd.get("cardName") || "").trim(),
    cardLast4: String(fd.get("cardLast4") || "").trim(),
    endDate: endDate ? String(endDate) : null,
  };

  subscriptions.push(entry);
  saveSubscriptions();
  form.reset();
  customDaysField.classList.add("hidden");
  customDaysField.querySelector("input").required = false;
  render();
});

render();
