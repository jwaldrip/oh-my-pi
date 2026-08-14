/**
 * Canonical contracts for ompd.
 *
 * This file is the authority. `docs/architecture.md` describes it in prose; if
 * the two ever disagree, this wins. Every slice builds against these types so
 * they can be developed concurrently without negotiating shapes.
 */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentId = string; // "agt_" + 16 hex

export type AgentState =
  | "provisioning" // host being acquired
  | "starting" // host up, session not yet created
  | "idle" // ready, no turn in flight
  | "busy" // turn streaming
  | "waiting" // blocked on an approval decision
  | "stopped" // clean exit, transcript retained
  | "failed"; // crashed or provisioning failed

/** States from which no further work can proceed without operator action. */
export const TERMINAL_AGENT_STATES: readonly AgentState[] = ["stopped", "failed"];

export interface Agent {
  id: AgentId;
  name: string;
  state: AgentState;
  /** OMP-side ACP session id. Absent until the session is created. */
  acpSessionId?: string;
  host: HostRef;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  /** Set when this agent was spawned by a routine rather than a human. */
  routineId?: string;
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export type HostKind = "local" | "container" | "cloud";

export interface HostSpec {
  kind: HostKind;
  image?: string;
  repo?: string;
  ref?: string;
  /** JIT hosts self-destruct after this long idle. Omit for no expiry. */
  ttlSeconds?: number;
  /**
   * Extra host directories a container host can see, beyond the workspace.
   * Each lands at the identical absolute path inside, the same property that
   * makes the workspace mount work: a path named in a transcript means the
   * same thing on both sides of the boundary.
   */
  mounts?: HostMount[];
}

export interface HostMount {
  /** Absolute host path. Relative paths are refused: there is no cwd to resolve them against on the far side. */
  hostPath: string;
  /**
   * "ro" is the default. A folder the agent should merely see does not need
   * write access, and a writable mount is a deliberate act an operator opts
   * into per path rather than something that falls out of naming a folder.
   */
  mode?: "ro" | "rw";
}

export interface HostRef {
  kind: HostKind;
  /** pid for local, container id for container, machine id for cloud. */
  id: string;
  spec: HostSpec;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type ApprovalChoice = "allow" | "deny";
export type ApprovalScope = "once" | "always";

/**
 * The only choices OMP offers when it asks an operator to review a plan.
 *
 * These strings are protocol values, not display copy: the answer goes back
 * through ACP's enum-shaped elicitation response.
 */
export type PlanReviewChoice = "Approve and execute" | "Refine plan";

/** A plan awaiting an operator's answer. It is transient, like an ACP turn. */
export interface PlanReviewRequest {
  requestId: string;
  agentId: AgentId;
  message: string;
  choices: readonly PlanReviewChoice[];
}

/**
 * ACP option ids, as advertised by `session/request_permission`. The supervisor
 * maps a PolicyDecision onto one of these; nothing else may.
 */
export type AcpOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface ApprovalRequest {
  requestId: string;
  agentId: AgentId;
  tool: string;
  input: unknown;
  /** Human-readable one-liner supplied by ACP, e.g. the shell command. */
  title: string;
  createdAt: string;
}

export interface ApprovalRecord extends ApprovalRequest {
  decision: ApprovalChoice;
  scope: ApprovalScope;
  /** Which rule decided. "operator" when a human broke a `prompt` tie. */
  rule: string;
  actorDeviceId: string | null;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface Actor {
  deviceId: string;
  scopes: string[];
}

export interface PolicyContext {
  agent: Agent;
  tool: string;
  input: unknown;
  actor: Actor;
}

export interface PolicyDecision {
  action: "allow" | "deny" | "prompt";
  reason: string;
  rule?: string;
}

export interface Policy {
  /** Pure and total: must never throw and never perform I/O. */
  evaluate(ctx: PolicyContext): PolicyDecision;
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export type TriggerSpec =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; seconds: number }
  | { kind: "manual" }
  | { kind: "webhook"; secretRef: string };

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerSpec;
  /** Prompt delivered to a fresh agent on each run. */
  prompt: string;
  cwd: string;
  host: HostSpec;
  /** Skip a run if the previous one is still going. */
  singleton: boolean;
  /** Kill a run that exceeds this. */
  timeoutSeconds?: number;
  labels: Record<string, string>;
  createdAt: string;
}

export type RunState = "queued" | "running" | "succeeded" | "failed" | "skipped" | "timed_out";

export interface Run {
  id: string;
  routineId: string;
  agentId?: AgentId;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  /** Final assistant text, truncated for listing. */
  summary?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface Device {
  id: string;
  name: string;
  publicKey: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** Scope required to break a `prompt` tie on a tool approval. */
export const SCOPE_APPROVE = "approve";
/** Scope required to create or destroy agents. */
export const SCOPE_MANAGE = "manage";
/** Scope required to read transcripts. */
export const SCOPE_READ = "read";
/** Scope required to send prompts. */
export const SCOPE_PROMPT = "prompt";

/**
 * Loopback port the daemon binds when config says nothing.
 *
 * Lives here because two very different things need the same number and got it
 * wrong: the daemon defaulted to 7777 while the client suggested 7717, so a
 * first pairing failed for a reason neither side could report. A client cannot
 * import the daemon to ask, since that pulls `bun:sqlite` into a phone bundle,
 * so the contract owns it and both read it from here.
 */
export const DEFAULT_DAEMON_PORT = 7777;

// ---------------------------------------------------------------------------
// Agent-driveable WebView
//
// A capability, not a device. iOS, Android, macOS and Windows can each host
// `react-native-webview` and drive it from inside the app process; the
// laptop's own `browser`/`computer` OMP tools reach the user's real Chrome
// through the OMP browser relay instead, because there is no in-app browser
// to embed on a desktop that already has one. The web build has neither: a
// browser tab cannot honestly host a driveable browser inside itself, so
// `WebViewCapability` is `null` there at the type level, never a runtime
// throw. See `docs/browser.md` for the full contract and per-platform
// verified/gap matrix, and `app/src/browser/` for the implementation.
// ---------------------------------------------------------------------------

/** Whether the host app has verified this capability actually works, per platform. */
export type WebViewSupport = "verified" | "unverified" | "unavailable";

export type AppPlatform = "ios" | "android" | "macos" | "windows" | "web";

/** One row of the capability matrix; see `docs/browser.md` for how each was decided. */
export interface WebViewPlatformStatus {
  platform: AppPlatform;
  support: WebViewSupport;
  /** Why, when the answer is not "it works": what was tried, what broke, what was never scaffolded. */
  note: string;
}

/**
 * A node in the structural read. `text` and `attributes` are exactly what the
 * page said and are never anything but data -- see "Page content can only
 * ever become data" in `docs/browser.md`.
 */
export interface WebViewNode {
  tag: string;
  role?: string;
  /** Minted by the native side, never by the page. Valid until the next `observe` or a navigation. */
  ref: string;
  text?: string;
  attributes?: Record<string, string>;
  children?: WebViewNode[];
}

export interface WebViewObservation {
  url: string;
  title: string;
  tree: WebViewNode;
  /** True when the page was still loading at capture time; the tree may be partial. */
  settled: boolean;
}

/**
 * The five actions, chosen to mirror the relay's own vocabulary (navigate,
 * observe, click, type, screenshot) so driving a phone is not a second
 * language for a model that has already driven the relay.
 */
export type WebViewAction =
  | { kind: "navigate"; url: string }
  | { kind: "observe" }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; replace?: boolean }
  | { kind: "screenshot" };

/**
 * There is deliberately no variant here that represents "the page asked for
 * something." Only the native bridge produces this type, from its own
 * nonce-matched response to a request it issued -- never from unmediated page
 * content. See `app/src/browser/bridge.ts`.
 */
export type WebViewActionResult =
  | { kind: "observe"; observation: WebViewObservation }
  | { kind: "screenshot"; pngBase64: string }
  | { kind: "ack"; url: string; title: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Client wire protocol
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { t: "attach"; agentId: AgentId; sinceSeq?: number }
  | { t: "detach"; agentId: AgentId }
  | { t: "prompt"; agentId: AgentId; text: string; images?: string[] }
  | { t: "cancel"; agentId: AgentId }
  | { t: "decide"; agentId: AgentId; requestId: string; choice: ApprovalChoice; scope?: ApprovalScope }
  | { t: "plan_decide"; agentId: AgentId; requestId: string; choice: PlanReviewChoice }
  | { t: "audio"; agentId: AgentId; pcm: string } // base64 16k mono PCM16
  | { t: "audio_end"; agentId: AgentId }
  /** Offer this socket's mounted WebView as the active target for an agent. */
  | { t: "webview_register"; agentId: AgentId }
  /** Withdraw this socket's WebView without detaching from the agent session. */
  | { t: "webview_unregister"; agentId: AgentId }
  /** The outcome of a `webview_action` this client's WebView was asked to perform. */
  | { t: "webview_result"; agentId: AgentId; requestId: string; result: WebViewActionResult }
  | { t: "ping" };

export type ServerFrame =
  | { t: "hello"; deviceId: string; agents: Agent[] }
  | { t: "agents"; agents: Agent[] }
  | { t: "update"; agentId: AgentId; seq: number; update: unknown }
  | { t: "approval"; agentId: AgentId; requestId: string; title: string; tool: string; input: unknown }
  | { t: "plan_review"; agentId: AgentId; requestId: string; message: string; choices: readonly PlanReviewChoice[] }
  /**
   * The speakable form of a turn's answer, as prose.
   *
   * Separate from `speech` because a client that owns its own voice should
   * never receive audio it has to know to ignore, and separate from
   * `transcript` because that one carries the operator's speech in the other
   * direction.
   *
   * A rendering hint and nothing more. Receiving one must never cause a client
   * to act, approve, or change state, and a client that branches on the
   * content of one has a bug. `seq` is the highest update this summary derives
   * from, so a client can tell which turn is speaking and refuse to say the
   * same one twice after a reconnect. The text is already sanitised and capped
   * by the daemon; there is no client-sent counterpart, because a client that
   * could ask for a `say` could make another device speak arbitrary words.
   */
  | { t: "say"; agentId: AgentId; seq: number; text: string }
  /** Synthesized audio, for a client with no voice of its own. */
  | { t: "speech"; agentId: AgentId; pcm: string }
  | { t: "transcript"; agentId: AgentId; text: string; final: boolean }
  | { t: "error"; agentId?: AgentId; message: string; code?: string }
  /** Ask a client's embedded WebView to perform an action, already cleared by the policy engine. */
  | { t: "webview_action"; agentId: AgentId; requestId: string; action: WebViewAction }
  | { t: "pong" };

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | "agent.create"
  | "agent.stop"
  | "agent.prompt"
  | "approval.decide"
  | "device.pair"
  | "device.revoke"
  /** A daemon registered an outbound tunnel leg with a hub, or was refused. */
  | "tunnel.register"
  /** A client opened a tunnel session to this daemon, or was refused. */
  | "tunnel.attach"
  | "routine.create"
  | "routine.run"
  | "proposal.submit"
  | "proposal.promote"
  | "proposal.reject"
  | "host.provision"
  | "host.destroy";

export interface AuditEntry {
  id: number;
  ts: string;
  action: AuditAction;
  actorDeviceId: string | null;
  agentId?: AgentId;
  /** Structured detail. Must never contain credentials. */
  detail: Record<string, unknown>;
  outcome: "ok" | "denied" | "error";
}

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------

/**
 * Paths the evolution engine may never modify. A proposal touching any of these
 * is archived at submission time rather than queued for review, because a loop
 * that can edit its own gate has no gate.
 *
 * Matched as path prefixes against repo-relative POSIX paths.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "packages/core/src/policy.ts",
  "packages/core/src/audit.ts",
  "packages/core/src/contracts.ts",
  "packages/daemon/src/auth/",
  "packages/daemon/src/provisioner/",
  "packages/daemon/src/evolution/gate.ts",
  ".github/workflows/",
  "mise.toml",
];

export type ProposalState =
  | "submitted"
  | "archived" // touched a protected path
  | "evaluating"
  | "rejected" // failed evaluation
  | "awaiting_review" // passed evaluation, needs an operator
  | "canary"
  | "promoted"
  | "rolled_back";

export interface Proposal {
  id: string;
  title: string;
  rationale: string;
  /** Unified diff. Never applied to the running tree. */
  diff: string;
  touchedPaths: string[];
  state: ProposalState;
  verdict?: { passed: boolean; log: string };
  createdAt: string;
  promotedCommit?: string;
}

export function isProtectedPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_PATHS.some((prefix) =>
    prefix.endsWith("/") ? norm.startsWith(prefix) : norm === prefix,
  );
}

// ---------------------------------------------------------------------------
// Workspace: skills and connectors
//
// The daemon does not implement discovery itself -- it calls upstream's own
// `discoverSkills`, `discoverSlashCommands`, and `discoverMCPServers` and
// reshapes the result. These types are that reshaped, wire-safe view: never a
// place for a connector's raw config, which routinely carries tokens and
// headers a client must never receive.
// ---------------------------------------------------------------------------

/** Where upstream resolved a skill or connector's configuration from. */
export type WorkspaceSourceLevel = "user" | "project" | "native";

/**
 * A skill (`SKILL.md`, auto-invoked by description match) and a slash command
 * (an explicit `/name` template) are different upstream mechanisms, but both
 * are "reusable workflows invoked as /name" from a user's point of view, so
 * they share one catalogue here. `kind` tells them apart for a client that
 * cares.
 */
export type SkillKind = "skill" | "command";

export interface SkillSummary {
  /** Invocation name, without a leading "/". */
  name: string;
  description: string;
  kind: SkillKind;
  /** Upstream's raw provenance string, e.g. "claude-plugins:project". */
  source: string;
  /** Upstream's display name for the loader that found it, e.g. "Claude Code Marketplace". */
  providerName?: string;
  level?: WorkspaceSourceLevel;
  /**
   * The specific plugin that owns this skill, when its source path names one
   * (a marketplace cache entry or an installed plugin root). `providerName`
   * names the *loading mechanism*; this names the *plugin*, which is what a
   * user with dozens of plugins actually wants grouped by. Absent when the
   * skill has no plugin -- a bare project- or user-level skill file -- which
   * is the honest answer for those, not a guess.
   */
  pluginName?: string;
}

export type ConnectorStatus = "connected" | "connecting" | "disconnected";

/**
 * A connector's identity and health. Never its config: config carries tokens,
 * headers, and OAuth client secrets, and this type is what crosses the wire.
 */
export interface ConnectorSummary {
  name: string;
  connected: boolean;
  status: ConnectorStatus;
  providerName?: string;
  level?: WorkspaceSourceLevel;
  pluginName?: string;
  /**
   * Why it is not connected. The whole value of this view: a connector list
   * that cannot say why something is down is decoration. Present only when
   * `status !== "connected"`, and redacted before it ever reaches the store or
   * the wire.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * `waiting` is never written to the store: it is derived at read time by
 * checking whether the owning `Agent` is currently blocked on an approval
 * while the task is `running`, the same overlay `SessionIndex` uses for
 * session liveness. `canceled` is detected the same way `done` is -- from
 * the stop reason `Supervisor.prompt` settles with -- rather than written by
 * a separate `cancel` code path, so there is exactly one place a task's
 * outcome is decided.
 */
export type TaskState = "running" | "waiting" | "done" | "failed" | "canceled";

/** States from which a task proceeds no further; a new task is what comes next. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["done", "failed", "canceled"];

/**
 * A named unit of work started from a sidebar: a prompt, the session doing
 * it, and a lifecycle a client can render as a card.
 *
 * Modelled as its own row rather than folded onto `Agent` because the two
 * lifecycles answer different questions. `Agent.state` is "is the process
 * alive and what is it doing right now" -- it returns to `idle` between
 * prompts and is reused across many of them. `Task.state` is "did the thing
 * the user asked for finish", which is a property of one prompt, not of the
 * process that served it. Collapsing them would force every agent creation
 * through the task fiction, or leave every non-task agent carrying nullable
 * task fields it never uses.
 *
 * `agentId` is the session doing the work, never a machine reference: per
 * control-plane/docs/portability.md, a task's session must not be assumed
 * local, and nothing here encodes where that session's host lives -- that is
 * `Agent.host`'s job, looked up through `agentId` at the point of use, not
 * copied here where it would go stale the moment the session moved.
 */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  /**
   * The skill or command this task ran, when it was started from one. Display
   * metadata only -- the daemon never branches on it. Invoking a skill is
   * ordinary agent work: `prompt` already contains whatever the caller wants
   * sent (typically a `/skill:<name>` or `/<command>` invocation), and it
   * reaches the agent through the exact same `Supervisor.prompt` path, and
   * therefore the exact same policy gate, as a task with no skill at all.
   */
  skillName?: string;
  agentId: AgentId;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  /** Stop reason on success, or an error message on failure. Redacted. */
  result?: string;
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Sessions
//
// Every OMP session ever written to ~/.omp/agent/sessions/<flattened-cwd>/,
// not only the ones ompd spawned. Filesystem-derived and rebuilt on every
// query -- see @ompd/daemon's SessionIndex -- because a session file can be
// appended to or removed by the OMP TUI at any moment and a cached copy would
// go stale under it. The only thing this layer persists is whether a session
// has been explicitly archived, which must survive a daemon restart.
//
// Per control-plane/docs/portability.md: a session id identifies a session,
// never a machine, and a cwd is data about a session, not its address.
// Nothing here encodes which host produced a session or implies grouping by
// directory is more than a view.
// ---------------------------------------------------------------------------

/**
 * Which of the three directory-naming schemes a session's flattened cwd
 * decoded under, or "unknown" when it could not be decoded with confidence.
 * See cwd-codec.ts in @ompd/daemon for what "confidence" means here: a
 * decode is trusted only when it round-trips back to the exact flattened
 * name through the same encoder OMP itself uses, and only when exactly one
 * real directory does so.
 */
export type SessionCwdScope = "home" | "tmp" | "abs" | "unknown";

/**
 * Why a cwd could not be decoded, present only when `cwd` is null. Distinct
 * from a client's point of view: "no real directory reconstructs this name"
 * usually means the directory was deleted after the session ran; "more than
 * one real directory reconstructs this name" is a genuine collision in
 * OMP's flattening scheme (e.g. home-relative "tmp/x" and a temp-relative
 * "x" both encode to "-tmp-x"). Either way the honest answer is "unknown",
 * never a guess.
 */
export type SessionCwdDecodeReason = "no_match" | "ambiguous";

/**
 * - `live-tui`: a running OMP TUI process holds this session (a live client
 *   presence record, verified against the real process, names it).
 * - `live-ompd`: an ompd-supervised agent holds this session. Checked before
 *   `live-tui`: an agent ompd drives also registers a TUI-shaped client
 *   presence in some code paths, and the agent row is the more specific,
 *   independently-reconciled source of truth for that case.
 * - `dormant`: on disk, no live process holds it.
 * - `archived`: explicitly archived. Excluded from default listings; never
 *   implies the session file was deleted.
 */
export type SessionLiveStatus = "live-tui" | "live-ompd" | "dormant" | "archived";

export interface SessionSummary {
  /** The session uuid, parsed from its jsonl filename. */
  id: string;
  /** Real working directory, when the flattened directory name decoded with confidence. Null, never guessed, otherwise. */
  cwd: string | null;
  cwdScope: SessionCwdScope;
  /** Present only when `cwd` is null. */
  cwdDecodeReason?: SessionCwdDecodeReason;
  /** The raw, still-flattened directory name this session was filed under, always present so a client can group or display something even when `cwd` is null. */
  flattenedDir: string;
  title: string;
  /** ISO timestamp, parsed from the jsonl filename. */
  createdAt: string;
  /** ISO timestamp, from the session file's mtime. */
  lastActivityAt: string;
  /** Null when the file exceeds the index build's size ceiling -- see `MESSAGE_COUNT_SIZE_CEILING_BYTES` in `@ompd/daemon`'s scanner.ts -- so one pathological transcript reports "unknown" instead of stalling the whole list. */
  messageCount: number | null;
  byteSize: number;
  status: SessionLiveStatus;
  archived: boolean;
  /** Present only when `status` is "live-tui". */
  pid?: number;
  /** Present only when `status` is "live-ompd". */
  agentId?: AgentId;
}

export type SessionSortKey = "status" | "age" | "lastActivity" | "messageCount" | "size";
export type SessionSortDir = "asc" | "desc";

export interface SessionQuery {
  status?: SessionLiveStatus[];
  /** Matches either a decoded `cwd` or a raw `flattenedDir`, so an undecodable group is still filterable. */
  cwd?: string;
  /** Archived sessions are excluded unless this is true. */
  includeArchived?: boolean;
  sort?: SessionSortKey;
  sortDir?: SessionSortDir;
}

export interface SessionGroup {
  /** The decoded `cwd` when every session in the group has one, else the shared `flattenedDir`. */
  key: string;
  cwd: string | null;
  sessions: SessionSummary[];
}
