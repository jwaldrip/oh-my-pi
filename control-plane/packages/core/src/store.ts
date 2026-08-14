/**
 * SQLite-backed store. The daemon is the only writer.
 *
 * `updates` exists rather than forwarding events straight to clients because a
 * phone that drops mid-turn must reattach with `sinceSeq` and replay the gap.
 * Without persistence, a lost connection means a lost turn.
 */

import { Database } from "bun:sqlite";
import { redact, redactString } from "./redact.ts";
import type {
  Agent,
  AgentId,
  AgentState,
  ApprovalRecord,
  AuditAction,
  AuditEntry,
  CollabVoiceNoteFrame,
  CollabVoiceNoteMetadata,
  CollabVoiceParticipant,
  Device,
  Routine,
  Run,
  Task,
  TaskState,
} from "./contracts.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
  acp_session_id TEXT, host TEXT NOT NULL, cwd TEXT NOT NULL,
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL,
  routine_id TEXT, parent_agent_id TEXT, task_title TEXT, model TEXT,
  metrics TEXT, labels TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS updates (
  agent_id TEXT NOT NULL, seq INTEGER NOT NULL,
  ts TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);

CREATE TABLE IF NOT EXISTS approvals (
  request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool TEXT NOT NULL,
  title TEXT NOT NULL, input TEXT NOT NULL, decision TEXT, scope TEXT,
  rule TEXT, actor_device_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL,
  scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
);

-- Issued bearer tokens. Only the SHA-256 hash is ever written, so a stolen
-- database yields nothing presentable. Persisted rather than held in memory
-- because a pairing a daemon restart silently dissolved is not a pairing:
-- every paired phone would be logged out by an upgrade, with no operator
-- action behind it and nothing in the audit log to explain it.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  label TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_tokens_hash ON auth_tokens(token_hash);
CREATE INDEX IF NOT EXISTS auth_tokens_device ON auth_tokens(device_id);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL,
  trigger_json TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
  host TEXT NOT NULL, singleton INTEGER NOT NULL DEFAULT 1,
  timeout_seconds INTEGER, labels TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);

-- A webhook trigger refers to this row by its stable secretRef. The value
-- presented to the public route is never persisted, only its SHA-256 hash.
CREATE TABLE IF NOT EXISTS webhook_secrets (
  secret_ref TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, created_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, agent_id TEXT, state TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, summary TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS runs_routine ON runs(routine_id, started_at DESC);

-- One row per named unit of work started from a sidebar. agent_id points at
-- an existing agents row; a task never provisions a host of its own, so this
-- table has no host/cwd columns to go stale when a session moves.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
  skill_name TEXT, agent_id TEXT NOT NULL, state TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  result TEXT, labels TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);

-- Every OMP session ever written to ~/.omp/agent/sessions/, keyed by the
-- session uuid parsed from its jsonl filename -- deliberately not by
-- agent_id, since most sessions on a real machine were never touched by
-- ompd. Archiving is the one durable fact about a session this store owns:
-- everything else (cwd, title, counts, liveness) is derived fresh from the
-- filesystem on every query, so it cannot go stale under an operator's feet.
-- Archiving must survive a restart and must never delete a session file.
CREATE TABLE IF NOT EXISTS session_archive (
  session_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL
);

-- A cache, not durable state: safe to delete wholesale at any time, in which
-- case the next index build simply recomputes every row and repopulates it.
-- Keyed by (mtime,size) rather than just session_id so a session appended to
-- since the last build invalidates its own row automatically -- a growing
-- file changes both halves of the key.
CREATE TABLE IF NOT EXISTS session_scan_cache (
  session_id TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL, message_count INTEGER NOT NULL
);

-- A voice note is transcript material. Its metadata is queryable separately,
-- while the PCM payload is committed with it so a reconnect can replay the
-- actual note rather than a dead "audio happened" placeholder.
CREATE TABLE IF NOT EXISTS collab_voice_notes (
  room_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  note_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_kind TEXT NOT NULL,
  participant_name TEXT,
  created_at TEXT NOT NULL,
  duration_ms INTEGER,
  encoding TEXT NOT NULL,
  sample_rate_hz INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  audio_pcm TEXT NOT NULL,
  PRIMARY KEY (room_id, sequence),
  UNIQUE (room_id, note_id)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, action TEXT NOT NULL,
  actor_device_id TEXT, agent_id TEXT, detail TEXT NOT NULL, outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);
`;

interface AgentRow {
  id: string;
  name: string;
  state: string;
  acp_session_id: string | null;
  host: string;
  cwd: string;
  created_at: string;
  last_active_at: string;
  routine_id: string | null;
  parent_agent_id: string | null;
  task_title: string | null;
  model: string | null;
  metrics: string | null;
  labels: string;
}

interface WebhookSecretRow {
  secret_ref: string;
  secret_hash: string;
  created_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  skill_name: string | null;
  agent_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  result: string | null;
  labels: string;
}

export interface UpdateRecord {
  seq: number;
  ts: string;
  payload: unknown;
}

export interface OpenApprovalInput {
  requestId: string;
  agentId: AgentId;
  tool: string;
  title: string;
  input: unknown;
}

export interface AuditInput {
  action: AuditAction;
  actorDeviceId?: string | null;
  agentId?: AgentId;
  detail?: Record<string, unknown>;
  outcome: "ok" | "denied" | "error";
}

/** A cached message count, valid only while the file's mtime and size match what produced it. */
export interface SessionScanCacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  messageCount: number;
}

/** Voice content and identity to commit atomically before a room broadcast. */
export interface PersistCollabVoiceNoteInput {
  roomId: string;
  noteId: string;
  participant: CollabVoiceParticipant;
  audio: CollabVoiceNoteFrame["audio"];
  durationMs?: number;
}

export interface PersistedCollabVoiceNote {
  frame: CollabVoiceNoteFrame;
  metadata: CollabVoiceNoteMetadata;
  /** False when this `noteId` was already committed for the room. */
  inserted: boolean;
}

/**
 * One issued bearer token, identified by its hash.
 *
 * `id` is opaque and safe to log, print, and pass over the wire; `tokenHash`
 * is the only thing that ties a row to a credential, and it is a one-way
 * function of a value this process saw once.
 */
export interface AuthTokenRecord {
  id: string;
  deviceId: string;
  /** SHA-256 hex of the raw token. The raw token is never written. */
  tokenHash: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface AddAuthTokenInput {
  id: string;
  deviceId: string;
  tokenHash: string;
  /** Free text for an operator listing credentials, e.g. "local operator". */
  label?: string;
}

/** A per-routine webhook credential, retained only as a SHA-256 hash. */
export interface WebhookSecretRecord {
  secretRef: string;
  secretHash: string;
  createdAt: string;
}

export class Store {
  #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true });
    this.#db.run(SCHEMA);
    this.#migrateAgentHubMetadata();
  }

  close(): void {
    this.#db.close();
  }

  // -- agents --------------------------------------------------------------

  /**
   * SQLite does not extend an existing table when its CREATE statement gains a
   * column. Keep the migration here, beside the schema it brings forward, so
   * an existing daemon database carries its live agent tree through upgrade.
   */
  #migrateAgentHubMetadata(): void {
    const columns = new Set(
      (this.#db.query("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    for (const [name, type] of [
      ["parent_agent_id", "TEXT"],
      ["task_title", "TEXT"],
      ["model", "TEXT"],
      ["metrics", "TEXT"],
    ] as const) {
      if (!columns.has(name)) this.#db.run(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
    }
  }

  upsertAgent(a: Agent): void {
    this.#db
      .query(
        `INSERT INTO agents (id,name,state,acp_session_id,host,cwd,created_at,last_active_at,routine_id,parent_agent_id,task_title,model,metrics,labels)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, state=excluded.state, acp_session_id=excluded.acp_session_id,
           host=excluded.host, cwd=excluded.cwd, last_active_at=excluded.last_active_at,
           routine_id=excluded.routine_id, parent_agent_id=excluded.parent_agent_id,
           task_title=excluded.task_title, model=excluded.model, metrics=excluded.metrics,
           labels=excluded.labels`,
      )
      .run(
        a.id,
        a.name,
        a.state,
        a.acpSessionId ?? null,
        JSON.stringify(a.host),
        a.cwd,
        a.createdAt,
        a.lastActiveAt,
        a.routineId ?? null,
        a.parentAgentId ?? null,
        a.taskTitle ?? null,
        a.model ?? null,
        a.metrics === undefined ? null : JSON.stringify(a.metrics),
        JSON.stringify(a.labels),
      );
  }

  setAgentState(id: AgentId, state: AgentState): void {
    this.#db
      .query(`UPDATE agents SET state=?, last_active_at=? WHERE id=?`)
      .run(state, new Date().toISOString(), id);
  }

  getAgent(id: AgentId): Agent | null {
    const row = this.#db.query(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | null;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.#db
      .query(`SELECT * FROM agents ORDER BY last_active_at DESC`)
      .all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  // -- updates -------------------------------------------------------------

  /** Append an update and return its assigned sequence number. */
  appendUpdate(agentId: AgentId, payload: unknown): number {
    const row = this.#db
      .query(`SELECT COALESCE(MAX(seq),0)+1 AS next FROM updates WHERE agent_id=?`)
      .get(agentId) as { next: number };
    this.#db
      .query(`INSERT INTO updates (agent_id,seq,ts,payload) VALUES (?,?,?,?)`)
      .run(agentId, row.next, new Date().toISOString(), JSON.stringify(redact(payload)));
    return row.next;
  }

  /** Replay everything after `sinceSeq`. This is what makes reattach lossless. */
  updatesSince(agentId: AgentId, sinceSeq: number, limit = 1000): UpdateRecord[] {
    const rows = this.#db
      .query(`SELECT seq,ts,payload FROM updates WHERE agent_id=? AND seq>? ORDER BY seq LIMIT ?`)
      .all(agentId, sinceSeq, limit) as Array<{ seq: number; ts: string; payload: string }>;
    return rows.map((r) => ({ seq: r.seq, ts: r.ts, payload: JSON.parse(r.payload) }));
  }

  // -- approvals -----------------------------------------------------------

  openApproval(rec: OpenApprovalInput): void {
    this.#db
      .query(
        // Deliberately not INSERT OR REPLACE: a replayed request id must never
        // overwrite an approval that already carries a decision.
        `INSERT INTO approvals (request_id,agent_id,tool,title,input,created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(request_id) DO NOTHING`,
      )
      .run(
        rec.requestId,
        rec.agentId,
        rec.tool,
        rec.title,
        JSON.stringify(redact(rec.input)),
        new Date().toISOString(),
      );
  }

  resolveApproval(
    requestId: string,
    decision: "allow" | "deny",
    scope: "once" | "always",
    rule: string,
    actorDeviceId: string | null,
  ): void {
    this.#db
      .query(
        // `decided_at IS NULL` makes the first decision final. Without it a
        // second `decide` frame could flip a recorded deny into an allow.
        `UPDATE approvals SET decision=?, scope=?, rule=?, actor_device_id=?, decided_at=?
         WHERE request_id=? AND decided_at IS NULL`,
      )
      .run(decision, scope, rule, actorDeviceId, new Date().toISOString(), requestId);
  }

  listApprovals(agentId?: AgentId): ApprovalRecord[] {
    const rows = (
      agentId
        ? this.#db
            .query(`SELECT * FROM approvals WHERE agent_id=? ORDER BY created_at DESC`)
            .all(agentId)
        : this.#db.query(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200`).all()
    ) as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      requestId: r.request_id as string,
      agentId: r.agent_id as string,
      tool: r.tool as string,
      title: r.title as string,
      input: JSON.parse(r.input as string),
      createdAt: r.created_at as string,
      decision: (r.decision ?? "deny") as "allow" | "deny",
      scope: (r.scope ?? "once") as "once" | "always",
      rule: r.rule ?? "",
      actorDeviceId: r.actor_device_id ?? null,
      decidedAt: r.decided_at ?? "",
    }));
  }

  // -- devices -------------------------------------------------------------

  addDevice(d: Device): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO devices (id,name,public_key,scopes,created_at,last_seen_at,revoked_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        d.id,
        d.name,
        d.publicKey,
        JSON.stringify(d.scopes),
        d.createdAt,
        d.lastSeenAt ?? null,
        d.revokedAt ?? null,
      );
  }

  getDevice(id: string): Device | null {
    const r = this.#db.query(`SELECT * FROM devices WHERE id=?`).get(id) as Record<
      string,
      string | null
    > | null;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      publicKey: r.public_key as string,
      scopes: JSON.parse(r.scopes as string),
      createdAt: r.created_at as string,
      lastSeenAt: r.last_seen_at ?? undefined,
      revokedAt: r.revoked_at ?? undefined,
    };
  }

  /**
   * Every device row, newest first, revoked ones included.
   *
   * Revoked rows are deliberately not filtered out. An operator listing
   * devices is auditing who has ever been let in, and a device that vanished
   * from the list on revocation would make the act of revoking unverifiable.
   */
  listDevices(): Device[] {
    const rows = this.#db
      .query(`SELECT * FROM devices ORDER BY created_at DESC`)
      .all() as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      publicKey: r.public_key as string,
      scopes: JSON.parse(r.scopes as string),
      createdAt: r.created_at as string,
      lastSeenAt: r.last_seen_at ?? undefined,
      revokedAt: r.revoked_at ?? undefined,
    }));
  }

  /**
   * Revoke a device and every credential issued to it, in one transaction.
   *
   * Transitive because tokens outlive the process now. A device row marked
   * revoked while its token rows stayed live would leave a credential that
   * only the device lookup refuses, and any future path that resolved a token
   * without re-reading the device would let it back in. Revoking the tokens
   * makes the refusal a property of the data rather than of one code path.
   */
  revokeDevice(id: string): void {
    const at = new Date().toISOString();
    this.#db.transaction(() => {
      this.#db.query(`UPDATE devices SET revoked_at=? WHERE id=?`).run(at, id);
      this.#db
        .query(`UPDATE auth_tokens SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL`)
        .run(at, id);
    })();
  }

  // -- auth tokens ---------------------------------------------------------

  addAuthToken(input: AddAuthTokenInput): AuthTokenRecord {
    const record: AuthTokenRecord = {
      id: input.id,
      deviceId: input.deviceId,
      tokenHash: input.tokenHash,
      createdAt: new Date().toISOString(),
    };
    if (input.label !== undefined) record.label = input.label;
    this.#db
      .query(
        `INSERT INTO auth_tokens (id,device_id,token_hash,label,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(record.id, record.deviceId, record.tokenHash, input.label ?? null, record.createdAt);
    return record;
  }

  /**
   * The row for a presented credential, revoked ones included.
   *
   * Revoked rows come back rather than reading as absent so the caller can
   * tell "never issued" from "issued and withdrawn". Both refuse the request;
   * only one of them is worth an audit line.
   */
  findAuthTokenByHash(tokenHash: string): AuthTokenRecord | null {
    const row = this.#db.query(`SELECT * FROM auth_tokens WHERE token_hash=?`).get(tokenHash) as
      | Record<string, string | null>
      | null;
    return row ? rowToAuthToken(row) : null;
  }

  listAuthTokens(deviceId?: string): AuthTokenRecord[] {
    const rows = (
      deviceId === undefined
        ? this.#db.query(`SELECT * FROM auth_tokens ORDER BY created_at DESC`).all()
        : this.#db
            .query(`SELECT * FROM auth_tokens WHERE device_id=? ORDER BY created_at DESC`)
            .all(deviceId)
    ) as Array<Record<string, string | null>>;
    return rows.map(rowToAuthToken);
  }

  /** Record that a credential was presented. Callers throttle this; see DeviceAuth. */
  touchAuthToken(id: string): void {
    this.#db
      .query(`UPDATE auth_tokens SET last_used_at=? WHERE id=?`)
      .run(new Date().toISOString(), id);
  }

  /**
   * Withdraw one credential. The first revocation stands: `revoked_at IS NULL`
   * keeps a second call from rewriting when it happened.
   */
  revokeAuthToken(id: string): void {
    this.#db
      .query(`UPDATE auth_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), id);
  }

  /** Withdraw every live credential a device holds. Returns how many there were. */
  revokeAuthTokensForDevice(deviceId: string): number {
    return this.#db
      .query(`UPDATE auth_tokens SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), deviceId).changes;
  }

  // -- routines and runs ---------------------------------------------------

  upsertRoutine(r: Routine): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO routines
         (id,name,enabled,trigger_json,prompt,cwd,host,singleton,timeout_seconds,labels,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.name,
        r.enabled ? 1 : 0,
        JSON.stringify(r.trigger),
        r.prompt,
        r.cwd,
        JSON.stringify(r.host),
        r.singleton ? 1 : 0,
        r.timeoutSeconds ?? null,
        JSON.stringify(r.labels),
        r.createdAt,
      );
  }

  listRoutines(): Routine[] {
    const rows = this.#db.query(`SELECT * FROM routines ORDER BY created_at`).all() as Array<
      Record<string, string | number | null>
    >;
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      enabled: r.enabled === 1,
      trigger: JSON.parse(r.trigger_json as string),
      prompt: r.prompt as string,
      cwd: r.cwd as string,
      host: JSON.parse(r.host as string),
      singleton: r.singleton === 1,
      timeoutSeconds: (r.timeout_seconds as number | null) ?? undefined,
      labels: JSON.parse((r.labels as string) ?? "{}"),
      createdAt: r.created_at as string,
    }));
  }

  /**
   * Replace the credential for a webhook trigger. `secretRef` belongs to the
   * routine definition, so rotating its value never changes the route.
   */
  upsertWebhookSecret(secretRef: string, secretHash: string): WebhookSecretRecord {
    const record: WebhookSecretRecord = {
      secretRef,
      secretHash,
      createdAt: new Date().toISOString(),
    };
    this.#db
      .query(
        `INSERT INTO webhook_secrets (secret_ref,secret_hash,created_at) VALUES (?,?,?)
         ON CONFLICT(secret_ref) DO UPDATE SET secret_hash=excluded.secret_hash, created_at=excluded.created_at`,
      )
      .run(record.secretRef, record.secretHash, record.createdAt);
    return record;
  }

  /** Null means this webhook has never had a credential minted. */
  getWebhookSecret(secretRef: string): WebhookSecretRecord | null {
    const row = this.#db
      .query(`SELECT secret_ref,secret_hash,created_at FROM webhook_secrets WHERE secret_ref=?`)
      .get(secretRef) as WebhookSecretRow | null;
    if (!row) return null;
    return {
      secretRef: row.secret_ref,
      secretHash: row.secret_hash,
      createdAt: row.created_at,
    };
  }

  upsertRun(run: Run): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO runs (id,routine_id,agent_id,state,started_at,finished_at,summary,error)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.routineId,
        run.agentId ?? null,
        run.state,
        run.startedAt,
        run.finishedAt ?? null,
        run.summary ?? null,
        run.error ?? null,
      );
  }

  hasActiveRun(routineId: string): boolean {
    const r = this.#db
      .query(`SELECT COUNT(*) AS n FROM runs WHERE routine_id=? AND state IN ('queued','running')`)
      .get(routineId) as { n: number };
    return r.n > 0;
  }

  /**
   * Force every mid-flight run terminal, and report how many there were.
   *
   * A run row is written `running` before its turn starts, and the scheduler's
   * own teardown is what settles it. A process that was killed never ran that
   * teardown, so the row survives the daemon and keeps `hasActiveRun` true,
   * which silences a singleton routine for good. Reconciling at startup is
   * deterministic because nothing can be in flight before the scheduler is
   * armed, where a timer sweeping for stale rows would have to guess.
   *
   * An error the run already recorded is kept: why it actually failed beats
   * why nobody settled it.
   */
  failInterruptedRuns(error: string): number {
    return this.#db
      .query(
        `UPDATE runs SET state='failed', finished_at=COALESCE(finished_at,?), error=COALESCE(error,?)
         WHERE state IN ('queued','running')`,
      )
      .run(new Date().toISOString(), error).changes;
  }

  listRuns(routineId: string, limit = 50): Run[] {
    const rows = this.#db
      .query(`SELECT * FROM runs WHERE routine_id=? ORDER BY started_at DESC LIMIT ?`)
      .all(routineId, limit) as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: r.id as string,
      routineId: r.routine_id as string,
      agentId: r.agent_id ?? undefined,
      state: r.state as Run["state"],
      startedAt: r.started_at as string,
      finishedAt: r.finished_at ?? undefined,
      summary: r.summary ?? undefined,
      error: r.error ?? undefined,
    }));
  }

  // -- tasks -----------------------------------------------------------------

  /**
   * `prompt` and `title` pass through `redactString`, the same defence
   * `updates`/`approvals`/`audit` apply to arbitrary text: it only replaces
   * recognisable secret shapes, so an ordinary prompt is untouched, and a
   * pasted credential does not sit in the database in the clear.
   */
  createTask(t: Task): void {
    this.#db
      .query(
        `INSERT INTO tasks (id,title,prompt,skill_name,agent_id,state,created_at,updated_at,result,labels)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id,
        redactString(t.title),
        redactString(t.prompt),
        t.skillName ?? null,
        t.agentId,
        t.state,
        t.createdAt,
        t.updatedAt,
        t.result === undefined ? null : redactString(t.result),
        JSON.stringify(t.labels),
      );
  }

  /**
   * Move a task to its next state. `updatedAt` is the store's own clock, not
   * the caller's, so two racing settlements cannot leave a row stamped with
   * whichever finished computing its timestamp first rather than whichever
   * write actually landed last.
   */
  updateTaskState(id: string, state: TaskState, result?: string): void {
    this.#db
      .query(`UPDATE tasks SET state=?, updated_at=?, result=? WHERE id=?`)
      .run(state, new Date().toISOString(), result === undefined ? null : redactString(result), id);
  }

  getTask(id: string): Task | null {
    const row = this.#db.query(`SELECT * FROM tasks WHERE id=?`).get(id) as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  /** Every task, or one agent's, newest first. */
  listTasks(agentId?: string): Task[] {
    const rows = (
      agentId === undefined
        ? this.#db.query(`SELECT * FROM tasks ORDER BY created_at DESC`).all()
        : this.#db
            .query(`SELECT * FROM tasks WHERE agent_id=? ORDER BY created_at DESC`)
            .all(agentId)
    ) as TaskRow[];
    return rows.map(rowToTask);
  }

  // -- sessions --------------------------------------------------------------
  //
  // `SessionIndex` in @ompd/daemon owns building the full session catalog
  // from the filesystem; these methods are only the two facts this store
  // keeps about a session that the filesystem cannot answer on its own.

  /** Mark a session archived. Idempotent, and re-archiving updates `archivedAt` to the latest decision. */
  archiveSession(sessionId: string): void {
    this.#db
      .query(
        `INSERT INTO session_archive (session_id,archived_at) VALUES (?,?)
         ON CONFLICT(session_id) DO UPDATE SET archived_at=excluded.archived_at`,
      )
      .run(sessionId, new Date().toISOString());
  }

  /** Clear an archive mark. A session with no archive row was never archived; this is also how "never archived" is represented, so it is not an error to unarchive one. */
  unarchiveSession(sessionId: string): void {
    this.#db.query(`DELETE FROM session_archive WHERE session_id=?`).run(sessionId);
  }

  /**
   * Every archived session id, in one query, so an index build checks
   * membership in a `Set` instead of issuing one `SELECT` per session in the
   * catalog.
   */
  listArchivedSessionIds(): Set<string> {
    const rows = this.#db.query(`SELECT session_id FROM session_archive`).all() as Array<{
      session_id: string;
    }>;
    return new Set(rows.map((r) => r.session_id));
  }

  /** The cached message count for a session, or null on a cache miss -- an empty table (deleted wholesale, or never populated) is exactly that: every session simply misses. */
  getSessionScanCache(sessionId: string): SessionScanCacheEntry | null {
    const row = this.#db
      .query(`SELECT mtime_ms,size_bytes,message_count FROM session_scan_cache WHERE session_id=?`)
      .get(sessionId) as { mtime_ms: number; size_bytes: number; message_count: number } | null;
    return row
      ? { mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes, messageCount: row.message_count }
      : null;
  }

  setSessionScanCache(sessionId: string, entry: SessionScanCacheEntry): void {
    this.#db
      .query(
        `INSERT INTO session_scan_cache (session_id,mtime_ms,size_bytes,message_count) VALUES (?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes, message_count=excluded.message_count`,
      )
      .run(sessionId, entry.mtimeMs, entry.sizeBytes, entry.messageCount);
  }

  // -- collaboration voice -------------------------------------------------

  /**
   * Allocate a room sequence and store replayable audio in one SQLite
   * transaction. The returned frame is safe to broadcast only after this
   * method returns: a crash cannot leave recipients holding an un-replayable
   * note, and a retry of the same `noteId` returns the original sequence.
   */
  recordCollabVoiceNote(input: PersistCollabVoiceNoteInput): PersistedCollabVoiceNote {
    return this.#db.transaction(() => {
      const existing = this.#db
        .query(`SELECT * FROM collab_voice_notes WHERE room_id=? AND note_id=?`)
        .get(input.roomId, input.noteId) as Record<string, string | number | null> | null;
      if (existing !== null) {
        const frame = rowToCollabVoiceNote(existing);
        return { frame, metadata: collabVoiceMetadata(frame), inserted: false };
      }

      const next = this.#db
        .query(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM collab_voice_notes WHERE room_id=?`)
        .get(input.roomId) as { sequence: number };
      const frame: CollabVoiceNoteFrame = {
        t: "collab_voice_note",
        roomId: input.roomId,
        noteId: input.noteId,
        sequence: next.sequence,
        createdAt: new Date().toISOString(),
        participant: input.participant,
        audio: input.audio,
      };
      if (input.durationMs !== undefined) frame.durationMs = input.durationMs;

      this.#db
        .query(
          `INSERT INTO collab_voice_notes (
             room_id,sequence,note_id,participant_id,participant_kind,participant_name,
             created_at,duration_ms,encoding,sample_rate_hz,channels,audio_pcm
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          frame.roomId,
          frame.sequence,
          frame.noteId,
          frame.participant.id,
          frame.participant.kind,
          frame.participant.displayName ?? null,
          frame.createdAt,
          frame.durationMs ?? null,
          frame.audio.encoding,
          frame.audio.sampleRateHz,
          frame.audio.channels,
          frame.audio.pcm,
        );
      return { frame, metadata: collabVoiceMetadata(frame), inserted: true };
    })();
  }

  /** Replay finished notes in their durable room order. */
  listCollabVoiceNotes(roomId: string): CollabVoiceNoteFrame[] {
    const rows = this.#db
      .query(`SELECT * FROM collab_voice_notes WHERE room_id=? ORDER BY sequence ASC`)
      .all(roomId) as Array<Record<string, string | number | null>>;
    return rows.map(rowToCollabVoiceNote);
  }

  // -- audit ---------------------------------------------------------------

  audit(entry: AuditInput): void {
    this.#db
      .query(
        `INSERT INTO audit (ts,action,actor_device_id,agent_id,detail,outcome) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        entry.action,
        entry.actorDeviceId ?? null,
        entry.agentId ?? null,
        JSON.stringify(redact(entry.detail ?? {})),
        entry.outcome,
      );
  }

  listAudit(limit = 200): AuditEntry[] {
    const rows = this.#db.query(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`).all(limit) as Array<
      Record<string, string | number | null>
    >;
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as string,
      action: r.action as AuditAction,
      actorDeviceId: (r.actor_device_id as string | null) ?? null,
      agentId: (r.agent_id as string | null) ?? undefined,
      detail: JSON.parse(r.detail as string),
      outcome: r.outcome as "ok" | "denied" | "error",
    }));
  }
}

function rowToAgent(row: AgentRow): Agent {
  const agent: Agent = {
    id: row.id,
    name: row.name,
    state: row.state as AgentState,
    acpSessionId: row.acp_session_id ?? undefined,
    host: JSON.parse(row.host),
    cwd: row.cwd,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    routineId: row.routine_id ?? undefined,
    labels: JSON.parse(row.labels),
  };
  if (row.parent_agent_id !== null) agent.parentAgentId = row.parent_agent_id;
  if (row.task_title !== null) agent.taskTitle = row.task_title;
  if (row.model !== null) agent.model = row.model;
  if (row.metrics !== null) agent.metrics = JSON.parse(row.metrics);
  return agent;
}

function rowToAuthToken(row: Record<string, string | null>): AuthTokenRecord {
  const record: AuthTokenRecord = {
    id: row.id as string,
    deviceId: row.device_id as string,
    tokenHash: row.token_hash as string,
    createdAt: row.created_at as string,
  };
  if (row.label !== null && row.label !== undefined) record.label = row.label;
  if (row.last_used_at !== null && row.last_used_at !== undefined) {
    record.lastUsedAt = row.last_used_at;
  }
  if (row.revoked_at !== null && row.revoked_at !== undefined) record.revokedAt = row.revoked_at;
  return record;
}

function collabVoiceMetadata(frame: CollabVoiceNoteFrame): CollabVoiceNoteMetadata {
  const metadata: CollabVoiceNoteMetadata = {
    roomId: frame.roomId,
    sequence: frame.sequence,
    noteId: frame.noteId,
    participant: frame.participant,
    createdAt: frame.createdAt,
    format: {
      encoding: frame.audio.encoding,
      sampleRateHz: frame.audio.sampleRateHz,
      channels: frame.audio.channels,
    },
  };
  if (frame.durationMs !== undefined) metadata.durationMs = frame.durationMs;
  return metadata;
}

function rowToCollabVoiceNote(row: Record<string, string | number | null>): CollabVoiceNoteFrame {
  const participant: CollabVoiceParticipant = {
    id: row.participant_id as string,
    kind: row.participant_kind as "human" | "agent",
  };
  if (row.participant_name !== null) participant.displayName = row.participant_name as string;

  const frame: CollabVoiceNoteFrame = {
    t: "collab_voice_note",
    roomId: row.room_id as string,
    noteId: row.note_id as string,
    sequence: row.sequence as number,
    createdAt: row.created_at as string,
    participant,
    audio: {
      pcm: row.audio_pcm as string,
      encoding: row.encoding as "pcm_s16le",
      sampleRateHz: row.sample_rate_hz as number,
      channels: row.channels as 1 | 2,
    },
  };
  if (row.duration_ms !== null) frame.durationMs = row.duration_ms as number;
  return frame;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    skillName: row.skill_name ?? undefined,
    agentId: row.agent_id,
    state: row.state as TaskState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: row.result ?? undefined,
    labels: JSON.parse(row.labels),
  };
}
