import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, BarChart3, Clock, LoaderCircle, RefreshCw, Rocket, Timer } from 'lucide-react'
import { getMetrics } from './api'
import type { MetricsAlert, MetricsTimelineEntry, PipelineMetrics } from './types'

const periodOptions = [7, 14, 28, 56]

const reasonLabels: Record<string, string> = {
  needs_review: 'Codex: потребує перегляду',
  quality_gate: 'Quality gate відхилив результат',
  waiting_mainline: 'Чекає зеленого mainline',
  mainline_red: 'Червоний mainline',
  live_verification_failed: 'Live-перевірка на DEV не пройшла',
  stopped: 'Зупинено оператором',
  codex_failed: 'Codex упав',
  codex_usage_limit: 'Ліміт використання Codex',
  'release_blocked:preflight': 'Release заблоковано: preflight',
  'release_blocked:validating': 'Release заблоковано: тести',
  'release_blocked:publishing': 'Release заблоковано: публікація',
  'release_blocked:migrating': 'Release заблоковано: міграції',
  'release_blocked:deploying': 'Release заблоковано: deploy',
  'release_blocked:verifying': 'Release заблоковано: перевірка',
  'release_blocked:release': 'Release заблоковано',
}

const outcomeLabels: Record<string, string> = {
  released: 'На DEV',
  queued: 'У черзі',
  running: 'Codex працює',
  in_release: 'Реліз триває',
  ...reasonLabels,
}

const stageColumns: Array<{ key: keyof MetricsTimelineEntry['stages']; label: string }> = [
  { key: 'queuedAt', label: 'Черга' },
  { key: 'startedAt', label: 'Старт' },
  { key: 'finishedAt', label: 'Codex готовий' },
  { key: 'gatesAt', label: 'Гейти' },
  { key: 'deployedAt', label: 'Deploy' },
  { key: 'verifiedAt', label: 'Live' },
  { key: 'releasedAt', label: 'Ретест' },
]

function formatDuration(milliseconds: number | null | undefined) {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '—'
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 1) return '<1 хв'
  if (minutes < 60) return `${minutes} хв`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return rest ? `${hours} год ${rest} хв` : `${hours} год`
  return `${Math.round(hours / 24)} дн`
}

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function reasonLabel(reason: string) {
  return reasonLabels[reason] ?? (reason.startsWith('release_blocked:') ? `Release заблоковано: ${reason.slice('release_blocked:'.length)}` : reason)
}

function outcomeLabel(outcome: string) {
  return outcomeLabels[outcome] ?? reasonLabel(outcome)
}

function alertText(alert: MetricsAlert) {
  switch (alert.kind) {
    case 'main_red':
      return alert.source === 'release-hold'
        ? `Mainline ${alert.repo || ''}${alert.sha ? `@${alert.sha.slice(0, 12)}` : ''} червоний${alert.check ? ` («${alert.check}»)` : ''}: чекають ${alert.taskIds?.length ?? 0} реліз(и)`
        : `${alert.title ?? 'MAIN RED'}`
    case 'long_run':
      return `Codex працює вже ${alert.minutes} хв`
    case 'usage_limit':
      return `Ліміт Codex: ${alert.count} подій за 24 год (останнє ${formatTime(alert.lastAt)})${alert.pausedUntil ? `; нові запуски на паузі до ${formatTime(alert.pausedUntil)}` : ''}`
    case 'stale_task':
      return `${alert.minutes} хв без зміни статусу чи коментаря (${alert.releaseStatus && alert.releaseStatus !== 'blocked' ? `реліз: ${alert.releaseStatus}` : `запуск: ${alert.runStatus}`})`
    default:
      return 'Сигнал конвеєра'
  }
}

const alertTitles: Record<MetricsAlert['kind'], string> = {
  main_red: 'Main червоний',
  long_run: 'Довгий запуск',
  usage_limit: 'Ліміт Codex',
  stale_task: 'Без руху',
}

export function MetricsView({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const [days, setDays] = useState(28)
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async (initial: boolean) => {
      if (!initial) setRefreshing(true)
      try {
        const next = await getMetrics(days)
        if (cancelled) return
        setMetrics(next)
        setError(null)
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Не вдалося зібрати метрики.')
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
  }, [days, reloadKey])

  if (loading && !metrics) {
    return <div className="loading-state"><LoaderCircle className="spin" /><span>Збираю метрики конвеєра…</span></div>
  }

  if (!metrics) {
    return (
      <div className="load-error">
        <strong>Метрики не зібрано</strong>
        <span>{error}</span>
        <button className="button button-secondary" onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={16} /> Спробувати ще</button>
      </div>
    )
  }

  const { totals } = metrics
  return (
    <section className="pipeline-view metrics-view">
      <header className="metrics-bar">
        <div className="metrics-periods" role="group" aria-label="Період">
          {periodOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={`metrics-period${option === days ? ' metrics-period-active' : ''}`}
              onClick={() => setDays(option)}
            >
              {option} дн
            </button>
          ))}
        </div>
        <span className="metrics-updated"><Activity size={13} /> оновлено {formatTime(metrics.generatedAt)}{error ? ` · ${error}` : ''}</span>
        <button className="button button-secondary" onClick={() => setReloadKey((value) => value + 1)} disabled={refreshing}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> Оновити
        </button>
      </header>

      <div className="pipeline-stats">
        <div className="pipeline-stat pipeline-stat-release">
          <span><Rocket size={13} /> Дійшло до DEV без людини</span>
          <strong className="metrics-kpi">{formatPercent(totals.releaseRate)}</strong>
          <small>{totals.releasedRuns} з {totals.finishedRuns} завершених запусків</small>
        </div>
        <div className="pipeline-stat pipeline-stat-worker">
          <span><Timer size={13} /> Codex готовий → DEV</span>
          <strong className="metrics-kpi">{formatDuration(totals.timeToDeploy.p50)}</strong>
          <small>p90 {formatDuration(totals.timeToDeploy.p90)} · {totals.timeToDeploy.count} релізів</small>
        </div>
        <div className="pipeline-stat pipeline-stat-queue">
          <span><Clock size={13} /> Очікування в черзі</span>
          <strong className="metrics-kpi">{formatDuration(totals.queueWait.p50)}</strong>
          <small>p90 {formatDuration(totals.queueWait.p90)}</small>
        </div>
        <div className="pipeline-stat pipeline-stat-sentinel">
          <span><BarChart3 size={13} /> Тривалість запуску Codex</span>
          <strong className="metrics-kpi">{formatDuration(totals.codexDuration.p50)}</strong>
          <small>p90 {formatDuration(totals.codexDuration.p90)}</small>
        </div>
      </div>

      <section className="pipeline-section pipeline-section-stopped">
        <h3><AlertTriangle size={16} /> Сигнали ({metrics.alerts.length})</h3>
        {metrics.alerts.length === 0 ? (
          <p className="pipeline-empty">Сигналів немає: main зелений, запуски вкладаються в 45 хв, кожна задача має свіжий статус або коментар.</p>
        ) : (
          <ul className="metrics-alerts">
            {metrics.alerts.map((alert, index) => {
              const taskIds = alert.taskId ? [alert.taskId] : alert.taskIds ?? []
              return (
                <li key={`${alert.kind}-${alert.taskId ?? alert.sha ?? index}`} className={`metrics-alert metrics-alert-${alert.kind}`}>
                  <strong>{alertTitles[alert.kind]}</strong>
                  <span>{alertText(alert)}</span>
                  {taskIds.length > 0 && (
                    <span className="metrics-task-links">
                      {taskIds.map((taskId) => (
                        <button key={taskId} type="button" className="metrics-task-link" onClick={() => onOpenTask(taskId)}>{taskId}</button>
                      ))}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <div className="metrics-columns">
        <section className="pipeline-section pipeline-section-retry">
          <h3><AlertTriangle size={16} /> Причини, чому задача не дійшла до DEV</h3>
          {metrics.failureReasons.length === 0 ? (
            <p className="pipeline-empty">За період усе, що завершилось, дійшло до DEV.</p>
          ) : (
            <ul className="metrics-reasons">
              {metrics.failureReasons.map((reason) => (
                <li key={reason.reason}>
                  <span>{reasonLabel(reason.reason)}</span>
                  <strong>{reason.count}</strong>
                  <span className="metrics-task-links">
                    {reason.taskIds.map((taskId) => (
                      <button key={taskId} type="button" className="metrics-task-link" onClick={() => onOpenTask(taskId)}>{taskId}</button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pipeline-section pipeline-section-released">
          <h3><Rocket size={16} /> По тижнях</h3>
          {metrics.weekly.length === 0 ? (
            <p className="pipeline-empty">Ще немає завершених запусків.</p>
          ) : (
            <table className="metrics-table">
              <thead>
                <tr>
                  <th>Тиждень</th>
                  <th>Завершено</th>
                  <th>На DEV</th>
                  <th>Частка</th>
                  <th>p50 → DEV</th>
                  <th>p90 → DEV</th>
                </tr>
              </thead>
              <tbody>
                {metrics.weekly.map((week) => (
                  <tr key={week.weekStart}>
                    <td>{new Date(`${week.weekStart}T00:00:00Z`).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })}</td>
                    <td>{week.finishedRuns}</td>
                    <td>{week.releasedRuns}</td>
                    <td>{formatPercent(week.releaseRate)}</td>
                    <td>{formatDuration(week.timeToDeployP50)}</td>
                    <td>{formatDuration(week.timeToDeployP90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="pipeline-section pipeline-section-queue">
        <h3><Clock size={16} /> Хронологія задач (останні {metrics.timeline.length})</h3>
        {metrics.timeline.length === 0 ? (
          <p className="pipeline-empty">За період запусків не було.</p>
        ) : (
          <div className="metrics-table-scroll">
            <table className="metrics-table metrics-timeline">
              <thead>
                <tr>
                  <th>Задача</th>
                  <th>Стан</th>
                  {stageColumns.map((column) => <th key={column.key}>{column.label}</th>)}
                  <th>Черга</th>
                  <th>Codex</th>
                  <th>→ DEV</th>
                </tr>
              </thead>
              <tbody>
                {metrics.timeline.map((entry) => (
                  <tr key={entry.runId}>
                    <td>
                      <button type="button" className="metrics-task-link" onClick={() => onOpenTask(entry.taskId)}>{entry.taskId}</button>
                      <span className="metrics-task-title" title={entry.title}>{entry.title}</span>
                    </td>
                    <td>
                      <span className={`metrics-outcome metrics-outcome-${entry.outcome.replace(/[^a-z_]/g, '_')}`} title={entry.events.map((event) => `${formatTime(event.at)} ${event.kind}${event.detail ? ` ${event.detail}` : ''}`).join('\n')}>
                        {outcomeLabel(entry.outcome)}
                      </span>
                      {entry.attempt > 1 && <small className="metrics-attempt">спроба {entry.attempt}</small>}
                    </td>
                    {stageColumns.map((column) => <td key={column.key} className="metrics-time">{formatTime(entry.stages[column.key])}</td>)}
                    <td>{formatDuration(entry.durations.queueWaitMs)}</td>
                    <td>{formatDuration(entry.durations.codexMs)}</td>
                    <td>{formatDuration(entry.durations.deployMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}
