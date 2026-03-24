const STORAGE_KEY = "tracksubfin.subscriptions.v1";

const form = document.getElementById("subscriptionForm");
const frequencySelect = document.getElementById("frequency");
const customDaysField = document.getElementById("customDaysField");
const listEl = document.getElementById("subscriptionsList");
const timelineEl = document.getElementById("timeline");
const totalMonthlyEl = document.getElementById("totalMonthly");
const cardTemplate = document.getElementById("subscriptionCardTemplate");

/** @type {Array<any>} */
let subscriptions = loadSubscriptions();

function loadSubscriptions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveSubscriptions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(subscriptions));
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

function render() {
  renderTimeline(subscriptions);
  renderList(subscriptions);
  renderTotal(subscriptions);
}

frequencySelect.addEventListener("change", (e) => {
  const show = e.target.value === "custom-days";
  customDaysField.classList.toggle("hidden", !show);
  customDaysField.querySelector("input").required = show;
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
