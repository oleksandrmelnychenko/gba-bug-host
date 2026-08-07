import dns from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'

const HOST = process.env.TOPOLOGY_HOST ?? 'host.docker.internal'
export const PUBLIC_IP = process.env.TOPOLOGY_PUBLIC_IP ?? '85.17.167.167'
const NIP = `${PUBLIC_IP}.nip.io`
const DEV_ES_SYNC_URL = process.env.TOPOLOGY_ES_SYNC_URL ?? `http://${HOST}:62506/api/v1/uk/elasticsearch/health`

function ai(port) {
  return `http://${HOST}:${port}/health`
}

function vhost(id, subdomain, label, target, { path = '/', note = '' } = {}) {
  return {
    id, label, group: 'net', kind: 'domain',
    subtitle: `${subdomain}.${NIP}`,
    hostname: `${subdomain}.${NIP}`,
    publicUrl: `https://${subdomain}.${NIP}${path}`,
    expectedIp: PUBLIC_IP,
    checkTls: true,
    target,
    note,
  }
}

export const PUBLIC_VHOSTS = [
  vhost('vh-console', 'gba-console-dev', 'Вхід: консоль', 'console', { note: 'публічний домен адмінки' }),
  vhost('vh-shop', 'shop-dev', 'Вхід: магазин', 'shop', { note: 'публічний домен вітрини' }),
  vhost('vh-legacy', 'gba-dev', 'Вхід: стара консоль', 'legacy'),
  vhost('vh-api', 'gba-api-dev', 'Вхід: data-concord', 'concord', { path: '/health' }),
  vhost('vh-analytics', 'gba-analytics-dev', 'Вхід: data-analytics', 'analytics', { path: '/health' }),
  vhost('vh-ecom-api', 'ecom-api-dev', 'Вхід: ecommerce-api', 'ecom-api', { path: '/health' }),
  vhost('vh-desk', 'gba-qa-desk', 'Вхід: QA Desk', 'desk-web', { note: 'за basic_auth: 401 = периметр живий' }),
]

export const TOPOLOGY_GROUPS = [
  { key: 'net', label: 'Мережа й доступ', hint: 'DNS · TLS · публічні адреси' },
  { key: 'edge', label: 'Периметр', hint: 'вхід трафіку' },
  { key: 'frontend', label: 'Інтерфейси', hint: 'те, що бачить користувач' },
  { key: 'backend', label: 'Бекенд', hint: 'API та бізнес-логіка' },
  { key: 'search', label: 'Пошук', hint: 'Elasticsearch і його синхронізація' },
  { key: 'data', label: 'Дані', hint: 'сховища' },
  { key: 'ai', label: 'AI-флот', hint: 'сервіси на хості, systemd' },
  { key: 'qa', label: 'QA-конвеєр', hint: 'ця деска та її воркери' },
  { key: 'prod', label: 'Прод-контур', hint: 'заморожений, лише спостереження' },
]

export const TOPOLOGY_NODES = [
  {
    id: 'net-dns', label: 'DNS', group: 'net', kind: 'dns',
    subtitle: `*.${NIP} → ${PUBLIC_IP}`,
    hostnames: PUBLIC_VHOSTS.map((item) => item.hostname),
    expectedIp: PUBLIC_IP,
    note: 'wildcard-резолвинг nip.io: імʼя містить сам IP, тож будь-яка розбіжність = підміна або зламаний резолвер',
  },
  {
    id: 'net-ip', label: 'Публічний IP', group: 'net', kind: 'net',
    subtitle: `${PUBLIC_IP} · ens10f0`,
    tcp: { host: PUBLIC_IP, port: 443 },
    note: 'зовнішня адреса хоста; перевіряється TCP-доступність 443, тобто чи приймає периметр трафік',
  },
  ...PUBLIC_VHOSTS,
  {
    id: 'net-docker', label: 'Docker-мережі', group: 'net', kind: 'net',
    subtitle: 'gba-dev · gba-prod · desk · infra',
    networks: ['gba-dev_default', 'gba-prod_default', 'gba-bug-host_default', 'gba-infra_default'],
    note: 'Caddy під’єднано і до prod-, і до desk-мережі — саме тому проксі дістає обидва контури за іменами контейнерів',
  },
  {
    id: 'caddy', label: 'Caddy', group: 'edge', kind: 'edge',
    subtitle: 'reverse proxy · 80/443', container: 'gba-prod-caddy-1',
    note: 'TLS, basic_auth для деска, маршрутизація на прод і на деску',
  },
  {
    id: 'console-proxy', label: 'nginx у консолі', group: 'edge', kind: 'edge',
    subtitle: '/api → concord · /qa-desk → деска',
    probe: `http://${HOST}:8083/qa-desk/api/builds/current`,
    note: 'перевіряється гілка /qa-desk (200 = і проксі, і docker-резолвер живі — саме тут колись залипав старий IP дески); /api, /hubs, /Images ідуть тим самим nginx у data-concord',
  },
  {
    id: 'firewall', label: 'Docker firewall', group: 'edge', kind: 'unit',
    subtitle: 'gba-docker-firewall', unit: 'gba-docker-firewall.service',
    note: 'oneshot: звужує опубліковані порти docker (active exited = норма)',
  },

  {
    id: 'console', label: 'GBA Console', group: 'frontend', kind: 'web',
    subtitle: 'nginx · :8083', container: 'gba-dev-gba-console-1',
    note: 'React/Vite адмінка; проксі /qa-desk на цю деску',
  },
  {
    id: 'shop', label: 'Інтернет-магазин', group: 'frontend', kind: 'web',
    subtitle: 'Next.js · :8081', container: 'gba-dev-gba-ecommerce-1',
    note: 'SSR-вітрина покупця',
  },
  {
    id: 'legacy', label: 'Стара консоль', group: 'frontend', kind: 'web',
    subtitle: 'nginx · :8082', container: 'gba-dev-gba-client-1',
    note: 'legacy gba_client, джерело парності при міграції',
  },
  {
    id: 'desk-web', label: 'QA Desk', group: 'frontend', kind: 'web',
    subtitle: 'Express+React · :4000', container: 'gba-bug-host-web-1',
    note: 'цей застосунок: задачі, білди, конвеєр, ця схема',
  },

  {
    id: 'concord', label: 'data-concord', group: 'backend', kind: 'api',
    subtitle: '.NET/Akka · :35981', container: 'gba-dev-data-concord-1', probe: `http://${HOST}:35981/health`,
    note: 'головний API консолі + актори + 1С DataSync',
  },
  {
    id: 'analytics', label: 'data-analytics', group: 'backend', kind: 'api',
    subtitle: '.NET · :35982', container: 'gba-dev-data-analytics-1', probe: `http://${HOST}:35982/health`,
    note: 'звітність/аналітика над ConcordDb_Data',
  },
  {
    id: 'ecom-api', label: 'gba-ecommerce-api', group: 'backend', kind: 'api',
    subtitle: '.NET · :62506', container: 'gba-dev-gba-ecommerce-api-1', probe: `http://${HOST}:62506/health`,
    note: 'API магазину: каталог, кошик, замовлення, профілі',
  },
  {
    id: 'reports-v9', label: 'reports-v9-analytics', group: 'backend', kind: 'api',
    subtitle: 'окремий контейнер · :35992', container: 'reports-v9-analytics',
    note: 'ізольований прогін звітів (поза compose-планом)',
  },

  {
    id: 'es-sync', label: 'Синхронізація пошуку', group: 'search', kind: 'sync',
    subtitle: 'ProductSearchSyncBackgroundService', probe: DEV_ES_SYNC_URL, probeKind: 'es-sync',
    note: 'мапить товари з MSSQL в Elasticsearch: інкремент за водяним знаком + нічна повна перебудова з підміною аліаса',
  },
  {
    id: 'elastic', label: 'Elasticsearch', group: 'search', kind: 'data',
    subtitle: '8.12 · :9200 (loopback)', container: 'gba-dev-elasticsearch-1',
    note: 'індекс товарів для пошуку магазину й консолі',
  },
  {
    id: 'elastic-setup', label: 'ES bootstrap', group: 'search', kind: 'oneshot',
    subtitle: 'разова ініціалізація', container: 'gba-dev-elasticsearch-setup-1',
    note: 'ставить паролі/ролі при піднятті стека; Exited(0) = відпрацював',
  },

  {
    id: 'mssql', label: 'MSSQL', group: 'data', kind: 'data',
    subtitle: 'ConcordDb_V5 · :1433', container: 'gba-dev-gba-mssql-1',
    note: 'єдине джерело правди для консолі, магазину та AI-флоту',
  },
  {
    id: 'redis', label: 'Redis', group: 'data', kind: 'data',
    subtitle: ':6379', container: 'gba-reco-redis',
    note: 'кеш і кулдауни AI-сервісів',
  },
  {
    id: 'mongo', label: 'MongoDB', group: 'data', kind: 'data',
    subtitle: ':27017', container: 'gba-nba-mongo',
    note: 'стан задач NBA-кокпіта',
  },

  { id: 'ai-reco', label: 'reco', group: 'ai', kind: 'ai', subtitle: ':8000 · рекомендації клієнту', probe: ai(8000), unit: 'gba-reco.service' },
  { id: 'ai-procure', label: 'procure', group: 'ai', kind: 'ai', subtitle: ':8001 · закупівлі', probe: ai(8001), unit: 'gba-procure.service' },
  { id: 'ai-nba', label: 'nba', group: 'ai', kind: 'ai', subtitle: ':8002 · задачі менеджера', probe: ai(8002), unit: 'gba-nba.service' },
  { id: 'ai-solvency', label: 'solvency', group: 'ai', kind: 'ai', subtitle: ':8003 · платоспроможність', probe: ai(8003), unit: 'gba-solvency.service' },
  { id: 'ai-pricing', label: 'pricing', group: 'ai', kind: 'ai', subtitle: ':8004 · ціни та конкуренти', probe: ai(8004), unit: 'gba-pricing.service' },
  { id: 'ai-products', label: 'products', group: 'ai', kind: 'ai', subtitle: ':8005 · здоров’я асортименту', probe: ai(8005), unit: 'gba-products.service' },
  { id: 'ai-forecast', label: 'forecast', group: 'ai', kind: 'ai', subtitle: ':8006 · прогноз продажів', probe: ai(8006), unit: 'gba-forecast.service' },
  {
    id: 'ai-schedulers', label: 'Планувальники', group: 'ai', kind: 'scheduler',
    subtitle: 'reco · procure · nba', units: ['gba-reco-scheduler.service', 'gba-procure-scheduler.service', 'gba-nba-scheduler.service'],
    note: 'прогрів кешів за розкладом',
  },
  {
    id: 'ai-retrain', label: 'Перетренування', group: 'ai', kind: 'timer',
    subtitle: 'nba · solvency (timer)', units: ['gba-nba-retrain.timer', 'gba-solvency-retrain.timer'],
    note: 'systemd-таймери перетренування моделей',
  },

  {
    id: 'desk-worker', label: 'Codex-воркер', group: 'qa', kind: 'worker',
    subtitle: 'worktree + Codex-фікс', container: 'gba-bug-host-worker-1',
    note: 'на кожну задачу створює git worktree у репозиторіях проєкту й жене Codex',
  },
  {
    id: 'desk-sentinel', label: 'Вартовий логів', group: 'qa', kind: 'worker',
    subtitle: 'docker logs → задачі', container: 'gba-bug-host-sentinel-1',
    note: 'стежить за ERROR у 4 dev-контейнерах і заводить [AUTO]-задачі',
  },
  {
    id: 'desk-release', label: 'Реліз-воркер', group: 'qa', kind: 'unit',
    subtitle: 'merge → тести → push → deploy', unit: 'gba-qa-release.service',
    note: 'єдиний, хто мерджить і деплоїть; він же шле сюди стан systemd-юнітів хоста',
  },

  { id: 'prod-caddy-note', label: 'Прод: фронти', group: 'prod', kind: 'web', subtitle: 'client · shop', container: 'gba-prod-gba-client-1' },
  { id: 'prod-shop', label: 'Прод: магазин', group: 'prod', kind: 'web', subtitle: 'Next.js', container: 'gba-prod-gba-ecommerce-1' },
  { id: 'prod-concord', label: 'Прод: data-concord', group: 'prod', kind: 'api', subtitle: 'заморожено', container: 'gba-prod-data-concord-1' },
  { id: 'prod-analytics', label: 'Прод: data-analytics', group: 'prod', kind: 'api', subtitle: 'заморожено', container: 'gba-prod-data-analytics-1' },
  { id: 'prod-ecom-api', label: 'Прод: ecommerce-api', group: 'prod', kind: 'api', subtitle: 'заморожено', container: 'gba-prod-gba-ecommerce-api-1' },
  { id: 'prod-mssql', label: 'Прод: MSSQL', group: 'prod', kind: 'data', subtitle: 'заморожено', container: 'gba-prod-gba-mssql-1' },
  { id: 'prod-elastic', label: 'Прод: Elasticsearch', group: 'prod', kind: 'data', subtitle: 'заморожено', container: 'gba-prod-elasticsearch-1' },
]

export const TOPOLOGY_EDGES = [
  { from: 'net-dns', to: 'caddy', label: 'резолвинг' },
  { from: 'net-ip', to: 'caddy', label: '443' },
  { from: 'net-docker', to: 'caddy', label: 'мережі проксі' },
  ...PUBLIC_VHOSTS.map((item) => ({ from: item.id, to: 'caddy', label: 'vhost' })),
  ...PUBLIC_VHOSTS.map((item) => ({ from: 'caddy', to: item.target, label: 'reverse_proxy' })),
  { from: 'caddy', to: 'desk-web', label: 'basic_auth' },
  { from: 'caddy', to: 'prod-caddy-note', label: 'прод' },
  { from: 'caddy', to: 'prod-shop' },
  { from: 'console', to: 'console-proxy', label: 'усі виклики' },
  { from: 'console-proxy', to: 'concord', label: '/api /hubs' },
  { from: 'console-proxy', to: 'analytics', label: '/history /report' },
  { from: 'console-proxy', to: 'desk-web', label: '/qa-desk білд-тікер' },
  { from: 'legacy', to: 'concord' },
  { from: 'shop', to: 'ecom-api', label: 'SSR + XFF' },
  { from: 'concord', to: 'mssql' },
  { from: 'analytics', to: 'mssql' },
  { from: 'ecom-api', to: 'mssql' },
  { from: 'reports-v9', to: 'mssql' },
  { from: 'ecom-api', to: 'es-sync', label: 'hosted service' },
  { from: 'es-sync', to: 'mssql', label: 'читає товари' },
  { from: 'es-sync', to: 'elastic', label: 'пише індекс + аліас' },
  { from: 'elastic-setup', to: 'elastic', label: 'ініціалізація' },
  { from: 'ecom-api', to: 'elastic', label: 'пошук' },
  { from: 'console', to: 'ai-reco', label: 'рекомендації' },
  { from: 'concord', to: 'ai-solvency', label: 'скор клієнта' },
  { from: 'concord', to: 'ai-forecast', label: 'прогноз' },
  { from: 'concord', to: 'ai-nba', label: 'задачі' },
  { from: 'ai-reco', to: 'mssql' },
  { from: 'ai-procure', to: 'mssql' },
  { from: 'ai-nba', to: 'mongo' },
  { from: 'ai-nba', to: 'mssql' },
  { from: 'ai-solvency', to: 'mssql' },
  { from: 'ai-pricing', to: 'mssql' },
  { from: 'ai-products', to: 'mssql' },
  { from: 'ai-forecast', to: 'mssql' },
  { from: 'ai-reco', to: 'redis' },
  { from: 'ai-nba', to: 'redis' },
  { from: 'ai-schedulers', to: 'ai-reco', label: 'прогрів' },
  { from: 'ai-schedulers', to: 'ai-procure' },
  { from: 'ai-schedulers', to: 'ai-nba' },
  { from: 'ai-retrain', to: 'ai-nba', label: 'моделі' },
  { from: 'ai-retrain', to: 'ai-solvency' },
  { from: 'desk-sentinel', to: 'concord', label: 'читає логи' },
  { from: 'desk-sentinel', to: 'analytics' },
  { from: 'desk-sentinel', to: 'ecom-api' },
  { from: 'desk-sentinel', to: 'shop' },
  { from: 'desk-sentinel', to: 'desk-web', label: 'заводить задачі' },
  { from: 'desk-worker', to: 'desk-web', label: 'бере чергу' },
  { from: 'desk-release', to: 'desk-web', label: 'штампує реліз' },
  { from: 'desk-release', to: 'console', label: 'деплой' },
  { from: 'desk-release', to: 'concord' },
  { from: 'desk-release', to: 'analytics' },
  { from: 'desk-release', to: 'ecom-api' },
  { from: 'desk-release', to: 'shop' },
]

// Інвентар можна доповнювати файлом-оверлеєм без перезбірки образу: сервіси
// незабаром почнуть віддавати власні конфіги, і тоді достатньо дописати вузлу
// configUrl (або додати новий вузол) — схема підхопить це на наступному зборі.
export function mergeInventory(base, overlay) {
  if (!overlay) return base

  const groups = [...base.groups]
  for (const group of overlay.groups ?? []) {
    const index = groups.findIndex((item) => item.key === group.key)
    if (index >= 0) groups[index] = { ...groups[index], ...group }
    else groups.push(group)
  }

  const nodes = [...base.nodes]
  for (const node of overlay.nodes ?? []) {
    if (!node?.id) continue
    const index = nodes.findIndex((item) => item.id === node.id)
    if (index >= 0) nodes[index] = { ...nodes[index], ...node }
    else nodes.push(node)
  }

  const removed = new Set(overlay.removeNodes ?? [])
  const keptNodes = nodes.filter((node) => !removed.has(node.id))
  const ids = new Set(keptNodes.map((node) => node.id))

  const edgeKey = (edge) => `${edge.from}->${edge.to}`
  const edges = new Map(base.edges.map((edge) => [edgeKey(edge), edge]))
  for (const edge of overlay.edges ?? []) {
    if (!edge?.from || !edge?.to) continue
    edges.set(edgeKey(edge), { ...edges.get(edgeKey(edge)), ...edge })
  }
  for (const edge of overlay.removeEdges ?? []) edges.delete(edgeKey(edge))

  return {
    groups,
    nodes: keptNodes,
    edges: [...edges.values()].filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  }
}

export function inventoryUnits(nodes = TOPOLOGY_NODES) {
  return [...new Set(nodes.flatMap((node) => node.units ?? (node.unit ? [node.unit] : [])))].sort()
}

export const STATUS_ORDER = ['down', 'warn', 'unknown', 'ok']

export function worstStatus(statuses) {
  for (const status of STATUS_ORDER) {
    if (statuses.includes(status)) return status
  }
  return 'unknown'
}

export function statusFromContainer(container, { oneshot = false } = {}) {
  if (!container) return { status: 'unknown', detail: 'контейнера немає в docker' }
  const state = container.state ?? ''
  const health = container.health ?? ''

  if (oneshot) {
    if (state === 'running') return { status: 'ok', detail: container.status }
    if (state === 'exited' && (container.exitCode ?? 0) === 0) return { status: 'ok', detail: `відпрацював: ${container.status}` }
    return { status: 'down', detail: container.status || state }
  }

  if (state !== 'running') return { status: 'down', detail: container.status || state || 'не запущено' }
  if (health === 'unhealthy') return { status: 'warn', detail: 'контейнер живий, healthcheck червоний' }
  if (health === 'starting') return { status: 'warn', detail: 'стартує' }
  return { status: 'ok', detail: container.status }
}

export function statusFromProbe(probe, { consecutiveFailures = 2 } = {}) {
  if (!probe) return { status: 'unknown', detail: 'не опитувався' }
  if (probe.error) {
    return consecutiveFailures >= 2
      ? { status: 'down', detail: `${probe.error} (підряд разів: ${consecutiveFailures})` }
      : { status: 'warn', detail: `${probe.error} — перший невдалий опит, чекаю підтвердження` }
  }
  if (probe.code >= 200 && probe.code < 300) return { status: 'ok', detail: `HTTP ${probe.code} · ${probe.ms} мс` }
  if (probe.code === 401 || probe.code === 403) return { status: 'ok', detail: `HTTP ${probe.code} — живий, потрібна авторизація` }
  return { status: 'warn', detail: `HTTP ${probe.code}` }
}

export function statusFromSearchSync(probe, options) {
  const base = statusFromProbe(probe, options)
  if (base.status !== 'ok') return base

  const payload = probe.json?.Body ?? probe.json ?? {}
  if (payload.healthy === false) return { status: 'down', detail: 'Elasticsearch недоступний для синхронізації', metrics: payload }
  if (payload.lastSyncUtc == null) return { status: 'warn', detail: 'водяного знаку ще немає — чекає на першу повну перебудову', metrics: payload }

  const lag = Math.round(payload.lagSeconds ?? 0)
  const human = lag < 90 ? `${lag} с` : `${Math.round(lag / 60)} хв`
  return {
    status: payload.stale ? 'warn' : 'ok',
    detail: payload.stale ? `індекс відстає на ${human}` : `індекс свіжий, відставання ${human}`,
    metrics: payload,
  }
}

export function statusFromDns(result, expectedIp) {
  if (!result) return { status: 'unknown', detail: 'не перевірявся' }
  if (result.error) return { status: 'down', detail: `резолвинг не працює: ${result.error}` }

  const addresses = result.addresses ?? []
  if (addresses.length === 0) return { status: 'down', detail: 'імʼя не резолвиться' }
  if (expectedIp && !addresses.includes(expectedIp)) {
    return { status: 'warn', detail: `очікували ${expectedIp}, отримали ${addresses.join(', ')}` }
  }
  return { status: 'ok', detail: addresses.join(', ') }
}

export function statusFromDnsGroup(results, expectedIp) {
  const entries = Object.entries(results ?? {})
  if (entries.length === 0) return { status: 'unknown', detail: 'не перевірявся' }

  const evaluated = entries.map(([hostname, result]) => ({ hostname, ...statusFromDns(result, expectedIp) }))
  const bad = evaluated.filter((item) => item.status !== 'ok')
  return {
    status: worstStatus(evaluated.map((item) => item.status)),
    detail: bad.length === 0
      ? `${evaluated.length}/${evaluated.length} імен → ${expectedIp}`
      : bad.map((item) => `${item.hostname}: ${item.detail}`).join(' · '),
  }
}

export function statusFromTls(certificate) {
  if (!certificate) return { status: 'unknown', detail: 'сертифікат не перевірявся' }
  if (certificate.error) return { status: 'down', detail: `TLS: ${certificate.error}` }

  const days = certificate.daysLeft
  const label = `${certificate.issuer || 'невідомий видавець'} · ${days} дн до кінця`
  if (days <= 3) return { status: 'down', detail: `сертифікат ось-ось закінчиться — ${label}` }
  if (days <= 14) return { status: 'warn', detail: `сертифікат треба поновити — ${label}` }
  return { status: 'ok', detail: label }
}

export function statusFromTcp(result) {
  if (!result) return { status: 'unknown', detail: 'не перевірявся' }
  if (result.error) return { status: 'down', detail: result.error }
  return { status: 'ok', detail: `порт відкритий · ${result.ms} мс` }
}

export function statusFromNetworks(expected, present) {
  if (!present) return { status: 'unknown', detail: 'docker недоступний' }
  const missing = expected.filter((name) => !present.includes(name))
  return missing.length === 0
    ? { status: 'ok', detail: `${expected.length} мереж на місці` }
    : { status: 'warn', detail: `немає: ${missing.join(', ')}` }
}

export function statusFromUnits(unitNames, report) {
  if (!report || !report.units) return { status: 'unknown', detail: 'хостовий агент ще не надсилав стан' }
  if (report.stale) return { status: 'unknown', detail: `стан застарів (${report.ageSeconds} с тому)` }

  const parts = unitNames.map((unit) => ({ unit, state: report.units[unit] ?? 'unknown' }))
  const statuses = parts.map(({ state }) => {
    if (state === 'active') return 'ok'
    if (state === 'activating' || state === 'reloading') return 'warn'
    if (state === 'unknown') return 'unknown'
    return 'down'
  })
  return {
    status: worstStatus(statuses),
    detail: parts.map(({ unit, state }) => `${unit.replace(/\.(service|timer)$/, '')}: ${state}`).join(' · '),
  }
}

export function evaluateNode(node, {
  containers = {},
  probes = {},
  unitReport = null,
  dnsResults = {},
  tlsResults = {},
  tcpResults = {},
  networks = null,
  probeFailures = {},
  configs = {},
} = {}) {
  const probeOptions = { consecutiveFailures: probeFailures[node.id] ?? 2 }
  const sources = []

  if (node.hostnames) {
    const scoped = Object.fromEntries(node.hostnames.map((hostname) => [hostname, dnsResults[hostname]]))
    sources.push({ kind: 'dns', ...statusFromDnsGroup(scoped, node.expectedIp) })
  }
  if (node.hostname) {
    sources.push({ kind: 'dns', ...statusFromDns(dnsResults[node.hostname], node.expectedIp) })
  }
  if (node.checkTls && node.hostname) {
    sources.push({ kind: 'tls', ...statusFromTls(tlsResults[node.hostname]) })
  }
  if (node.publicUrl) {
    sources.push({ kind: 'probe', ...statusFromProbe(probes[node.id], probeOptions), url: node.publicUrl })
  }
  if (node.tcp) {
    sources.push({ kind: 'tcp', ...statusFromTcp(tcpResults[node.id]), url: `${node.tcp.host}:${node.tcp.port}` })
  }
  if (node.networks) {
    sources.push({ kind: 'docker', ...statusFromNetworks(node.networks, networks) })
  }

  if (node.container) {
    const evaluated = statusFromContainer(containers[node.container], { oneshot: node.kind === 'oneshot' })
    sources.push({ kind: 'docker', ...evaluated, container: containers[node.container] ?? null })
  }
  if (node.probe) {
    const probe = probes[node.id]
    const evaluated = node.probeKind === 'es-sync'
      ? statusFromSearchSync(probe, probeOptions)
      : statusFromProbe(probe, probeOptions)
    sources.push({ kind: 'probe', ...evaluated, url: node.probe })
  }
  const units = node.units ?? (node.unit ? [node.unit] : [])
  if (units.length > 0 && !node.probe) {
    sources.push({ kind: 'systemd', ...statusFromUnits(units, unitReport) })
  }

  const configResult = node.configUrl ? configs[node.id] : null
  const config = configResult && !configResult.error && configResult.json
    ? (configResult.json.Body ?? configResult.json)
    : null

  if (sources.length === 0) {
    return { ...node, status: 'unknown', detail: 'без джерела стану', sources: [], config, metrics: null }
  }

  return {
    ...node,
    status: worstStatus(sources.map((source) => source.status)),
    detail: sources.map((source) => source.detail).filter(Boolean).join(' · '),
    metrics: sources.find((source) => source.metrics)?.metrics ?? null,
    config,
    configError: configResult?.error ?? null,
    sources,
  }
}

export function summarize(nodes) {
  return nodes.reduce((accumulator, node) => {
    accumulator[node.status] = (accumulator[node.status] ?? 0) + 1
    return accumulator
  }, { ok: 0, warn: 0, down: 0, unknown: 0 })
}

export function dockerStateFromList(rows) {
  const containers = {}
  for (const row of rows ?? []) {
    const name = (row.Names ?? []).map((item) => item.replace(/^\//, ''))[0]
    if (!name) continue
    const healthMatch = /\((healthy|unhealthy|health: starting)\)/.exec(row.Status ?? '')
    containers[name] = {
      name,
      image: row.Image,
      state: row.State,
      status: row.Status,
      health: healthMatch ? healthMatch[1].replace('health: ', '') : '',
      exitCode: /Exited \((\d+)\)/.exec(row.Status ?? '') ? Number(/Exited \((\d+)\)/.exec(row.Status)[1]) : null,
      project: row.Labels?.['com.docker.compose.project'] ?? '',
      ports: (row.Ports ?? [])
        .filter((port) => port.PublicPort)
        .map((port) => `${port.IP === '::' ? '' : `${port.IP}:`}${port.PublicPort}→${port.PrivatePort}`),
    }
  }
  return containers
}

export function dockerRequest(socketPath, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method: 'GET' }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`docker ${requestPath} → ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

// Проби йдуть пачками: перший збір після старту контейнера піднімає одночасно
// десяток HTTP-запитів, сім TLS-хендшейків і DNS-резолвів, і в цьому сплеску
// поодинокі відповіді не встигали в таймаут — сервіс виглядав мертвим, хоча був живий.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

async function probeDns(hostname) {
  try {
    return { addresses: await dns.resolve4(hostname) }
  } catch (error) {
    return { error: String(error.code ?? error.message ?? error) }
  }
}

function probeTls(hostname, timeoutMs) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: timeoutMs }, () => {
      const certificate = socket.getPeerCertificate()
      const validTo = certificate?.valid_to ? Date.parse(certificate.valid_to) : NaN
      socket.end()
      resolve(Number.isNaN(validTo)
        ? { error: 'сертифікат без дати завершення' }
        : {
          issuer: certificate.issuer?.O ?? certificate.issuer?.CN ?? '',
          subject: certificate.subject?.CN ?? hostname,
          validTo: new Date(validTo).toISOString(),
          daysLeft: Math.round((validTo - Date.now()) / 86_400_000),
        })
    })
    socket.on('timeout', () => { socket.destroy(); resolve({ error: `handshake довше ${timeoutMs} мс` }) })
    socket.on('error', (error) => resolve({ error: String(error.message ?? error) }))
  })
}

function probeTcp({ host, port }, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const socket = net.connect({ host, port, timeout: timeoutMs }, () => {
      socket.end()
      resolve({ ms: Date.now() - startedAt })
    })
    socket.on('timeout', () => { socket.destroy(); resolve({ error: `порт мовчить ${timeoutMs} мс` }) })
    socket.on('error', (error) => resolve({ error: String(error.message ?? error) }))
  })
}

async function probeUrl(url, timeoutMs) {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text().catch(() => '')
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { code: response.status, ms: Date.now() - startedAt, json, body: json ? null : text.slice(0, 200) }
  } catch (error) {
    return { error: error.name === 'TimeoutError' ? `немає відповіді за ${timeoutMs} мс` : String(error.message ?? error) }
  }
}

export class TopologyService {
  constructor({
    dockerSocket = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    nodes = TOPOLOGY_NODES,
    edges = TOPOLOGY_EDGES,
    groups = TOPOLOGY_GROUPS,
    cacheMs = Number.parseInt(process.env.TOPOLOGY_CACHE_MS ?? '8000', 10),
    probeTimeoutMs = Number.parseInt(process.env.TOPOLOGY_PROBE_TIMEOUT_MS ?? '5000', 10),
    probeConcurrency = Number.parseInt(process.env.TOPOLOGY_PROBE_CONCURRENCY ?? '4', 10),
    unitStaleSeconds = Number.parseInt(process.env.TOPOLOGY_UNIT_STALE_SECONDS ?? '180', 10),
    overlayPath = process.env.TOPOLOGY_INVENTORY_FILE
      ?? path.join(process.env.DATA_DIR ?? './data', 'topology.local.json'),
  } = {}) {
    this.overlayPath = overlayPath
    this.dockerSocket = dockerSocket
    this.nodes = nodes
    this.edges = edges
    this.groups = groups
    this.cacheMs = cacheMs
    this.probeTimeoutMs = probeTimeoutMs
    this.probeConcurrency = Math.max(1, probeConcurrency)
    this.unitStaleSeconds = unitStaleSeconds
    this.cache = null
    this.inFlight = null
    this.heartbeat = null
    this.probeFailures = new Map()
  }

  units() {
    return inventoryUnits(this.nodes)
  }

  async inventory() {
    let overlay = null
    let overlayError = null
    try {
      overlay = JSON.parse(await readFile(this.overlayPath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') overlayError = String(error.message ?? error)
    }
    const merged = mergeInventory({ groups: this.groups, nodes: this.nodes, edges: this.edges }, overlay)
    return { ...merged, overlayApplied: Boolean(overlay), overlayError }
  }

  recordHeartbeat(payload) {
    this.heartbeat = { units: payload?.units ?? {}, host: payload?.host ?? '', receivedAt: new Date().toISOString() }
    this.cache = null
    this.persist?.(this.heartbeat)
    return this.heartbeat
  }

  // Стан systemd приходить ззовні раз на 30 с, тому після рестарту вебу його треба
  // підняти зі сховища — інакше пів схеми показує «немає даних» на рівному місці.
  restoreHeartbeat(saved) {
    if (!saved?.units) return null
    this.heartbeat = { units: saved.units, host: saved.host ?? '', receivedAt: saved.receivedAt ?? saved.updatedAt }
    this.cache = null
    return this.heartbeat
  }

  unitReport() {
    if (!this.heartbeat) return null
    const ageSeconds = Math.round((Date.now() - Date.parse(this.heartbeat.receivedAt)) / 1000)
    return { ...this.heartbeat, ageSeconds, stale: ageSeconds > this.unitStaleSeconds }
  }

  async collect() {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.value
    if (this.inFlight) return this.inFlight

    this.inFlight = this.#collectFresh()
      .then((value) => {
        this.cache = { at: Date.now(), value }
        return value
      })
      .finally(() => { this.inFlight = null })

    return this.inFlight
  }

  async #collectFresh() {
    let containers = {}
    let networks = null
    let dockerError = null
    try {
      containers = dockerStateFromList(await dockerRequest(this.dockerSocket, '/v1.41/containers/json?all=1'))
      networks = (await dockerRequest(this.dockerSocket, '/v1.41/networks')).map((network) => network.Name)
    } catch (error) {
      dockerError = String(error.message ?? error)
    }

    const inventory = await this.inventory()
    const probeNodes = inventory.nodes.filter((node) => node.probe || node.publicUrl)
    const hostnames = [...new Set(inventory.nodes.flatMap((node) => node.hostnames ?? (node.hostname ? [node.hostname] : [])))]
    const tlsHostnames = inventory.nodes.filter((node) => node.checkTls && node.hostname).map((node) => node.hostname)
    const tcpNodes = inventory.nodes.filter((node) => node.tcp)
    const configNodes = inventory.nodes.filter((node) => node.configUrl)

    const [probeResults, dnsResolutions, tlsCertificates, tcpChecks, configFetches] = await Promise.all([
      mapWithConcurrency(probeNodes, this.probeConcurrency, (node) => probeUrl(node.probe ?? node.publicUrl, this.probeTimeoutMs)),
      mapWithConcurrency(hostnames, this.probeConcurrency, (hostname) => probeDns(hostname)),
      mapWithConcurrency(tlsHostnames, this.probeConcurrency, (hostname) => probeTls(hostname, this.probeTimeoutMs)),
      mapWithConcurrency(tcpNodes, this.probeConcurrency, (node) => probeTcp(node.tcp, this.probeTimeoutMs)),
      mapWithConcurrency(configNodes, this.probeConcurrency, (node) => probeUrl(node.configUrl, this.probeTimeoutMs)),
    ])

    const probes = Object.fromEntries(probeNodes.map((node, index) => [node.id, probeResults[index]]))
    for (const node of probeNodes) {
      const failed = Boolean(probes[node.id]?.error)
      this.probeFailures.set(node.id, failed ? (this.probeFailures.get(node.id) ?? 0) + 1 : 0)
    }
    const probeFailures = Object.fromEntries(this.probeFailures)
    const dnsResults = Object.fromEntries(hostnames.map((hostname, index) => [hostname, dnsResolutions[index]]))
    const tlsResults = Object.fromEntries(tlsHostnames.map((hostname, index) => [hostname, tlsCertificates[index]]))
    const tcpResults = Object.fromEntries(tcpNodes.map((node, index) => [node.id, tcpChecks[index]]))

    const configs = Object.fromEntries(configNodes.map((node, index) => [node.id, configFetches[index]]))

    const unitReport = this.unitReport()
    const nodes = inventory.nodes.map((node) =>
      evaluateNode(node, { containers, probes, unitReport, dnsResults, tlsResults, tcpResults, networks, probeFailures, configs }))

    return {
      generatedAt: new Date().toISOString(),
      groups: inventory.groups,
      nodes,
      edges: inventory.edges,
      summary: summarize(nodes),
      hostAgent: unitReport
        ? { receivedAt: unitReport.receivedAt, ageSeconds: unitReport.ageSeconds, stale: unitReport.stale, host: unitReport.host }
        : null,
      dockerError,
      overlay: { applied: inventory.overlayApplied, path: this.overlayPath, error: inventory.overlayError },
    }
  }
}
