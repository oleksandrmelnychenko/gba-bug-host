import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOPOLOGY_EDGES,
  TOPOLOGY_GROUPS,
  TOPOLOGY_NODES,
  dockerStateFromList,
  evaluateNode,
  inventoryUnits,
  mergeInventory,
  statusFromContainer,
  statusFromDns,
  statusFromDnsGroup,
  statusFromNetworks,
  statusFromProbe,
  statusFromSearchSync,
  statusFromTcp,
  statusFromTls,
  statusFromUnits,
  summarize,
  worstStatus,
} from '../server/topology.js'
import { parseUnitStates } from '../server/release-worker.js'

test('найгірший статус перемагає', () => {
  assert.equal(worstStatus(['ok', 'warn', 'down']), 'down')
  assert.equal(worstStatus(['ok', 'unknown']), 'unknown')
  assert.equal(worstStatus(['ok', 'ok']), 'ok')
})

test('стан контейнера читається зі State і healthcheck', () => {
  assert.equal(statusFromContainer({ state: 'running', status: 'Up 2 hours (healthy)', health: 'healthy' }).status, 'ok')
  assert.equal(statusFromContainer({ state: 'running', status: 'Up (unhealthy)', health: 'unhealthy' }).status, 'warn')
  assert.equal(statusFromContainer({ state: 'running', status: 'Up 3s (health: starting)', health: 'starting' }).status, 'warn')
  assert.equal(statusFromContainer({ state: 'exited', status: 'Exited (1) 5 minutes ago' }).status, 'down')
  assert.equal(statusFromContainer(null).status, 'unknown')
})

test('разовий контейнер після Exited(0) вважається відпрацьованим', () => {
  const exited = { state: 'exited', status: 'Exited (0) 9 hours ago', exitCode: 0 }
  assert.equal(statusFromContainer(exited).status, 'down')
  assert.equal(statusFromContainer(exited, { oneshot: true }).status, 'ok')
  assert.equal(statusFromContainer({ state: 'exited', status: 'Exited (2) 1 min ago', exitCode: 2 }, { oneshot: true }).status, 'down')
})

test('HTTP-проба: 401 від захисту Desk не є падінням', () => {
  assert.equal(statusFromProbe({ code: 200, ms: 12 }).status, 'ok')
  assert.equal(statusFromProbe({ code: 401, ms: 12 }).status, 'ok')
  assert.equal(statusFromProbe({ code: 502, ms: 12 }).status, 'warn')
  assert.equal(statusFromProbe({ error: 'немає відповіді' }).status, 'down')
  assert.equal(statusFromProbe(undefined).status, 'unknown')
})

test('синхронізація пошуку оцінюється за водяним знаком', () => {
  const fresh = statusFromSearchSync({ code: 200, ms: 20, json: { Body: { healthy: true, lastSyncUtc: '2026-08-07T06:41:45Z', lagSeconds: 60, stale: false } } })
  assert.equal(fresh.status, 'ok')
  assert.match(fresh.detail, /свіжий/)

  const stale = statusFromSearchSync({ code: 200, ms: 20, json: { Body: { healthy: true, lastSyncUtc: '2026-08-07T00:00:00Z', lagSeconds: 4800, stale: true } } })
  assert.equal(stale.status, 'warn')
  assert.match(stale.detail, /80 хв/)

  assert.equal(statusFromSearchSync({ code: 200, ms: 20, json: { Body: { healthy: true, lastSyncUtc: null } } }).status, 'warn')
  assert.equal(statusFromSearchSync({ code: 200, ms: 20, json: { Body: { healthy: false } } }).status, 'down')
  assert.equal(statusFromSearchSync({ error: 'timeout' }).status, 'down')
})

test('DNS: розбіжність адреси — це попередження, а не падіння', () => {
  assert.equal(statusFromDns({ addresses: ['85.17.167.167'] }, '85.17.167.167').status, 'ok')
  assert.equal(statusFromDns({ addresses: ['1.2.3.4'] }, '85.17.167.167').status, 'warn')
  assert.equal(statusFromDns({ addresses: [] }, '85.17.167.167').status, 'down')
  assert.equal(statusFromDns({ error: 'ENOTFOUND' }, '85.17.167.167').status, 'down')

  const group = statusFromDnsGroup({
    'a.nip.io': { addresses: ['85.17.167.167'] },
    'b.nip.io': { error: 'ESERVFAIL' },
  }, '85.17.167.167')
  assert.equal(group.status, 'down')
  assert.match(group.detail, /b\.nip\.io/)
})

test('TLS попереджає завчасно і падає перед самим закінченням', () => {
  assert.equal(statusFromTls({ issuer: "Let's Encrypt", daysLeft: 71 }).status, 'ok')
  assert.equal(statusFromTls({ issuer: "Let's Encrypt", daysLeft: 10 }).status, 'warn')
  assert.equal(statusFromTls({ issuer: "Let's Encrypt", daysLeft: 2 }).status, 'down')
  assert.equal(statusFromTls({ error: 'handshake' }).status, 'down')
})

test('TCP і docker-мережі', () => {
  assert.equal(statusFromTcp({ ms: 8 }).status, 'ok')
  assert.equal(statusFromTcp({ error: 'ECONNREFUSED' }).status, 'down')
  assert.equal(statusFromNetworks(['a', 'b'], ['a', 'b', 'c']).status, 'ok')
  assert.equal(statusFromNetworks(['a', 'b'], ['a']).status, 'warn')
  assert.equal(statusFromNetworks(['a'], null).status, 'unknown')
})

test('systemd-звіт: застарілий heartbeat не видає стан за свіжий', () => {
  const report = { units: { 'gba-reco.service': 'active', 'gba-nba.service': 'failed' } }
  assert.equal(statusFromUnits(['gba-reco.service'], report).status, 'ok')
  assert.equal(statusFromUnits(['gba-reco.service', 'gba-nba.service'], report).status, 'down')
  assert.equal(statusFromUnits(['gba-reco.service'], { ...report, stale: true, ageSeconds: 900 }).status, 'unknown')
  assert.equal(statusFromUnits(['gba-reco.service'], null).status, 'unknown')
})

test('вузол зводить кілька джерел за найгіршим', () => {
  const node = { id: 'x', label: 'X', group: 'backend', kind: 'api', container: 'c', probe: 'http://x/health' }
  const evaluated = evaluateNode(node, {
    containers: { c: { state: 'running', status: 'Up 1 hour', health: '' } },
    probes: { x: { error: 'немає відповіді за 5000 мс' } },
  })
  assert.equal(evaluated.status, 'down')
  assert.equal(evaluated.sources.length, 2)
  assert.match(evaluated.detail, /Up 1 hour/)
})

test('публічний домен перевіряється по DNS, TLS і HTTP разом', () => {
  const node = TOPOLOGY_NODES.find((item) => item.id === 'vh-desk')
  const evaluated = evaluateNode(node, {
    dnsResults: { [node.hostname]: { addresses: ['85.17.167.167'] } },
    tlsResults: { [node.hostname]: { issuer: "Let's Encrypt", daysLeft: 89 } },
    probes: { [node.id]: { code: 401, ms: 140 } },
  })
  assert.deepEqual(evaluated.sources.map((source) => source.kind), ['dns', 'tls', 'probe'])
  assert.equal(evaluated.status, 'ok')
})

test('docker-список нормалізується у мапу за іменем', () => {
  const containers = dockerStateFromList([
    {
      Names: ['/gba-dev-data-concord-1'],
      Image: 'gba-data-concord:latest',
      State: 'running',
      Status: 'Up 9 hours (healthy)',
      Labels: { 'com.docker.compose.project': 'gba-dev' },
      Ports: [{ IP: '0.0.0.0', PrivatePort: 35981, PublicPort: 35981 }, { PrivatePort: 9300 }],
    },
  ])
  const concord = containers['gba-dev-data-concord-1']
  assert.equal(concord.health, 'healthy')
  assert.equal(concord.project, 'gba-dev')
  assert.deepEqual(concord.ports, ['0.0.0.0:35981→35981'])
})

test('інвентар цілісний: групи існують, ребра ведуть у наявні вузли', () => {
  const groups = new Set(TOPOLOGY_GROUPS.map((group) => group.key))
  const ids = new Set(TOPOLOGY_NODES.map((node) => node.id))
  assert.equal(ids.size, TOPOLOGY_NODES.length, 'id вузлів мають бути унікальні')

  for (const node of TOPOLOGY_NODES) {
    assert.ok(groups.has(node.group), `група ${node.group} для ${node.id}`)
    assert.ok(
      node.container || node.probe || node.unit || node.units || node.hostname || node.hostnames || node.tcp || node.networks,
      `${node.id} без джерела стану`,
    )
  }
  for (const edge of TOPOLOGY_EDGES) {
    assert.ok(ids.has(edge.from), `ребро з невідомого ${edge.from}`)
    assert.ok(ids.has(edge.to), `ребро у невідомий ${edge.to}`)
  }
})

test('ES-мапер присутній у схемі й підвʼязаний до MSSQL та Elasticsearch', () => {
  const syncNode = TOPOLOGY_NODES.find((node) => node.id === 'es-sync')
  assert.ok(syncNode, 'вузол синхронізації пошуку має бути в інвентарі')
  assert.equal(syncNode.probeKind, 'es-sync')
  const links = TOPOLOGY_EDGES.filter((edge) => edge.from === 'es-sync').map((edge) => edge.to)
  assert.deepEqual(links.sort(), ['elastic', 'mssql'])
})

test('оверлей додає сервіси й патчить наявні без перезбірки', () => {
  const base = {
    groups: [{ key: 'backend', label: 'Бекенд' }],
    nodes: [{ id: 'a', group: 'backend' }, { id: 'b', group: 'backend' }],
    edges: [{ from: 'a', to: 'b' }],
  }
  const merged = mergeInventory(base, {
    groups: [{ key: 'new', label: 'Нова група' }],
    nodes: [
      { id: 'a', configUrl: 'http://a/config' },
      { id: 'c', group: 'new', label: 'Новий сервіс' },
    ],
    edges: [{ from: 'b', to: 'c', label: 'нове ребро' }],
  })

  assert.equal(merged.nodes.find((node) => node.id === 'a').configUrl, 'http://a/config')
  assert.equal(merged.nodes.find((node) => node.id === 'a').group, 'backend', 'патч не має губити наявні поля')
  assert.equal(merged.nodes.length, 3)
  assert.equal(merged.groups.length, 2)
  assert.deepEqual(merged.edges.map((edge) => `${edge.from}->${edge.to}`), ['a->b', 'b->c'])
})

test('оверлей прибирає вузли разом з їхніми ребрами', () => {
  const merged = mergeInventory(
    { groups: [], nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
    { removeNodes: ['b'] },
  )
  assert.deepEqual(merged.nodes.map((node) => node.id), ['a'])
  assert.deepEqual(merged.edges, [])
})

test('конфіг сервісу зчитується з відповіді, помилка не ламає вузол', () => {
  const node = { id: 'svc', label: 'svc', group: 'ai', kind: 'ai', probe: 'http://svc/health', configUrl: 'http://svc/config' }
  const withConfig = evaluateNode(node, {
    probes: { svc: { code: 200, ms: 10 } },
    configs: { svc: { code: 200, ms: 10, json: { Body: { mode: 'production', horizonDays: 30 } } } },
  })
  assert.deepEqual(withConfig.config, { mode: 'production', horizonDays: 30 })
  assert.equal(withConfig.status, 'ok')

  const broken = evaluateNode(node, {
    probes: { svc: { code: 200, ms: 10 } },
    configs: { svc: { error: 'ECONNREFUSED' } },
  })
  assert.equal(broken.config, null)
  assert.equal(broken.configError, 'ECONNREFUSED')
  assert.equal(broken.status, 'ok', 'недоступний конфіг не робить сервіс мертвим')
})

test('зведення рахує вузли за статусами', () => {
  assert.deepEqual(
    summarize([{ status: 'ok' }, { status: 'ok' }, { status: 'warn' }]),
    { ok: 2, warn: 1, down: 0, unknown: 0 },
  )
})

test('парсер systemctl show бере Id і ActiveState, включно з вимкненими', () => {
  const units = parseUnitStates([
    'Id=gba-reco.service',
    'ActiveState=active',
    '',
    'Id=gba-nba.service',
    'ActiveState=failed',
    '',
    'Id=gba-nba-retrain.timer',
    'ActiveState=inactive',
    '',
  ].join('\n'))
  assert.deepEqual(units, {
    'gba-reco.service': 'active',
    'gba-nba.service': 'failed',
    'gba-nba-retrain.timer': 'inactive',
  })
})

test('інвентар віддає плаский список юнітів для хостового агента', () => {
  const units = inventoryUnits()
  assert.ok(units.includes('gba-qa-release.service'))
  assert.ok(units.includes('gba-nba-retrain.timer'), 'вимкнений таймер теж має опитуватись')
  assert.deepEqual(units, [...new Set(units)].sort())
})

test('перший невдалий опит — попередження, другий підряд — падіння', () => {
  const timeout = { error: 'немає відповіді за 5000 мс' }
  assert.equal(statusFromProbe(timeout, { consecutiveFailures: 1 }).status, 'warn')
  assert.equal(statusFromProbe(timeout, { consecutiveFailures: 2 }).status, 'down')
})
