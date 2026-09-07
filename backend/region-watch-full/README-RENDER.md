# RegionWatch — Render-ready

Проект уже собран как **один Render Web Service**: backend раздаёт API и frontend из соседней папки.

## Структура

- `backend/` — Node.js + Express + PostgreSQL API
- `frontend/` — готовый сайт
- `render.yaml` — Blueprint для Render
- `backend/package.json` — зависимости и `npm start`

## Деплой

1. Загрузите содержимое этой папки в GitHub.
2. В Render откройте **New → Blueprint** и выберите этот репозиторий.
3. Render увидит `render.yaml` и создаст:
   - Web Service `region-watch`
   - PostgreSQL `region-watch-db`
4. При первом создании Render попросит значения:
   - `ADMIN_EMAIL` — email администратора
   - `ADMIN_PASSWORD` — пароль администратора
5. Нажмите Apply.

После первого успешного запуска `initialDeployHook` автоматически выполнит `npm run create-admin`, поэтому отдельный запуск скрипта для администратора не нужен.

### Важно

- `DATABASE_URL` подключается автоматически к Render PostgreSQL.
- `JWT_SECRET` генерируется Render автоматически.
- `PORT` вручную задавать не нужно: сервер использует `process.env.PORT`.
- `ALLOWED_ORIGINS=*` оставлено для простого первого запуска. После подключения собственного домена лучше заменить на его адрес.
- DeepSeek API key не нужен для самого запуска. Его можно задать через админские настройки сайта.
- Файл `.env` с секретами в репозиторий не добавляйте.

Render Blueprint поддерживает одновременное создание Web Service и PostgreSQL и может связать `DATABASE_URL` с базой автоматически.
