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
  researcher:         { name: "Vesper", role: "Senior Research Agent",               emoji: "🔬" },
  writer:             { name: "Cassia", role: "Senior Content & Writing Agent",      emoji: "📝" },
  architect:          { name: "Lorne",  role: "Principal Solutions Architect",       emoji: "🏗️" },
  "code-reviewer":    { name: "Piers",  role: "Senior Code Review Agent",            emoji: "👀" },
  planner:            { name: "Orla",   role: "Senior Project Planning Agent",       emoji: "📋" },
  productmanager:     { name: "Senna",  role: "Senior Product Management Agent",     emoji: "🎯" },
  "security-auditor": { name: "Vael",   role: "Senior Security Audit Agent",         emoji: "🛡️" },
  // New agents for scenarios
  triage:             { name: "Dara",   role: "Triage Lead",                         emoji: "🛡️" },
  analyst:            { name: "Cael",   role: "Root Cause Analyst",                  emoji: "🔍" },
  deployer:           { name: "Bex",    role: "Hotfix Deployer",                     emoji: "⚡" },
  marketresearcher:   { name: "Vesper", role: "Market Researcher",                   emoji: "🔬" },
  datainsights:       { name: "Maren",  role: "Data Insights Analyst",               emoji: "📊" },
  strategist:         { name: "Senna",  role: "Product Strategist",                  emoji: "🎯" },
  contentlead:        { name: "Cassia", role: "Content Lead",                        emoji: "✍️" },
  launchcoordinator:  { name: "Cleo",   role: "Launch Coordinator",                    emoji: "🚀" },
  positioning:        { name: "Cleo",   role: "Positioning Strategist",              emoji: "📣" },
  backupanalyst:      { name: "Vesper", role: "Backup Analyst",                      emoji: "🔬" },
  verifier:           { name: "Cassia", role: "Verifier",                            emoji: "✍️" },
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
  | "the-3am-problem" | "from-brief-to-launch" | "strategic-brief" | "error-recovery";

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
    "from-brief-to-launch": async () => {
      const senSid  = "senna-"  + randomUUID().slice(0, 8);
      const vesSid  = "vesper-" + randomUUID().slice(0, 8);
      const lorSid  = "lorne-"  + randomUUID().slice(0, 8);
      const pierSid = "piers-"  + randomUUID().slice(0, 8);
      const casSid  = "cassia-" + randomUUID().slice(0, 8);
      const cleoSid = "cleo-"   + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "productmanager", senSid, { parentId: pipSid, task: "Define product requirements from strategic brief" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "researcher",     vesSid, { parentId: senSid, task: "Competitive analysis and market sizing" }));
      await sleep(1500);
      addEvent(makeEvent("working", "productmanager", senSid, { parentId: pipSid, message: "Scoping features from brief..." }));
      addEvent(makeEvent("working", "researcher",     vesSid, { parentId: senSid, message: "Analysing 6 competitors..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "productmanager", senSid, { parentId: pipSid, message: "PRD complete: 12 user stories" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "architect",     lorSid,  { parentId: senSid, task: "Design architecture for launch" }));
      addEvent(makeEvent("spawn",   "code-reviewer", pierSid, { parentId: senSid, task: "Security review for launch" }));
      await sleep(1500);
      addEvent(makeEvent("working", "architect",     lorSid,  { parentId: senSid, message: "Sizing infrastructure..." }));
      addEvent(makeEvent("working", "code-reviewer", pierSid, { parentId: senSid, message: "Threat modeling..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "researcher",    vesSid,  { parentId: senSid, message: "Market report: $2.4M TAM identified" }));
      await sleep(500);
      addEvent(makeEvent("done",    "architect",     lorSid,  { parentId: senSid, message: "Architecture approved" }));
      await sleep(500);
      addEvent(makeEvent("done",    "code-reviewer", pierSid, { parentId: senSid, message: "Security review passed" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "writer",       casSid,  { parentId: senSid, task: "Write launch copy and positioning" }));
      await sleep(1500);
      addEvent(makeEvent("working", "writer",       casSid,  { parentId: senSid, message: "Drafting messaging..." }));
      await sleep(2000);
      addEvent(makeEvent("done",    "writer",       casSid,  { parentId: senSid, message: "Launch copy ready" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "launchcoordinator", cleoSid, { parentId: pipSid, task: "Coordinate final launch" }));
      await sleep(1200);
      addEvent(makeEvent("done",    "launchcoordinator", cleoSid, { parentId: pipSid, message: "Launch sequence complete — live in 3, 2, 1..." }));
      addEvent(makeEvent("done",    "pip",               pipSid,  { message: "From brief to launch: complete" }));
    },
    "the-3am-problem": async () => {
      const pipSid  = "pip-"  + randomUUID().slice(0, 8);
      const darSid  = "dara-" + randomUUID().slice(0, 8);
      const caelSid = "cael-" + randomUUID().slice(0, 8);
      const vaelSid = "vael-" + randomUUID().slice(0, 8);
      const casSid  = "cassia-" + randomUUID().slice(0, 8);
      const bexSid  = "bex-"  + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "pip",    pipSid, { task: "Incident Commander — 3am production outage" }));
      await sleep(800);
      addEvent(makeEvent("message", "pip",    pipSid, { message: "🚨 P1 alert — payment service latency >5s" }));
      await sleep(500);
      addEvent(makeEvent("spawn",   "triage", darSid, { parentId: pipSid, task: "Assess severity and customer impact" }));
      await sleep(1200);
      addEvent(makeEvent("working", "triage", darSid, { parentId: pipSid, message: "Checking error rates..." }));
      await sleep(1500);
      addEvent(makeEvent("done",    "triage", darSid, { parentId: pipSid, message: "Confirmed: 12% checkout failures, revenue at risk" }));
      await sleep(600);
      addEvent(makeEvent("spawn",   "analyst", caelSid, { parentId: pipSid, task: "Find root cause" }));
      addEvent(makeEvent("spawn",   "security-auditor", vaelSid, { parentId: pipSid, task: "Check for security exploit" }));
      await sleep(1500);
      addEvent(makeEvent("working", "analyst", caelSid, { parentId: pipSid, message: "Correlating deploy timeline..." }));
      addEvent(makeEvent("working", "security-auditor", vaelSid, { parentId: pipSid, message: "Scanning access logs..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "security-auditor", vaelSid, { parentId: pipSid, message: "No exploit — clean" }));
      await sleep(500);
      addEvent(makeEvent("working", "analyst", caelSid, { parentId: pipSid, message: "Found it — commit #447 introduced N+1 query" }));
      await sleep(1500);
      addEvent(makeEvent("done",    "analyst", caelSid, { parentId: pipSid, message: "Root cause: missing index on orders.user_id" }));
      await sleep(600);
      addEvent(makeEvent("spawn",   "writer", casSid, { parentId: pipSid, task: "Draft status page update" }));
      await sleep(1200);
      addEvent(makeEvent("working", "writer", casSid, { parentId: pipSid, message: "Writing customer communication..." }));
      await sleep(2000);
      addEvent(makeEvent("done",    "writer", casSid, { parentId: pipSid, message: "Status page updated — all customers notified" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "deployer", bexSid, { parentId: pipSid, task: "Deploy hotfix to production" }));
      await sleep(1500);
      addEvent(makeEvent("working", "deployer", bexSid, { parentId: pipSid, message: "Running migrations..." }));
      await sleep(2000);
      addEvent(makeEvent("done",    "deployer", bexSid, { parentId: pipSid, message: "Hotfix deployed — latency <200ms" }));
      await sleep(600);
      addEvent(makeEvent("done",    "pip", pipSid, { message: "Incident resolved — MTTR 14 minutes" }));
    },
    "strategic-brief": async () => {
      const vesSid = "vesper-" + randomUUID().slice(0, 8);
      const marSid = "maren-"  + randomUUID().slice(0, 8);
      const senSid = "senna-"  + randomUUID().slice(0, 8);
      const lorSid = "lorne-"  + randomUUID().slice(0, 8);
      const cleoSid = "cleo-"  + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn",   "researcher", vesSid, { parentId: pipSid, task: "Market entry analysis — AI ops sector" }));
      await sleep(1000);
      addEvent(makeEvent("spawn",   "datainsights", marSid, { parentId: vesSid, task: "Competitive intelligence data" }));
      await sleep(1500);
      addEvent(makeEvent("working", "researcher",   vesSid, { parentId: vesSid, message: "Sizing TAM and growth rates..." }));
      addEvent(makeEvent("working", "datainsights", marSid, { parentId: vesSid, message: "Analysing competitor pricing..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "datainsights", marSid, { parentId: vesSid, message: "Competitor analysis complete: 7 players mapped" }));
      await sleep(800);
      addEvent(makeEvent("done",    "researcher",   vesSid, { parentId: vesSid, message: "Market sizing: $4.2B TAM, 34% CAGR" }));
      await sleep(600);
      addEvent(makeEvent("spawn",   "strategist", senSid, { parentId: pipSid, task: "Define market entry strategy" }));
      await sleep(1200);
      addEvent(makeEvent("working", "strategist", senSid, { parentId: pipSid, message: "Identifying whitespace opportunities..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "strategist", senSid, { parentId: pipSid, message: "Entry point identified: mid-market underserved" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "architect", lorSid, { parentId: senSid, task: "Capability gap analysis" }));
      await sleep(1500);
      addEvent(makeEvent("working", "architect", lorSid, { parentId: senSid, message: "Mapping build vs buy decisions..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "architect", lorSid, { parentId: senSid, message: "Capability roadmap defined: 3 phases" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "positioning", cleoSid, { parentId: pipSid, task: "Develop positioning and messaging" }));
      await sleep(1500);
      addEvent(makeEvent("working", "positioning", cleoSid, { parentId: pipSid, message: "Crafting value proposition..." }));
      await sleep(2500);
      addEvent(makeEvent("done",    "positioning", cleoSid, { parentId: pipSid, message: "Positioning: 'AI operations for teams that ship'" }));
      addEvent(makeEvent("done",    "pip",         pipSid,  { message: "Strategic brief complete — market entry plan ready" }));
    },
    "error-recovery": async () => {
      const caelSid   = "cael-"   + randomUUID().slice(0, 8);
      const pip2Sid   = "pip2-"   + randomUUID().slice(0, 8);
      const vesSid    = "vesper-" + randomUUID().slice(0, 8);
      const cassSid   = "cassia-" + randomUUID().slice(0, 8);
      addEvent(makeEvent("spawn", "analyst", caelSid, { parentId: pipSid, task: "Primary analysis — market sentiment" }));
      await sleep(1500);
      addEvent(makeEvent("working", "analyst", caelSid, { parentId: pipSid, message: "Processing 50k social mentions..." }));
      await sleep(2500);
      addEvent(makeEvent("error",   "analyst", caelSid, { parentId: pipSid, message: "Analysis pipeline failed — rate limit exceeded" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "pip", pip2Sid, { parentId: pipSid, task: "Orchestrator — detecting failure" }));
      await sleep(600);
      addEvent(makeEvent("message", "pip", pip2Sid, { parentId: pipSid, message: "⚠️ Cael failed — re-routing to backup" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "backupanalyst", vesSid, { parentId: pip2Sid, task: "Backup analysis — complete the task" }));
      await sleep(1500);
      addEvent(makeEvent("working", "backupanalyst", vesSid, { parentId: pip2Sid, message: "Processing with distributed workers..." }));
      await sleep(3000);
      addEvent(makeEvent("done",    "backupanalyst", vesSid, { parentId: pip2Sid, message: "Analysis complete — sentiment: 78% positive" }));
      await sleep(800);
      addEvent(makeEvent("spawn",   "verifier", cassSid, { parentId: pip2Sid, task: "Verify backup results" }));
      await sleep(1500);
      addEvent(makeEvent("working", "verifier", cassSid, { parentId: pip2Sid, message: "Cross-checking sample..." }));
      await sleep(2000);
      addEvent(makeEvent("done",    "verifier", cassSid, { parentId: pip2Sid, message: "Verified: results match expected patterns" }));
      addEvent(makeEvent("done",    "pip", pip2Sid, { parentId: pipSid, message: "Fault tolerance demonstrated — 0 data loss" }));
      addEvent(makeEvent("done",    "pip", pipSid,  { message: "Error recovery complete" }));
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
    ({ body, set }) => {
      const ev = body as AgentEvent;
      if (!ev.type || typeof ev.type !== "string") {
        console.warn("[/api/event] rejected: missing or invalid 'type' field", body);
        set.status = 400;
        return { error: "field 'type' is required and must be a string" };
      }
      if (!ev.sessionId || typeof ev.sessionId !== "string") {
        console.warn("[/api/event] rejected: missing or invalid 'sessionId' field", body);
        set.status = 400;
        return { error: "field 'sessionId' is required and must be a string" };
      }
      if (!ev.agent || typeof ev.agent !== "object" || typeof ev.agent.id !== "string") {
        console.warn("[/api/event] rejected: missing or invalid 'agent' field", body);
        set.status = 400;
        return { error: "field 'agent' is required and must be an object with an 'id' string" };
      }
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
        "from-brief-to-launch", "the-3am-problem", "strategic-brief", "error-recovery",
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

console.log(`🐉 AI Ops Centre listening on http://localhost:${PORT} (MAX_RUNS=${MAX_RUNS}, DB=${DB_PATH})`);
