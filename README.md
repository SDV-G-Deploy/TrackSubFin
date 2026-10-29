# TrackSubFin

Простой трекер подписок для пары/семьи (Google Sign-In + Firestore realtime).

Сайт: **https://sdv-g-deploy.github.io/TrackSubFin/**
Демо без входа: **https://sdv-g-deploy.github.io/TrackSubFin/?demo=1**

---

## Демо-режим (без Google и Firebase)

Кнопка «Попробовать демо без входа» на экране входа или параметр `?demo=1` в адресе.

- Вместо `firebase-service.js` подключается `demo-service.js` — адаптер с тем же интерфейсом,
  данные лежат только в `localStorage` этого браузера (ключ `tracksubfin.demo.v1`). Firebase SDK
  в демо не загружается, сетевых запросов нет.
- Предзаполнено: пространство `DEMO01`, два участника (Сергей и Аня), 12 подписок в RSD/EUR/USD,
  ежемесячные, ежегодные и «каждые N дней». Даты считаются от сегодняшнего дня.
- Жёлтая плашка «ДЕМО» вверху; кнопки «Сбросить демо-данные» и «Выйти из демо».
- Ключи интерфейса в демо отделены от реального режима, демо не трогает реальные данные.

### Короткий сценарий показа (2–3 минуты)

1. Откройте `?demo=1`. В «Сводке» — расходы в месяц и в год в одной валюте, сумма списаний
   за 7 и 30 дней.
2. Переключите валюту (EUR / USD / RSD) — пересчитывается всё. Курсы статичные, дата указана
   под карточками.
3. «Кто сколько платит» — разбивка по участникам (кто добавил подписку), «По категориям» — по
   категориям.
4. «Ближайшие списания» — переключатель 7 / 30 дней; красным — ≤ 3 дня, жёлтым — ≤ 7 дней.
5. «Что можно отменить» — пересечения в одной категории, дорогие подписки (≥ 25% бюджета),
   скорое годовое продление, устаревшие даты.
6. Переключите «Действовать от имени участника» на Аню и добавьте подписку — в карточке
   появится её имя. Во второй вкладке изменения появятся сразу (синхронизация через `storage`).
7. «Экспорт CSV» — выгрузка всех подписок (UTF-8, с пересчётом в выбранную валюту).
8. «Создать код» → «Подключить» — новое пустое пространство (пустые состояния).
   «Сбросить демо-данные» — вернуть исходный набор.

### Валюта и категория

Поля `currency` и `category` есть только в демо. Текущие Firestore Rules разрешают фиксированный
набор ключей подписки, поэтому в реальном режиме эти поля скрыты и не отправляются; старые записи
считаются в USD (как раньше — `$`) и попадают в категорию «Другое». Чтобы включить их в реальном
режиме, нужно расширить `hasOnlyAllowedSubscriptionKeys` в `firestore.rules` (с проверкой значений),
задеплоить rules и выставить `capabilities.extendedFields = true` в `firebase-service.js`.

### Курсы валют

Фиксированные ориентировочные курсы в `logic.js` (`EXCHANGE_RATES`, дата `asOf`), не live.
Обновляются вручную.

---

## Что изменено по security

### Почему одного `familyCode` недостаточно
Если пускать по одному коду пространства, любой, кто узнал `familyCode`, может сам себе открыть доступ (IDOR / privilege escalation).

Теперь вход в существующее пространство только через **invite**:
- `spaces/{familyCode}/invites/{inviteCode}`
- проверка срока (`expiresAt`)
- проверка лимита (`maxUses`, `usedCount`)
- только после этого создаётся `members/{uid}`

> Для нового пространства (первый участник) bootstrap выполняется в 2 шага (сначала `meta/access`, потом `members/{uid}`), чтобы не упираться в Firestore Rules.

---

## Новый flow (коротко)

1. Войти через Google.
2. Первый пользователь нажимает «Создать код» и «Подключить» (создаёт своё пространство).
3. Первый пользователь нажимает «Создать инвайт».
4. Второй пользователь вводит `familyCode + inviteCode` (или share-код `FAMILY-INVITE`) и подключается.
5. После подключения оба видят и редактируют общий список подписок.
6. Ошибки подключения теперь показываются с причиной (`permission-denied`, `failed-precondition`, просроченный/исчерпанный инвайт и т.д.), без «тихого» фейла.

---

## Firestore структура

- `spaces/{familyCode}/meta/access` — владелец пространства (bootstrap первого участника)
- `spaces/{familyCode}/members/{uid}` — участники
- `spaces/{familyCode}/invites/{inviteCode}` — инвайты
- `spaces/{familyCode}/subscriptions/{id}` — подписки

Пример invite-документа:
```json
{
  "createdAt": "timestamp",
  "createdBy": { "uid": "...", "email": "...", "name": "..." },
  "expiresAt": "timestamp",
  "maxUses": 1,
  "usedCount": 0,
  "usedBy": null,
  "usedAt": null
}
```

---

## Деплой Firestore rules

```bash
npm i -g firebase-tools
firebase login
firebase use <YOUR_FIREBASE_PROJECT_ID>
firebase deploy --only firestore:rules
```

Проверить активные rules:
```bash
firebase firestore:rules:get
```

---

## Security regression checks (минимум)

В проект добавлен скелет теста правил для Firebase Emulator:
- `tests/firestore.rules.test.mjs`
- script: `npm run test:rules` (после `npm i`)

Запуск с эмулятором (нужны Java и firebase-tools; проект `demo-*` не обращается к реальному Firebase):
```bash
npm i --legacy-peer-deps   # @firebase/rules-unit-testing@4 объявляет peer firebase@11
firebase emulators:exec --only firestore --project demo-tracksubfin "npm run test:rules"
```

Быстрый smoke-check синтаксиса JS:
```bash
npm run lint:smoke
```

Unit-тесты чистой логики (итоги, пересчёт валют, продления, подсказки, CSV) и демо-адаптера,
без зависимостей:
```bash
npm test
```

## Файлы

- `app.js` — UI; выбирает адаптер (`firebase-service.js` или `demo-service.js`)
- `logic.js` — чистые функции без DOM (итоги, продления, подсказки, CSV)
- `firebase-service.js` — Firebase Auth + Firestore
- `demo-service.js` — демо-адаптер на `localStorage`

---

## Локальный запуск

```bash
python3 -m http.server 8080
# или
npx serve -l 8080
```

Открыть: `http://localhost:8080` (демо: `http://localhost:8080/?demo=1`)

> `file://` для Firebase Auth не подходит; ES-модули тоже требуют http-сервер.

---

## Deploy

При push в `main` GitHub Actions публикует сайт на GitHub Pages (`.github/workflows/pages.yml`).
