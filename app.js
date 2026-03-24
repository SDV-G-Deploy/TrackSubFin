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
const persistTokenCheckbox = document.getElementById("persistTokenCheckbox");
const syncFormError = document.getElementById("syncFormError");
const syncNowBtn = document.getElementById("syncNowBtn");
const disconnectSyncBtn = document.getElementById("disconnectSyncBtn");
const syncStateBadge = document.getElementById("syncStateBadge");
const syncStatusText = document.getElementById("syncStatusText");

const conflictModal = document.getElementById("conflictModal");
const closeConflictModalBtn = document.getElementById("closeConflictModalBtn");
const conflictCloudMeta = document.getElementById("conflictCloudMeta");
const conflictLocalMeta = document.getElementById("conflictLocalMeta");
const useCloudBtn = document.getElementById("useCloudBtn");
const useLocalBtn = document.getElementById("useLocalBtn");
const cancelConflictBtn = document.getElementById("cancelConflictBtn");

/** @type {Array<any>} */
let subscriptions = [];
let localMeta = { updatedAt: new Date(0).toISOString(), revision: "", version: 1 };
let syncConfig = loadSyncConfig();
let runtimeToken = syncConfig?.persistToken ? syncConfig?.token || "" : "";
let autosaveTimeout = null;

hydrateLocalState();

function stableSubscriptionsString(items) {
  return JSON.stringify(items || []);
}

function computeRevision(items) {
  const str = stableSubscriptionsString(items);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `r${(hash >>> 0).toString(16)}`;
}

function normalizePayload(payload) {
  const safeSubscriptions = Array.isArray(payload?.subscriptions) ? payload.subscriptions : [];
  const revision = payload?.revision || computeRevision(safeSubscriptions);
  const updatedAt = payload?.updatedAt || new Date().toISOString();

  return {
    version: 1,
    subscriptions: safeSubscriptions,
    updatedAt,
    revision,
  };
}

function hydrateLocalState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");

    if (Array.isArray(parsed)) {
      subscriptions = parsed;
      localMeta = {
        version: 1,
        updatedAt: new Date().toISOString(),
        revision: computeRevision(subscriptions),
      };
      persistLocalState();
      return;
    }

    if (parsed && typeof parsed === "object") {
      const normalized = normalizePayload(parsed);
      subscriptions = normalized.subscriptions;
      localMeta = {
        version: normalized.version,
        updatedAt: normalized.updatedAt,
        revision: normalized.revision,
      };
      return;
    }
  } catch {
    // fallback below
  }

  subscriptions = [];
  localMeta = {
    version: 1,
    updatedAt: new Date().toISOString(),
    revision: computeRevision(subscriptions),
  };
  persistLocalState();
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

  const persisted = {
    ...syncConfig,
    token: syncConfig.persistToken ? runtimeToken : undefined,
  };

  if (!syncConfig.persistToken) {
    delete persisted.token;
  }

  localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(persisted));
}

function persistLocalState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      updatedAt: localMeta.updatedAt,
      revision: localMeta.revision,
      subscriptions,
    })
  );
}

function markLocalChanged() {
  localMeta.updatedAt = new Date().toISOString();
  localMeta.revision = computeRevision(subscriptions);
  persistLocalState();
}

function saveSubscriptions() {
  markLocalChanged();
  scheduleAutosave();
}

function applyCloudPayload(payload) {
  const normalized = normalizePayload(payload);
  subscriptions = normalized.subscriptions;
  localMeta.updatedAt = normalized.updatedAt;
  localMeta.revision = normalized.revision;
  persistLocalState();
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
    updatedAt: localMeta.updatedAt,
    revision: localMeta.revision,
    subscriptions,
  };
}

function localHasUnsyncedChanges() {
  if (!syncConfig?.lastSyncedRevision) return subscriptions.length > 0;
  return localMeta.revision !== syncConfig.lastSyncedRevision;
}

function hasSessionTokenOnly() {
  return Boolean(syncConfig?.gistId) && !syncConfig?.persistToken;
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

function parseGistPayload(gist) {
  const file = gist?.files?.[GIST_FILENAME];
  if (!file?.content) {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      revision: computeRevision([]),
      subscriptions: [],
    };
  }

  try {
    const parsed = JSON.parse(file.content);
    return normalizePayload(parsed);
  } catch {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      revision: computeRevision([]),
      subscriptions: [],
    };
  }
}

async function loadFullGist(gistId, token) {
  const response = await githubFetch(`https://api.github.com/gists/${gistId}`, { method: "GET" }, token);
  return response.json();
}

async function pushToCloud(statusText = "Синхронизация выполнена") {
  if (!syncConfig?.gistId || !runtimeToken) return;

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
    runtimeToken
  );

  await response.json();
  syncConfig.lastSyncAt = new Date().toISOString();
  syncConfig.lastSyncStatus = statusText;
  syncConfig.lastSyncedRevision = localMeta.revision;
  syncConfig.lastKnownCloudUpdatedAt = localMeta.updatedAt;
  saveSyncConfig();
  renderSyncState();
}

function scheduleAutosave() {
  if (!syncConfig?.gistId || !runtimeToken) return;
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

  if (hasSessionTokenOnly() && !runtimeToken) {
    syncStateBadge.textContent = `Подключено: ${syncConfig.archiveCode}`;
    syncStateBadge.className = "sync-badge warn";
    syncStatusText.textContent = "Требуется токен для синхронизации после перезагрузки.";
    syncNowBtn.disabled = true;
    disconnectSyncBtn.disabled = false;
    return;
  }

  syncStateBadge.textContent = `Подключено: ${syncConfig.archiveCode}`;
  syncStateBadge.className = hasSessionTokenOnly() ? "sync-badge warn" : "sync-badge ok";

  const tokenMode = hasSessionTokenOnly() ? " Токен: только текущая сессия." : " Токен хранится локально.";
  const syncAt = syncConfig.lastSyncAt
    ? ` Последняя синхра: ${new Date(syncConfig.lastSyncAt).toLocaleString("ru-RU")}.`
    : "";
  syncStatusText.textContent = `${syncConfig.lastSyncStatus || "Готово"}.${tokenMode}${syncAt}`;

  syncNowBtn.disabled = !runtimeToken;
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

function openConflictModal(localPayload, cloudPayload) {
  return new Promise((resolve) => {
    const cloudDate = new Date(cloudPayload.updatedAt).toLocaleString("ru-RU");
    const localDate = new Date(localPayload.updatedAt).toLocaleString("ru-RU");

    conflictCloudMeta.textContent = `Облако: ${cloudDate}, ревизия ${cloudPayload.revision}`;
    conflictLocalMeta.textContent = `Локально: ${localDate}, ревизия ${localPayload.revision}`;

    const cleanup = () => {
      conflictModal.classList.add("hidden");
      useCloudBtn.removeEventListener("click", onCloud);
      useLocalBtn.removeEventListener("click", onLocal);
      cancelConflictBtn.removeEventListener("click", onCancel);
      closeConflictModalBtn.removeEventListener("click", onCancel);
      conflictModal.removeEventListener("click", onBackdrop);
    };

    const onCloud = () => {
      cleanup();
      resolve("cloud");
    };

    const onLocal = () => {
      cleanup();
      resolve("local");
    };

    const onCancel = () => {
      cleanup();
      resolve("cancel");
    };

    const onBackdrop = (event) => {
      if (event.target === conflictModal) onCancel();
    };

    useCloudBtn.addEventListener("click", onCloud);
    useLocalBtn.addEventListener("click", onLocal);
    cancelConflictBtn.addEventListener("click", onCancel);
    closeConflictModalBtn.addEventListener("click", onCancel);
    conflictModal.addEventListener("click", onBackdrop);

    conflictModal.classList.remove("hidden");
  });
}

openSyncModalBtn.addEventListener("click", () => {
  archiveCodeInput.value = syncConfig?.archiveCode || "";
  githubTokenInput.value = runtimeToken || "";
  persistTokenCheckbox.checked = Boolean(syncConfig?.persistToken);
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
  const persistToken = persistTokenCheckbox.checked;

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
      runtimeToken = token;
      syncConfig = {
        archiveCode,
        gistId: null,
        persistToken,
        lastSyncAt: null,
        lastSyncStatus: "Подключено. Создано новое облако.",
        lastSyncedRevision: null,
        lastKnownCloudUpdatedAt: null,
      };

      gist = await createGist(archiveCode, token);
      syncConfig.gistId = gist.id;
      syncConfig.lastSyncAt = new Date().toISOString();
      syncConfig.lastSyncedRevision = localMeta.revision;
      syncConfig.lastKnownCloudUpdatedAt = localMeta.updatedAt;
      saveSyncConfig();
      render();
      closeModal();
      return;
    }

    gist = await loadFullGist(gist.id, token);
    const cloudPayload = parseGistPayload(gist);
    const localPayload = syncPayload();

    const cloudIsNewer = new Date(cloudPayload.updatedAt).getTime() > new Date(localPayload.updatedAt).getTime();
    const localUnsynced = cloudPayload.revision !== localPayload.revision;

    let conflictChoice = "cloud";
    if (cloudIsNewer && localUnsynced) {
      conflictChoice = await openConflictModal(localPayload, cloudPayload);
      if (conflictChoice === "cancel") {
        showSyncError("Подключение отменено: выберите вариант разрешения конфликта, когда будете готовы.");
        return;
      }
    }

    runtimeToken = token;
    syncConfig = {
      archiveCode,
      gistId: gist.id,
      persistToken,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: gistExisted ? "Подключено." : "Подключено. Создано новое облако.",
      lastSyncedRevision: null,
      lastKnownCloudUpdatedAt: null,
    };

    if (conflictChoice === "cloud") {
      applyCloudPayload(cloudPayload);
      syncConfig.lastSyncStatus = "Подключено. Использована версия из облака.";
      syncConfig.lastSyncedRevision = localMeta.revision;
      syncConfig.lastKnownCloudUpdatedAt = localMeta.updatedAt;
      saveSyncConfig();
      render();
      closeModal();
      return;
    }

    await pushToCloud("Подключено. Локальная версия отправлена в облако.");
    saveSyncConfig();
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

  if (!runtimeToken) {
    showSyncError("Для ручной синхронизации введите токен заново через «Синхронизация».");
    openModal();
    return;
  }

  syncNowBtn.disabled = true;
  syncNowBtn.textContent = "Синхронизация...";
  try {
    const gist = await loadFullGist(syncConfig.gistId, runtimeToken);
    const cloudPayload = parseGistPayload(gist);
    const localPayload = syncPayload();

    const cloudIsNewer = new Date(cloudPayload.updatedAt).getTime() > new Date(localPayload.updatedAt).getTime();
    const localUnsynced = localHasUnsyncedChanges() && cloudPayload.revision !== localPayload.revision;

    if (cloudIsNewer && localUnsynced) {
      const choice = await openConflictModal(localPayload, cloudPayload);
      if (choice === "cancel") {
        syncConfig.lastSyncStatus = "Ручная синхронизация отменена пользователем.";
        saveSyncConfig();
        renderSyncState();
        return;
      }

      if (choice === "cloud") {
        applyCloudPayload(cloudPayload);
        syncConfig.lastSyncAt = new Date().toISOString();
        syncConfig.lastSyncStatus = "Ручная синхронизация: применена версия из облака.";
        syncConfig.lastSyncedRevision = localMeta.revision;
        syncConfig.lastKnownCloudUpdatedAt = localMeta.updatedAt;
        saveSyncConfig();
        render();
        return;
      }
    }

    await pushToCloud("Ручная синхронизация выполнена");
  } catch (err) {
    syncConfig.lastSyncStatus = `Ошибка ручной синхры: ${err.message}`;
    saveSyncConfig();
    renderSyncState();
  } finally {
    syncNowBtn.disabled = !runtimeToken;
    syncNowBtn.textContent = "Синхронизировать сейчас";
  }
});

disconnectSyncBtn.addEventListener("click", () => {
  syncConfig = null;
  runtimeToken = "";
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