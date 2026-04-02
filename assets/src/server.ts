import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const PORT     = Number(process.env.PORT     ?? 3456);
const MAX_EVENTS = 200;
const MAX_RUNS = Number(process.env.MAX_RUNS ?? 20);
const DB_PATH  = process.env.DB_PATH ?? "./data/swarm.db";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentEvent {
  id: string;
  ts: number;
  type: "spawn" | "working" | "done" | "error" | "message";
  sessionId: string;
  parentId?: string;
  agent: {
    id: string;
    name: string;
    role: string;
    emoji?: string;
  };
  task?: string;
  message?: string;
}

interface Run {
  runId: string;
  startedAt: number;
  endedAt?: number;
  events: AgentEvent[];
}

// ── SQLite ───────────────────────────────────────────────────────────────────

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH, { create: true });

db.run(`CREATE TABLE IF NOT EXISTS runs (
  run_id     TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
)`);

db.run(`CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_id  TEXT,
  agent_id   TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  agent_emoji TEXT,
  task       TEXT,
  message    TEXT,
  root_id    TEXT NOT NULL
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_events_root ON events(root_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts)`);

const stmtInsertRun   = db.prepare(`INSERT OR IGNORE INTO runs (run_id, started_at) VALUES (?, ?)`);
const stmtUpdateRun   = db.prepare(`UPDATE runs SET ended_at = ? WHERE run_id = ?`);
const stmtInsertEvent = db.prepare(`
  INSERT OR IGNORE INTO events
    (id, ts, type, session_id, parent_id, agent_id, agent_name, agent_role, agent_emoji, task, message, root_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtPruneRuns   = db.prepare(`
  DELETE FROM runs WHERE run_id NOT IN (
    SELECT run_id FROM runs ORDER BY started_at DESC LIMIT ?
  )
`);
const stmtPruneEvents = db.prepare(`
  DELETE FROM events WHERE root_id NOT IN (SELECT run_id FROM runs)
`);
const stmtPruneSessionToRoot = db.prepare(`
  DELETE FROM events WHERE root_id NOT IN (SELECT run_id FROM runs)
`);

function persistEvent(ev: AgentEvent, rootId: string) {
  stmtInsertEvent.run(
    ev.id, ev.ts, ev.type, ev.sessionId, ev.parentId ?? null,
    ev.agent.id, ev.agent.name, ev.agent.role, ev.agent.emoji ?? null,
    ev.task ?? null, ev.message ?? null,
    rootId,
  );
}

function persistRunStart(runId: string, startedAt: number) {
  stmtInsertRun.run(runId, startedAt);
}

function persistRunEnd(runId: string, endedAt: number) {
  stmtUpdateRun.run(endedAt, runId);
}

function pruneDB() {
  stmtPruneRuns.run(MAX_RUNS);
  stmtPruneEvents.run();
}

function rowToEvent(row: any): AgentEvent {
  return {
    id:        row.id,
    ts:        row.ts,
    type:      row.type as AgentEvent["type"],
    sessionId: row.session_id,
    parentId:  row.parent_id ?? undefined,
    agent: {
      id:    row.agent_id,
      name:  row.agent_name,
      role:  row.agent_role,
      emoji: row.agent_emoji ?? undefined,
    },
    task:    row.task    ?? undefined,
    message: row.message ?? undefined,
  };
}

// ── In-memory state (populated from DB on startup) ───────────────────────────

const events: AgentEvent[] = [];
const runs: Run[] = [];
const activeRuns = new Map<string, Run>();
const sessionToRoot = new Map<string, string>();
const wsClients = new Set<any>();

function loadFromDB() {
  const dbRuns = db.query(`SELECT * FROM runs ORDER BY started_at ASC`).all() as any[];
  for (const r of dbRuns.slice(-MAX_RUNS)) {
    const run: Run = {
      runId:     r.run_id,
      startedAt: r.started_at,
      endedAt:   r.ended_at ?? undefined,
      events:    [],
    };
    const dbEvents = db.query(`SELECT * FROM events WHERE root_id = ? ORDER BY ts ASC`).all(r.run_id) as any[];
    for (const e of dbEvents) {
      const ev = rowToEvent(e);
      run.events.push(ev);
      sessionToRoot.set(ev.sessionId, r.run_id);
      if (ev.parentId) sessionToRoot.set(ev.sessionId, sessionToRoot.get(ev.parentId) ?? ev.parentId);
    }
    runs.push(run);
    if (!run.endedAt) activeRuns.set(run.runId, run);
  }
  // Seed recent events buffer
  const recent = db.query(`SELECT * FROM events ORDER BY ts DESC LIMIT ?`).all(MAX_EVENTS) as any[];
  for (const e of recent.reverse()) events.push(rowToEvent(e));
  console.log(`📦 Loaded ${runs.length} runs, ${events.length} recent events from DB`);
}

loadFromDB();

// ── Event ingestion ──────────────────────────────────────────────────────────

function recordInRun(ev: AgentEvent) {
  // Resolve root
  if (!ev.parentId) {
    sessionToRoot.set(ev.sessionId, ev.sessionId);
  } else {
    const parentRoot = sessionToRoot.get(ev.parentId) ?? ev.parentId;
    sessionToRoot.set(ev.sessionId, parentRoot);
  }
  const rootId = sessionToRoot.get(ev.sessionId) ?? ev.sessionId;

  let run = activeRuns.get(rootId);
  if (!run) {
    run = { runId: rootId, startedAt: ev.ts, events: [] };
    activeRuns.set(rootId, run);
    runs.push(run);
    persistRunStart(rootId, ev.ts);
    if (runs.length > MAX_RUNS) {
      runs.splice(0, runs.length - MAX_RUNS);
      pruneDB();
    }
  }

  run.events.push(ev);
  persistEvent(ev, rootId);

  if (ev.sessionId === rootId && (ev.type === "done" || ev.type === "error")) {
    run.endedAt = ev.ts;
    persistRunEnd(rootId, ev.ts);
    activeRuns.delete(rootId);
  }
}

function addEvent(ev: AgentEvent) {
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  recordInRun(ev);
  const payload = JSON.stringify(ev);
  for (const ws of wsClients) {
    try { ws.send(payload); } catch { wsClients.delete(ws); }
  }
}

// ── Agent registry ───────────────────────────────────────────────────────────

const AGENTS: Record<string, { name: string; role: string; emoji?: string }> = {
  pip:                { name: "Pip",    role: "Orchestrator",                       emoji: "🐉" },
  orchestrator:       { name: "Caden",  role: "Lead Orchestration Agent",            emoji: "🎯" },
  researcher:         { name: "Vesper", role: "Senior Research Agent",               emoji: "🔍" },
  writer:             { name: "Cassia", role: "Senior Content & Writing Agent",      emoji: "✍️" },
  architect:          { name: "Lorne",  role: "Principal Solutions Architect",       emoji: "🏗️" },
  "code-reviewer":    { name: "Piers",  role: "Senior Code Review Agent",            emoji: "👁️" },
  planner:            { name: "Orla",   role: "Senior Project Planning Agent",       emoji: "📋" },
  productmanager:     { name: "Senna",  role: "Senior Product Management Agent",     emoji: "📊" },
  "security-auditor": { name: "Vael",   role: "Senior Security Audit Agent",         emoji: "🛡️" },
};

function makeAgent(id: string) {
  const a = AGENTS[id] ?? { name: id, role: "Agent" };
  return { id, ...a };
}

function makeEvent(
  type: AgentEvent["type"],
  agentId: string,
  sessionId: string,
  opts: Partial<Pick<AgentEvent, "parentId" | "task" | "message">> = {}
): AgentEvent {
  return { id: randomUUID(), ts: Date.now(), type, sessionId, agent: makeAgent(agentId), ...opts };
}

// ── Demo scenarios ───────────────────────────────────────────────────────────

type Scenario =
  | "research-write" | "design-review" | "sprint-plan" | "security-audit"
  | "product-launch" | "incident-response";

async function runDemoSequential(scenario: Scenario) {
  const pipSid = "pip-" + randomUUID().slice(0, 8);
  addEvent(makeEvent("spawn", "pip", pipSid, { task: scenario }));

  const scenarios: Record<Scenario, () => Promise<void>> = {
    "research-write": async () => {
      const vesSid = "vesper-" + randomUUID().slice(0, 8);
      const casSid = "cassia-" + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "researcher", vesSid, { parentId: pipSid, task: "Research modern AI agent orchestration patterns" }));
      await sleep(1500);
      addEvent(makeEvent("working", "researcher", vesSid, { parentId: pipSid, message: "Gathering sources..." }));
      await sleep(2000);
      addEvent(makeEvent("spawn",   "writer",     casSid, { parentId: pipSid, task: "Draft a technical post on AI orchestration" }));
      await sleep(1000);
      addEvent(makeEvent("done",    "researcher", vesSid, { parentId: pipSid, message: "Found 12 relevant sources" }));
      await sleep(1500);
      addEvent(makeEvent("working", "writer",     casSid, { parentId: pipSid, message: "Drafting post..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "writer",     casSid, { parentId: pipSid, message: "Post ready for review" }));
      addEvent(makeEvent("done",    "pip",        pipSid, { message: "Research & write complete" }));
    },
    "design-review": async () => {
      const lorSid  = "lorne-" + randomUUID().slice(0, 8);
      const pierSid = "piers-" + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "architect",     lorSid,  { parentId: pipSid, task: "Design REST API for event ingestion service" }));
      await sleep(2000);
      addEvent(makeEvent("working", "architect",     lorSid,  { parentId: pipSid, message: "Sketching endpoint structure..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "architect",     lorSid,  { parentId: pipSid, message: "API design complete" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "code-reviewer", pierSid, { parentId: pipSid, task: "Review Lorne's API design" }));
      await sleep(2000);
      addEvent(makeEvent("working", "code-reviewer", pierSid, { parentId: pipSid, message: "Reviewing for consistency and edge cases..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "code-reviewer", pierSid, { parentId: pipSid, message: "Review complete, 2 suggestions" }));
      addEvent(makeEvent("done",    "pip",           pipSid,  { message: "Design review complete" }));
    },
    "sprint-plan": async () => {
      const cadSid  = "caden-" + randomUUID().slice(0, 8);
      const senSid  = "senna-" + randomUUID().slice(0, 8);
      const orlaSid = "orla-"  + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "orchestrator",   cadSid,  { parentId: pipSid, task: "Coordinate sprint planning for Q2" }));
      await sleep(1200);
      addEvent(makeEvent("spawn",   "productmanager", senSid,  { parentId: cadSid, task: "Define product requirements for Q2 sprint" }));
      await sleep(2000);
      addEvent(makeEvent("working", "productmanager", senSid,  { parentId: cadSid, message: "Gathering stakeholder input..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "productmanager", senSid,  { parentId: cadSid, message: "Requirements defined: 8 user stories" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "planner",        orlaSid, { parentId: cadSid, task: "Break requirements into sprint tasks" }));
      await sleep(2000);
      addEvent(makeEvent("working", "planner",        orlaSid, { parentId: cadSid, message: "Estimating and scheduling..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "planner",        orlaSid, { parentId: cadSid, message: "Sprint plan ready: 24 tasks, 2 weeks" }));
      addEvent(makeEvent("done",    "orchestrator",   cadSid,  { parentId: pipSid, message: "Sprint plan delivered" }));
      addEvent(makeEvent("done",    "pip",            pipSid,  { message: "Sprint planning complete" }));
    },
    "security-audit": async () => {
      const cadSid  = "caden-" + randomUUID().slice(0, 8);
      const vaelSid = "vael-"  + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "orchestrator",     cadSid,  { parentId: pipSid, task: "Run security audit on auth service" }));
      await sleep(1200);
      addEvent(makeEvent("spawn",   "security-auditor", vaelSid, { parentId: cadSid, task: "Audit authentication service for vulnerabilities" }));
      await sleep(2000);
      addEvent(makeEvent("working", "security-auditor", vaelSid, { parentId: cadSid, message: "Scanning codebase..." }));
      await sleep(2500);
      addEvent(makeEvent("working", "security-auditor", vaelSid, { parentId: cadSid, message: "Checking OWASP top 10..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "security-auditor", vaelSid, { parentId: cadSid, message: "Audit complete: 1 high, 3 medium findings" }));
      await sleep(1000);
      addEvent(makeEvent("done",    "orchestrator",     cadSid,  { parentId: pipSid, message: "Audit report compiled" }));
      addEvent(makeEvent("done",    "pip",              pipSid,  { message: "Security audit complete" }));
    },
    "product-launch": async () => {
      const cadSid  = "caden-"  + randomUUID().slice(0, 8);
      const vesSid  = "vesper-" + randomUUID().slice(0, 8);
      const senSid  = "senna-"  + randomUUID().slice(0, 8);
      const lorSid  = "lorne-"  + randomUUID().slice(0, 8);
      const casSid  = "cassia-" + randomUUID().slice(0, 8);
      const vaelSid = "vael-"   + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "orchestrator",   cadSid, { parentId: pipSid, task: "Coordinate full product launch for v2.0" }));
      await sleep(1000);
      addEvent(makeEvent("spawn",   "researcher",     vesSid, { parentId: cadSid, task: "Research competitor landscape for v2.0 launch" }));
      addEvent(makeEvent("spawn",   "productmanager", senSid, { parentId: cadSid, task: "Draft go-to-market strategy" }));
      await sleep(1500);
      addEvent(makeEvent("working", "researcher",     vesSid, { parentId: cadSid, message: "Analysing 8 competitors..." }));
      addEvent(makeEvent("working", "productmanager", senSid, { parentId: cadSid, message: "Defining ICP and positioning..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "researcher",     vesSid, { parentId: cadSid, message: "Competitor report ready" }));
      await sleep(1000);
      addEvent(makeEvent("done",    "productmanager", senSid, { parentId: cadSid, message: "GTM strategy drafted" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "architect",        lorSid,  { parentId: cadSid, task: "Design infrastructure for v2.0 scale targets" }));
      addEvent(makeEvent("spawn",   "security-auditor", vaelSid, { parentId: cadSid, task: "Pre-launch security review" }));
      await sleep(1500);
      addEvent(makeEvent("working", "architect",        lorSid,  { parentId: cadSid, message: "Sizing for 10× current load..." }));
      addEvent(makeEvent("working", "security-auditor", vaelSid, { parentId: cadSid, message: "Reviewing auth flows and data handling..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "architect",        lorSid,  { parentId: cadSid, message: "Infra plan approved" }));
      await sleep(500);
      addEvent(makeEvent("done",    "security-auditor", vaelSid, { parentId: cadSid, message: "All clear — 0 blockers" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "writer",  casSid, { parentId: cadSid, task: "Write launch announcement, blog post, and email" }));
      await sleep(1500);
      addEvent(makeEvent("working", "writer",  casSid, { parentId: cadSid, message: "Drafting announcement copy..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "writer",  casSid, { parentId: cadSid, message: "All launch content ready for review" }));
      await sleep(800);
      addEvent(makeEvent("done",    "orchestrator", cadSid, { parentId: pipSid, message: "Launch pack complete — 6 agents, all green" }));
      addEvent(makeEvent("done",    "pip",          pipSid, { message: "Product launch pipeline complete" }));
    },
    "incident-response": async () => {
      const cadSid  = "caden-"  + randomUUID().slice(0, 8);
      const vaelSid = "vael-"   + randomUUID().slice(0, 8);
      const lorSid  = "lorne-"  + randomUUID().slice(0, 8);
      const pierSid = "piers-"  + randomUUID().slice(0, 8);
      const orlaSid = "orla-"   + randomUUID().slice(0, 8);
      const casSid  = "cassia-" + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "orchestrator", cadSid, { parentId: pipSid, task: "Coordinate P1 incident response — API latency spike" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "security-auditor", vaelSid, { parentId: cadSid, task: "Rule out security breach — check access logs" }));
      addEvent(makeEvent("spawn",   "architect",        lorSid,  { parentId: cadSid, task: "Diagnose infrastructure root cause" }));
      await sleep(1000);
      addEvent(makeEvent("working", "security-auditor", vaelSid, { parentId: cadSid, message: "Scanning access logs for anomalies..." }));
      addEvent(makeEvent("working", "architect",        lorSid,  { parentId: cadSid, message: "Checking DB query times, CPU, memory..." }));
      await sleep(2000);
      addEvent(makeEvent("done",    "security-auditor", vaelSid, { parentId: cadSid, message: "No breach detected — clean" }));
      await sleep(800);
      addEvent(makeEvent("working", "architect",        lorSid,  { parentId: cadSid, message: "Found it: N+1 query after deploy #447" }));
      await sleep(1500);
      addEvent(makeEvent("done",    "architect",        lorSid,  { parentId: cadSid, message: "Root cause confirmed: missing index on events.session_id" }));
      await sleep(600);
      addEvent(makeEvent("spawn",   "code-reviewer", pierSid, { parentId: cadSid, task: "Review hotfix: add index on events.session_id" }));
      await sleep(1500);
      addEvent(makeEvent("working", "code-reviewer", pierSid, { parentId: cadSid, message: "Checking migration for side effects..." }));
      await sleep(2000);
      addEvent(makeEvent("done",    "code-reviewer", pierSid, { parentId: cadSid, message: "Hotfix approved — safe to deploy" }));
      await sleep(600);
      addEvent(makeEvent("spawn",   "planner", orlaSid, { parentId: cadSid, task: "Draft incident timeline and action items" }));
      addEvent(makeEvent("spawn",   "writer",  casSid,  { parentId: cadSid, task: "Write customer-facing status page update" }));
      await sleep(1500);
      addEvent(makeEvent("working", "planner", orlaSid, { parentId: cadSid, message: "Reconstructing timeline from logs..." }));
      addEvent(makeEvent("working", "writer",  casSid,  { parentId: cadSid, message: "Drafting status update..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "writer",  casSid,  { parentId: cadSid, message: "Status update posted" }));
      await sleep(500);
      addEvent(makeEvent("done",    "planner", orlaSid, { parentId: cadSid, message: "Post-mortem doc ready: 3 action items" }));
      await sleep(800);
      addEvent(makeEvent("done",    "orchestrator", cadSid, { parentId: pipSid, message: "Incident resolved — MTTR 18 min" }));
      addEvent(makeEvent("done",    "pip",          pipSid, { message: "Incident response complete" }));
    },
  };

  await scenarios[scenario]();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Elysia app ───────────────────────────────────────────────────────────────

const app = new Elysia()
  .use(staticPlugin({ assets: "src/public", prefix: "/" }))
  .get("/api/events", () => ({ events }))
  .get("/api/runs",   () => ({ runs }))
  .post(
    "/api/event",
    ({ body }) => {
      const ev = body as AgentEvent;
      if (!ev.id) ev.id = randomUUID();
      if (!ev.ts) ev.ts = Date.now();
      addEvent(ev);
      return { ok: true };
    },
    { body: t.Any() }
  )
  .post(
    "/api/demo",
    ({ body }) => {
      const { scenario } = body as { scenario: Scenario };
      const valid: Scenario[] = [
        "research-write", "design-review", "sprint-plan", "security-audit",
        "product-launch", "incident-response",
      ];
      if (!valid.includes(scenario)) return { error: "unknown scenario" };
      runDemoSequential(scenario).catch(console.error);
      return { ok: true, scenario };
    },
    { body: t.Object({ scenario: t.String() }) }
  )
  .ws("/ws", {
    open(ws)  { wsClients.add(ws);    console.log(`WS connect    (total: ${wsClients.size})`); },
    close(ws) { wsClients.delete(ws); console.log(`WS disconnect (total: ${wsClients.size})`); },
    message(_ws, _msg) {},
  })
  .listen(PORT);

console.log(`🐉 Agent Swarm Dashboard listening on http://localhost:${PORT} (MAX_RUNS=${MAX_RUNS}, DB=${DB_PATH})`);
