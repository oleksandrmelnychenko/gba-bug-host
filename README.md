# GBA QA Desk

Окремий сервіс для ведення багів GBA Console: задачі, статуси, технічні нотатки, фото, відео, JSON/PDF/XML-докази та автоматичні Codex-виправлення в одному інтерфейсі.

## Можливості

- створення, inline-редагування та видалення задач;
- статуси, пріоритети, URL проблемної сторінки й технічні нотатки;
- завантаження і перегляд зображень, відео та документів JSON, PDF, XML;
- запис опису голосом із перетворенням української мови на текст;
- окрема SQLite-база й локальне файлове сховище;
- автоматичний запуск Codex після створення задачі;
- автоматичний повторний запуск через статус «Передивись ще раз»;
- історія AI-запусків зі станом, результатом і git-гілкою;
- персональні акаунти співробітників, внутрішні дерева коментарів і лічильник непрочитаного;
- окремий Codex worker для локального або серверного запуску.

## Як працює Codex worker

1. Нова задача автоматично створює `queued` job у таблиці `agent_runs`.
2. Worker атомарно забирає наступні job-и й обробляє до трьох задач паралельно.
3. Для задачі створюється окрема гілка `codex/qa-bug-*` та git worktree.
4. Codex отримує опис, URL, нотатки, локальні шляхи вкладень і незмінний snapshot постійного контексту проєкту.
5. Після успішного виправлення задача переходить у «Готовий до ретесту».
6. Статус «Передивись ще раз» автоматично створює нову спробу в тому самому worktree та продовжує власну Codex-сесію задачі.

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
# coding queue is deliberately singleton (one active Codex task)
CODEX_WORKER_LEASE_TTL_MS=20000
CODEX_WORKER_HEARTBEAT_MS=5000
CODEX_RUN_STALE_MS=30000
QA_DESK_INTERNAL_API_TOKEN=replace_with_at_least_32_random_bytes
```

Потім запустіть:

```bash
docker compose up -d --build
docker compose logs -f worker
```

Після першої міграції створіть персональні акаунти. Пароль передається лише в одноразову команду, а в SQLite зберігається `scrypt`-хеш:

```bash
docker compose exec web npm run provision:user -- user@qa-desk.com "Ім’я" "довгий-унікальний-пароль"
```

Повторний запуск для того самого email змінює пароль і відкликає всі активні сесії. `QA_DESK_INTERNAL_API_TOKEN` використовують тільки sentinel/release worker; людські коментарі завжди підписуються персональним акаунтом і не передаються Codex.

### Застосування нових міграцій під час deployment

Схема GBA QA Desk оновлюється автоматично при старті API або worker, але у production міграцію краще застосувати окремим кроком до запуску нових контейнерів. Команда `npm run migrate` використовує той самий `DATA_DIR`, що й застосунок, і безпечно пропускає вже застосовані зміни.

Перед оновленням зупиніть усі процеси, які працюють зі спільною SQLite, зробіть backup, зберіть нові image-и, застосуйте міграції один раз і лише після цього запускайте весь стек:

```bash
docker compose stop web worker sentinel
mkdir -p backups
docker compose run --rm --no-deps -v "$PWD/backups:/backup" web sh -lc 'cp /app/data/gba-qa.sqlite "/backup/gba-qa-$(date +%Y%m%d-%H%M%S).sqlite"'
docker compose build web worker sentinel
docker compose run --rm --no-deps web npm run migrate
docker compose up -d web worker sentinel
docker compose logs --tail=100 web worker
```

У логах має з’явитися `SQLite migrations applied`. Якщо міграція завершилася з помилкою, не запускайте нову версію: виправте причину або поверніть попередній image і відновіть SQLite з останнього backup. Не видаляйте named volumes під час deployment і не запускайте міграцію одночасно у кількох контейнерах.

Контейнери `web` і `worker` використовують спільні volumes для SQLite та uploads. Розміщуйте їх на одному сервері з локальним диском; SQLite-файл не слід тримати на NFS.

Docker image для `web` містить `faster-whisper` і multilingual-модель `base`; модель завантажується один раз під час `docker compose build`. Транскрипція працює на CPU в режимі `int8` і не використовує зовнішній API.

`APP_BUILD_NUMBER` має бути однаковим для `web` і `worker` та змінюватися під час кожного нового deployment. Задачі, переведені в ретест або закриті, автоматично записуються в історію цього build.

Щоб Codex міг відкривати URL або завантажувати залежності, встановіть `CODEX_NETWORK_ACCESS=true`. Вмикайте це лише для довірених задач і репозиторію.

Codex-черга навмисно виконує рівно одну coding-задачу за раз. Окремі git worktree-и зберігають ізоляцію й історію повторних спроб, але наступна задача не конкурує з поточною за CPU/RAM або test runner. `CODEX_CONCURRENCY` примусово нормалізується до `1`, навіть якщо старе середовище ще передає більше значення.

`CODEX_REFERENCE_REPOS_CONSOLE` і `CODEX_REFERENCE_REPOS_ECOMMERCE` задають необов’язкові read-only legacy/stable репозиторії. Вони доступні лише як джерело бізнес-контракту: worker не створює там worktree, не змінює їх і не включає в release. У локальному override legacy `gba_client` монтується з Docker-прапорцем `:ro`.

Перед `completed` worker тепер застосовує fail-closed quality gate: Codex має зіставити кожен acceptance-критерій із доказом, пояснити root cause і current/legacy/API контракт, зафіксувати конкретні спостереження з усіх вкладень та підтвердити перегляд повного diff. Host окремо звіряє declared files/repositories з фактичним Git, а стороння зміна глобального build/test-конфіга переводить результат у `needs_review`, а не в automatic release.

Постійний контекст задається у `server/codex-worker-context.md`. Під час першого запуску нової версії пам’яті worker фіксує epoch у SQLite. Для кожного запуску він зберігає незмінний snapshot контексту та додає останні підтверджені release-и відповідного проєкту, зроблені після цього epoch. Невипущені, старі або відхилені зміни в нову спільну пам’ять не потрапляють. Повторна спроба тієї самої задачі використовує її збережений `codexSessionId`; якщо rollout-файл сесії втрачено, worker безпечно запускає нову сесію з тим самим snapshot. Ліміти керуються `CODEX_CONTEXT_HISTORY_LIMIT` і `CODEX_CONTEXT_MAX_LENGTH`; нову чисту епоху можна почати зміною `CODEX_CONTEXT_EPOCH_KEY`.

Codex-worker тримає singleton lease у спільній SQLite, оновлює heartbeat активних запусків і при коректній зупинці повертає незавершені задачі в чергу. `resume` не запускає другого агента поверх живого worktree: перезапуск дозволяється лише після `CODEX_RUN_STALE_MS`. Вердикт Codex `fixed` лишає задачу «в роботі»: у ретест вона переходить тільки після release-гейта.

Release-worker має окремий singleton lease і веде довговічні `releasePhase`/`releaseEvidence`. Він послідовно: перевіряє всі репозиторії задачі без зміни mainline, запускає тестові проєкти лише для доведеного зміненого контуру (невідомий source-контур fail-closed отримує повну батарею), публікує й пушить доведені commit-и, запускає штатний Concord DB migrator, виконує `docker compose up --build --wait`, перевіряє container/image ID та live health кожного сервісу і лише тоді ставить `released`/`ready_for_retest`. Провал міграції, rebuild або health лишає задачу в retry/blocked із точною фазою; повтор deploy не ганяє вже зелену батарею для того самого commit повторно. Зниклий/порожній worktree ніколи не вважається успішним release.

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
- історія кожної AI-спроби з QA-коментарем, snapshot задачі, snapshot постійного контексту та `codexSessionId` зберігається в таблиці `agent_runs`;
- медіа: `public/uploads`;
- результати Codex: `data/agent-runs`;
- локальні worktrees за замовчуванням: `data/agent-worktrees` або `CODEX_WORKTREES_DIR`.

Схема SQLite оновлюється автоматично при старті API або worker. Для контрольованого production-оновлення використовуйте `npm run migrate` за процедурою вище. Перед оновленням однаково робіть backup `gba-qa.sqlite`, а `DATA_DIR` монтуйте як постійний volume.

## Перевірка

```bash
npm run check
```

Тести перевіряють API, міграції SQLite, чергу повторних запусків і ізоляцію Codex у git worktree.
