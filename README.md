# GBA QA Desk

Окремий сервіс для ведення багів GBA Console: задачі, статуси, технічні нотатки, фото, відео та автоматичні Codex-виправлення в одному інтерфейсі.

## Можливості

- створення, inline-редагування та видалення задач;
- статуси, пріоритети, URL проблемної сторінки й технічні нотатки;
- завантаження і перегляд зображень та відео;
- запис опису голосом із перетворенням української мови на текст;
- окрема SQLite-база й локальне файлове сховище;
- автоматичний запуск Codex після створення задачі;
- автоматичний повторний запуск через статус «Передивись ще раз»;
- історія AI-запусків зі станом, результатом і git-гілкою;
- окремий Codex worker для локального або серверного запуску.

## Як працює Codex worker

1. Нова задача автоматично створює `queued` job у таблиці `agent_runs`.
2. Worker атомарно забирає наступні job-и й обробляє до трьох задач паралельно.
3. Для задачі створюється окрема гілка `codex/qa-bug-*` та git worktree.
4. Codex отримує опис, URL, нотатки й локальні шляхи вкладень.
5. Після успішного виправлення задача переходить у «Готовий до ретесту».
6. Статус «Передивись ще раз» автоматично створює нову спробу в тому самому worktree.

Worker не робить commit, push або merge. Основна робоча папка репозиторію не змінюється. Доступ до мережі для Codex вимкнено за замовчуванням.

## Локальний запуск

Потрібні Node.js 24+, Git, встановлений та авторизований Codex CLI. Для голосового вводу локально встановіть CPU-версію `faster-whisper` в окреме Python-середовище:

```bash
npm install
python3 -m venv .voice-venv
.voice-venv/bin/pip install faster-whisper==1.2.1
VOICE_TRANSCRIBE_PYTHON="$PWD/.voice-venv/bin/python" CODEX_TARGET_REPO="/absolute/path/to/gba-console" npm run dev
```

Браузер надсилає завершений запис до `/api/transcriptions`, після чого Node запускає локальний `faster-whisper` через shell і повертає текст. Зовнішній speech API та ключ для voice не потрібні. Тимчасове аудіо гарантовано видаляється й не зберігається в SQLite або uploads. Для доступу до мікрофона на віддаленому сервері сайт має працювати через HTTPS; `localhost` підтримується браузерами окремо.

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
VOICE_TRANSCRIBE_MODEL=base
CODEX_TARGET_REPO_HOST_PATH=/srv/gba-console
CODEX_WORKTREES_HOST_PATH=/srv/gba-worktrees
CODEX_NETWORK_ACCESS=false
CODEX_JOB_TIMEOUT_MS=2700000
CODEX_CONCURRENCY=3
CODEX_WORKER_LEASE_TTL_MS=20000
CODEX_WORKER_HEARTBEAT_MS=5000
CODEX_RUN_STALE_MS=30000
```

Потім запустіть:

```bash
docker compose up -d --build
docker compose logs -f worker
```

Контейнери `web` і `worker` використовують спільні volumes для SQLite та uploads. Розміщуйте їх на одному сервері з локальним диском; SQLite-файл не слід тримати на NFS.

Docker image для `web` містить `faster-whisper` і multilingual-модель `base`; модель завантажується один раз під час `docker compose build`. Транскрипція працює на CPU в режимі `int8` і не використовує зовнішній API.

`APP_BUILD_NUMBER` має бути однаковим для `web` і `worker` та змінюватися під час кожного нового deployment. Задачі, переведені в ретест або закриті, автоматично записуються в історію цього build.

Щоб Codex міг відкривати URL або завантажувати залежності, встановіть `CODEX_NETWORK_ACCESS=true`. Вмикайте це лише для довірених задач і репозиторію.

`CODEX_CONCURRENCY` задає кількість паралельних Codex-агентів від 1 до 3; типовим значенням є `3`. Кожен агент отримує окремий git worktree, а release-черга лишається послідовною.

Worker тримає singleton lease у спільній SQLite, оновлює heartbeat активних запусків і при коректній зупинці повертає незавершені задачі в чергу. `resume` не запускає другого агента поверх живого worktree: перезапуск дозволяється лише після `CODEX_RUN_STALE_MS`. Після успішного merge, push і deploy release-worker атомарно фіксує стан `released` та прибирає службовий worktree.

## Production без Docker

API та worker запускаються окремими процесами під systemd, Supervisor або іншим process manager:

```bash
npm run build
VOICE_TRANSCRIBE_PYTHON="$PWD/.voice-venv/bin/python" npm start
CODEX_TARGET_REPO=/srv/gba-console CODEX_WORKTREES_DIR=/srv/gba-worktrees npm run worker
```

Для voice worker перед стартом API створіть `.voice-venv` за командами з локального запуску. Для Codex worker потрібно один раз виконати `codex login --with-api-key` або налаштувати інший підтримуваний спосіб авторизації Codex CLI.

## Дані

- SQLite: `data/gba-qa.sqlite`;
- історія кожної AI-спроби з QA-коментарем та незмінним snapshot задачі зберігається в таблиці `agent_runs`;
- медіа: `public/uploads`;
- результати Codex: `data/agent-runs`;
- локальні worktrees за замовчуванням: `data/agent-worktrees` або `CODEX_WORKTREES_DIR`.

Схема SQLite оновлюється автоматично при старті API або worker. Перед production-оновленням однаково робіть backup `gba-qa.sqlite`, а `DATA_DIR` монтуйте як постійний volume.

## Перевірка

```bash
npm run check
```

Тести перевіряють API, міграції SQLite, чергу повторних запусків і ізоляцію Codex у git worktree.
