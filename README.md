# HermBuild TEE Dashboard (Frontend)

Demo-friendly dashboard for visualizing the HermBuild secure pipeline in real time.

## What this app includes

- Run configuration panel with all PRD input fields
- One-screen dark dashboard layout for quick demos
- Live phase timeline (`pending | running | success | failed`)
- Worker fanout grid with per-worker status and CID
- Logs console with level filter, worker filter, search, and auto-scroll toggle
- Final result card with run summary and artifact links
- Architecture explainer panel for viva/presentation clarity
- Mock mode for offline demos and Live mode for backend SSE

## Stack

- React + TypeScript + Vite
- Native `EventSource` for SSE (`GET /events`)

## Setup

```bash
npm install
npm run dev
```

Open the local Vite URL and use:
- **Mock Demo** mode when backend is unavailable
- **Live SSE** mode when backend is serving `GET /events`

## Backend integration

Expected endpoint:
- `GET /events` (SSE stream)

Configure host/port in the run configuration panel (`sseHost`, `ssePort`).

If backend event shape differs, update event parsing in `src/App.tsx` (`normalizeEvent` function).

## Offline sample artifacts

Sample files (for screenshots/backups) are in `sample-data/`:

- `sample-data/tee-summary.json`
- `sample-data/enclave-results/worker-0.json`
- `sample-data/enclave-results/worker-1.json`
- `sample-data/enclave-results/worker-2.json`
- `sample-data/run.log`

## Recommended demo flow (2-4 minutes)

1. Show architecture explainer panel.
2. Load sample config (`enclaveCount = 3`).
3. Start run in mock mode.
4. Highlight timeline progression.
5. Show worker cards updating in parallel.
6. Filter logs to an individual worker.
7. End on final summary card.
