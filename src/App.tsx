import { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, MarkerType } from "reactflow";
import "reactflow/dist/style.css";

type RunStatus = "idle" | "running" | "completed" | "failed";
type PhaseStatus = "pending" | "running" | "success" | "failed";
type LogLevel = "info" | "warning" | "error";
type EventName =
  | "sse_log_server_started"
  | "pipeline_started"
  | "pipeline_failed"
  | "pipeline_completed"
  | "pipeline_completed_with_failures"
  | "sse_keep_alive_waiting_for_signal"
  | "sse_log_server_stopping"
  | "orchestrator_run_started"
  | "input_bundle_ready"
  | "git_clone_started"
  | "git_clone_completed"
  | "tee_start"
  | "enclave_launch_started"
  | "enclave_launch_completed"
  | "vsock_send_started"
  | "vsock_send_completed"
  | "vsock_receive_started"
  | "vsock_receive_completed"
  | "enclave_log_line"
  | "tee_worker_failed"
  | "enclave_terminated"
  | "enclave_terminate_failed"
  | "tee_completed"
  | "nitro_cli_command_started"
  | "nitro_cli_stream_line"
  | "nitro_cli_command_completed";

type RunConfig = {
  repo_url: string;
  enclave_count: number;
  cpu_count: number;
  memory_mib: number;
  "timeout-sec": number;
};

type WorkerState = {
  workerIndex: number;
  cid: number | null;
  status: PhaseStatus;
  phase: string;
  durationMs: number;
  lastMessage: string;
};

type LogEntry = {
  id: string;
  ts: string;
  level: LogLevel;
  workerIndex: number | null;
  message: string;
};

type RunHistoryItem = {
  runId: string;
  endedAt: string;
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  mode: "live";
};

type SsePayload = {
  timestamp?: string;
  level?: string;
  logger?: string;
  message?: string;
  phase?: string;
  run_id?: string;
  worker_index?: number;
  cid?: number;
  enclave_id?: string;
  repo_url?: string;
  commit_sha?: string;
  response_status?: string;
  error?: string;
  line_number?: number;
  line?: string;
  command?: string;
  stream?: string;
  exception?: string;
};

const FAILURE_EVENTS: EventName[] = [
  "pipeline_failed",
  "pipeline_completed_with_failures",
  "tee_worker_failed",
  "enclave_terminate_failed",
];
const COMPLETE_EVENTS: EventName[] = ["pipeline_completed"];
const TERMINAL_EVENTS: EventName[] = [
  "pipeline_completed",
  "pipeline_failed",
  "pipeline_completed_with_failures",
  "sse_log_server_stopping",
];
const FLOW_MILESTONES: EventName[] = [
  "enclave_launch_started",
  "enclave_launch_completed",
  "vsock_send_started",
  "vsock_send_completed",
  "vsock_receive_started",
  "vsock_receive_completed",
  "nitro_cli_command_started",
  "nitro_cli_command_completed",
  "tee_worker_failed",
  "enclave_terminated",
  "enclave_terminate_failed",
  "tee_completed",
  "pipeline_completed",
];
const MAIN_FLOW_EVENTS: EventName[] = [
  "enclave_launch_started",
  "enclave_launch_completed",
  "vsock_send_started",
  "vsock_send_completed",
  "vsock_receive_started",
  "vsock_receive_completed",
  "nitro_cli_command_started",
  "nitro_cli_command_completed",
  "enclave_terminated",
  "tee_completed",
  "pipeline_completed",
];
const SUCCESS_PROGRESS_EVENTS: EventName[] = [
  "enclave_launch_completed",
  "vsock_send_completed",
  "vsock_receive_completed",
  "nitro_cli_command_completed",
  "enclave_terminated",
  "tee_completed",
  "pipeline_completed",
];
const FLOW_LAYOUT: Record<string, { x: number; y: number }> = {
  enclave_launch_started: { x: 0, y: 0 },
  enclave_launch_completed: { x: 320, y: 0 },
  vsock_send_started: { x: 640, y: 0 },
  vsock_send_completed: { x: 960, y: 0 },
  vsock_receive_started: { x: 1280, y: 0 },
  vsock_receive_completed: { x: 1600, y: 0 },
  nitro_cli_command_started: { x: 1920, y: 0 },
  nitro_cli_command_completed: { x: 2240, y: 0 },
  enclave_terminated: { x: 2560, y: 0 },
  tee_completed: { x: 2880, y: 0 },
  pipeline_completed: { x: 3200, y: 0 },
  tee_worker_failed: { x: 1600, y: 220 },
  enclave_terminate_failed: { x: 2240, y: 220 },
};
const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/$/,
    "",
  ) ?? "https://3.87.217.35:8080";
const API_ROOT = import.meta.env.DEV ? "/api" : API_BASE_URL;
const INITIAL_FLOW_STATUS = Object.fromEntries(
  FLOW_MILESTONES.map((eventName) => [eventName, "pending"]),
) as Record<string, PhaseStatus>;

const DEFAULT_CONFIG: RunConfig = {
  repo_url: "file:///home/ec2-user/major-project/demo-node-app",
  enclave_count: 1,
  cpu_count: 2,
  memory_mib: 1024,
  "timeout-sec": 300,
};

const createWorkers = (config: RunConfig): WorkerState[] =>
  Array.from({ length: config.enclave_count }, (_, workerIndex) => ({
    workerIndex,
    cid: null,
    status: "pending",
    phase: "Pending",
    durationMs: 0,
    lastMessage: "Not started",
  }));

const formatEventLabel = (eventName: string) =>
  eventName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

function App() {
  const [activeView, setActiveView] = useState<"overview" | "runs">("overview");
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [runId, setRunId] = useState<string>("demo-run");
  const [config, setConfig] = useState<RunConfig>(DEFAULT_CONFIG);
  const [workers, setWorkers] = useState<WorkerState[]>(
    createWorkers(DEFAULT_CONFIG),
  );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [healthState, setHealthState] = useState<
    "unknown" | "checking" | "up" | "down"
  >("unknown");
  const [configError, setConfigError] = useState("");
  const [activeLevel, setActiveLevel] = useState<"all" | LogLevel>("all");
  const [workerFilter, setWorkerFilter] = useState<"all" | number>("all");
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryItem[]>([]);
  const [flowStatus, setFlowStatus] =
    useState<Record<string, PhaseStatus>>(INITIAL_FLOW_STATUS);
  const [finalCounts, setFinalCounts] = useState<{
    passed: number;
    failed: number;
  } | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<number[]>([]);
  const workerStartTimes = useRef<Record<number, number>>({});
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const savedHistory = localStorage.getItem("hermbuild-run-history");
    if (!savedHistory) {
      return;
    }
    try {
      setRunHistory(JSON.parse(savedHistory));
    } catch {
      localStorage.removeItem("hermbuild-run-history");
    }
  }, []);

  useEffect(() => {
    if (!autoScroll || !logRef.current) {
      return;
    }
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, autoScroll]);

  useEffect(
    () => () => {
      timers.current.forEach((timerId) => window.clearTimeout(timerId));
      eventSourceRef.current?.close();
    },
    [],
  );

  const pushLog = (entry: Omit<LogEntry, "id" | "ts">) => {
    setLogs((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        ts: new Date().toLocaleTimeString(),
        ...entry,
      },
    ]);
  };

  const resetDashboard = () => {
    timers.current.forEach((timerId) => window.clearTimeout(timerId));
    timers.current = [];
    workerStartTimes.current = {};
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setRunStatus("idle");
    setRunId("demo-run");
    setErrorMessage("");
    setStartedAt(null);
    setWorkers(createWorkers(config));
    setLogs([]);
    setConfigError("");
    setFlowStatus(INITIAL_FLOW_STATUS);
    setFinalCounts(null);
  };

  const updateWorker = (workerIndex: number, patch: Partial<WorkerState>) => {
    setWorkers((prev) =>
      prev.map((worker) =>
        worker.workerIndex === workerIndex ? { ...worker, ...patch } : worker,
      ),
    );
  };

  const setEventStatus = (eventName: EventName, status: PhaseStatus) => {
    if (!FLOW_MILESTONES.includes(eventName)) {
      return;
    }
    setFlowStatus((prev) => ({ ...prev, [eventName]: status }));
  };

  const updateWorkerFromEvent = (payload: SsePayload, eventName: string) => {
    if (typeof payload.worker_index !== "number") {
      return;
    }
    const now = Date.now();
    const workerIndex = payload.worker_index;
    if (eventName === "enclave_launch_started") {
      workerStartTimes.current[workerIndex] = now;
    }
    const durationMs = workerStartTimes.current[workerIndex]
      ? now - workerStartTimes.current[workerIndex]
      : 0;
    const phase = payload.phase ?? eventName;
    const lastMessage =
      payload.error ?? payload.line ?? payload.exception ?? eventName;
    const status: PhaseStatus =
      eventName === "tee_worker_failed" ||
      eventName === "enclave_terminate_failed"
        ? "failed"
        : eventName === "tee_completed" || eventName === "enclave_terminated"
          ? "success"
          : "running";
    updateWorker(workerIndex, {
      ...(typeof payload.cid === "number" ? { cid: payload.cid } : {}),
      phase,
      status,
      durationMs,
      lastMessage,
    });
  };

  const parseSsePayload = (rawData: string): SsePayload => {
    const trimmed = rawData.trim();
    if (!trimmed) {
      return {
        timestamp: new Date().toISOString(),
        level: "INFO",
        logger: "sse",
        message: "empty_event",
      };
    }

    try {
      return JSON.parse(trimmed) as SsePayload;
    } catch {
      // Some streams send lines like: "log\t{...json...}"
      const firstBrace = trimmed.indexOf("{");
      const lastBrace = trimmed.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const maybeJson = trimmed.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(maybeJson) as SsePayload;
        } catch {
          return {
            timestamp: new Date().toISOString(),
            level: "INFO",
            logger: "sse",
            message: trimmed,
          };
        }
      }
      return {
        timestamp: new Date().toISOString(),
        level: "INFO",
        logger: "sse",
        message: trimmed,
      };
    }
  };

  const applySseEvent = (payload: SsePayload) => {
    const eventName = payload.message as EventName | undefined;
    const level =
      payload.level?.toUpperCase() === "ERROR"
        ? "error"
        : payload.level?.toUpperCase() === "WARNING"
          ? "warning"
          : "info";
    const workerIndex =
      typeof payload.worker_index === "number" ? payload.worker_index : null;
    const logMessage = `${payload.message ?? "unknown_event"}${payload.error ? ` | ${payload.error}` : ""}${payload.line ? ` | ${payload.line}` : ""}`;
    pushLog({ level, workerIndex, message: logMessage });

    if (!eventName) {
      return;
    }
    if (eventName.endsWith("_started")) {
      setEventStatus(eventName, "running");
    } else {
      setEventStatus(eventName, "success");
    }
    if (FAILURE_EVENTS.includes(eventName)) {
      setRunStatus("failed");
      setErrorMessage(payload.error ?? payload.exception ?? eventName);
      if (eventName === "pipeline_failed") {
        setEventStatus("pipeline_completed", "failed");
      }
    }
    if (COMPLETE_EVENTS.includes(eventName)) {
      setRunStatus("completed");
    }
    if (
      typeof (payload as Record<string, unknown>).successful_workers ===
        "number" &&
      typeof (payload as Record<string, unknown>).failed_workers === "number"
    ) {
      setFinalCounts({
        passed: (payload as Record<string, number>).successful_workers,
        failed: (payload as Record<string, number>).failed_workers,
      });
    }

    if (eventName === "pipeline_started") {
      setRunStatus("running");
    }

    updateWorkerFromEvent(payload, eventName);

    if (TERMINAL_EVENTS.includes(eventName)) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    }
  };

  const connectLiveEvents = () => {
    const endpoint = `${API_ROOT}/events`;
    const source = new EventSource(endpoint);
    eventSourceRef.current = source;

    const handleIncomingEvent = (event: MessageEvent) => {
      const parsed = parseSsePayload(String(event.data));
      applySseEvent(parsed);
    };
    // Handle named SSE events like: "event: log"
    source.addEventListener("log", handleIncomingEvent as EventListener);
    // Keep a fallback for default "message" events.
    source.onmessage = handleIncomingEvent;

    source.onerror = () => {
      setErrorMessage(
        "SSE connection dropped. Check backend /events endpoint.",
      );
      setRunStatus("failed");
      source.close();
    };
  };

  const checkHealth = async () => {
    setHealthState("checking");
    try {
      const res = await fetch(`${API_ROOT}/health`);
      setHealthState(res.ok ? "up" : "down");
    } catch {
      setHealthState("down");
    }
  };

  const validateConfig = () => {
    if (!config.repo_url.includes("://")) {
      return "repo_url must be a valid URL format (for example file:///... or https://...).";
    }
    if (config.enclave_count < 1) {
      return "enclave_count should be at least 1.";
    }
    if (config.cpu_count < 1 || config.memory_mib < 128) {
      return "cpu_count and memory_mib values are too low.";
    }
    return "";
  };

  const handleStart = async () => {
    const validationError = validateConfig();
    if (validationError) {
      setConfigError(validationError);
      return;
    }
    resetDashboard();
    setRunStatus("running");
    setRunId(`run-${Date.now()}`);
    setWorkers(createWorkers(config));
    setStartedAt(Date.now());
    pushLog({
      level: "info",
      workerIndex: null,
      message: "Run started in LIVE mode",
    });
    connectLiveEvents();
    try {
      const response = await fetch(`${API_ROOT}/rebuild-last`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) {
        const body = await response.text();
        setRunStatus("failed");
        setErrorMessage(`Failed to trigger run: ${response.status} ${body}`);
      }
    } catch {
      setRunStatus("failed");
      setErrorMessage(
        "Failed to trigger run. Check API host/cert and network access.",
      );
    }
  };

  const summary = useMemo(() => {
    const workerPassed = workers.filter(
      (worker) => worker.status === "success",
    ).length;
    const workerFailed = workers.filter(
      (worker) => worker.status === "failed",
    ).length;
    const passed = finalCounts?.passed ?? workerPassed;
    const failed = finalCounts?.failed ?? workerFailed;
    const durationMs = startedAt ? Date.now() - startedAt : 0;
    return {
      total: workers.length,
      passed,
      failed,
      durationMs,
      status: runStatus,
    };
  }, [workers, startedAt, runStatus]);

  useEffect(() => {
    if (runStatus !== "completed" && runStatus !== "failed") {
      return;
    }
    const item: RunHistoryItem = {
      runId,
      endedAt: new Date().toLocaleString(),
      status: runStatus,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      mode: "live",
    };
    setRunHistory((prev) => {
      if (prev[0]?.runId === runId) {
        return prev;
      }
      const next = [item, ...prev].slice(0, 10);
      localStorage.setItem("hermbuild-run-history", JSON.stringify(next));
      return next;
    });
  }, [runStatus, runId, summary.total, summary.passed, summary.failed]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const byLevel = activeLevel === "all" || log.level === activeLevel;
      const byWorker =
        workerFilter === "all" || log.workerIndex === workerFilter;
      const bySearch = log.message.toLowerCase().includes(query.toLowerCase());
      return byLevel && byWorker && bySearch;
    });
  }, [logs, activeLevel, workerFilter, query]);

  const completedPhases = SUCCESS_PROGRESS_EVENTS.filter(
    (eventName) => flowStatus[eventName] === "success",
  ).length;
  const phaseProgress = SUCCESS_PROGRESS_EVENTS.length
    ? Math.round((completedPhases / SUCCESS_PROGRESS_EVENTS.length) * 100)
    : 0;
  const runningWorkers = workers.filter(
    (worker) => worker.status === "running",
  ).length;
  const successRate = summary.total
    ? Math.round((summary.passed / summary.total) * 100)
    : 0;
  const flowNodes = useMemo(
    () =>
      FLOW_MILESTONES.map((eventName) => {
        const status = flowStatus[eventName];
        const border =
          status === "success"
            ? "1px solid #34d399"
            : status === "running"
              ? "1px solid #5ea1ff"
              : status === "failed"
                ? "1px solid #f87171"
                : "1px solid #4b5563";
        const background =
          status === "success"
            ? "rgba(16, 90, 66, 0.5)"
            : status === "running"
              ? "repeating-linear-gradient(135deg, rgba(47, 93, 168, 0.72) 0 12px, rgba(28, 62, 122, 0.72) 12px 24px)"
              : status === "failed"
                ? "rgba(115, 27, 27, 0.5)"
                : "rgba(26, 35, 56, 0.7)";
        return {
          id: eventName,
          position: FLOW_LAYOUT[eventName],
          data: {
            label: `${formatEventLabel(eventName)}\n${status.toUpperCase()}`,
          },
          style: {
            width: 280,
            minHeight: 110,
            whiteSpace: "pre-wrap",
            border,
            borderRadius: 14,
            background,
            color: "#e6ebfa",
            fontSize: 14,
            fontWeight: 600,
            transition: "all 280ms ease",
            animation:
              status === "running"
                ? "flowNodePulse 1.4s ease-in-out infinite"
                : "none",
          },
        };
      }),
    [flowStatus],
  );
  const flowEdges = useMemo(
    () => [
      ...MAIN_FLOW_EVENTS.slice(0, -1).map((eventName, index) => ({
        id: `${eventName}-${MAIN_FLOW_EVENTS[index + 1]}`,
        source: eventName,
        target: MAIN_FLOW_EVENTS[index + 1],
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        animated: true,
      })),
      {
        id: "branch-vsock_receive_completed-tee_worker_failed",
        source: "vsock_receive_completed",
        target: "tee_worker_failed",
        type: "smoothstep" as const,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        animated: true,
      },
      {
        id: "branch-nitro_cli_command_started-enclave_terminate_failed",
        source: "nitro_cli_command_started",
        target: "enclave_terminate_failed",
        type: "smoothstep" as const,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        animated: true,
      },
    ],
    [],
  );

  return (
    <main className="app-shell">
      <div className="bg-orb orb-one" />
      <div className="bg-orb orb-two" />
      <div className="bg-grid" />
      <aside className="left-nav panel">
        <p className="eyebrow">HermBuild</p>
        <h2 className="nav-title">TEE Demo Portal</h2>
        <button
          className={activeView === "overview" ? "nav-btn active" : "nav-btn"}
          onClick={() => setActiveView("overview")}
        >
          Overview
        </button>
        <button
          className={activeView === "runs" ? "nav-btn active" : "nav-btn"}
          onClick={() => setActiveView("runs")}
        >
          Run History
        </button>
        <div className="health-box">
          <p>
            Backend health:{" "}
            <span className={`health-${healthState}`}>{healthState}</span>
          </p>
          <button className="secondary" onClick={checkHealth}>
            Check /health
          </button>
        </div>
      </aside>

      <section className="dashboard-shell">
        <header className="dashboard-header">
          <div className="hero-copy">
            <p className="eyebrow">HermBuild TEE Dashboard</p>
            <h1>HermBuild Console</h1>
          </div>
          <div className="hero-actions">
            <button
              className="primary-cta"
              onClick={handleStart}
              disabled={runStatus === "running"}
            >
              {runStatus === "running" ? "Run in Progress" : "Start New Run"}
            </button>
            <div className={`status-pill status-${runStatus}`}>
              {runStatus.toUpperCase()}
            </div>
          </div>
        </header>
        <section className="workspace-strip panel">
          <article className="workspace-item">
            <p className="workspace-label">Repository</p>
            <p className="workspace-value" title={config.repo_url}>
              {config.repo_url}
            </p>
          </article>
          <article className="workspace-item">
            <p className="workspace-label">Environment</p>
            <p className="workspace-value">Live SSE</p>
          </article>
          <article className="workspace-item">
            <p className="workspace-label">Enclave Count</p>
            <p className="workspace-value">{config.enclave_count}</p>
          </article>
          <article className="workspace-item">
            <p className="workspace-label">Timeout</p>
            <p className="workspace-value">{config["timeout-sec"]} sec</p>
          </article>
        </section>

        <section className="kpi-grid">
          <article className="panel kpi-card">
            <p className="kpi-label">Pipeline Progress</p>
            <p className="kpi-value">{phaseProgress}%</p>
            <div className="meter">
              <div
                className="meter-fill"
                style={{ width: `${phaseProgress}%` }}
              />
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
            <p className="kpi-value">
              {(summary.durationMs / 1000).toFixed(1)}s
            </p>
            <p className="kpi-subtle">Run ID: {runId}</p>
          </article>
        </section>

        {activeView === "overview" && (
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
                            typeof value === "number"
                              ? Number(event.target.value || 0)
                              : event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="row">
                <button
                  className="secondary"
                  onClick={handleStart}
                  disabled={runStatus === "running"}
                >
                  Start Run
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setConfig(DEFAULT_CONFIG);
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

            <section>
              <article className="panel">
                <div className="section-head">
                  <h2>Pipeline Flow (React Flow)</h2>
                  <span className="chip">SSE Lifecycle</span>
                </div>
                <div className="timeline-progress">
                  <div
                    className="timeline-progress-fill"
                    style={{ width: `${phaseProgress}%` }}
                  />
                </div>
                <div className="flow-wrap">
                  <ReactFlow
                    nodes={flowNodes}
                    edges={flowEdges}
                    fitView
                    fitViewOptions={{ maxZoom: 1.2, padding: 0.15 }}
                  >
                    <Controls />
                    <Background />
                  </ReactFlow>
                </div>
              </article>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>Worker Fanout Grid</h2>
                <span className="chip">Parallel Enclaves</span>
              </div>
              <div className="worker-grid">
                {workers.map((worker) => (
                  <article
                    key={worker.workerIndex}
                    className={`worker-card worker-${worker.status}`}
                  >
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
                            worker.status === "success"
                              ? "100%"
                              : worker.status === "running"
                                ? "65%"
                                : worker.status === "failed"
                                  ? "100%"
                                  : "10%",
                        }}
                      />
                    </div>
                    <p className="worker-note" title={worker.lastMessage}>
                      {worker.lastMessage}
                    </p>
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
                  <select
                    value={activeLevel}
                    onChange={(event) =>
                      setActiveLevel(event.target.value as "all" | LogLevel)
                    }
                  >
                    <option value="all">All Levels</option>
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="error">Error</option>
                  </select>
                  <select
                    value={workerFilter}
                    onChange={(event) =>
                      setWorkerFilter(
                        event.target.value === "all"
                          ? "all"
                          : Number(event.target.value),
                      )
                    }
                  >
                    <option value="all">All Workers</option>
                    {workers.map((worker) => (
                      <option
                        key={worker.workerIndex}
                        value={worker.workerIndex}
                      >
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
                      [{log.ts}]{" "}
                      {log.workerIndex !== null
                        ? `worker-${log.workerIndex}`
                        : "run"}
                      : {log.message}
                    </p>
                  ))}
                  {filteredLogs.length === 0 && (
                    <p className="empty">No logs for current filters.</p>
                  )}
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

        {activeView === "runs" && (
          <section className="panel history-panel">
            <h2>Recent Runs</h2>
            {runHistory.length === 0 && (
              <p className="empty">
                No completed runs yet. Start one from Overview.
              </p>
            )}
            {runHistory.length > 0 && (
              <div className="history-table">
                <div className="history-row history-head">
                  <p>Run ID</p>
                  <p>Ended At</p>
                  <p>Mode</p>
                  <p>Status</p>
                  <p>Pass/Fail</p>
                </div>
                {runHistory.map((item) => (
                  <div className="history-row" key={item.runId}>
                    <p>{item.runId}</p>
                    <p>{item.endedAt}</p>
                    <p>{item.mode.toUpperCase()}</p>
                    <p className={`status-${item.status}`}>{item.status}</p>
                    <p>
                      {item.passed}/{item.failed}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </section>
    </main>
  );
}

export default App;
