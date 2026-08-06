# GBA QA Desk

Окремий сервіс для ведення багів GBA Console: задачі, статуси, технічні нотатки, фото, відео та автоматичні Codex-виправлення в одному інтерфейсі.

## Можливості

- створення, inline-редагування та видалення задач;
- статуси, пріоритети, URL проблемної сторінки й технічні нотатки;
- завантаження і перегляд зображень та відео;
- окрема SQLite-база й локальне файлове сховище;
- автоматичний запуск Codex після створення задачі;
- автоматичний повторний запуск через статус «Передивись ще раз»;
- історія AI-запусків зі станом, результатом і git-гілкою;
- окремий Codex worker для локального або серверного запуску.

## Як працює Codex worker

1. Нова задача автоматично створює `queued` job у таблиці `agent_runs`.
2. Worker атомарно забирає наступний job і переводить задачу в «У роботі».
3. Для задачі створюється окрема гілка `codex/qa-bug-*` та git worktree.
4. Codex отримує опис, URL, нотатки й локальні шляхи вкладень.
5. Після успішного виправлення задача переходить у «Готовий до ретесту».
6. Статус «Передивись ще раз» автоматично створює нову спробу в тому самому worktree.

Worker не робить commit, push або merge. Основна робоча папка репозиторію не змінюється. Доступ до мережі для Codex вимкнено за замовчуванням.

## Локальний запуск

Потрібні Node.js 24+, Git, встановлений та авторизований Codex CLI.

```bash
npm install
CODEX_TARGET_REPO="/absolute/path/to/gba-console" npm run dev
```

`npm run dev` запускає React, API та worker. Окремі команди:

```bash
npm run dev:server
npm run dev:web
CODEX_TARGET_REPO="/absolute/path/to/gba-console" npm run worker
```

## Розгортання на одному сервері через Docker Compose

Цільовий git-репозиторій має бути клонований на сервері. Створіть окрему директорію для worktrees і дайте користувачу контейнера право запису:

```bash
sudo mkdir -p /srv/gba-worktrees
sudo chown -R 1000:1000 /srv/gba-worktrees /srv/gba-console
```

Створіть `.env` поруч із `docker-compose.yml`:

```dotenv
QA_DESK_PORT=4000
APP_BUILD_NUMBER=2026.08.06.1
OPENAI_API_KEY=your_api_key
CODEX_TRIGGER_TOKEN=replace_with_a_long_random_secret
CODEX_TARGET_REPO_HOST_PATH=/srv/gba-console
CODEX_WORKTREES_HOST_PATH=/srv/gba-worktrees
CODEX_NETWORK_ACCESS=false
CODEX_JOB_TIMEOUT_MS=2700000
```

Згенерувати trigger-token можна командою `openssl rand -hex 32`. При першому запуску Codex із браузера QA Desk попросить цей токен і збереже його лише в `sessionStorage` поточної вкладки.

Потім запустіть:

```bash
docker compose up -d --build
docker compose logs -f worker
```

Контейнери `web` і `worker` використовують спільні volumes для SQLite та uploads. Розміщуйте їх на одному сервері з локальним диском; SQLite-файл не слід тримати на NFS.

`APP_BUILD_NUMBER` має бути однаковим для `web` і `worker` та змінюватися під час кожного нового deployment. Задачі, переведені в ретест або закриті, автоматично записуються в історію цього build.

Щоб Codex міг відкривати URL або завантажувати залежності, встановіть `CODEX_NETWORK_ACCESS=true`. Вмикайте це лише для довірених задач і репозиторію.

## Production без Docker

API та worker запускаються окремими процесами під systemd, Supervisor або іншим process manager:

```bash
npm run build
npm start
CODEX_TARGET_REPO=/srv/gba-console CODEX_WORKTREES_DIR=/srv/gba-worktrees npm run worker
```

Для worker потрібно один раз виконати `codex login --with-api-key` або налаштувати інший підтримуваний спосіб авторизації Codex CLI.

## Дані

- SQLite: `data/gba-qa.sqlite`;
- медіа: `public/uploads`;
- результати Codex: `data/agent-runs`;
- локальні worktrees за замовчуванням: `data/agent-worktrees` або `CODEX_WORKTREES_DIR`.

## Перевірка

```bash
npm run check
```

Тести перевіряють API, міграції SQLite, чергу повторних запусків і ізоляцію Codex у git worktree.
