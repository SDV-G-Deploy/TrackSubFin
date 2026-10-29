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

### Валюта и категория: сейчас только в демо

| | Демо (`?demo=1`) | Реальный режим (Firebase) |
|---|---|---|
| Добавление / удаление подписок | да | да |
| Редактирование (кнопка «Изменить», только автор) | да | да |
| Поля `currency` / `category` в форме и в записи | да | **нет** (`capabilities.extendedFields = false`) |
| Сводка, прогноз, разбивки, CSV | да | да (записи без валюты считаются в USD, категория «Другое») |

Почему так: GitHub Pages выкладывается автоматически при мерже в `main`, а Firestore rules деплоятся
вручную. **`firestore.rules` в репозитории = rules, задеплоенные сейчас в Firebase.** Они отклоняют любые
лишние ключи, поэтому в реальном режиме клиент шлёт только старую форму документа (без `currency` /
`category`, и без `customDays` для monthly/yearly). Это проверяет `tests/firestore.rules.prod.test.mjs`
на эмуляторе: создание monthly / yearly / custom-days и редактирование ровно теми payload, которые
формирует приложение (`validateSubscriptionInput` → `buildSubscriptionDoc` / `buildSubscriptionPatch`
из `logic.js`).

Будущие rules с полями валюты/категории лежат в **`firestore.rules.next`** (проверяются
`tests/firestore.rules.next.test.mjs`; списки валют/категорий синхронизированы с `logic.js` —
`tests/rules-sync.test.mjs`).

#### Включение валюты и категории в реальном режиме (позже, владелец проекта)

Порядок важен: сначала rules, потом код.

1. Прогнать тесты: `npm test && npm run test:rules:emulator`.
2. Задеплоить новые rules, не меняя код сайта:
   ```bash
   cp firestore.rules.next firestore.rules
   firebase deploy --only firestore:rules
   ```
3. PR в `main`: `firestore.rules` = содержимое `firestore.rules.next` (файл `.next` можно удалить
   или оставить равным), в `firebase-service.js` — `extendedFields: true`, в
   `tests/firestore.rules.prod.test.mjs` — ожидание `extendedFields=true` и разрешённых полей.
   `tests/rules-sync.test.mjs` не даст смержить `extendedFields: true` при старых `firestore.rules`.
4. После мержа старые записи остаются валидными; у них можно указать валюту через «Изменить».

### Редактирование подписок

Кнопка «Изменить» на карточке — форма переключается в режим редактирования. Как и в rules,
менять подписку может только её автор (`createdBy.uid`); `createdAt`/`createdBy` не меняются.
Удалять может любой участник пространства.

### Прогноз списаний по месяцам

В «Сводке» — столбики фактических списаний по календарным месяцам на 12 месяцев вперёд
(с учётом периодичности, годовых продлений и даты окончания), пунктир — среднее, подпись — пик.
Текущий месяц считается с сегодняшнего дня. Наведение/фокус на столбик — сумма и число списаний.

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

Делает только владелец Firebase-проекта, вручную (CI rules не деплоит). Текущий код сайта работает
с уже задеплоенными `firestore.rules` — деплой для него не нужен. Новые rules (`firestore.rules.next`)
деплоятся по шагам из раздела «Включение валюты и категории». Перед деплоем прогоните
`npm run test:rules:emulator`.

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

Тесты правил для Firebase Emulator (`npm run test:rules` запускает оба файла):

- `tests/firestore.rules.prod.test.mjs` — **задеплоенные** `firestore.rules` против записей, которые
  реально шлёт приложение в режиме Firebase: bootstrap, инвайты, создание monthly / yearly /
  custom-days, редактирование (смена периодичности с удалением `customDays`, `endDate`), удаление;
  плюс отказ для `currency`/`category`, `customDays: null`, чужих правок и не-участников.
- `tests/firestore.rules.next.test.mjs` — будущие `firestore.rules.next` (41 кейс: валидные/невалидные
  `currency`/`category`, лишние поля, редактирование только автором, неизменяемый `createdAt`).

Запуск с эмулятором (нужны Java 21 и firebase-tools; offline-проект `demo-tracksubfin` не обращается
к реальному Firebase и ничего не деплоит):
```bash
npm ci
npm i -g firebase-tools
npm run test:rules:emulator
# = firebase emulators:exec --only firestore --project demo-tracksubfin "npm run test:rules"
```

Пакет `firebase` в `devDependencies` нужен только тестам (`@firebase/rules-unit-testing@4` требует
`firebase@11`). Само приложение грузит Firebase SDK 10.12.5 с CDN `gstatic.com` и от npm не зависит.

Быстрый smoke-check синтаксиса JS:
```bash
npm run lint:smoke
```

Unit-тесты чистой логики (итоги, пересчёт валют, продления, подсказки, CSV) и демо-адаптера,
без зависимостей:
```bash
npm test
```

### CI

`.github/workflows/ci.yml` на каждый PR (и push в `main`): `npm ci`, `lint:smoke`, `npm test` и
rules-тесты на Firestore emulator. Деплой сайта — отдельный `pages.yml` (только `main`).

## Файлы

- `app.js` — UI; выбирает адаптер (`firebase-service.js` или `demo-service.js`)
- `logic.js` — чистые функции без DOM (итоги, продления, подсказки, CSV)
- `firebase-service.js` — Firebase Auth + Firestore
- `demo-service.js` — демо-адаптер на `localStorage`
- `firestore.rules` — rules, задеплоенные сейчас в Firebase (менять только вместе с деплоем)
- `firestore.rules.next` — будущие rules с `currency`/`category` (ещё не задеплоены)

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
