# TrackSubFin

Простой трекер подписок для пары/семьи (Google Sign-In + Firestore realtime).

Демо: **https://sdv-g-deploy.github.io/TrackSubFin/**

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

Быстрый smoke-check синтаксиса JS:
```bash
npm run lint:smoke
```

---

## Локальный запуск

```bash
python3 -m http.server 8080
# или
npx serve -l 8080
```

Открыть: `http://localhost:8080`

> `file://` для Firebase Auth не подходит.

---

## Deploy

При push в `main` GitHub Actions публикует сайт на GitHub Pages (`.github/workflows/pages.yml`).
