# Agent Swarm Dashboard

An [OpenClaw](https://openclaw.ai) skill that installs a live web dashboard for monitoring sub-agent activity in real time.

![Agent Swarm Dashboard](https://raw.githubusercontent.com/AndyBold/agent-swarm-dashboard/main/assets/preview.png)

---

## What it does

When you're running multi-agent workflows in OpenClaw, it can be hard to know what's happening inside a swarm. This skill gives you a live window into that activity:

- **Force-directed graph** — agents appear as nodes connected by parent/child edges, coloured by state (spawning, working, done, error)
- **Activity feed** — real-time event stream with click-to-detail for each event
- **Run history** — persistent log of previous runs (SQLite), survives service restarts; click any run to replay it in the graph and feed
- **Demo scenarios** — 6 built-in demos to preview the UI without running real agents
- **REST + WebSocket API** — any agent or tool can push events via a simple HTTP POST

---

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- [Tailscale](https://tailscale.com) (for HTTPS on `.ts.net` domains)
- Linux with systemd (for the service)

---

## Installation

### 1. Run the setup script

```bash
bash scripts/setup.sh
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3456` | Port the server listens on |
| `--serve-path` | `/agents` | URL path via `tailscale serve` |
| `--install-dir` | `~/agent-swarm-dashboard` | Where to install the app |
| `--db-path` | `$install-dir/data/swarm.db` | SQLite database path |

The script auto-detects your `bun` binary, installs dependencies, and prints the sudo commands needed to complete the install.

### 2. Run the printed sudo commands

```bash
sudo cp /tmp/agent-swarm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-swarm
sudo tailscale serve --bg --set-path /agents 3456
```

### 3. Open the dashboard

```
https://<your-tailscale-hostname>/agents
```

---

## Sending events

Push events from your agents via `POST /api/event`:

```bash
curl -X POST http://localhost:3456/api/event \
  -H "Content-Type: application/json" \
  -d '{
    "type": "spawn",
    "sessionId": "my-session-123",
    "agent": {
      "id": "researcher",
      "name": "Vesper",
      "role": "Senior Research Agent",
      "emoji": "🔍"
    },
    "task": "Research competitor landscape"
  }'
```

### Event types

| Type | Meaning |
|------|---------|
| `spawn` | Agent started |
| `working` | Agent is actively processing |
| `done` | Agent completed successfully |
| `error` | Agent encountered an error |
| `message` | Informational message |

### Event fields

| Field | Required | Description |
|-------|----------|-------------|
| `type` | ✓ | Event type (see above) |
| `sessionId` | ✓ | Unique ID for this agent session |
| `agent.id` | ✓ | Agent identifier (used for registry lookup) |
| `agent.name` | ✓ | Display name |
| `agent.role` | ✓ | Role description |
| `agent.emoji` | | Emoji shown on the node |
| `parentId` | | Session ID of the parent agent |
| `task` | | Task description (shown in feed) |
| `message` | | Status message (shown in feed) |
| `id` | | Event ID (auto-generated if omitted) |
| `ts` | | Unix timestamp ms (auto-set if omitted) |

### Hierarchy

Set `parentId` to the parent agent's `sessionId` to create a tree. The dashboard resolves the full ancestry chain — deeply nested agents all appear under the correct root run.

---

## API reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/event` | POST | Ingest a single event |
| `/api/events` | GET | Recent event buffer (last 200) |
| `/api/runs` | GET | Run history (`{ runs: [...] }`) |
| `/api/demo` | POST | Trigger a demo scenario |
| `/ws` | WS | Live event stream |

---

## Configuration

All config via environment variables (set in the systemd service):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `MAX_RUNS` | `20` | Max runs retained in history |
| `DB_PATH` | `./data/swarm.db` | SQLite database path |

---

## Demo scenarios

Trigger via the UI or `POST /api/demo` with `{ "scenario": "<name>" }`:

| Scenario | Agents | Description |
|----------|--------|-------------|
| `research-write` | 2 | Vesper researches, Cassia writes |
| `design-review` | 2 | Lorne designs an API, Piers reviews |
| `sprint-plan` | 3 | Caden coordinates, Senna defines requirements, Orla plans |
| `security-audit` | 2 | Caden coordinates, Vael audits |
| `product-launch` | 6 | Full launch pipeline: research, PM, architecture, security, copy |
| `incident-response` | 6 | P1 triage, diagnosis, hotfix review, post-mortem, comms |

> **Note:** Demo scenarios don't call any real AI APIs — they simulate events with timeouts.

---

## Service management

```bash
sudo systemctl status agent-swarm
sudo systemctl restart agent-swarm
journalctl -u agent-swarm -f
```

---

## License

MIT — see [LICENSE](LICENSE).
