// Чистая логика без DOM и Firebase: нормализация, валюты, итоги, продления, подсказки, CSV.
// Модуль импортируется и браузером (app.js), и node-тестами (tests/logic.test.mjs).

export const ALLOWED_FREQUENCIES = new Set(["monthly", "yearly", "custom-days"]);

export const CURRENCIES = ["EUR", "USD", "RSD"];
export const DEFAULT_CURRENCY = "USD"; // старые записи без валюты отображались как "$"

// Статичные курсы, НЕ живые. Сколько единиц валюты за 1 EUR.
// Ориентировочные значения, зафиксированы вручную на дату ниже.
export const EXCHANGE_RATES = {
  asOf: "2026-10-01",
  base: "EUR",
  perEur: { EUR: 1, USD: 1.08, RSD: 117.2 },
};

export const CATEGORIES = [
  "Видео",
  "Музыка",
  "Софт",
  "Облако",
  "Связь",
  "Спорт",
  "Доставка",
  "Другое",
];
export const DEFAULT_CATEGORY = "Другое";

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseIsoDateOrNull(value) {
  const str = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const date = new Date(`${str}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // отсекаем 2026-02-31 и т.п.
  return date.toISOString().slice(0, 10) === str ? str : null;
}

export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoToUtcMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

function utcMsToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  return utcMsToIso(isoToUtcMs(iso) + days * DAY_MS);
}

export function addMonths(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return utcMsToIso(Date.UTC(ny, nm, Math.min(d, lastDay)));
}

export function daysBetween(fromIso, toIso) {
  return Math.round((isoToUtcMs(toIso) - isoToUtcMs(fromIso)) / DAY_MS);
}

function sanitizeCreatedBy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const uid = raw.uid ? String(raw.uid) : "";
  if (!uid) return null;
  return {
    uid,
    name: raw.name ? String(raw.name) : null,
    email: raw.email ? String(raw.email) : null,
  };
}

export function normalizeSubscription(raw) {
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
  const currencyRaw = String(raw.currency || "").trim().toUpperCase();
  const currency = CURRENCIES.includes(currencyRaw) ? currencyRaw : DEFAULT_CURRENCY;
  const categoryRaw = String(raw.category || "").trim();
  const category = CATEGORIES.includes(categoryRaw) ? categoryRaw : DEFAULT_CATEGORY;

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
    currency,
    category,
    frequency,
    customDays,
    nextChargeDate,
    cardName,
    cardLast4,
    endDate,
    createdBy: sanitizeCreatedBy(raw.createdBy),
  };
}

export function normalizeSubscriptions(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map(normalizeSubscription).filter(Boolean);
}

/**
 * Проверка данных формы. Возвращает { entry } или { error }.
 * entry не содержит ключа customDays для monthly/yearly — так требуют Firestore Rules.
 */
export function validateSubscriptionInput(input, { extendedFields = false } = {}) {
  const frequency = String(input.frequency || "").trim();
  const price = Number(input.price);
  const customDaysValue = Number(input.customDays);
  const nextChargeDate = parseIsoDateOrNull(input.nextChargeDate);
  const endDate = input.endDate ? parseIsoDateOrNull(input.endDate) : null;
  const name = String(input.name || "").trim();
  const cardName = String(input.cardName || "").trim();
  const cardLast4 = String(input.cardLast4 || "").trim();

  if (!name) return { error: "Укажите название подписки." };
  if (name.length > 120) return { error: "Название слишком длинное (максимум 120 символов)." };
  if (!ALLOWED_FREQUENCIES.has(frequency)) return { error: "Некорректная периодичность." };
  if (String(input.price ?? "").trim() === "" || !Number.isFinite(price) || price < 0) {
    return { error: "Цена должна быть числом не меньше 0." };
  }
  if (frequency === "custom-days" && !(Number.isInteger(customDaysValue) && customDaysValue >= 1)) {
    return { error: "Для «Каждые N дней» укажите целое количество дней (минимум 1)." };
  }
  if (!nextChargeDate) return { error: "Укажите корректную дату следующего списания." };
  if (input.endDate && !endDate) return { error: "Укажите корректную дату окончания." };
  if (endDate && endDate < nextChargeDate) return { error: "Дата окончания не может быть раньше списания." };
  if (!cardName) return { error: "Укажите название карты." };
  if (cardName.length > 120) return { error: "Название карты слишком длинное (максимум 120 символов)." };
  if (!/^\d{4}$/.test(cardLast4)) return { error: "Последние цифры карты — ровно 4 цифры." };

  const entry = { name, price, frequency, nextChargeDate, cardName, cardLast4, endDate };
  if (frequency === "custom-days") entry.customDays = customDaysValue;

  if (extendedFields) {
    const currency = String(input.currency || "").toUpperCase();
    const category = String(input.category || "");
    if (!CURRENCIES.includes(currency)) return { error: "Выберите валюту." };
    if (!CATEGORIES.includes(category)) return { error: "Выберите категорию." };
    entry.currency = currency;
    entry.category = category;
  }

  return { entry };
}

export function convert(amount, from, to, rates = EXCHANGE_RATES) {
  const fromRate = rates.perEur[from];
  const toRate = rates.perEur[to];
  if (!fromRate || !toRate) throw new Error(`Unknown currency: ${from} -> ${to}`);
  return (Number(amount) / fromRate) * toRate;
}

/** Стоимость в месяц в исходной валюте подписки. */
export function monthlyCost(sub) {
  const price = Number(sub.price || 0);
  if (sub.frequency === "yearly") return price / 12;
  if (sub.frequency === "custom-days") {
    const days = Number(sub.customDays || 30);
    return days > 0 ? price * (365 / 12 / days) : 0;
  }
  return price;
}

export function monthlyIn(sub, currency, rates = EXCHANGE_RATES) {
  return convert(monthlyCost(sub), sub.currency || DEFAULT_CURRENCY, currency, rates);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function totals(items, currency, rates = EXCHANGE_RATES) {
  const monthly = items.reduce((acc, sub) => acc + monthlyIn(sub, currency, rates), 0);
  return { currency, monthly: round2(monthly), yearly: round2(monthly * 12) };
}

function stepDate(sub, iso) {
  if (sub.frequency === "monthly") return addMonths(iso, 1);
  if (sub.frequency === "yearly") return addMonths(iso, 12);
  return addDays(iso, Number(sub.customDays) || 30);
}

/**
 * Все списания подписки в окне [today, today + days] (включительно),
 * с учётом периодичности и даты окончания. Прошедший nextChargeDate
 * прокручивается вперёд по периоду.
 */
export function occurrencesInWindow(sub, today, days) {
  const until = addDays(today, days);
  const out = [];
  let date = sub.nextChargeDate;
  let guard = 0;
  while (date < today && guard < 2000) {
    date = stepDate(sub, date);
    guard += 1;
  }
  while (date <= until && guard < 4000) {
    if (sub.endDate && date > sub.endDate) break;
    out.push(date);
    date = stepDate(sub, date);
    guard += 1;
  }
  return out;
}

export function upcomingRenewals(items, today, days, currency, rates = EXCHANGE_RATES) {
  const list = [];
  for (const sub of items) {
    for (const date of occurrencesInWindow(sub, today, days)) {
      list.push({
        sub,
        date,
        inDays: daysBetween(today, date),
        amount: Number(sub.price),
        converted: round2(convert(sub.price, sub.currency || DEFAULT_CURRENCY, currency, rates)),
      });
    }
  }
  list.sort((a, b) => (a.date === b.date ? a.sub.name.localeCompare(b.sub.name) : a.date < b.date ? -1 : 1));
  const total = round2(list.reduce((acc, r) => acc + r.converted, 0));
  return { items: list, total, currency };
}

/**
 * Прогноз фактических списаний по календарным месяцам: текущий месяц (от today)
 * и следующие months-1. Учитывает периодичность, годовые всплески и endDate.
 * Возвращает [{ month: "YYYY-MM", total, count }] в валюте currency.
 */
export function monthlyForecast(items, today, months, currency, rates = EXCHANGE_RATES) {
  const startMonth = today.slice(0, 7);
  const buckets = [];
  const index = new Map();
  for (let i = 0; i < months; i += 1) {
    const month = addMonths(`${startMonth}-01`, i).slice(0, 7);
    index.set(month, buckets.length);
    buckets.push({ month, total: 0, count: 0 });
  }
  const lastMonth = buckets[buckets.length - 1]?.month;
  if (!lastMonth) return [];
  const lastDay = addDays(addMonths(`${lastMonth}-01`, 1), -1);
  const days = daysBetween(today, lastDay);
  for (const sub of items) {
    const amount = convert(sub.price, sub.currency || DEFAULT_CURRENCY, currency, rates);
    for (const date of occurrencesInWindow(sub, today, days)) {
      const i = index.get(date.slice(0, 7));
      if (i == null) continue;
      buckets[i].total += amount;
      buckets[i].count += 1;
    }
  }
  return buckets.map((b) => ({ ...b, total: round2(b.total) }));
}

export function memberLabel(createdBy) {
  if (!createdBy) return "Не указан";
  return createdBy.name || createdBy.email || "Участник";
}

function groupMonthly(items, keyFn, labelFn, currency, rates) {
  const map = new Map();
  for (const sub of items) {
    const key = keyFn(sub);
    const cur = map.get(key) || { key, label: labelFn(sub), monthly: 0, count: 0 };
    cur.monthly += monthlyIn(sub, currency, rates);
    cur.count += 1;
    map.set(key, cur);
  }
  const total = [...map.values()].reduce((a, g) => a + g.monthly, 0);
  return [...map.values()]
    .map((g) => ({
      ...g,
      monthly: round2(g.monthly),
      share: total > 0 ? Math.round((g.monthly / total) * 100) : 0,
    }))
    .sort((a, b) => b.monthly - a.monthly || a.label.localeCompare(b.label));
}

export function splitByMember(items, currency, rates = EXCHANGE_RATES) {
  return groupMonthly(
    items,
    (s) => s.createdBy?.uid || "unknown",
    (s) => memberLabel(s.createdBy),
    currency,
    rates
  );
}

export function categoryBreakdown(items, currency, rates = EXCHANGE_RATES) {
  return groupMonthly(
    items,
    (s) => s.category || DEFAULT_CATEGORY,
    (s) => s.category || DEFAULT_CATEGORY,
    currency,
    rates
  );
}

/**
 * Кандидаты на отмену — только то, что выводится из имеющихся данных
 * (данных об использовании в модели нет):
 *  - overlap: 2+ подписки в одной категории (кроме «Другое»);
 *  - expensive: подписка занимает >= 25% месячного бюджета (если подписок >= 3);
 *  - yearly-soon: годовое продление в ближайшие 30 дней — время решить;
 *  - stale: дата списания давно прошла (> 7 дней) — данные устарели или подписка не нужна.
 */
export function cancelCandidates(items, today, currency, rates = EXCHANGE_RATES) {
  const hints = [];
  const total = items.reduce((a, s) => a + monthlyIn(s, currency, rates), 0);

  const byCategory = new Map();
  for (const sub of items) {
    if (sub.category === DEFAULT_CATEGORY) continue;
    const arr = byCategory.get(sub.category) || [];
    arr.push(sub);
    byCategory.set(sub.category, arr);
  }
  for (const [category, subs] of byCategory) {
    if (subs.length < 2) continue;
    const sum = subs.reduce((a, s) => a + monthlyIn(s, currency, rates), 0);
    hints.push({
      kind: "overlap",
      subs: subs.map((s) => s.name),
      monthly: round2(sum),
      text: `${subs.length} подписки в категории «${category}»: ${subs
        .map((s) => s.name)
        .join(", ")}. Нужны ли все?`,
    });
  }

  if (items.length >= 3 && total > 0) {
    for (const sub of items) {
      const m = monthlyIn(sub, currency, rates);
      const share = Math.round((m / total) * 100);
      if (share >= 25) {
        hints.push({
          kind: "expensive",
          subs: [sub.name],
          monthly: round2(m),
          text: `${sub.name} — ${share}% месячных расходов на подписки.`,
        });
      }
    }
  }

  for (const sub of items) {
    if (sub.frequency !== "yearly") continue;
    const next = occurrencesInWindow(sub, today, 30)[0];
    if (!next) continue;
    hints.push({
      kind: "yearly-soon",
      subs: [sub.name],
      monthly: round2(monthlyIn(sub, currency, rates)),
      text: `${sub.name}: годовое продление через ${daysBetween(today, next)} дн. Решите до списания.`,
    });
  }

  for (const sub of items) {
    const overdue = daysBetween(sub.nextChargeDate, today);
    if (overdue > 7) {
      hints.push({
        kind: "stale",
        subs: [sub.name],
        monthly: round2(monthlyIn(sub, currency, rates)),
        text: `${sub.name}: дата списания прошла ${overdue} дн. назад — обновите или отмените.`,
      });
    }
  }

  return hints;
}

const FREQ_LABEL = { monthly: "Ежемесячно", yearly: "Ежегодно", "custom-days": "Каждые N дней" };
export function frequencyLabel(sub) {
  if (sub.frequency === "custom-days") return `Каждые ${sub.customDays} дн.`;
  return FREQ_LABEL[sub.frequency] || sub.frequency;
}

function csvCell(value) {
  let str = value == null ? "" : String(value);
  // защита от CSV/formula injection при открытии в Excel/Sheets
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r;]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(items, currency, rates = EXCHANGE_RATES) {
  const header = [
    "name",
    "category",
    "price",
    "currency",
    "frequency",
    "custom_days",
    "next_charge_date",
    "end_date",
    "card_name",
    "card_last4",
    "member",
    `monthly_${currency}`,
    "rates_as_of",
  ];
  const rows = items.map((s) => [
    s.name,
    s.category || DEFAULT_CATEGORY,
    Number(s.price).toFixed(2),
    s.currency || DEFAULT_CURRENCY,
    s.frequency,
    s.customDays ?? "",
    s.nextChargeDate,
    s.endDate || "",
    s.cardName,
    s.cardLast4,
    memberLabel(s.createdBy),
    monthlyIn(s, currency, rates).toFixed(2),
    rates.asOf,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function formatMoney(value, currency, locale = "ru-RU") {
  const digits = currency === "RSD" ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number(value || 0));
  } catch {
    return `${Number(value || 0).toFixed(digits)} ${currency}`;
  }
}
