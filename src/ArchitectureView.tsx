import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  Clock,
  Database,
  Globe,
  LayoutDashboard,
  LoaderCircle,
  Network,
  RefreshCw,
  Server,
  Settings,
  Sparkles,
  Timer,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { getTopology } from './api'
import { nodeStatusMeta } from './types'
import type { NodeKind, NodeStatus, Topology, TopologyNode, TopologySource } from './types'

const COLUMN_WIDTH = 232
const COLUMN_GAP = 92
const NODE_HEIGHT = 78
const NODE_GAP = 16
const HEADER_HEIGHT = 54
const CANVAS_PADDING = 24

const sourceLabel: Record<TopologySource['kind'], string> = {
  docker: 'Контейнер',
  probe: 'HTTP-проба',
  systemd: 'systemd',
  dns: 'DNS',
  tls: 'TLS-сертифікат',
  tcp: 'TCP-порт',
}

const kindIcon: Record<NodeKind, typeof Server> = {
  domain: Globe,
  dns: Network,
  net: Network,
  edge: Globe,
  web: LayoutDashboard,
  api: Server,
  data: Database,
  sync: RefreshCw,
  ai: Sparkles,
  worker: Bot,
  unit: Settings,
  scheduler: Clock,
  timer: Timer,
  oneshot: Zap,
}

const statusOrder: NodeStatus[] = ['down', 'warn', 'unknown', 'ok']

type Placed = TopologyNode & { x: number; y: number; column: number }

function layout(topology: Topology) {
  const groupOrder = topology.groups.map((group) => group.key)
  const byGroup = new Map<string, TopologyNode[]>()
  for (const node of topology.nodes) {
    const bucket = byGroup.get(node.group) ?? []
    bucket.push(node)
    byGroup.set(node.group, bucket)
  }

  const placed: Placed[] = []
  let tallest = 0
  groupOrder.forEach((groupKey, column) => {
    const nodes = byGroup.get(groupKey) ?? []
    tallest = Math.max(tallest, nodes.length)
    nodes.forEach((node, index) => {
      placed.push({
        ...node,
        column,
        x: CANVAS_PADDING + column * (COLUMN_WIDTH + COLUMN_GAP),
        y: CANVAS_PADDING + HEADER_HEIGHT + index * (NODE_HEIGHT + NODE_GAP),
      })
    })
  })

  return {
    placed,
    width: CANVAS_PADDING * 2 + groupOrder.length * COLUMN_WIDTH + (groupOrder.length - 1) * COLUMN_GAP,
    height: CANVAS_PADDING * 2 + HEADER_HEIGHT + tallest * (NODE_HEIGHT + NODE_GAP),
  }
}

function edgePath(from: Placed, to: Placed) {
  const fromCenterY = from.y + NODE_HEIGHT / 2
  const toCenterY = to.y + NODE_HEIGHT / 2
  const forward = to.x > from.x
  const backward = to.x < from.x

  const startX = forward ? from.x + COLUMN_WIDTH : from.x
  const endX = forward ? to.x : to.x + COLUMN_WIDTH
  const bend = Math.min(Math.max(Math.abs(endX - startX) / 2, 46), 150)
  const controlOne = forward ? startX + bend : startX - bend
  const controlTwo = forward ? endX - bend : endX + bend

  if (!forward && !backward) {
    const loop = from.x + COLUMN_WIDTH + 60
    return `M ${from.x + COLUMN_WIDTH} ${fromCenterY} C ${loop} ${fromCenterY}, ${loop} ${toCenterY}, ${to.x + COLUMN_WIDTH} ${toCenterY}`
  }

  return `M ${startX} ${fromCenterY} C ${controlOne} ${fromCenterY}, ${controlTwo} ${toCenterY}, ${endX} ${toCenterY}`
}

function formatAge(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds} с тому`
  if (seconds < 3600) return `${Math.round(seconds / 60)} хв тому`
  return `${Math.round(seconds / 3600)} год тому`
}

export function ArchitectureView() {
  const [topology, setTopology] = useState<Topology | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async (initial: boolean) => {
      if (!initial) setRefreshing(true)
      try {
        const next = await getTopology()
        if (cancelled) return
        setTopology(next)
        setError(null)
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Не вдалося зібрати топологію.')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }

    void load(true)
    const timer = window.setInterval(() => void load(false), 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const model = useMemo(() => (topology ? layout(topology) : null), [topology])
  const positions = useMemo(() => new Map((model?.placed ?? []).map((node) => [node.id, node])), [model])
  const selected = selectedId ? positions.get(selectedId) ?? null : null

  const connectedIds = useMemo(() => {
    if (!topology || !selectedId) return null
    const ids = new Set<string>([selectedId])
    for (const edge of topology.edges) {
      if (edge.from === selectedId) ids.add(edge.to)
      if (edge.to === selectedId) ids.add(edge.from)
    }
    return ids
  }, [topology, selectedId])

  if (loading) {
    return <div className="loading-state"><LoaderCircle className="spin" /><span>Збираю схему системи…</span></div>
  }

  if (error || !topology || !model) {
    return (
      <div className="load-error">
        <strong>Схему не зібрано</strong>
        <span>{error}</span>
        <button className="button button-secondary" onClick={() => window.location.reload()}><RefreshCw size={16} /> Спробувати ще</button>
      </div>
    )
  }

  const refreshNow = async () => {
    setRefreshing(true)
    try {
      setTopology(await getTopology())
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Не вдалося оновити топологію.')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section className="architecture">
      <header className="architecture-bar">
        <div className="architecture-summary">
          {topology.environment && <span className="arch-env">{topology.environment}</span>}
          {statusOrder.map((status) => (
            <span key={status} className={`arch-chip arch-chip-${status}`}>
              <i /> {nodeStatusMeta[status].label}
              <strong>{topology.summary[status] ?? 0}</strong>
            </span>
          ))}
        </div>
        <div className="architecture-meta">
          <span><Activity size={13} /> оновлено {formatAge(topology.generatedAt)}</span>
          {topology.hostAgent
            ? <span className={topology.hostAgent.stale ? 'arch-meta-stale' : undefined}>
                хостовий агент: {topology.hostAgent.stale ? `мовчить ${topology.hostAgent.ageSeconds} с` : 'на звʼязку'}
              </span>
            : <span className="arch-meta-stale">хостовий агент ще не звітував</span>}
          {topology.dockerError && <span className="arch-meta-stale">docker: {topology.dockerError}</span>}
          {topology.overlay?.applied && <span>інвентар доповнено оверлеєм</span>}
          {topology.overlay?.error && <span className="arch-meta-stale">оверлей зламаний: {topology.overlay.error}</span>}
        </div>
        <div className="architecture-controls">
          <button className="icon-button" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))} aria-label="Зменшити"><ZoomOut size={16} /></button>
          <span className="architecture-zoom">{Math.round(zoom * 100)}%</span>
          <button className="icon-button" onClick={() => setZoom((value) => Math.min(1.4, Number((value + 0.1).toFixed(2))))} aria-label="Збільшити"><ZoomIn size={16} /></button>
          <button className="button button-secondary" onClick={() => void refreshNow()} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Оновити
          </button>
        </div>
      </header>

      <div className="architecture-body">
        <div className="architecture-canvas-scroll">
          <div
            className="architecture-canvas"
            style={{ width: model.width, height: model.height, transform: `scale(${zoom})` }}
            onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null) }}
          >
            <svg className="architecture-edges" width={model.width} height={model.height}>
              {topology.edges.map((edge) => {
                const from = positions.get(edge.from)
                const to = positions.get(edge.to)
                if (!from || !to) return null
                const active = selectedId ? edge.from === selectedId || edge.to === selectedId : false
                const dimmed = Boolean(selectedId) && !active
                return (
                  <path
                    key={`${edge.from}->${edge.to}`}
                    d={edgePath(from, to)}
                    className={`arch-edge${active ? ' arch-edge-active' : ''}${dimmed ? ' arch-edge-dim' : ''}`}
                  />
                )
              })}
            </svg>

            {topology.groups.map((group, column) => (
              <div
                key={group.key}
                className="architecture-column-head"
                style={{ left: CANVAS_PADDING + column * (COLUMN_WIDTH + COLUMN_GAP), width: COLUMN_WIDTH, top: CANVAS_PADDING }}
              >
                <strong>{group.label}</strong>
                {group.hint && <span>{group.hint}</span>}
              </div>
            ))}

            {model.placed.map((node) => {
              const Icon = kindIcon[node.kind] ?? Server
              const dimmed = Boolean(connectedIds) && !connectedIds!.has(node.id)
              return (
                <button
                  type="button"
                  key={node.id}
                  className={`arch-node arch-node-${node.status}${selectedId === node.id ? ' arch-node-selected' : ''}${dimmed ? ' arch-node-dim' : ''}`}
                  style={{ left: node.x, top: node.y, width: COLUMN_WIDTH, height: NODE_HEIGHT }}
                  onClick={() => setSelectedId((current) => (current === node.id ? null : node.id))}
                  title={node.detail}
                >
                  <span className="arch-node-head">
                    <Icon size={14} />
                    <strong>{node.label}</strong>
                    <i className={`arch-dot arch-dot-${node.status}`} />
                  </span>
                  {node.subtitle && <span className="arch-node-subtitle">{node.subtitle}</span>}
                  <span className="arch-node-detail">{node.detail || nodeStatusMeta[node.status].label}</span>
                </button>
              )
            })}
          </div>
        </div>

        {selected && (
          <aside className="architecture-detail">
            <header>
              <div>
                <span className="eyebrow">{topology.groups.find((group) => group.key === selected.group)?.label}</span>
                <h3>{selected.label}</h3>
              </div>
              <button className="icon-button" onClick={() => setSelectedId(null)} aria-label="Закрити"><X size={18} /></button>
            </header>

            <span className={`arch-status-pill arch-chip-${selected.status}`}>
              <i /> {nodeStatusMeta[selected.status].label}
            </span>

            {selected.note && <p className="arch-detail-note">{selected.note}</p>}

            <dl className="arch-detail-list">
              {selected.sources.map((source) => (
                <div key={`${selected.id}-${source.kind}`}>
                  <dt>{sourceLabel[source.kind] ?? source.kind}</dt>
                  <dd>
                    <span className={`arch-source-status arch-chip-${source.status}`}>{nodeStatusMeta[source.status].label}</span>
                    <span>{source.detail}</span>
                    {source.container && (
                      <>
                        <code>{source.container.name}</code>
                        <code>{source.container.image}</code>
                        {source.container.ports.length > 0 && <code>{source.container.ports.join(' · ')}</code>}
                        {source.container.project && <code>compose: {source.container.project}</code>}
                      </>
                    )}
                    {source.url && <code>{source.url}</code>}
                  </dd>
                </div>
              ))}
              {selected.metrics && (
                <div>
                  <dt>Метрики</dt>
                  <dd>
                    {Object.entries(selected.metrics).map(([key, value]) => (
                      <code key={key}>{key}: {String(value)}</code>
                    ))}
                  </dd>
                </div>
              )}
              {(selected.config || selected.configError) && (
                <div>
                  <dt>Конфіг сервісу</dt>
                  <dd>
                    {selected.configError
                      ? <span className="arch-config-error">{selected.configError}</span>
                      : Object.entries(selected.config ?? {}).map(([key, value]) => (
                        <code key={key}>{key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}</code>
                      ))}
                  </dd>
                </div>
              )}
            </dl>

            <div className="arch-detail-links">
              <strong>Звʼязки</strong>
              <ul>
                {topology.edges
                  .filter((edge) => edge.from === selected.id || edge.to === selected.id)
                  .map((edge) => {
                    const outgoing = edge.from === selected.id
                    const other = positions.get(outgoing ? edge.to : edge.from)
                    return (
                      <li key={`${edge.from}->${edge.to}`}>
                        <button type="button" onClick={() => setSelectedId(other?.id ?? null)}>
                          <span className="arch-link-direction">{outgoing ? '→' : '←'}</span>
                          {other?.label ?? (outgoing ? edge.to : edge.from)}
                          {edge.label && <em>{edge.label}</em>}
                        </button>
                      </li>
                    )
                  })}
              </ul>
            </div>
          </aside>
        )}
      </div>
    </section>
  )
}
