import { useEffect, useMemo, useRef, useState } from 'react'

type RunStatus = 'idle' | 'running' | 'completed' | 'failed'
type PhaseStatus = 'pending' | 'running' | 'success' | 'failed'
type LogLevel = 'info' | 'warning' | 'error'

type RunConfig = {
  repoUrl: string
  eifPath: string
  enclaveCount: number
  cpuCount: number
  memoryMib: number
  baseEnclaveCid: number
  enclaveTimeoutSec: number
  workdir: string
  sseHost: string
  ssePort: string
}

type Phase = {
  id: string
  label: string
  status: PhaseStatus
  message: string
}

type WorkerState = {
  workerIndex: number
  cid: number
  status: PhaseStatus
  phase: string
  durationMs: number
  lastMessage: string
}

type LogEntry = {
  id: string
  ts: string
  level: LogLevel
  workerIndex: number | null
  message: string
}

type RunHistoryItem = {
  runId: string
  endedAt: string
  status: RunStatus
  total: number
  passed: number
  failed: number
  mode: 'mock' | 'live'
}

const PHASE_LABELS = [
  'Clone repository',
  'Resolve commit',
  'Prepare bundle + manifest',
  'Launch enclaves',
  'Send framed payloads',
  'Receive worker responses',
  'Persist results + terminate enclaves',
  'Generate summary',
]

const DEFAULT_CONFIG: RunConfig = {
  repoUrl: 'https://github.com/example/hermbuild-demo-repo',
  eifPath: './enclaves/hermbuild.eif',
  enclaveCount: 3,
  cpuCount: 2,
  memoryMib: 512,
  baseEnclaveCid: 18,
  enclaveTimeoutSec: 120,
  workdir: '/tmp/hermbuild-run',
  sseHost: 'localhost',
  ssePort: '8000',
}

const createInitialPhases = (): Phase[] =>
  PHASE_LABELS.map((label, index) => ({
    id: `phase-${index}`,
    label,
    status: 'pending',
    message: 'Waiting',
  }))

const createWorkers = (config: RunConfig): WorkerState[] =>
  Array.from({ length: config.enclaveCount }, (_, workerIndex) => ({
    workerIndex,
    cid: config.baseEnclaveCid + workerIndex,
    status: 'pending',
    phase: 'Pending',
    durationMs: 0,
    lastMessage: 'Not started',
  }))

function App() {
  const [activeView, setActiveView] = useState<'overview' | 'runs' | 'guide'>('overview')
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runId, setRunId] = useState<string>('demo-run')
  const [config, setConfig] = useState<RunConfig>(DEFAULT_CONFIG)
  const [phases, setPhases] = useState<Phase[]>(createInitialPhases)
  const [workers, setWorkers] = useState<WorkerState[]>(createWorkers(DEFAULT_CONFIG))
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [activeMode, setActiveMode] = useState<'mock' | 'live'>('mock')
  const [healthState, setHealthState] = useState<'unknown' | 'checking' | 'up' | 'down'>('unknown')
  const [configError, setConfigError] = useState('')
  const [activeLevel, setActiveLevel] = useState<'all' | LogLevel>('all')
  const [workerFilter, setWorkerFilter] = useState<'all' | number>('all')
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [runHistory, setRunHistory] = useState<RunHistoryItem[]>([])
  const logRef = useRef<HTMLDivElement | null>(null)
  const timers = useRef<number[]>([])
  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const savedHistory = localStorage.getItem('hermbuild-run-history')
    if (!savedHistory) {
      return
    }
    try {
      setRunHistory(JSON.parse(savedHistory))
    } catch {
      localStorage.removeItem('hermbuild-run-history')
    }
  }, [])

  useEffect(() => {
    if (!autoScroll || !logRef.current) {
      return
    }
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs, autoScroll])

  useEffect(
    () => () => {
      timers.current.forEach((timerId) => window.clearTimeout(timerId))
      eventSourceRef.current?.close()
    },
    [],
  )

  const pushLog = (entry: Omit<LogEntry, 'id' | 'ts'>) => {
    setLogs((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        ts: new Date().toLocaleTimeString(),
        ...entry,
      },
    ])
  }

  const resetDashboard = () => {
    timers.current.forEach((timerId) => window.clearTimeout(timerId))
    timers.current = []
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    setRunStatus('idle')
    setRunId('demo-run')
    setErrorMessage('')
    setStartedAt(null)
    setPhases(createInitialPhases())
    setWorkers(createWorkers(config))
    setLogs([])
    setConfigError('')
  }

  const updatePhase = (phaseIndex: number, status: PhaseStatus, message: string) => {
    setPhases((prev) =>
      prev.map((phase, index) => (index === phaseIndex ? { ...phase, status, message } : phase)),
    )
  }

  const updateWorker = (workerIndex: number, patch: Partial<WorkerState>) => {
    setWorkers((prev) =>
      prev.map((worker) => (worker.workerIndex === workerIndex ? { ...worker, ...patch } : worker)),
    )
  }

  const runMockFlow = () => {
    const steps = PHASE_LABELS.map((label, index) => ({ label, index }))
    let elapsed = 0

    steps.forEach(({ label, index }) => {
      elapsed += 800
      timers.current.push(
        window.setTimeout(() => {
          updatePhase(index, 'running', `Running ${label.toLowerCase()}`)
          pushLog({ level: 'info', workerIndex: null, message: `[phase] ${label} started` })
        }, elapsed),
      )

      elapsed += 900
      timers.current.push(
        window.setTimeout(() => {
          updatePhase(index, 'success', `${label} completed`)
          pushLog({ level: 'info', workerIndex: null, message: `[phase] ${label} completed` })
        }, elapsed),
      )
    })

    for (let workerIndex = 0; workerIndex < config.enclaveCount; workerIndex += 1) {
      const startMs = 2000 + workerIndex * 300
      const endMs = 5000 + workerIndex * 550
      const hasFailed = workerIndex === config.enclaveCount - 1

      timers.current.push(
        window.setTimeout(() => {
          updateWorker(workerIndex, {
            status: 'running',
            phase: 'Executing inside enclave',
            lastMessage: 'Receiving framed payload',
          })
          pushLog({
            level: 'info',
            workerIndex,
            message: `worker-${workerIndex} launched with CID ${config.baseEnclaveCid + workerIndex}`,
          })
        }, startMs),
      )

      timers.current.push(
        window.setTimeout(() => {
          updateWorker(workerIndex, {
            status: hasFailed ? 'failed' : 'success',
            phase: hasFailed ? 'Validation failed' : 'Completed',
            durationMs: endMs - startMs,
            lastMessage: hasFailed
              ? 'Build hash mismatch detected'
              : 'Signed result persisted to enclave-results',
          })
          pushLog({
            level: hasFailed ? 'error' : 'info',
            workerIndex,
            message: hasFailed
              ? `worker-${workerIndex} failed: Build hash mismatch`
              : `worker-${workerIndex} completed successfully`,
          })
          if (hasFailed) {
            setRunStatus('failed')
          }
        }, endMs),
      )
    }

    timers.current.push(
      window.setTimeout(() => {
        setRunStatus((prev) => (prev === 'failed' ? 'failed' : 'completed'))
      }, elapsed + 1100),
    )
  }

  const normalizeEvent = (raw: unknown): Partial<LogEntry> & { phaseIndex?: number; phaseStatus?: PhaseStatus } => {
    if (typeof raw !== 'object' || raw === null) {
      return { message: String(raw), level: 'info', workerIndex: null }
    }
    const asRecord = raw as Record<string, unknown>
    const level = (asRecord.level as LogLevel | undefined) ?? 'info'
    const msg = (asRecord.message as string | undefined) ?? JSON.stringify(asRecord)
    const workerIndex =
      typeof asRecord.workerIndex === 'number'
        ? asRecord.workerIndex
        : typeof asRecord.worker === 'number'
          ? asRecord.worker
          : null
    return {
      level: level === 'warning' || level === 'error' ? level : 'info',
      message: msg,
      workerIndex,
      phaseIndex: typeof asRecord.phaseIndex === 'number' ? asRecord.phaseIndex : undefined,
      phaseStatus:
        asRecord.phaseStatus === 'pending' ||
        asRecord.phaseStatus === 'running' ||
        asRecord.phaseStatus === 'success' ||
        asRecord.phaseStatus === 'failed'
          ? asRecord.phaseStatus
          : undefined,
    }
  }

  const connectLiveEvents = () => {
    const endpoint = `http://${config.sseHost}:${config.ssePort}/events`
    const source = new EventSource(endpoint)
    eventSourceRef.current = source

    source.onmessage = (event) => {
      let parsed: unknown = event.data
      try {
        parsed = JSON.parse(event.data)
      } catch {
        parsed = event.data
      }
      const normalized = normalizeEvent(parsed)
      pushLog({
        level: normalized.level ?? 'info',
        workerIndex: normalized.workerIndex ?? null,
        message: normalized.message ?? 'Received event',
      })
      if (typeof normalized.phaseIndex === 'number' && normalized.phaseStatus) {
        updatePhase(normalized.phaseIndex, normalized.phaseStatus, normalized.message ?? 'Updated')
      }
    }

    source.onerror = () => {
      setErrorMessage('SSE connection dropped. Check backend /events endpoint.')
      setRunStatus('failed')
      source.close()
    }
  }

  const checkHealth = async () => {
    setHealthState('checking')
    try {
      const res = await fetch(`http://${config.sseHost}:${config.ssePort}/health`)
      setHealthState(res.ok ? 'up' : 'down')
    } catch {
      setHealthState('down')
    }
  }

  const validateConfig = () => {
    if (!config.repoUrl.startsWith('http')) {
      return 'repoUrl should start with http/https.'
    }
    if (config.enclaveCount < 1) {
      return 'enclaveCount should be at least 1.'
    }
    if (config.cpuCount < 1 || config.memoryMib < 128) {
      return 'cpuCount and memoryMib values are too low.'
    }
    return ''
  }

  const handleStart = () => {
    const validationError = validateConfig()
    if (validationError) {
      setConfigError(validationError)
      return
    }
    resetDashboard()
    setRunStatus('running')
    setRunId(`run-${Date.now()}`)
    setWorkers(createWorkers(config))
    setStartedAt(Date.now())
    pushLog({ level: 'info', workerIndex: null, message: `Run started in ${activeMode.toUpperCase()} mode` })
    if (activeMode === 'mock') {
      runMockFlow()
    } else {
      connectLiveEvents()
    }
  }

  const summary = useMemo(() => {
    const passed = workers.filter((worker) => worker.status === 'success').length
    const failed = workers.filter((worker) => worker.status === 'failed').length
    const durationMs = startedAt ? Date.now() - startedAt : 0
    return {
      total: workers.length,
      passed,
      failed,
      durationMs,
      status: runStatus,
    }
  }, [workers, startedAt, runStatus])

  useEffect(() => {
    if (runStatus !== 'completed' && runStatus !== 'failed') {
      return
    }
    const item: RunHistoryItem = {
      runId,
      endedAt: new Date().toLocaleString(),
      status: runStatus,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      mode: activeMode,
    }
    setRunHistory((prev) => {
      if (prev[0]?.runId === runId) {
        return prev
      }
      const next = [item, ...prev].slice(0, 10)
      localStorage.setItem('hermbuild-run-history', JSON.stringify(next))
      return next
    })
  }, [runStatus, runId, summary.total, summary.passed, summary.failed, activeMode])

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const byLevel = activeLevel === 'all' || log.level === activeLevel
      const byWorker = workerFilter === 'all' || log.workerIndex === workerFilter
      const bySearch = log.message.toLowerCase().includes(query.toLowerCase())
      return byLevel && byWorker && bySearch
    })
  }, [logs, activeLevel, workerFilter, query])

  const completedPhases = phases.filter((phase) => phase.status === 'success').length
  const phaseProgress = Math.round((completedPhases / phases.length) * 100)
  const runningWorkers = workers.filter((worker) => worker.status === 'running').length
  const successRate = summary.total ? Math.round((summary.passed / summary.total) * 100) : 0

  return (
    <main className="app-shell">
      <div className="bg-orb orb-one" />
      <div className="bg-orb orb-two" />
      <div className="bg-grid" />
      <aside className="left-nav panel">
        <p className="eyebrow">HermBuild</p>
        <h2 className="nav-title">TEE Demo Portal</h2>
        <button className={activeView === 'overview' ? 'nav-btn active' : 'nav-btn'} onClick={() => setActiveView('overview')}>
          Overview
        </button>
        <button className={activeView === 'runs' ? 'nav-btn active' : 'nav-btn'} onClick={() => setActiveView('runs')}>
          Run History
        </button>
        <button className={activeView === 'guide' ? 'nav-btn active' : 'nav-btn'} onClick={() => setActiveView('guide')}>
          Demo Guide
        </button>
        <div className="health-box">
          <p>Backend health: <span className={`health-${healthState}`}>{healthState}</span></p>
          <button className="secondary" onClick={checkHealth}>Check /health</button>
        </div>
      </aside>

      <section className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">HermBuild TEE Dashboard</p>
          <h1>Hermetic Pipeline Demo Console</h1>
          <p className="subtle">
            Track clone to summary with live enclave fanout visibility for fast, judge-friendly demos.
          </p>
        </div>
        <div className={`status-pill status-${runStatus}`}>{runStatus.toUpperCase()}</div>
      </header>

      <section className="kpi-grid">
        <article className="panel kpi-card">
          <p className="kpi-label">Pipeline Progress</p>
          <p className="kpi-value">{phaseProgress}%</p>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${phaseProgress}%` }} />
          </div>
        </article>
        <article className="panel kpi-card">
          <p className="kpi-label">Workers Active</p>
          <p className="kpi-value">{runningWorkers}</p>
          <p className="kpi-subtle">{summary.total} total enclaves</p>
        </article>
        <article className="panel kpi-card">
          <p className="kpi-label">Success Rate</p>
          <p className="kpi-value">{successRate}%</p>
          <p className="kpi-subtle">
            {summary.passed} passed / {summary.failed} failed
          </p>
        </article>
        <article className="panel kpi-card">
          <p className="kpi-label">Run Duration</p>
          <p className="kpi-value">{(summary.durationMs / 1000).toFixed(1)}s</p>
          <p className="kpi-subtle">Run ID: {runId}</p>
        </article>
      </section>

      {activeView === 'overview' && (
      <>
      <section className="panel config-panel">
        <div className="section-head">
          <h2>Run Configuration</h2>
          <span className="chip">Control Plane</span>
        </div>
        <div className="field-grid">
          {Object.entries(config).map(([key, value]) => (
            <label key={key}>
              <span>{key}</span>
              <input
                value={value}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    [key]:
                      typeof value === 'number' ? Number(event.target.value || 0) : event.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
        <div className="row">
          <label className="mode-toggle">
            Mode
            <select
              value={activeMode}
              onChange={(event) => setActiveMode(event.target.value as 'mock' | 'live')}
            >
              <option value="mock">Mock Demo</option>
              <option value="live">Live SSE</option>
            </select>
          </label>
          <button onClick={handleStart} disabled={runStatus === 'running'}>
            Start Run
          </button>
          <button
            className="secondary"
            onClick={() => {
              setConfig(DEFAULT_CONFIG)
            }}
          >
            Load Sample Config
          </button>
          <button className="ghost" onClick={resetDashboard}>
            Reset
          </button>
        </div>
        {configError && <p className="error-line">{configError}</p>}
      </section>

      <section className="middle-grid">
        <article className="panel">
          <div className="section-head">
            <h2>Live Pipeline Timeline</h2>
            <span className="chip">Lifecycle</span>
          </div>
          <div className="timeline-progress">
            <div className="timeline-progress-fill" style={{ width: `${phaseProgress}%` }} />
          </div>
          <div className="timeline">
            {phases.map((phase) => (
              <div key={phase.id} className={`timeline-item timeline-${phase.status}`}>
                <div className="dot" />
                <div>
                  <p className="phase-title">{phase.label}</p>
                  <p className="phase-message">{phase.message}</p>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="section-head">
            <h2>Architecture Explainer</h2>
            <span className="chip">Viva Ready</span>
          </div>
          <ul className="explainer">
            <li>Parent orchestrator drives lifecycle and run-level guarantees.</li>
            <li>Fanout starts parallel enclave workers for isolated execution.</li>
            <li>Framed JSON payloads are exchanged over vsock channels.</li>
            <li>Cleanup is guaranteed with terminate-enclave in finalization logic.</li>
          </ul>
        </article>
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>Worker Fanout Grid</h2>
          <span className="chip">Parallel Enclaves</span>
        </div>
        <div className="worker-grid">
          {workers.map((worker) => (
            <article key={worker.workerIndex} className={`worker-card worker-${worker.status}`}>
              <p className="worker-title">worker-{worker.workerIndex}</p>
              <p>CID: {worker.cid}</p>
              <p>Phase: {worker.phase}</p>
              <p>Status: {worker.status}</p>
              <p>Duration: {worker.durationMs} ms</p>
              <div className="worker-meter">
                <div
                  className={`worker-meter-fill worker-meter-${worker.status}`}
                  style={{
                    width:
                      worker.status === 'success' ? '100%' : worker.status === 'running' ? '65%' : worker.status === 'failed' ? '100%' : '10%',
                  }}
                />
              </div>
              <p className="worker-note">{worker.lastMessage}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="bottom-grid">
        <article className="panel">
          <div className="section-head">
            <h2>Logs Console</h2>
            <span className="chip">Observability</span>
          </div>
          <div className="log-controls">
            <select value={activeLevel} onChange={(event) => setActiveLevel(event.target.value as 'all' | LogLevel)}>
              <option value="all">All Levels</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
            <select
              value={workerFilter}
              onChange={(event) =>
                setWorkerFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))
              }
            >
              <option value="all">All Workers</option>
              {workers.map((worker) => (
                <option key={worker.workerIndex} value={worker.workerIndex}>
                  worker-{worker.workerIndex}
                </option>
              ))}
            </select>
            <input
              placeholder="Search logs..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label className="auto-scroll">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
              />
              Auto-scroll
            </label>
          </div>
          <div className="log-box" ref={logRef}>
            {filteredLogs.map((log) => (
              <p key={log.id} className={`log-${log.level}`}>
                [{log.ts}] {log.workerIndex !== null ? `worker-${log.workerIndex}` : 'run'}: {log.message}
              </p>
            ))}
            {filteredLogs.length === 0 && <p className="empty">No logs for current filters.</p>}
          </div>
        </article>

        <article className="panel">
          <div className="section-head">
            <h2>Final Result View</h2>
            <span className="chip">Outcome</span>
          </div>
          <div className="result-card">
            <p>Run ID: {runId}</p>
            <p>Total Workers: {summary.total}</p>
            <p>Passed: {summary.passed}</p>
            <p>Failed: {summary.failed}</p>
            <p>Overall: {summary.status}</p>
            <p>Duration: {(summary.durationMs / 1000).toFixed(1)}s</p>
            {errorMessage && <p className="error-line">{errorMessage}</p>}
          </div>
          <div className="artifacts">
            <p>Artifacts Preview</p>
            <a href="#">tee-summary.json</a>
            <a href="#">enclave-results/worker-*.json</a>
            <a href="#">run.log</a>
          </div>
        </article>
      </section>
      </>
      )}

      {activeView === 'runs' && (
        <section className="panel history-panel">
          <h2>Recent Runs</h2>
          {runHistory.length === 0 && <p className="empty">No completed runs yet. Start one from Overview.</p>}
          {runHistory.length > 0 && (
            <div className="history-table">
              <p className="table-head">Run ID</p>
              <p className="table-head">Ended At</p>
              <p className="table-head">Mode</p>
              <p className="table-head">Status</p>
              <p className="table-head">Pass/Fail</p>
              {runHistory.map((item) => (
                <div className="history-row" key={item.runId}>
                  <p>{item.runId}</p>
                  <p>{item.endedAt}</p>
                  <p>{item.mode.toUpperCase()}</p>
                  <p className={`status-${item.status}`}>{item.status}</p>
                  <p>{item.passed}/{item.failed}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeView === 'guide' && (
        <section className="panel guide-panel">
          <h2>How To Present This In 3 Minutes</h2>
          <ol>
            <li>Open Overview and explain the run configuration inputs.</li>
            <li>Click Check /health to prove backend connectivity.</li>
            <li>Start a run in Mock or Live mode.</li>
            <li>Narrate phase progress in timeline.</li>
            <li>Show worker fanout parallelism and one failed worker.</li>
            <li>Filter logs by level/worker and search one keyword.</li>
            <li>Conclude with final result card and artifacts.</li>
          </ol>
        </section>
      )}
      </section>
    </main>
  )
}

export default App
