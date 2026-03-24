# TrackSubFin

Простой трекер подписок для пары/семьи:
- вход через Google в 1 клик,
- общий список подписок по коду пары,
- мгновенная синхронизация между устройствами через Firestore (`onSnapshot`).

Демо: **https://sdv-g-deploy.github.io/TrackSubFin/**

---

## Быстрый запуск Firebase

### 1) Создай проект в Firebase Console
1. Открой [Firebase Console](https://console.firebase.google.com/)
2. Нажми **Create project**
3. Добавь Web App (иконка `</>`)

### 2) Включи Google Sign-In
1. **Authentication → Sign-in method**
2. Включи **Google**
3. Укажи email поддержки (если попросит)

### 3) Добавь authorized domains
В **Authentication → Settings → Authorized domains** добавь:
- `sdv-g-deploy.github.io`
- `localhost` (для локальных тестов)

### 4) Создай Firestore
1. **Firestore Database → Create database**
2. Режим: любой (рекомендуется production mode)
3. Выбери ближайший регион

### 5) Заполни config
1. Скопируй `firebase-config.template.js` в `firebase-config.js`
2. Подставь web config из Firebase (Project settings → General → Your apps)

После этого перезагрузи страницу — блок "Нужна настройка Firebase" исчезнет.

---

## Модель доступа (membership)

Структура данных:
- `spaces/{familyCode}/members/{uid}` — участники пространства (кто имеет доступ)
- `spaces/{familyCode}/subscriptions/{id}` — подписки

Как это работает:
1. Пользователь входит через Google.
2. Вводит/создаёт `familyCode`.
3. Приложение автоматически (idempotent) записывает membership-документ
   `spaces/{familyCode}/members/{uid}`.
4. После этого разрешены чтение/запись подписок в этом `familyCode`.

---

## Firestore Rules deployment

В репозитории есть:
- `firestore.rules`
- `firebase.json`

Деплой правил (один раз настроить CLI, далее по мере изменений):

```bash
npm i -g firebase-tools
firebase login
firebase use <YOUR_FIREBASE_PROJECT_ID>
firebase deploy --only firestore:rules
```

Проверка:
```bash
firebase firestore:rules:get
```

---

## Локальный запуск (важно: через HTTP)

`file://`-открытие `index.html` для Firebase Auth не подходит.

Запускай через локальный HTTP-сервер, например:

```bash
cd TrackSubFin
python3 -m http.server 8080
# или
npx serve -l 8080
```

Открой `http://localhost:8080`.

---

## Deploy

При push в `main` GitHub Actions автоматически публикует сайт на GitHub Pages (`.github/workflows/pages.yml`).
Workflow публикует только runtime-файлы (`index.html`, `styles.css`, `app.js`, `firebase-service.js`, `firebase-config.js`, `assets/` если есть).
