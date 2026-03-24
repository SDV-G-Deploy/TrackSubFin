# TrackSubFin

Простой трекер подписок для пары/семьи:
- вход через Google в 1 клик,
- общий список подписок по коду пары,
- мгновенная синхронизация между устройствами через Firestore (`onSnapshot`).

Демо: **https://sdv-g-deploy.github.io/TrackSubFin/**

---

## Быстрый запуск Firebase (MVP)

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
2. Режим: **Start in test mode** (для MVP)
3. Выбери ближайший регион

### 5) Заполни config
1. Скопируй `firebase-config.template.js` в `firebase-config.js`
2. Подставь web config из Firebase (Project settings → General → Your apps)

После этого перезагрузи страницу — блок "Нужна настройка Firebase" исчезнет.

---

## Как подключить два устройства (код пары)

1. На обоих устройствах открой приложение.
2. Нажми **Войти через Google**.
3. На первом устройстве нажми **Создать код** (или введи свой).
4. На втором устройстве введи тот же код и нажми **Подключить**.
5. Готово — подписки общие и обновляются в реальном времени.

Данные хранятся в коллекции:
`spaces/{familyCode}/subscriptions/{id}`

---

## Что уже реализовано

- Google Sign-In popup
- Кнопки Войти/Выйти
- Показ имени/email/аватара
- Shared space по `familyCode`
- Realtime синк через Firestore `onSnapshot`
- CRUD подписок напрямую в Firestore
- Локальный cache как fallback для offline preview
- Сохранены текущие UX-фичи:
  - карточки подписок,
  - timeline,
  - цветовые статусы (<=3 красный, 4-7 янтарный),
  - monthly total normalization.

---

## Безопасность (что усилить после MVP)

Сейчас для скорости используется test mode. Перед продом обязательно:
1. Ограничить Firestore Rules только авторизованным пользователям.
2. Добавить проверку доступа к конкретному `familyCode` (membership).
3. Ограничить запись/удаление (валидировать поля и типы).
4. При желании: сделать отдельную коллекцию участников пространства.

---

## Локальный запуск

Достаточно открыть `index.html` в браузере.

## Deploy

При push в `main` GitHub Actions автоматически публикует сайт на GitHub Pages (`.github/workflows/pages.yml`).
