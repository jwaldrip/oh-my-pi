/**
 * The client-facing surface: HTTP for state, one websocket for everything live.
 *
 * Two properties shape this file.
 *
 * The first is that agent lifetime does not belong to a connection. Nothing
 * here stops, cancels, or unblocks an agent because a socket went away, and the
 * update log is written by the supervisor whether or not anyone is listening.
 * That is what makes `attach` with `sinceSeq` able to hand a phone the exact
 * frames it missed rather than a truncated turn.
 *
 * The second is that this layer is the least trusted part of the daemon. It
 * terminates connections from a phone on someone else's network, so every frame
 * is treated as hostile input: scopes are re-read from the device row, a
 * client's `decide` is passed to the supervisor as evidence rather than applied,
 * malformed input produces an error frame instead of a dropped socket, and no
 * single client can monopolise the daemon.
 */

import { createHash, randomBytes } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import {
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  type Actor,
  type AgentId,
  type ClientFrame,
  type ConnectorSummary,
  type EndpointOffer,
  type HostSpec,
  type Run,
  type ServerFrame,
  type SessionLiveStatus,
  type SessionQuery,
  type SessionSortDir,
  type SessionSortKey,
  type SkillSummary,
  type Store,
  type Task,
  type WebViewAction,
  type WebViewActionResult,
} from "@ompd/core";
import type { SessionIndex } from "../sessions/session-index.ts";
import { WEB_ASSETS, WEB_ASSETS_BUILT } from "../web-assets.ts";
import { Supervisor, UnauthorizedError, type PendingApproval } from "../supervisor.ts";
import { DeviceAuth, PairingBacklogError, PairingError } from "./auth.ts";
import type { GatewayEvents } from "./events.ts";
import { MODE_OPTION_ID, type SessionConfig } from "../hosts.ts";
import type { CreateTaskInput } from "../workspace/tasks.ts";
import { TokenBucket } from "./ratelimit.ts";

/**
 * Content types for the console's asset kinds.
 *
 * Explicit rather than inferred: a `.webmanifest` served as octet-stream makes
 * the PWA silently uninstallable, and that failure looks like nothing at all.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".map": "application/json",
};

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extname(key)] ?? "application/octet-stream";
}

/** Decode one embedded asset into a response with an explicit content type. */
function embeddedResponse(base64: string, key: string): Response {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, { headers: { "content-type": contentTypeFor(key) } });
}
/** Narrow an untrusted client payload before it reaches the MCP result path. */
function isWebViewActionResult(value: unknown): value is WebViewActionResult {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const result = value as Record<string, unknown>;
  switch (result.kind) {
    case "ack":
      return typeof result.url === "string" && typeof result.title === "string";
    case "error":
      return typeof result.message === "string";
    case "screenshot":
      return typeof result.pngBase64 === "string";
    case "observe": {
      if (typeof result.observation !== "object" || result.observation === null) return false;
      const observation = result.observation as Record<string, unknown>;
      return (
        typeof observation.url === "string" &&
        typeof observation.title === "string" &&
        typeof observation.settled === "boolean" &&
        typeof observation.tree === "object" &&
        observation.tree !== null
      );
    }
    default:
      return false;
  }
}

const SESSION_STATUSES: readonly SessionLiveStatus[] = ["live-tui", "live-ompd", "dormant", "archived"];
const SESSION_SORT_KEYS: readonly SessionSortKey[] = [
  "status",
  "age",
  "lastActivity",
  "messageCount",
  "size",
];
const SESSION_SORT_DIRS: readonly SessionSortDir[] = ["asc", "desc"];

/**
 * Parses and validates `/v1/sessions*` query parameters into a
 * `SessionQuery`, doing the grouping/sorting/filtering decisions
 * server-side rather than handing a client 305 rows to sort itself -- the
 * whole point of running this behind a phone's pull-to-refresh.
 */
function parseSessionQuery(url: URL): { query: SessionQuery } | { error: string } {
  const query: SessionQuery = {};

  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    const requested = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of requested) {
      if (!SESSION_STATUSES.includes(s as SessionLiveStatus)) {
        return { error: `unknown status "${s}", expected one of ${SESSION_STATUSES.join(", ")}` };
      }
    }
    query.status = requested as SessionLiveStatus[];
  }

  const cwdParam = url.searchParams.get("cwd");
  if (cwdParam) query.cwd = cwdParam;

  const includeArchivedParam = url.searchParams.get("includeArchived");
  if (includeArchivedParam !== null) {
    query.includeArchived = includeArchivedParam === "true" || includeArchivedParam === "1";
  }

  const sortParam = url.searchParams.get("sort");
  if (sortParam) {
    if (!SESSION_SORT_KEYS.includes(sortParam as SessionSortKey)) {
      return { error: `unknown sort "${sortParam}", expected one of ${SESSION_SORT_KEYS.join(", ")}` };
    }
    query.sort = sortParam as SessionSortKey;
  }

  const sortDirParam = url.searchParams.get("sortDir");
  if (sortDirParam) {
    if (!SESSION_SORT_DIRS.includes(sortDirParam as SessionSortDir)) {
      return {
        error: `unknown sortDir "${sortDirParam}", expected one of ${SESSION_SORT_DIRS.join(", ")}`,
      };
    }
    query.sortDir = sortDirParam as SessionSortDir;
  }

  return { query };
}

/**
 * Loopback by default. Reaching this daemon from elsewhere must be a separate,
 * deliberate act (a tunnel the operator starts), never a default anyone
 * inherits by running it.
 */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_VERSION = "0.1.0";

/** Frames a socket may burst, and its steady-state allowance. */
const RATE_BURST = 50;
const RATE_PER_SECOND = 10;
/** ACP owns streaming backpressure; only cap an individual tunneled JSON-RPC frame. */
const MAX_TUI_ACP_FRAME_BYTES = 32 * 1024 * 1024;

/** The only scopes a device row may carry. Anything else is a typo, not a grant. */
const KNOWN_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE];

/**
 * The slice of the voice bridge the gateway needs.
 *
 * Declared structurally so the gateway never imports the voice package: the
 * two slices are wired together by whoever builds the daemon, and a test double
 * satisfies this just as well as the real bridge.
 */
export interface VoiceHandler {
  handleFrame(frame: ClientFrame, actor: Actor): Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Built once per socket so the bridge can push speech back down that socket.
 *
 * The actor comes with it because voice belongs to a device, not a
 * connection: a phone that drops and reconnects is the same paired device and
 * should still be spoken to, and a desktop attached to the same agent is a
 * different device and should not be.
 */
export type VoiceHandlerFactory = (
  send: (frame: ServerFrame) => void,
  actor: Actor,
) => VoiceHandler;

/**
 * The slice of the scheduler the gateway needs, declared structurally for the
 * same reason `VoiceHandler` is: the two are wired together by whoever builds
 * the daemon, and neither has to import the other.
 */
export interface WebhookFireAttempt {
  accepted: boolean;
  reason?: "not_found" | "forbidden";
  run?: Run;
}

export interface RoutineRunner {
  runNow(routineId: string, actor: Actor): Promise<Run>;
  fireWebhook(routineId: string, presentedSecret: string): Promise<WebhookFireAttempt>;
}

/**
 * The slice of the workspace skills catalogue the gateway needs, declared
 * structurally like `RoutineRunner`: `../workspace/skills.ts` does not know
 * this file exists.
 */
export interface SkillCatalog {
  list(cwd?: string): Promise<SkillSummary[]>;
}

/** The connector counterpart to `SkillCatalog`. */
export interface ConnectorCatalog {
  list(cwd?: string): Promise<ConnectorSummary[]>;
}

/**
 * The slice of task lifecycle the gateway needs. `create` and `cancel` take
 * the resolved `Actor` and are expected to authorize it themselves -- see
 * `TaskManager` in `../workspace/tasks.ts` -- so the scope checks below are
 * the same defence-in-depth `/v1/agents/:id/prompt` already has, not the only
 * ones.
 */
export interface TaskCatalog {
  get(id: string): Task | null;
  list(agentId?: string): Task[];
  create(input: CreateTaskInput, actor: Actor): Promise<Task>;
  cancel(id: string, actor: Actor): Promise<Task>;
}

export interface GatewayOptions {
  supervisor: Supervisor;
  store: Store;
  /**
   * The same `GatewayEvents` instance handed to the supervisor as its event
   * sink. Without it the HTTP surface still works and the socket still accepts
   * frames, but nothing is pushed.
   */
  events?: GatewayEvents;
  /**
   * Where a bug in a request handler is reported.
   *
   * Server side only, and deliberately not part of the response: a stack from
   * this process names filesystem paths and internals that a remote client has
   * no business reading.
   */
  onError?: (err: Error) => void;
  host?: string;
  /** 0 asks the OS for a free port; read the real one back from `listen()`. */
  port?: number;
  version?: string;
  /**
   * Opaque identity of the state directory this daemon serves.
   *
   * Published on `/v1/health` so a second `ompd start` can tell "that is me
   * already running" from "something else owns this port". Without it the CLI
   * treats any healthy listener as itself and silently points the operator at
   * a foreign daemon with a different token.
   */
  homeId?: string;
  /** How long an unapproved pairing stays claimable. */
  pairingTtlMs?: number;
  voice?: VoiceHandlerFactory;
  /**
   * Called when a device sends a typed prompt.
   *
   * Exists so voice can follow the modality a device most recently used: it
   * speaks, it hears; it types, it stops hearing. The gateway does not know
   * what that means, only that it happened.
   */
  onTextPrompt?: (agentId: AgentId, actor: Actor) => void;
  /**
   * Runs routines on demand. Absent, `POST /v1/routines/:id/run` reports the
   * feature off rather than pretending to have queued something.
   */
  routines?: RoutineRunner;
  /**
   * Reads and writes a session's ACP config options (mode, model). Absent,
   * `/v1/agents/:id/config` reports the feature off rather than inventing a
   * mode the agent has never heard of.
   */
  sessions?: SessionConfig;
  /**
   * Directory of built web-client files served from `/`.
   *
   * Unauthenticated on purpose: it is the app shell, and a browser has to load
   * it before it can present a token. Nothing about this machine's agents is
   * in it. Absent, the gateway is API-only.
   */
  staticRoot?: string;
  /**
   * Called with the replacement a rotation minted, before the response goes
   * out. Returns the path it persisted the token to, if it persisted it.
   *
   * The daemon uses it to rewrite `<home>/token` when the local operator's
   * credential is the one rotating, so a rotation performed from a phone does
   * not lock the CLI on this machine out of its own daemon. The gateway itself
   * knows nothing about the state directory, and reports back only so the
   * answer can say which file moved rather than guessing.
   */
  onTokenRotated?: (deviceId: string, token: string) => string | undefined;
  /** Fails in-flight actions when their registered target disappears. */
  onWebViewUnavailable?: (agentId: AgentId) => void;
  /**
   * The skills-and-commands catalogue. Absent, `GET /v1/skills` reports the
   * feature off rather than an empty catalogue, which a client would read as
   * "this workspace has no skills" instead of "this daemon build has no
   * catalogue wired in".
   */
  skills?: SkillCatalog;
  /** The connector counterpart to `skills`. Absent, `GET /v1/connectors` reports the feature off the same way. */
  connectors?: ConnectorCatalog;
  /**
   * Task lifecycle. Absent, every `/v1/tasks*` route reports the feature off
   * rather than 404ing, so a client can tell "no such task" from "this
   * daemon build has no task tracking".
   */
  tasks?: TaskCatalog;
  /**
   * The filesystem-derived session catalog. Absent, every `/v1/sessions*`
   * route reports the feature off rather than an empty list, the same
   * distinction `skills`/`connectors`/`tasks` already draw between "nothing
   * here" and "this daemon build has no catalogue wired in".
   */
  sessionIndex?: SessionIndex;
  /**
   * Reads live endpoint offers from config and identity. Absent, `GET
   * /v1/endpoints` reports an empty offer list rather than an error: unlike
   * `skills`/`connectors`/`tasks`, "nothing reachable" is itself a real
   * answer this route can give, so there is no separate off-signal to draw.
   */
  endpoints?: () => EndpointOffer[];
  /**
   * Settles one action previously dispatched to a registered client WebView.
   * Returning false means the request is stale, unknown, or belongs elsewhere.
   */
  onWebViewResult?: (agentId: AgentId, requestId: string, result: WebViewActionResult) => boolean;
}

interface LiveTuiSocket {
  sessionId: string;
  cwd: string;
  title: string | undefined;
  pid: number;
  agentId: AgentId | undefined;
  onAcpMessage: ((raw: string) => void) | undefined;
  onAcpClose: (() => void) | undefined;
}

interface PendingTuiTakeover {
  socket: GatewaySocket;
  actor: Actor;
  resolve: (agent: Agent) => void;
  reject: (error: Error) => void;
}

interface SocketState {
  deviceId: string;
  scopes: Set<string>;
  /** Agents this socket asked for. Nothing is pushed for anything else. */
  attached: Set<AgentId>;
  /**
   * Highest seq already delivered, per agent. Replay and the live stream both
   * go through this, which is what guarantees a reattach has no duplicates.
   */
  delivered: Map<AgentId, number>;
  /**
   * Approval request ids already delivered, per agent. Serves the same purpose
   * as `delivered` does for updates: replay and the live push share one choke
   * point, so a reattach cannot show the same ask twice.
   */
  approvals: Map<AgentId, Set<string>>;
  /**
   * Highest turn already summarised to this socket, per agent. Serves the same
   * purpose `delivered` does for updates: a repeat is how a client ends up
   * saying the same sentence twice.
   */
  said: Map<AgentId, number>;
  bucket: TokenBucket;
  /**
   * Set when this device is revoked while the connection is live.
   *
   * Revocation is already enforced on every privileged call, because the
   * supervisor re-reads the device row before honouring one. What that misses
   * is a connection that has already attached and is only reading: it reaches
   * no supervisor call, so nothing re-checks it. This flag is what closes that
   * gap, and it closes it the same way for every transport.
   *
   * A flag rather than closing the socket, because `stop(true)` deadlocks on
   * Bun 1.3.4 if a socket was closed here first, as the note on `close` below
   * records. An inert socket is as good: it accepts no frame and is pushed
   * nothing.
   */
  revoked: boolean;
  voice: VoiceHandler | null;
  /** Present only on the one socket serving a normal live TUI. */
  tui: LiveTuiSocket | null;
}

/**
 * What the frame handler needs from a connection.
 *
 * A real `ServerWebSocket<SocketState>` satisfies this, and so does a tunnel
 * session, which is the point: one handler, one set of scope checks, and no
 * second authorization surface that can drift from this one.
 *
 * Deliberately structural in the transport and not in the payload. `data` stays
 * `SocketState` so every check below still reads a known shape; widening that
 * toward a loose record is how a scope check quietly starts trusting whatever
 * the caller put there.
 */
export interface GatewaySocket {
  data: SocketState;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

/**
 * A live tunnel session, or the reason there is not one.
 *
 * The refusal reasons mirror `AuthVerdict` rather than flattening to a
 * boolean, because the tunnel audits which door closed and "unknown token"
 * and "revoked device" call for different responses from an operator.
 */
export type TunnelSessionResult =
  | {
      ok: true;
      deviceId: string;
      /** Hand one decrypted client frame to the shared handler. */
      deliver(raw: string): void;
      close(): void;
    }
  | { ok: false; reason: "unknown" | "revoked" };

export class Gateway {
  #sup: Supervisor;
  #store: Store;
  #auth: DeviceAuth;
  #events: GatewayEvents | undefined;
  #host: string;
  #port: number;
  #version: string;
  #homeId: string | undefined;
  #voice: VoiceHandlerFactory | undefined;
  #onTextPrompt: ((agentId: AgentId, actor: Actor) => void) | undefined;
  #routines: RoutineRunner | undefined;
  #sessions: SessionConfig | undefined;
  #onTokenRotated: ((deviceId: string, token: string) => string | undefined) | undefined;
  #skills: SkillCatalog | undefined;
  #connectors: ConnectorCatalog | undefined;
  #tasks: TaskCatalog | undefined;
  #sessionIndex: SessionIndex | undefined;
  #endpoints: (() => EndpointOffer[]) | undefined;
  #onWebViewResult: GatewayOptions["onWebViewResult"];
  #onWebViewUnavailable: GatewayOptions["onWebViewUnavailable"];
  #staticRoot: string | undefined;
  #onError: GatewayOptions["onError"];
  /** Set by `listen`, so uptime measures serving rather than construction. */
  #startedAtMs: number | undefined;

  #server: Server<SocketState> | undefined;
  #sockets = new Set<GatewaySocket>();
  /** Most recently registered live WebView socket for each agent. */
  #webviews = new Map<AgentId, GatewaySocket>();
  #tuiTakeovers = new Map<string, PendingTuiTakeover>();
  #unsubscribeSay: (() => void) | undefined;
  #unsubscribeRevoked: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(opts: GatewayOptions) {
    this.#sup = opts.supervisor;
    this.#store = opts.store;
    this.#auth = new DeviceAuth({ store: opts.store, pairingTtlMs: opts.pairingTtlMs });
    this.#events = opts.events;
    this.#host = opts.host ?? DEFAULT_HOST;
    this.#port = opts.port ?? 0;
    this.#version = opts.version ?? DEFAULT_VERSION;
    this.#homeId = opts.homeId;
    this.#voice = opts.voice;
    this.#onTextPrompt = opts.onTextPrompt;
    this.#routines = opts.routines;
    this.#sessions = opts.sessions;
    this.#onTokenRotated = opts.onTokenRotated;
    this.#skills = opts.skills;
    this.#connectors = opts.connectors;
    this.#tasks = opts.tasks;
    this.#sessionIndex = opts.sessionIndex;
    this.#endpoints = opts.endpoints;
    this.#onWebViewResult = opts.onWebViewResult;
    this.#onWebViewUnavailable = opts.onWebViewUnavailable;
    // Resolved once so the traversal check below compares two absolute paths.
    this.#staticRoot = opts.staticRoot === undefined ? undefined : resolve(opts.staticRoot);
    this.#onError = opts.onError;

    this.#unsubscribe = this.#events?.add({
      onUpdate: (agentId, seq, update) => {
        for (const ws of this.#sockets) {
          if (ws.data.attached.has(agentId)) this.#deliverUpdate(ws, agentId, seq, update);
        }
      },
      onAgentsChanged: (agents) => {
        // Attached sockets only, like the other two events. `hello` is what
        // does discovery; a socket watching no agent refreshes the list with
        // `GET /v1/agents` or by reconnecting, rather than being pushed to.
        for (const ws of this.#sockets) {
          if (ws.data.attached.size === 0) continue;
          if (ws.data.scopes.has(SCOPE_READ)) this.#send(ws, { t: "agents", agents });
        }
      },
      onApprovalNeeded: (approval) => {
        for (const ws of this.#sockets) {
          if (!ws.data.attached.has(approval.agentId)) continue;
          this.#deliverApproval(ws, approval);
        }
      },
    });

    this.#unsubscribeSay = this.#events?.addSayListener((event) => {
      for (const ws of this.#sockets) {
        // The same rule the other pushes follow: attached to that agent, and
        // holding read. Not a broadcast, and never to a socket that has not
        // asked about this agent.
        if (!ws.data.attached.has(event.agentId)) continue;
        if (!ws.data.scopes.has(SCOPE_READ)) continue;
        // One summary per turn per socket. A second copy of the same seq is
        // how a client ends up saying the same sentence twice.
        if ((ws.data.said.get(event.agentId) ?? 0) >= event.seq) continue;
        ws.data.said.set(event.agentId, event.seq);
        this.#send(ws, { t: "say", agentId: event.agentId, seq: event.seq, text: event.text });
      }
    });

    // Revocation is already enforced on every privileged call: the supervisor
    // re-reads the device row before honouring one. What that does not cover is
    // a socket that has already attached and is only reading, which reaches no
    // supervisor call and so re-checks nothing. Dropping the connection closes
    // that gap, and it closes it for every transport at once rather than for
    // whichever one remembered to ask.
    this.#unsubscribeRevoked = this.#auth.onRevoked((deviceId) => {
      for (const ws of [...this.#sockets]) {
        if (ws.data.deviceId !== deviceId) continue;
        ws.data.revoked = true;
        this.#send(ws, { t: "error", code: "unauthorized", message: "this device has been revoked" });
        // Keep the TCP socket inert for Bun's stop behaviour, but revoke an
        // ACP leg immediately so a removed device cannot keep owning a TUI.
        this.#close(ws);
      }
    });
  }

  /** Start serving. Returns the bound port, which matters when `port` was 0. */
  async listen(): Promise<number> {
    this.#server ??= Bun.serve({
      hostname: this.#host,
      port: this.#port,
      fetch: (req, server) => this.#fetch(req, server),
      /**
       * A request handler that throws is a bug in this daemon, and Bun's own
       * 500 body says only "Internal error" with the stack going nowhere. That
       * is indistinguishable from a route that deliberately answered 500,
       * which has already cost real time to tell apart.
       */
      error: (err: Error) => {
        this.#onError?.(err);
        return Response.json({ error: "internal_error" }, { status: 500 });
      },
      websocket: {
        open: (ws: ServerWebSocket<SocketState>) => this.#open(ws),
        message: (ws: ServerWebSocket<SocketState>, message: string | Buffer) =>
          this.#message(ws, message),
        close: (ws: ServerWebSocket<SocketState>) => this.#close(ws),
      },
    });
    this.#startedAtMs ??= Date.now();

    // Bun reports no port for a unix-socket server. This one always binds TCP,
    // so an absent port means the listen did not do what was asked.
    const { port } = this.#server;
    if (port === undefined) throw new Error("gateway did not bind a TCP port");
    return port;
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeSay?.();
    this.#unsubscribeSay = undefined;
    this.#unsubscribeRevoked?.();
    this.#unsubscribeRevoked = undefined;
    for (const ws of [...this.#sockets]) this.#close(ws);
    // `stop(true)` closes live connections itself. Closing each socket here
    // first and then awaiting it deadlocks on Bun 1.3.4: the promise never
    // settles. Measured, not guessed. Clients therefore see an abnormal close
    // rather than a 1001, which is the right trade for a shutdown path that
    // actually returns.
    await this.#server?.stop(true);
    this.#server = undefined;
    this.#startedAtMs = undefined;
  }

  /**
   * Operator action. Turns a recorded pairing intent into a device with scopes.
   *
   * In-process, and the scopes it writes are the caller's choice rather than
   * the pairing client's. `POST /v1/pairings/approve` reaches this over HTTP,
   * but only for a device that already holds `approve`, and only for scopes
   * that device already holds. Nothing a client says at `POST /v1/pair`
   * influences either check, so pairing still grants nothing by itself.
   */
  approvePairing(code: string, scopes: string[]): string {
    return this.#auth.approvePairing(code, scopes);
  }

  /**
   * Admit a connection that arrived over a tunnel rather than over the port.
   *
   * The whole point is that this is not a second authorization surface. The
   * token goes to the same `authenticate` a local websocket uses, the identity
   * comes only from that verdict, and every frame afterwards runs the same
   * handler with the same scope checks. A caller cannot name a device, cannot
   * choose a scope, and cannot skip a check, because none of those are
   * parameters.
   *
   * Returns a refusal rather than throwing: the tunnel needs to say which door
   * closed so the daemon can audit it, and an exception collapses that back to
   * one outcome.
   */
  acceptTunnelSession(token: string, send: (raw: string) => void): TunnelSessionResult {
    const verdict = this.#auth.authenticate(token);
    if (!verdict.ok) {
      switch (verdict.reason) {
        case "unknown":
          return { ok: false, reason: "unknown" };
        case "revoked":
          return { ok: false, reason: "revoked" };
        default: {
          // A variant added later must break the build here rather than fall
          // through into an accidental admission.
          const exhaustive: never = verdict.reason;
          throw new Error(`unhandled auth verdict ${String(exhaustive)}`);
        }
      }
    }

    const ws: GatewaySocket = {
      data: this.#socketStateFor(verdict.actor),
      send,
      close: () => {
        this.#close(ws);
      },
    };
    this.#open(ws);
    return {
      ok: true,
      deviceId: verdict.actor.deviceId,
      deliver: (raw) => {
        this.#message(ws, raw);
      },
      close: () => {
        this.#close(ws);
      },
    };
  }

  /**
   * The one place a `SocketState` is built.
   *
   * Both transports come through here, so scopes are resolved from the device
   * row exactly once and neither transport can supply its own.
   */
  #socketStateFor(actor: Actor): SocketState {
    return {
      deviceId: actor.deviceId,
      scopes: new Set(actor.scopes),
      attached: new Set(),
      delivered: new Map(),
      approvals: new Map(),
      said: new Map(),
      bucket: new TokenBucket({ capacity: RATE_BURST, refillPerSecond: RATE_PER_SECOND }),
      revoked: false,
      voice: null,
      tui: null,
    };
  }

  /**
   * Mint a token for a device row that already exists.
   *
   * In-process only, and deliberately unreachable over HTTP: a route that
   * handed out a token for an arbitrary device id would be a way to impersonate
   * one. The daemon uses it for the local operator device, whose authority
   * comes from filesystem access rather than from pairing.
   */
  issueToken(deviceId: string): string {
    return this.#auth.issueToken(deviceId);
  }

  /**
   * Whether a raw token is still a live credential for that device, without
   * recording a use.
   *
   * In-process only. The daemon asks it of the token file it finds at startup,
   * which is how a plain restart reuses the operator's existing credential
   * instead of minting a new one and logging every other device out with it.
   */
  hasLiveToken(deviceId: string, token: string): boolean {
    return this.#auth.hasLiveToken(deviceId, token);
  }


  /**
   * Dispatch an already policy-cleared action to the active WebView target.
   *
   * False is a synchronous availability result, not an eventual timeout: the
   * bridge can fail the tool call immediately when no client has mounted the
   * requested agent's WebView.
   */
  sendWebViewAction(agentId: AgentId, requestId: string, action: WebViewAction): boolean {
    const ws = this.#webviews.get(agentId);
    if (ws === undefined || !this.#sockets.has(ws) || ws.data.revoked) return false;
    try {
      ws.send(JSON.stringify({ t: "webview_action", agentId, requestId, action } satisfies ServerFrame));
      return true;
    } catch {

      this.#webviews.delete(agentId);
      return false;
    }
  }

  /**
   * The webhook's secret is the only credential this path accepts. It is used
   * by both the loopback HTTP route and the outbound tunnel's local endpoint.
   */
  async fireWebhook(
    routineId: string,
    secret: string,
    _body?: Uint8Array,
    _contentType?: string,
  ): Promise<Response> {
    const runner = this.#routines;
    if (!runner) return Response.json({ error: "routines_unavailable" }, { status: 503 });

    const result = await runner.fireWebhook(routineId, secret);
    if (!result.accepted) {
      return Response.json(
        { error: "webhook_refused" },
        { status: result.reason === "forbidden" ? 403 : 404 },
      );
    }
    return Response.json({ run: result.run }, { status: 202 });
  }
  /** Revoke a paired device. Takes effect on its next request or frame. */
  revokeDevice(deviceId: string): void {
    this.#auth.revoke(deviceId);
  }

  // -- http ------------------------------------------------------------------

  async #fetch(req: Request, server: Server<SocketState>): Promise<Response | undefined> {
    // `req.url` is absolute only when the request carried a Host header, and
    // HTTP/1.0 does not require one. Parsed bare, such a request threw here,
    // before any authentication ran, so anything able to open the port could
    // produce an unhandled exception on every request it sent. The bind
    // address is a base rather than a guess at what the client meant: only the
    // path and query are ever read from this.
    const url = URL.parse(req.url, `http://${this.#host}`);
    if (url === null) return Response.json({ error: "bad_request" }, { status: 400 });
    const path = url.pathname;

    if (path === "/v1/health") {
      // Unauthenticated, so it carries liveness and nothing else. Anything
      // about agents here would be an unauthenticated disclosure of what this
      // machine is doing.
      //
      // `homeId` is the exception, and it earns its place: without it `ompd
      // start` treats ANY healthy listener on its port as itself, silently
      // reports "already listening", and leaves the operator pointed at a
      // different daemon holding a different token. It is a hash rather than
      // the path because the path contains a username and this route is
      // unauthenticated.
      return Response.json({ ok: true, version: this.#version, homeId: this.#homeId });
    }

    if (path === "/v1/pair") {
      if (req.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
      let body: { name?: unknown; publicKey?: unknown };
      try {
        body = (await req.json()) as { name?: unknown; publicKey?: unknown };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.name !== "string" || typeof body.publicKey !== "string") {
        return Response.json({ error: "name and publicKey are required" }, { status: 400 });
      }
      try {
        // Only the code comes back. No token, no scopes, no device id: there is
        // nothing here a client could present to any other route.
        const code = this.#auth.beginPairing({ name: body.name, publicKey: body.publicKey });
        return Response.json({ code });
      } catch (err) {
        if (err instanceof PairingBacklogError) {
          return Response.json({ error: "pairing_backlog" }, { status: 429 });
        }
        throw err;
      }
    }

    const webhook = /^\/v1\/webhooks\/([^/]+)$/.exec(path);
    if (webhook && req.method === "POST") {
      // This is deliberately not a device bearer token. It is a narrow,
      // per-routine capability and the scheduler verifies its stored hash.
      const secret = req.headers.get("x-webhook-secret") ?? url.searchParams.get("token") ?? "";
      const body = new Uint8Array(await req.arrayBuffer());
      return await this.fireWebhook(webhook[1] ?? "", secret, body, req.headers.get("content-type") ?? undefined);
    }

    // Everything outside `/v1` is the web client, and it is terminal: a path
    // that is not an API route must never fall through to the bearer check
    // below, or a missing asset answers 401 and a browser is told to
    // authenticate for a file that does not exist. Unauthenticated on purpose,
    // because a browser cannot present a token it has not loaded the app to
    // obtain.
    if (!path.startsWith("/v1/")) {
      return (await this.#serveStatic(path)) ?? Response.json({ error: "not_found" }, { status: 404 });
    }

    const header = req.headers.get("authorization");
    const bearer = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : null;

    if (path === "/v1/socket") {
      // A browser cannot set headers on a websocket, so the query parameter is
      // the primary carrier here and the header is the convenience.
      const token = url.searchParams.get("token") ?? bearer;
      const actor = token === null ? null : this.#auth.resolveActor(token);
      if (!actor) return new Response("unauthorized", { status: 401 });

      const data = this.#socketStateFor(actor);
      if (server.upgrade(req, { data })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    const actor = bearer === null ? null : this.#auth.resolveActor(bearer);
    if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
    const scopes = new Set(actor.scopes);

    if (path === "/v1/agents" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ agents: this.#sup.listAgents() });
    }

    if (path === "/v1/agents" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      let body: {
        name?: unknown;
        cwd?: unknown;
        host?: HostSpec;
        routineId?: string;
        labels?: Record<string, string>;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.name !== "string" || typeof body.cwd !== "string") {
        return Response.json({ error: "name and cwd are required" }, { status: 400 });
      }
      try {
        const agent = await this.#sup.createAgent(
          {
            name: body.name,
            cwd: body.cwd,
            host: body.host,
            routineId: body.routineId,
            labels: body.labels,
          },
          actor,
        );
        return Response.json({ agent }, { status: 201 });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(
          { error: err instanceof Error ? err.message : "agent creation failed" },
          { status: 500 },
        );
      }
    }

    const agentRoute = /^\/v1\/agents\/([^/]+)$/.exec(path);
    if (agentRoute && req.method === "DELETE") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      try {
        await this.#sup.stopAgent(agentRoute[1] ?? "", actor);
        return Response.json({ ok: true });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(
          { error: err instanceof Error ? err.message : "stop failed" },
          { status: 404 },
        );
      }
    }

    const configRoute = /^\/v1\/agents\/([^/]+)\/config$/.exec(path);
    if (configRoute && (req.method === "GET" || req.method === "POST")) {
      // Reading the mode is watching; setting it is driving. `plan` is the
      // read-only mode, so moving off it widens what the agent may do, and a
      // device holding only `read` must not be able to do that. `prompt` is the
      // right bar rather than `manage`: anyone who can send a prompt can
      // already make a default-mode agent act.
      const needed = req.method === "GET" ? SCOPE_READ : SCOPE_PROMPT;
      if (!scopes.has(needed)) return Response.json({ error: "forbidden" }, { status: 403 });

      const sessions = this.#sessions;
      if (!sessions) return Response.json({ error: "config_unavailable" }, { status: 503 });

      const agent = this.#store.getAgent(configRoute[1] ?? "");
      if (!agent) return Response.json({ error: "not_found" }, { status: 404 });
      const sessionId = agent.acpSessionId;
      if (sessionId === undefined) {
        return Response.json({ error: "no_session" }, { status: 409 });
      }

      if (req.method === "GET") {
        const options = sessions.configFor(sessionId);
        if (!options) return Response.json({ error: "config_unavailable" }, { status: 503 });
        return Response.json({ agentId: agent.id, configOptions: options });
      }

      let body: { modeId?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.modeId !== "string") {
        return Response.json({ error: "modeId is required" }, { status: 400 });
      }

      // Checked against what this session actually offers. Forwarding an
      // unknown mode would either be ignored or wedge the turn, and both look
      // like the daemon losing the request.
      const known = sessions.configFor(sessionId)?.find((option) => option.id === MODE_OPTION_ID);
      if (known && !known.options.some((choice) => choice.value === body.modeId)) {
        return Response.json(
          { error: "unknown_mode", known: known.options.map((choice) => choice.value) },
          { status: 400 },
        );
      }

      try {
        // Not audited: `AuditAction` is a frozen closed union with no member
        // for a mode change, and recording this under a member that means
        // something else would corrupt the audit log to fake coverage.
        const options = await sessions.setMode(sessionId, body.modeId);
        return Response.json({ agentId: agent.id, configOptions: options });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "set_mode failed" },
          { status: 502 },
        );
      }
    }

    const promptRoute = /^\/v1\/agents\/([^/]+)\/prompt$/.exec(path);
    if (promptRoute && req.method === "POST") {
      // The same gate the socket's `prompt` frame passes, and the supervisor
      // re-authorizes from the device row behind it either way.
      if (!scopes.has(SCOPE_PROMPT)) return Response.json({ error: "forbidden" }, { status: 403 });
      let body: { text?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.text !== "string" || body.text.length === 0) {
        return Response.json({ error: "text is required" }, { status: 400 });
      }

      try {
        // Awaited, unlike the socket path: the whole point of this route is to
        // hand a script the stop reason, which does not exist until the turn
        // settles. The turn itself is identical either way.
        const result = await this.#sup.prompt(promptRoute[1] ?? "", body.text, actor);
        return Response.json({ agentId: promptRoute[1], stopReason: result.stopReason });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(
          { error: err instanceof Error ? err.message : "prompt failed" },
          { status: 404 },
        );
      }
    }

    if (path === "/v1/audit" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const raw = Number(url.searchParams.get("limit") ?? "200");
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1000) : 200;
      return Response.json({ entries: this.#store.listAudit(limit) });
    }

    if (path === "/v1/approvals" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({
        pending: this.#sup.pendingApprovals(),
        recent: this.#store.listApprovals(url.searchParams.get("agentId") ?? undefined),
      });
    }

    if (path === "/v1/status" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const byState: Record<string, number> = {};
      for (const agent of this.#sup.listAgents()) {
        byState[agent.state] = (byState[agent.state] ?? 0) + 1;
      }
      const startedAtMs = this.#startedAtMs ?? Date.now();
      return Response.json({
        version: this.#version,
        startedAt: new Date(startedAtMs).toISOString(),
        uptimeMs: Date.now() - startedAtMs,
        agents: { total: this.#sup.listAgents().length, byState },
      });
    }

    if (path === "/v1/pairings" && req.method === "GET") {
      // Approve scope, not read: a code is the thing an approval is spent on,
      // so seeing the queue is part of approving rather than part of watching.
      if (!scopes.has(SCOPE_APPROVE)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      return Response.json({ pending: this.#auth.pendingPairings() });
    }

    if (path === "/v1/pairings/approve" && req.method === "POST") {
      if (!scopes.has(SCOPE_APPROVE)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      let body: { code?: unknown; scopes?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.code !== "string" || !Array.isArray(body.scopes)) {
        return Response.json({ error: "code and scopes are required" }, { status: 400 });
      }

      // Narrowed element by element rather than asserted wholesale: this array
      // came off the wire and decides what a new device is allowed to do.
      const requested: string[] = [];
      for (const scope of body.scopes) {
        if (typeof scope !== "string" || !KNOWN_SCOPES.includes(scope)) {
          return Response.json({ error: "unknown_scope", known: KNOWN_SCOPES }, { status: 400 });
        }
        requested.push(scope);
      }

      // A device may never mint one more powerful than itself. Refused rather
      // than quietly clamped: an operator who asked for `manage` and got a
      // device without it would debug the wrong thing for a long time. The
      // code is not spent, so the right approver can still use it.
      const missing = requested.filter((scope) => !scopes.has(scope));
      if (missing.length > 0) {
        return Response.json({ error: "scope_escalation", missing }, { status: 403 });
      }

      try {
        const token = this.#auth.approvePairing(body.code, requested);
        return Response.json({ token });
      } catch (err) {
        if (err instanceof PairingError) {
          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }
    }

    if (path === "/v1/devices" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ devices: this.#store.listDevices() });
    }

    if (path === "/v1/endpoints" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const offers = this.#endpoints?.() ?? [];
      return Response.json({ offers });
    }

    const deviceRoute = /^\/v1\/devices\/([^/]+)$/.exec(path);
    if (deviceRoute && req.method === "DELETE") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const deviceId = deviceRoute[1] ?? "";
      if (!this.#store.getDevice(deviceId)) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      this.#auth.revoke(deviceId);
      return Response.json({ ok: true });
    }

    if (path === "/v1/tokens/rotate" && req.method === "POST") {
      // Read as text first: rotating your own token needs no body at all, and
      // an absent one must not read as malformed.
      const raw = await req.text();
      let body: { deviceId?: unknown } = {};
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as { deviceId?: unknown };
        } catch {
          return Response.json({ error: "bad_json" }, { status: 400 });
        }
      }
      if (body.deviceId !== undefined && typeof body.deviceId !== "string") {
        return Response.json({ error: "deviceId must be a string" }, { status: 400 });
      }

      // Rotating your own credential needs no scope. It only ever withdraws
      // authority the caller already holds and replaces it with the same
      // authority under a new secret, which is a thing every device should be
      // able to do the moment it suspects its token has leaked.
      const target = body.deviceId ?? actor.deviceId;
      const own = target === actor.deviceId;

      if (!own) {
        if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
        const device = this.#store.getDevice(target);
        if (!device) return Response.json({ error: "not_found" }, { status: 404 });
        // The same clamp pairing approval uses, for the same reason. Rotation
        // hands the caller a working credential for the target, so without
        // this a device holding only `manage` could mint itself one holding
        // `approve` and answer its own tool approvals.
        const missing = device.scopes.filter((scope) => !scopes.has(scope));
        if (missing.length > 0) {
          return Response.json({ error: "scope_escalation", missing }, { status: 403 });
        }
      }

      try {
        // `bearer` is non-null here: the check above this block is what
        // produced `actor`. Passing it makes a self-rotation withdraw exactly
        // the row the caller presented rather than everything that device holds.
        const rotated = this.#auth.rotateToken(target, own ? (bearer ?? undefined) : undefined);
        const tokenPath = this.#onTokenRotated?.(rotated.deviceId, rotated.token);
        return Response.json({
          deviceId: rotated.deviceId,
          tokenId: rotated.tokenId,
          revoked: rotated.revoked,
          ...(tokenPath === undefined ? {} : { tokenPath }),
          token: rotated.token,
        });
      } catch (err) {
        if (err instanceof PairingError) {

          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }
    }

    const webhookSecret = /^\/v1\/routines\/([^/]+)\/webhook-secret$/.exec(path);
    if (webhookSecret && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const routine = this.#store.listRoutines().find((candidate) => candidate.id === webhookSecret[1]);
      if (!routine) return Response.json({ error: "not_found" }, { status: 404 });
      if (routine.trigger.kind !== "webhook") {
        return Response.json({ error: "not_a_webhook_routine" }, { status: 400 });
      }

      // Returned exactly once. The store receives only the digest, so neither
      // a restart nor another route can reveal this credential later.
      const secret = randomBytes(32).toString("base64url");
      this.#store.upsertWebhookSecret(
        routine.trigger.secretRef,
        createHash("sha256").update(secret).digest("hex"),
      );
      return Response.json({ secret }, { status: 201 });
    }

    if (path === "/v1/routines" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ routines: this.#store.listRoutines() });
    }

    const routineRun = /^\/v1\/routines\/([^/]+)\/run$/.exec(path);
    if (routineRun && req.method === "POST") {
      // The scheduler authorizes again from the device row. This is the cheap
      // first gate, not the authority.
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const runner = this.#routines;
      if (!runner) {
        return Response.json({ error: "routines_unavailable" }, { status: 503 });
      }
      try {
        const run = await runner.runNow(routineRun[1] ?? "", actor);
        return Response.json({ run });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(
          { error: err instanceof Error ? err.message : "run failed" },
          { status: 404 },
        );
      }
    }

    if (path === "/v1/skills" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const catalog = this.#skills;
      if (!catalog) return Response.json({ error: "skills_unavailable" }, { status: 503 });
      const resolved = this.#resolveCatalogCwd(url);
      if ("notFound" in resolved) return Response.json({ error: "not_found" }, { status: 404 });
      try {
        return Response.json({ skills: await catalog.list(resolved.cwd) });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "skill discovery failed" },
          { status: 502 },
        );
      }
    }

    if (path === "/v1/connectors" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const catalog = this.#connectors;
      if (!catalog) return Response.json({ error: "connectors_unavailable" }, { status: 503 });
      const resolved = this.#resolveCatalogCwd(url);
      if ("notFound" in resolved) return Response.json({ error: "not_found" }, { status: 404 });
      try {
        return Response.json({ connectors: await catalog.list(resolved.cwd) });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "connector discovery failed" },
          { status: 502 },
        );
      }
    }

    if (path === "/v1/tasks" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const catalog = this.#tasks;
      if (!catalog) return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      return Response.json({ tasks: catalog.list(url.searchParams.get("agentId") ?? undefined) });
    }

    const taskRoute = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    if (taskRoute && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const catalog = this.#tasks;
      if (!catalog) return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      const task = catalog.get(taskRoute[1] ?? "");
      if (!task) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ task });
    }

    if (path === "/v1/tasks" && req.method === "POST") {
      // The same gate a plain prompt needs: a task is a named, tracked
      // prompt against a session that already exists, not a session-spawner.
      // Creating that session is `manage`'s job via `POST /v1/agents`.
      if (!scopes.has(SCOPE_PROMPT)) return Response.json({ error: "forbidden" }, { status: 403 });
      const catalog = this.#tasks;
      if (!catalog) return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      let body: {
        title?: unknown;
        prompt?: unknown;
        agentId?: unknown;
        skillName?: unknown;
        labels?: Record<string, string>;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (
        typeof body.title !== "string" ||
        typeof body.prompt !== "string" ||
        typeof body.agentId !== "string"
      ) {
        return Response.json({ error: "title, prompt, and agentId are required" }, { status: 400 });
      }
      if (body.skillName !== undefined && typeof body.skillName !== "string") {
        return Response.json({ error: "skillName must be a string" }, { status: 400 });
      }
      try {
        const task = await catalog.create(
          {
            title: body.title,
            prompt: body.prompt,
            agentId: body.agentId,
            ...(body.skillName === undefined ? {} : { skillName: body.skillName }),
            ...(body.labels === undefined ? {} : { labels: body.labels }),
          },
          actor,
        );
        return Response.json({ task }, { status: 201 });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(
          { error: err instanceof Error ? err.message : "task creation failed" },
          { status: 404 },
        );
      }
    }

    const taskCancel = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (taskCancel && req.method === "POST") {
      // The same gate `cancel` takes on the websocket frame and on
      // `Supervisor.cancel` itself; this call re-authorizes from the device
      // row regardless.
      if (!scopes.has(SCOPE_PROMPT)) return Response.json({ error: "forbidden" }, { status: 403 });
      const catalog = this.#tasks;
      if (!catalog) return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      try {
        const task = await catalog.cancel(taskCancel[1] ?? "", actor);
        return Response.json({ task });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json(
          { error: err instanceof Error ? err.message : "cancel failed" },
          { status: 404 },
        );
      }
    }

    // -- sessions ------------------------------------------------------------
    //
    // `read` lists and groups; `manage` archives, the same split every other
    // catalogue-vs-mutation pair in this route table uses (skills/connectors
    // read vs agent create/stop). Grouping and sorting happen inside
    // `SessionIndex`, not here, so a phone never downloads the full catalog
    // to sort it locally.

    if (path === "/v1/sessions" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      const parsed = parseSessionQuery(url);
      if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
      return Response.json({ sessions: index.query(parsed.query) });
    }

    if (path === "/v1/sessions/grouped" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      const parsed = parseSessionQuery(url);
      if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
      return Response.json({ groups: index.grouped(parsed.query) });
    }

    const sessionTakeoverRoute = /^\/v1\/sessions\/([^/]+)\/takeover$/.exec(path);
    if (sessionTakeoverRoute && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      try {
        const agent = await this.#takeOverLiveTui(sessionTakeoverRoute[1] ?? "", actor);
        return Response.json({ agent }, { status: 201 });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "TUI takeover failed" },
          { status: 409 },
        );
      }
    }

    const sessionArchiveRoute = /^\/v1\/sessions\/([^/]+)\/archive$/.exec(path);
    if (sessionArchiveRoute && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      index.archive(sessionArchiveRoute[1] ?? "");
      return Response.json({ ok: true });
    }

    const sessionUnarchiveRoute = /^\/v1\/sessions\/([^/]+)\/unarchive$/.exec(path);
    if (sessionUnarchiveRoute && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      index.unarchive(sessionUnarchiveRoute[1] ?? "");
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /**
   * Which directory a skills/connectors catalogue query is scoped to.
   *
   * `cwd` wins when both are given. `agentId` resolves through this daemon's
   * own agent rows rather than being handed to discovery as a raw path,
   * because an operator asking "what does agent X have" who mistypes the id
   * must get a 404, not a silent fall-through to the daemon's own default
   * project directory and a catalogue for the wrong workspace.
   */
  #resolveCatalogCwd(url: URL): { cwd: string | undefined } | { notFound: true } {
    const cwd = url.searchParams.get("cwd");
    if (cwd !== null) return { cwd };
    const agentId = url.searchParams.get("agentId");
    if (agentId === null) return { cwd: undefined };
    const agent = this.#store.getAgent(agentId);
    return agent ? { cwd: agent.cwd } : { notFound: true };
  }

  /**
   * Serve a built web-client file, or null to let the API's 404 stand.
   *
   * The traversal check compares resolved absolute paths rather than screening
   * the request for `..`, because a request path is not a filesystem path until
   * it has been decoded and normalised, and screening before that is how
   * traversal bugs happen.
   */
  async #serveStatic(pathname: string): Promise<Response | null> {
    const root = this.#staticRoot;
    // No directory on disk means this is the compiled binary, which carries the
    // console embedded instead. Without this branch the installed artifact
    // serves the API and answers `/` with not_found, which is what `ompd open`
    // used to land on.
    if (root === undefined) return await this.#serveEmbedded(pathname);

    let relative = "";
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
      // Malformed percent-encoding. Nothing here can name a real file.
      return null;
    }

    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return null;

    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);

    // The client owns its own routing, so a path with no file extension is a
    // route rather than a missing asset and gets the shell. A missing `.js`
    // stays a 404, because answering it with HTML turns a broken deploy into a
    // console parse error somewhere unrelated.
    if (extname(target) !== "") return null;
    const shell = Bun.file(join(root, "index.html"));
    if (!(await shell.exists())) return null;
    return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  /**
   * Serve the console embedded in the compiled binary.
   *
   * The asset map is generated at build time by `scripts/gen-web-assets.ts`,
   * so lookups are exact and there is no path to traverse: a request either
   * names a key that was embedded or it does not exist.
   */
  #serveEmbedded(pathname: string): Response | null {
    if (!WEB_ASSETS_BUILT) return null;

    let key = "";
    try {
      key = decodeURIComponent(pathname);
    } catch {

      // Malformed percent-encoding cannot name an embedded key.
      return null;
    }
    // The manifest keys all start with a slash, so normalise before lookup
    // rather than trusting the request to have one.
    if (!key.startsWith("/")) key = `/${key}`;
    if (key === "/") key = "/index.html";

    const embedded = WEB_ASSETS[key];
    if (embedded !== undefined) return embeddedResponse(embedded, key);

    // Same rule as the on-disk path: an extensionless path is a client route
    // and gets the shell, while a missing asset stays a 404 so a broken build
    // fails where it broke rather than as a parse error somewhere unrelated.
    if (extname(key) !== "") return null;
    const shell = WEB_ASSETS["/index.html"];
    if (shell === undefined) return null;
    return embeddedResponse(shell, "/index.html");
  }
  async #takeOverLiveTui(sessionId: string, actor: Actor): Promise<Agent> {
    const socket = [...this.#sockets].find(ws => ws.data.tui?.sessionId === sessionId);
    const tui = socket?.data.tui;
    if (!socket || !tui) throw new Error(`no connected TUI owns session ${sessionId}`);
    if (tui.agentId) throw new Error(`session ${sessionId} is already managed as agent ${tui.agentId}`);
    if (this.#tuiTakeovers.has(sessionId)) throw new Error(`session ${sessionId} takeover is already pending`);

    return await new Promise<Agent>((resolve, reject) => {
      this.#tuiTakeovers.set(sessionId, { socket, actor, resolve, reject });
      this.#send(socket, { t: "tui_takeover", sessionId });
    });
  }

  async #completeLiveTuiTakeover(ws: GatewaySocket, sessionId: string): Promise<void> {
    const pending = this.#tuiTakeovers.get(sessionId);
    const tui = ws.data.tui;
    if (!pending || pending.socket !== ws || !tui || tui.sessionId !== sessionId) {
      this.#send(ws, { t: "error", code: "bad_frame", message: "unexpected TUI takeover acknowledgement" });
      return;
    }
    this.#tuiTakeovers.delete(sessionId);
    try {
      const agent = await this.#sup.takeOverTuiSession(
        { sessionId, name: tui.title ?? `TUI ${sessionId}`, cwd: tui.cwd, pid: tui.pid },
        {
          send: raw => this.#send(ws, { t: "tui_acp", sessionId, raw }),
          onMessage: listener => {
            tui.onAcpMessage = listener;
          },
          onClose: listener => {
            tui.onAcpClose = listener;
          },
          close: () => ws.close(),
        },
        pending.actor,
      );
      tui.agentId = agent.id;
      pending.resolve(agent);
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error("TUI takeover failed"));
      // The renderer has already stopped. Closing the control transport makes
      // its in-process ACP server dispose the adopted session instead of
      // stranding a headless process that the daemon never registered.
      ws.close();
    }
  }

  // -- websocket -------------------------------------------------------------

  #open(ws: GatewaySocket): void {
    this.#sockets.add(ws);
    if (this.#voice) ws.data.voice = this.#voice((frame) => this.#send(ws, frame), this.#actorOf(ws));
    this.#send(ws, {
      t: "hello",
      deviceId: ws.data.deviceId,
      agents: ws.data.scopes.has(SCOPE_READ) ? this.#sup.listAgents() : [],
    });
  }

  #close(ws: GatewaySocket): void {
    this.#sockets.delete(ws);
    this.#unregisterWebViews(ws);
    for (const [sessionId, pending] of this.#tuiTakeovers) {
      if (pending.socket !== ws) continue;
      this.#tuiTakeovers.delete(sessionId);
      pending.reject(new Error(`TUI disconnected during takeover of session ${sessionId}`));
    }
    const tui = ws.data.tui;
    ws.data.tui = null;
    const closeAcp = tui?.onAcpClose;
    if (tui) {
      tui.onAcpClose = undefined;
      tui.onAcpMessage = undefined;
    }
    closeAcp?.();
    void ws.data.voice?.close();
    ws.data.voice = null;
  }

  #unregisterWebView(agentId: AgentId, ws: GatewaySocket): void {
    if (this.#webviews.get(agentId) !== ws) return;
    this.#webviews.delete(agentId);
    this.#onWebViewUnavailable?.(agentId);
  }

  #unregisterWebViews(ws: GatewaySocket): void {
    for (const [agentId, target] of this.#webviews) {
      if (target === ws) this.#unregisterWebView(agentId, ws);
    }
  }


  #message(ws: GatewaySocket, message: string | Buffer): void {
    if (ws.data.revoked) {
      this.#send(ws, { t: "error", code: "unauthorized", message: "this device has been revoked" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : message.toString());
    } catch {
      // A bad frame is a client bug, not grounds to drop a connection the
      // client may be relying on to finish a turn.
      this.#send(ws, { t: "error", code: "bad_json", message: "frame was not valid JSON" });
      return;
    }

    if (parsed === null || typeof parsed !== "object" || !("t" in parsed)) {
      this.#send(ws, { t: "error", code: "unknown_frame", message: "frame has no type" });
      return;
    }
    const frameType = parsed.t;
    if (typeof frameType !== "string") {
      this.#send(ws, { t: "error", code: "unknown_frame", message: "frame type is not a string" });
      return;
    }

    const tui = ws.data.tui;
    let registeredTuiAcp = false;
    let tuiAcpRaw = "";
    if (frameType === "tui_acp" && tui !== null && "sessionId" in parsed && "raw" in parsed) {
      const sessionId = parsed.sessionId;
      const raw = parsed.raw;
      if (sessionId === tui.sessionId && typeof raw === "string") {
        registeredTuiAcp = true;
        tuiAcpRaw = raw;
      }
    }
    if (registeredTuiAcp && Buffer.byteLength(tuiAcpRaw, "utf8") > MAX_TUI_ACP_FRAME_BYTES) {
      this.#send(ws, { t: "error", code: "frame_too_large", message: "ACP frame exceeds 32 MiB" });
      return;
    }
    if (!registeredTuiAcp && !ws.data.bucket.take()) {
      this.#send(ws, { t: "error", code: "rate_limited", message: "too many frames" });
      return;
    }

    // Narrowed as far as a discriminant can take it. Whether the rest of the
    // frame matches its type is checked per case below, because the wire is
    // not a place to assume anyone kept to the contract.
    const frame = parsed as ClientFrame;
    try {
      this.#handle(ws, frame, frameType);
    } catch (err) {
      // Last line of defence. A frame handler that throws would otherwise take
      // the connection, and on an unhandled path the process, down with it. A
      // hostile or merely malformed frame must cost one error frame, no more.
      this.#send(ws, {
        t: "error",
        code: err instanceof UnauthorizedError ? "unauthorized" : "frame_failed",
        message: err instanceof Error ? err.message : "frame handling failed",
      });
    }
  }

  #handle(ws: GatewaySocket, frame: ClientFrame, frameType: string): void {
    switch (frame.t) {
      case "tui_register": {
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "TUI registration requires manage scope" });
          return;
        }
        if (
          typeof frame.sessionId !== "string" ||
          frame.sessionId.length === 0 ||
          typeof frame.cwd !== "string" ||
          frame.cwd.length === 0 ||
          (frame.title !== undefined && typeof frame.title !== "string") ||
          !Number.isSafeInteger(frame.pid) ||
          frame.pid <= 0
        ) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "invalid TUI registration" });
          return;
        }
        const registeredElsewhere = [...this.#sockets].some(
          socket => socket !== ws && socket.data.tui?.sessionId === frame.sessionId,
        );
        if (registeredElsewhere || (ws.data.tui !== null && ws.data.tui.sessionId !== frame.sessionId)) {
          this.#send(ws, { t: "error", code: "session_busy", message: "that TUI session is already registered" });
          return;
        }
        ws.data.tui = {
          sessionId: frame.sessionId,
          cwd: frame.cwd,
          title: frame.title,
          pid: frame.pid,
          agentId: undefined,
          onAcpMessage: undefined,
          onAcpClose: undefined,
        };
        return;
      }

      case "tui_acp": {
        const tui = ws.data.tui;
        if (!tui || frame.sessionId !== tui.sessionId || typeof frame.raw !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "ACP frame has no registered TUI" });
          return;
        }
        tui.onAcpMessage?.(frame.raw);
        return;
      }

      case "tui_acp_ready": {
        const tui = ws.data.tui;
        if (!tui || frame.sessionId !== tui.sessionId) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "takeover acknowledgement has no registered TUI" });
          return;
        }
        void this.#completeLiveTuiTakeover(ws, frame.sessionId);
        return;
      }

      case "ping":
        this.#send(ws, { t: "pong" });
        return;

      case "attach": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "attach requires read scope" });
          return;
        }
        if (typeof frame.agentId !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "attach needs an agentId" });
          return;
        }
        // Registering before the replay is what closes the gap. The store read
        // and the sends below are synchronous, so no live update can interleave
        // and arrive out of order, and `#deliverUpdate` drops anything at or
        // below the high-water mark so nothing arrives twice either.
        ws.data.attached.add(frame.agentId);
        if (frame.sinceSeq !== undefined) {
          for (const record of this.#store.updatesSince(frame.agentId, frame.sinceSeq)) {
            this.#deliverUpdate(ws, frame.agentId, record.seq, record.payload);
          }
        }

        // An approval is otherwise only ever pushed live, so a client that
        // connects or reconnects while the agent is already blocked on one
        // sees an agent that is simply not moving, with no way to unblock it.
        // Replaying after the updates puts the ask in the same order it
        // originally arrived in, behind the transcript that led to it. This is
        // the update log's lossless-resume rule applied to the other thing a
        // client cannot reconstruct on its own.
        for (const approval of this.#sup.pendingApprovals()) {
          if (approval.agentId !== frame.agentId) continue;
          this.#deliverApproval(ws, approval);
        }
        return;
      }

      case "detach":
        ws.data.attached.delete(frame.agentId);
        // Forget the high-water mark too, so a later attach may replay again.
        ws.data.delivered.delete(frame.agentId);
        // Same for approvals, so a reattach is shown a still-pending ask.
        ws.data.approvals.delete(frame.agentId);
        // And the spoken summary, so a reattached client is told again what
        // the turn it is watching came to.
        ws.data.said.delete(frame.agentId);
        this.#unregisterWebView(frame.agentId, ws);
        return;

      case "webview_register": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, {
            t: "error",
            code: "unauthorized",
            message: "webview registration requires read scope",
          });
          return;
        }
        if (typeof frame.agentId !== "string" || !ws.data.attached.has(frame.agentId)) {
          this.#send(ws, {
            t: "error",
            code: "webview_not_attached",
            message: "attach to the agent before registering its WebView",
          });
          return;
        }
        const previous = this.#webviews.get(frame.agentId);
        if (previous !== undefined && previous !== ws) this.#unregisterWebView(frame.agentId, previous);
        this.#webviews.set(frame.agentId, ws);
        return;
      }

      case "webview_unregister":
        this.#unregisterWebView(frame.agentId, ws);
        return;

      case "webview_result": {
        if (
          typeof frame.agentId !== "string" ||
          typeof frame.requestId !== "string" ||
          !isWebViewActionResult(frame.result)
        ) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "invalid webview result" });
          return;
        }
        if (this.#webviews.get(frame.agentId) !== ws) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "webview_not_registered",
            message: "this socket is not the active WebView target for the agent",
          });
          return;
        }
        if (this.#onWebViewResult?.(frame.agentId, frame.requestId, frame.result) !== true) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unknown_webview_request",
            message: "the WebView request is unknown or already settled",
          });
        }
        return;
      }

      case "prompt": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "prompt requires prompt scope",
          });
          return;
        }
        // Announced before it is sent, so whoever is tracking how a device is
        // talking to an agent learns it typed even if the prompt then fails.
        this.#onTextPrompt?.(frame.agentId, this.#actorOf(ws));
        // Deliberately not awaited: a turn outlives the frame that started it,
        // and the socket has to stay responsive to `cancel` while it runs.
        void this.#sup.prompt(frame.agentId, frame.text, this.#actorOf(ws)).catch((err: unknown) => {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: err instanceof UnauthorizedError ? "unauthorized" : "prompt_failed",
            message: err instanceof Error ? err.message : "prompt failed",
          });
        });
        return;
      }

      case "cancel": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "cancel requires prompt scope",
          });
          return;
        }
        void this.#sup.cancel(frame.agentId, this.#actorOf(ws)).catch((err: unknown) => {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: err instanceof UnauthorizedError ? "unauthorized" : "cancel_failed",
            message: err instanceof Error ? err.message : "cancel failed",
          });
        });
        return;
      }

      case "decide": {
        // The frame contributes a request id and a choice. Everything about who
        // is asking comes from the socket's resolved identity, and the
        // supervisor re-reads the device row before honouring any of it, so a
        // client cannot name a device or a scope it does not hold. A false
        // return means unknown request or insufficient scope, and the pending
        // approval is left to policy and the timeout.
        const accepted = this.#sup.decide(
          frame.requestId,
          frame.choice,
          frame.scope ?? "once",
          this.#actorOf(ws),
        );
        if (!accepted) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "decision refused: unknown request or missing approve scope",
          });
        }
        return;
      }

      case "audio":
      case "audio_end": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "audio requires prompt scope",
          });
          return;
        }
        const voice = ws.data.voice;
        if (!voice) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "voice_unavailable",
            message: "no voice bridge is attached to this daemon",
          });
          return;
        }
        void voice.handleFrame(frame, this.#actorOf(ws));
        return;
      }

      default:
        this.#send(ws, {
          t: "error",
          code: "unknown_frame",
          message: `unsupported frame type ${frameType}`,
        });
    }
  }

  // -- internals -------------------------------------------------------------

  /**
   * The identity a frame acts under.
   *
   * Resolved at connect time from the device row, never from frame contents.
   * Revocation mid-session is still honoured because every privileged call this
   * feeds re-reads the device row and rejects a revoked one.
   */
  #actorOf(ws: GatewaySocket): Actor {
    return { deviceId: ws.data.deviceId, scopes: [...ws.data.scopes] };
  }

  #deliverUpdate(
    ws: GatewaySocket,
    agentId: AgentId,
    seq: number,
    update: unknown,
  ): void {
    // The single choke point replay and live traffic share, so a frame the
    // socket already has can never be sent twice.
    const delivered = ws.data.delivered.get(agentId) ?? 0;
    if (seq <= delivered) return;
    ws.data.delivered.set(agentId, seq);
    this.#send(ws, { t: "update", agentId, seq, update });
  }

  /**
   * The approval counterpart to `#deliverUpdate`, and the only place an
   * `approval` frame is written.
   *
   * Keyed by request id rather than by a high-water mark, because approvals
   * settle out of order and a pending set shrinks as well as grows. Detach
   * clears the agent's set, so a deliberate reattach can be shown the ask
   * again while a duplicate attach cannot.
   */
  #deliverApproval(
    ws: GatewaySocket,
    approval: Omit<PendingApproval, "resolve">,
  ): void {
    let sent = ws.data.approvals.get(approval.agentId);
    if (!sent) {
      sent = new Set<string>();
      ws.data.approvals.set(approval.agentId, sent);
    }
    if (sent.has(approval.requestId)) return;
    sent.add(approval.requestId);
    this.#send(ws, {
      t: "approval",
      agentId: approval.agentId,
      requestId: approval.requestId,
      title: approval.title,
      tool: approval.tool,
      input: approval.input,
    });
  }

  #send(ws: GatewaySocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket went away between an event firing and this send. `#close`
      // removes it from the registry; there is nothing to report to.
    }
  }
}
