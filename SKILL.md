---
name: agent-swarm-dashboard
description: >-
  Install and manage the Agent Swarm Dashboard — a live web UI that shows sub-agent activity in real time.
  Provides a WebSocket-connected dashboard and a REST event ingest API.
  Use when: (1) setting up or reinstalling the dashboard on an OpenClaw instance,
  (2) troubleshooting the dashboard service,
  (3) sending agent lifecycle events (spawn/working/done/error) to the dashboard,
  (4) running demo scenarios to preview the UI.
---

# Agent Swarm Dashboard

Live web dashboard showing sub-agent activity. Built on Bun + Elysia with WebSocket push.

## Architecture

- **Backend:** `src/server.ts` — Elysia server, `/api/event` ingest, `/api/events` state, `/api/runs` run log, `/ws` WebSocket, `/api/demo` demo trigger
- **Frontend:** `src/public/index.html` — single-file dashboard, auto-reconnecting WebSocket, D3 force graph, activity feed with click-to-detail, run history panel
- **Database:** `bun:sqlite` — runs and events persisted to SQLite; survives service restarts

## Run Log

The server tracks the last N runs (groups of events sharing a root session). Configurable via `MAX_RUNS` env var (default: 20). Persisted to SQLite.

```bash
GET /api/runs  →  { runs: [{ runId, startedAt, endedAt?, events[] }] }
```

The UI exposes a **Run History** panel (click to expand) — selecting a run replays its events into the graph and feed.

## Persistence (SQLite)

Data is stored in a SQLite DB via `bun:sqlite` (zero extra dependencies).

- **`DB_PATH`** env var sets the database path (default: `./data/swarm.db`)
- On startup, runs and recent events are loaded from DB automatically
- Pruning respects `MAX_RUNS` — oldest runs and their events are evicted together
- Tables: `runs` (run_id, started_at, ended_at) and `events` (all fields + root_id)

## Setup

Run the setup script (non-elevated — prints sudo commands at the end):

```bash
bash scripts/setup.sh [--port 3456] [--serve-path /agents] [--install-dir ~/agent-swarm-dashboard]
```

Then run the printed sudo commands to register the systemd service and configure `tailscale serve`.

**Defaults:** port `3456`, path `/agents`, installs to `~/agent-swarm-dashboard`.

**Requires:** `bun` (auto-detected), `tailscale` (for HTTPS).

## Event Ingest API

Fire events from the agent runtime via `POST /api/event`:

```json
{
  "type": "spawn",
  "sessionId": "session-abc123",
  "parentId": "pip-main",
  "agent": {
    "id": "researcher",
    "name": "Vesper",
    "role": "Senior Research Agent",
    "emoji": "🔍"
  },
  "task": "Research AI orchestration patterns"
}
```

**Event types:** `spawn` | `working` | `done` | `error` | `message`

All fields except `type`, `sessionId`, and `agent` are optional. `id` and `ts` are auto-generated if omitted.

## Agent Registry

The server has a built-in registry (`AGENTS` map in `server.ts`). To add agents, edit `src/server.ts` and restart the service. Unregistered agent IDs fall back to `{ name: id, role: "Agent" }`.

## Sending Events (OpenClaw Agents)

When spawning, steering, or receiving results from any sub-agent, fire an event:

```bash
curl -s -X POST http://localhost:3456/api/event \
  -H "Content-Type: application/json" \
  -d '{"type":"spawn","sessionId":"<session-id>","agent":{"id":"<agent-id>","name":"<name>","role":"<role>"},"task":"<task>"}'
```

## Service Management

```bash
sudo systemctl status agent-swarm
sudo systemctl restart agent-swarm
journalctl -u agent-swarm -f
```

## Demo Scenarios

POST to `/api/demo` with `{ "scenario": "<name>" }`:
- `research-write` — Vesper + Cassia
- `design-review` — Lorne + Piers
- `sprint-plan` — Caden + Senna + Orla
- `security-audit` — Caden + Vael
- `product-launch` — 6 agents: research, PM, architecture, security, writing
- `incident-response` — 6 agents: triage, diagnose, hotfix review, post-mortem, comms

Or use the demo buttons in the UI. Note: demos consume tokens on your instance.

## Troubleshooting

**Port in use:** Change `PORT` in the systemd service env, re-run `tailscale serve` with the new port.

**WebSocket disconnected:** Check the service is running. The UI auto-reconnects with backoff.

**404 on API calls:** Ensure `tailscale serve` is configured with `--set-path` matching the path the page was loaded from.

**Cert errors:** Tailscale only issues certs for the machine's own hostname (e.g. `vertex.vulture-squeaker.ts.net`). Use `tailscale serve` rather than nginx+manual certs for `.ts.net` domains.
