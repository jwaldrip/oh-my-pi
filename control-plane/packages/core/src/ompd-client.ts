/**
 * Typed websocket client for the ompd gateway.
 *
 * The load-bearing property here is lossless resume. Agent lifetime belongs to
 * the daemon, so a client that loses its connection mid-turn must come back to
 * exactly the updates it missed: no gap, no duplicate. The daemon persists
 * every `session/update` with a monotonic per-agent `seq` for precisely this
 * reason, so the client's job is to remember the highest `seq` it has actually
 * delivered and to reattach with that watermark on every reconnect.
 *
 * Everything the client touches from the outside world (socket construction,
 * timers, randomness, connectivity) is injectable, so the reconnect path is
 * testable without a live daemon and without waiting on wall-clock time.
 *
 * This is the one implementation every ompd client (TUI, app, web, and
 * anything future) shares. It has no framework dependency: only
 * `@ompd/core/contracts` and the seams above. A host that cannot use the
 * platform `WebSocket` global supplies its own via `createSocket`.
 */

import type { Agent, AgentId, ApprovalChoice, ApprovalScope, ClientFrame, ServerFrame } from "./contracts.ts";

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** Cancels a scheduled callback. Calling it twice must be harmless. */
export type Cancel = () => void;

/** Schedules `fn` after `ms`. Mirrors `setTimeout`, minus the host quirks. */
export type Scheduler = (fn: () => void, ms: number) => Cancel;

export interface SocketCloseInfo {
  code?: number;
  reason?: string;
}

/**
 * The slice of a websocket this client uses. A real `WebSocket` is adapted onto
 * this rather than typed as it, because DOM's `CloseEvent`-shaped handlers are
 * contravariantly incompatible with a narrower structural type.
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((info: SocketCloseInfo) => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/**
 * What the daemon said when asked whether a token is still a credential.
 *
 * `unknown` is not a failure to answer politely: it is the answer when the
 * daemon could not be reached at all, and it must never be treated as a
 * rejection. An unreachable daemon is the ordinary case this client already
 * handles by reconnecting.
 */
export type CredentialVerdict = "valid" | "rejected" | "unknown";

export type CredentialProbe = () => Promise<CredentialVerdict>;

const SOCKET_OPEN = 1;

/**
 * Error codes worth asking the daemon whether this credential is still good.
 *
 * The gateway answers `unauthorized` both for "that token is not valid" and
 * for "your device does not hold that scope", and the two want opposite
 * responses: forget the pairing, or carry on with fewer buttons. The code
 * alone cannot tell them apart, so it only triggers the question.
 */
const AUTH_SUSPECT_CODES: Record<string, true> = { unauthorized: true };

/**
 * Whether losing a frame to a closed socket is worth telling the operator
 * about. Attach and detach are re-sent from `attached` on the next `hello`,
 * and a ping that never left is answered by the next ping, so their loss is
 * invisible by design. A prompt, cancel, or decision is an instruction that
 * simply did not happen, and silence there is how an operator ends up
 * believing they approved something.
 */
const LOSS_IS_VISIBLE: Record<ClientFrame["t"], boolean> = {
  attach: false,
  detach: false,
  ping: false,
  audio: false,
  audio_end: false,
  prompt: true,
  cancel: true,
  decide: true,
  // A lost result is a lost answer: the agent never learns whether the
  // navigate/click/type it dispatched actually happened, which is the same
  // "silently believed something occurred" failure a lost `decide` is.
  webview_result: true,
  // Normal TUI control frames are emitted only by the terminal client, never
  // by this app-facing client. Losing one here is not a user instruction.
  tui_register: false,
  tui_acp: false,
  tui_acp_ready: false,
};

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs: number;
  /** Ceiling. Growth stops here however long the outage runs. */
  maxMs: number;
  /** Multiplier applied per consecutive failure. */
  factor: number;
  /**
   * Fraction of the delay given over to randomness, in `[0, 1]`. A delay lands
   * in `[raw * (1 - jitter), raw]`, so jitter only ever shortens a wait and can
   * never breach the ceiling. Its job is to stop every client in a fleet
   * reconnecting on the same tick after the daemon restarts.
   */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.3,
};

/**
 * Delay before retry number `attempt` (zero-based: attempt 0 is the first
 * retry after a healthy connection dropped).
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions, random: () => number): number {
  const exponent = Math.max(0, attempt);
  const raw = Math.min(options.maxMs, options.baseMs * options.factor ** exponent);
  const spread = raw * clamp01(options.jitter) * clamp01(random());
  return Math.max(0, Math.round(raw - spread));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export interface StatusEvent {
  state: ConnectionState;
  /** Consecutive failed attempts. Zero while healthy. */
  attempt: number;
  /** Present on `reconnecting`: how long until the next attempt. */
  delayMs?: number;
  /** Human-readable cause of the last transition, when there was one. */
  reason?: string;
}

export interface AgentsEvent {
  agents: Agent[];
  /** Present only on the initial `hello` of a connection. */
  deviceId?: string;
}

export interface UpdateEvent {
  agentId: AgentId;
  seq: number;
  /** Raw ACP `session/update` payload. Shape is the transcript's problem. */
  update: unknown;
}

export interface ApprovalEvent {
  agentId: AgentId;
  requestId: string;
  title: string;
  tool: string;
  input: unknown;
}

export interface ClientErrorEvent {
  message: string;
  code?: string;
  agentId?: AgentId;
}

/**
 * The spoken form of a settled turn, as text.
 *
 * `seq` is the update the prose derives from, so a client that reconnects and
 * replays can tell a fresh summary from one it has already spoken.
 */
export interface SayEvent {
  agentId: AgentId;
  seq: number;
  text: string;
}

/** Synthesized speech for a turn the operator started by speaking. */
export interface SpeechEvent {
  agentId: AgentId;
  /** base64 16kHz mono PCM16, the same wire format the client sends up. */
  pcm: string;
}

/** A finalised transcript of what the operator said. */
export interface TranscriptEvent {
  agentId: AgentId;
  text: string;
  final: boolean;
}

/**
 * The daemon has confirmed this token is no longer a credential.
 *
 * Terminal. The client has stopped and will not reconnect, because there is
 * nothing to reconnect with: only a new pairing produces a working token.
 */
export interface UnauthorizedEvent {
  /** Plain language, for a screen a person is looking at. */
  reason: string;
}

export interface ClientEventMap {
  status: StatusEvent;
  agents: AgentsEvent;
  update: UpdateEvent;
  approval: ApprovalEvent;
  error: ClientErrorEvent;
  say: SayEvent;
  speech: SpeechEvent;
  transcript: TranscriptEvent;
  unauthorized: UnauthorizedEvent;
}

export type ClientEventName = keyof ClientEventMap;
export type Listener<K extends ClientEventName> = (event: ClientEventMap[K]) => void;
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface OmpdClientOptions {
  /** Socket endpoint, e.g. `ws://127.0.0.1:7777/v1/socket`. */
  url: string;
  /** Device token issued at pairing. Appended as the `token` query parameter. */
  token: string;
  backoff?: Partial<BackoffOptions>;
  /** Interval between liveness pings once a connection is established. */
  pingIntervalMs?: number;
  /** How long a `pong` may take before the link is declared dead. */
  pongTimeoutMs?: number;
  createSocket?: SocketFactory;
  schedule?: Scheduler;
  random?: () => number;
  /** Reports host connectivity. Distinguishes "retrying" from "no network". */
  isOnline?: () => boolean;
  /**
   * Asks the daemon whether the token is still a credential. Defaults to one
   * authenticated HTTP request against the same origin as `url`.
   */
  probeCredential?: CredentialProbe;
}

export interface AttachOptions {
  /**
   * Replay from just after this sequence number. Omit to resume from the
   * client's own watermark, which is what a reconnect wants. Pass `0` to ask
   * for the full transcript.
   */
  sinceSeq?: number;
}

export class OmpdClient {
  private readonly url: string;
  private readonly token: string;
  private readonly backoff: BackoffOptions;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly createSocket: SocketFactory;
  private readonly schedule: Scheduler;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;
  private readonly probeCredential: CredentialProbe;

  private readonly listeners = new Map<ClientEventName, Set<(event: never) => void>>();

  /** Highest `seq` delivered per agent. The resume watermark. */
  private readonly watermarks = new Map<AgentId, number>();
  /** Agents whose attachment must survive a reconnect. */
  private readonly attached = new Set<AgentId>();

  private socket: SocketLike | null = null;
  /** Invalidates handlers belonging to a socket we have already abandoned. */
  private generation = 0;
  private attempt = 0;
  private state: ConnectionState = "offline";
  private started = false;
  /** Last delay handed to the scheduler, so a repeat can be stepped off. */
  private previousDelayMs: number | null = null;
  /** True once this attempt has been answered with `hello`. Reset per attempt. */
  private authenticated = false;
  /** Set once the daemon has confirmed the token is dead. Never unset. */
  private rejected = false;
  /** One probe at a time; a flurry of refusals asks the same question once. */
  private probing = false;

  private cancelReconnect: Cancel | null = null;
  private cancelPing: Cancel | null = null;
  private cancelPong: Cancel | null = null;

  constructor(options: OmpdClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.createSocket = options.createSocket ?? createPlatformSocket;
    this.schedule = options.schedule ?? scheduleWithTimeout;
    this.random = options.random ?? Math.random;
    this.isOnline = options.isOnline ?? readNavigatorOnline;
    this.probeCredential = options.probeCredential ?? createCredentialProbe(options.url, options.token);
  }

  // -- public surface -------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Highest sequence number delivered for an agent, or `undefined`. */
  watermark(agentId: AgentId): number | undefined {
    return this.watermarks.get(agentId);
  }

  on<K extends ClientEventName>(name: K, listener: Listener<K>): Unsubscribe {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    // One cast, contained here: the map is heterogeneous by construction and
    // `on`/`emit` are the only two places that know the pairing is sound.
    const erased = listener as unknown as (event: never) => void;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  /** Opens the connection and keeps it open until `close()`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.previousDelayMs = null;
    this.openSocket("start");
  }

  /** Closes deliberately. No further reconnects until `start()` is called. */
  close(): void {
    this.started = false;
    this.clearTimers();
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, "client closed");
    this.setStatus("offline", { reason: "closed by client" });
  }

  /**
   * Skips a pending backoff wait and retries immediately. Called when the
   * host comes back online or regains foreground, both of which mean the
   * reason for the wait has probably just gone away.
   *
   * A pending timer is the only thing this cancels. With an attempt already in
   * flight there is nothing to hurry, and tearing that socket down on every
   * refocus would turn a flaky link into a connect loop.
   */
  reconnectNow(): void {
    if (!this.started) return;
    if (this.cancelReconnect === null) return;
    this.cancelReconnect();
    this.cancelReconnect = null;
    this.openSocket("manual retry");
  }

  attach(agentId: AgentId, options: AttachOptions = {}): void {
    this.attached.add(agentId);
    if (options.sinceSeq !== undefined) this.watermarks.set(agentId, options.sinceSeq);
    this.sendAttach(agentId);
  }

  detach(agentId: AgentId): void {
    // The watermark deliberately outlives the attachment: reattaching later
    // should resume, not replay a transcript the client already holds.
    this.attached.delete(agentId);
    this.send({ t: "detach", agentId });
  }

  prompt(agentId: AgentId, text: string, images?: string[]): void {
    const frame: ClientFrame =
      images && images.length > 0 ? { t: "prompt", agentId, text, images } : { t: "prompt", agentId, text };
    this.send(frame);
  }

  cancel(agentId: AgentId): void {
    this.send({ t: "cancel", agentId });
  }

  decide(agentId: AgentId, requestId: string, choice: ApprovalChoice, scope?: ApprovalScope): void {
    const frame: ClientFrame =
      scope === undefined
        ? { t: "decide", agentId, requestId, choice }
        : { t: "decide", agentId, requestId, choice, scope };
    this.send(frame);
  }

  // -- connection lifecycle -------------------------------------------------

  private openSocket(reason: string): void {
    this.clearTimers();
    this.generation += 1;
    const generation = this.generation;
    this.authenticated = false;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting", { reason });

    let socket: SocketLike;
    try {
      socket = this.createSocket(this.socketUrl());
    } catch (cause) {
      this.emit("error", { message: `could not open socket: ${describe(cause)}`, code: "socket_open" });
      this.scheduleReconnect("socket construction failed");
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (generation !== this.generation) return;
      // Not "connected" yet. The link is only proven once the daemon has
      // authenticated us and said `hello`.
      this.startPingLoop();
    };
    socket.onmessage = (message) => {
      if (generation !== this.generation) return;
      this.handleRaw(message.data);
    };
    socket.onerror = () => {
      if (generation !== this.generation) return;
      // A socket error is always followed by a close; let close drive recovery
      // so the two paths cannot both schedule a reconnect.
      this.emit("error", { message: "websocket error", code: "socket" });
    };
    socket.onclose = (info) => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.clearTimers();
      if (!this.started) return;
      const cause = info.reason && info.reason.length > 0 ? info.reason : `closed (${info.code ?? "no code"})`;
      // A handshake the daemon refused and a cable someone pulled arrive here
      // identically: a client cannot read the status of a failed websocket
      // upgrade. So the reconnect is scheduled exactly as it always was, and
      // the question is asked alongside it. An outage answers "unknown" and
      // nothing changes; only a daemon that is up and says 401 stops the loop.
      if (!this.authenticated) {
        this.checkCredential("The daemon rejected this device's token.");
      }
      this.scheduleReconnect(cause);
    };
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started) return;
    if (this.cancelReconnect) return;
    const delayMs = this.nextDelayMs();
    this.attempt += 1;
    const offline = !this.isOnline();
    this.setStatus(offline ? "offline" : "reconnecting", { delayMs, reason });
    this.cancelReconnect = this.schedule(() => {
      this.cancelReconnect = null;
      if (!this.started) return;
      this.openSocket("retry");
    }, delayMs);
  }

  /**
   * Backoff delay for the next attempt, guaranteed to differ from the delay
   * used for the previous one.
   *
   * Jitter exists so retries do not line up: not just across a fleet of
   * clients, but across successive attempts by one client hammering a daemon
   * that is coming back up. Two identical waits in a row are the exact
   * collision jitter is there to prevent, and they do happen once the delay is
   * pinned at the ceiling and only the jitter term varies. So when the formula
   * repeats itself, step one millisecond off it. That stays inside
   * `[0, maxMs]` by construction, because it only ever shortens the wait.
   */
  private nextDelayMs(): number {
    const proposed = computeBackoffDelay(this.attempt, this.backoff, this.random);
    if (proposed !== this.previousDelayMs) {
      this.previousDelayMs = proposed;
      return proposed;
    }
    // A zero proposal can only repeat when the ceiling itself is zero, and a
    // zero ceiling means "never wait", which has no second value to offer.
    const nudged = proposed > 0 ? proposed - 1 : Math.min(1, this.backoff.maxMs);
    this.previousDelayMs = nudged;
    return nudged;
  }

  private startPingLoop(): void {
    if (this.cancelPing) this.cancelPing();
    this.cancelPing = this.schedule(() => {
      this.cancelPing = null;
      if (!this.socket) return;
      this.send({ t: "ping" });
      this.armPongDeadline();
      this.startPingLoop();
    }, this.pingIntervalMs);
  }

  private armPongDeadline(): void {
    if (this.cancelPong) this.cancelPong();
    this.cancelPong = this.schedule(() => {
      this.cancelPong = null;
      // Silence is indistinguishable from a half-open socket, and a half-open
      // socket is the failure mode that loses a turn without anyone noticing.
      this.emit("error", { message: "no pong within deadline; link is dead", code: "timeout" });
      this.dropSocket("ping timeout");
    }, this.pongTimeoutMs);
  }

  private dropSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    this.clearTimers();
    if (socket) socket.close(4000, reason);
    this.scheduleReconnect(reason);
  }

  /**
   * Ask the daemon whether this token is still a credential, and stop if it
   * is not.
   *
   * Fire and forget: nothing waits on the answer, so a reconnect already in
   * flight proceeds at its usual pace and an unreachable daemon costs one
   * failed request. Only a definite `rejected` changes anything.
   */
  private checkCredential(reason: string): void {
    if (this.probing || this.rejected || !this.started) return;
    this.probing = true;
    void this.probeCredential().then(
      (verdict) => {
        this.probing = false;
        if (verdict === "rejected") this.declareRejected(reason);
      },
      () => {
        // A probe that threw is a probe that learned nothing. Silence here is
        // correct: the reconnect loop is still running and will ask again.
        this.probing = false;
      },
    );
  }

  /**
   * Terminal. The token is gone, and retrying a credential the daemon has
   * withdrawn is the loop this exists to break: it never succeeds, and it
   * leaves an operator watching a spinner that means "re-pair".
   */
  private declareRejected(reason: string): void {
    if (this.rejected) return;
    this.rejected = true;
    this.started = false;
    if (this.cancelReconnect) {
      this.cancelReconnect();
      this.cancelReconnect = null;
    }
    this.clearTimers();
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(4001, "credential rejected");
    this.setStatus("offline", { reason });
    this.emit("unauthorized", { reason });
  }

  private clearTimers(): void {
    if (this.cancelPing) {
      this.cancelPing();
      this.cancelPing = null;
    }
    if (this.cancelPong) {
      this.cancelPong();
      this.cancelPong = null;
    }
  }

  // -- frames ---------------------------------------------------------------

  private socketUrl(): string {
    const separator = this.url.includes("?") ? "&" : "?";
    return `${this.url}${separator}token=${encodeURIComponent(this.token)}`;
  }

  private send(frame: ClientFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      if (LOSS_IS_VISIBLE[frame.t]) {
        this.emit("error", { message: `not connected; "${frame.t}" was not sent`, code: "offline" });
      }
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (cause) {
      this.emit("error", { message: `send failed: ${describe(cause)}`, code: "send" });
    }
  }

  private sendAttach(agentId: AgentId): void {
    const sinceSeq = this.watermarks.get(agentId);
    const frame: ClientFrame = sinceSeq === undefined ? { t: "attach", agentId } : { t: "attach", agentId, sinceSeq };
    this.send(frame);
  }

  private handleRaw(data: unknown): void {
    if (typeof data !== "string") {
      this.emit("error", { message: "binary frame ignored", code: "bad_frame" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.emit("error", { message: "unparseable frame ignored", code: "bad_frame" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || !("t" in parsed) || typeof parsed.t !== "string") {
      this.emit("error", { message: "frame without a type ignored", code: "bad_frame" });
      return;
    }
    // Narrowed above to an object carrying a string `t`. Which string it is
    // remains the switch's problem, and its default arm covers every value
    // this build does not recognise.
    const frame = parsed as ServerFrame;
    this.handleFrame(frame);
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case "hello": {
        this.attempt = 0;
        this.authenticated = true;
        this.setStatus("connected", { reason: "hello" });
        this.emit("agents", { agents: frame.agents, deviceId: frame.deviceId });
        // The whole point of the watermark. Every agent this client cares about
        // is reattached from exactly where its stream stopped.
        for (const agentId of this.attached) this.sendAttach(agentId);
        return;
      }
      case "agents":
        this.emit("agents", { agents: frame.agents });
        return;
      case "update":
        this.handleUpdate(frame.agentId, frame.seq, frame.update);
        return;
      case "approval":
        this.emit("approval", {
          agentId: frame.agentId,
          requestId: frame.requestId,
          title: frame.title,
          tool: frame.tool,
          input: frame.input,
        });
        return;
      case "error":
        // An error frame is a message about a request, not a transport
        // failure. Tearing down the socket here would turn "that prompt was
        // rejected" into "you are disconnected".
        this.emit("error", { message: frame.message, code: frame.code, agentId: frame.agentId });
        // Except when the daemon has stopped recognising us at all, which
        // wears the same code as a scope refusal. Asking settles which it is
        // without guessing from the message text.
        if (frame.code !== undefined && AUTH_SUSPECT_CODES[frame.code]) {
          this.checkCredential(`The daemon rejected this device's token: ${frame.message}`);
        }
        return;
      case "pong":
        if (this.cancelPong) {
          this.cancelPong();
          this.cancelPong = null;
        }
        return;
      case "say":
        // The text path. A client with a local synthesizer speaks this and
        // never needs the PCM below. Dropping it into `default` is what made
        // the whole point of an on-device voice unreachable.
        this.emit("say", { agentId: frame.agentId, seq: frame.seq, text: frame.text });
        return;
      case "speech":
        // Emitted, not dropped. The daemon speaks only to a device that spoke
        // first, so a frame arriving here was asked for, and swallowing it is
        // what made "bi-directional voice" one-directional.
        this.emit("speech", { agentId: frame.agentId, pcm: frame.pcm });
        return;
      case "transcript":
        this.emit("transcript", {
          agentId: frame.agentId,
          text: frame.text,
          final: frame.final,
        });
        return;
      default:
        // A newer daemon may speak frames this build has never heard of.
        // Ignoring them is the only forward-compatible answer.
        return;
    }
  }

  private handleUpdate(agentId: AgentId, seq: number, update: unknown): void {
    const previous = this.watermarks.get(agentId);
    if (previous !== undefined && seq <= previous) {
      // Replay overlap after a reconnect. Dropping it here is what makes
      // resume idempotent.
      return;
    }
    if (previous !== undefined && seq > previous + 1) {
      this.emit("error", {
        agentId,
        code: "seq_gap",
        message: `missed updates ${previous + 1}..${seq - 1}`,
      });
    }
    this.watermarks.set(agentId, seq);
    this.emit("update", { agentId, seq, update });
  }

  // -- emitter --------------------------------------------------------------

  private setStatus(state: ConnectionState, extra: { delayMs?: number; reason?: string }): void {
    this.state = state;
    this.emit("status", { state, attempt: this.attempt, ...extra });
  }

  private emit<K extends ClientEventName>(name: K, event: ClientEventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      // The listener map is heterogeneous by construction; `on` and `emit` are
      // the only two places that know each key's payload type, and they agree.
      const typed = listener as unknown as Listener<K>;
      try {
        typed(event);
      } catch (cause) {
        // A broken view must not take the connection down with it.
        console.error(`ompd: "${name}" listener threw`, cause);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function scheduleWithTimeout(fn: () => void, ms: number): Cancel {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
}

/**
 * Optimistic by design. Browsers report connectivity on `navigator.onLine`;
 * a plain Node/Bun process has no such property, and its absence has to mean
 * "assume reachable", because the failure mode of guessing offline is a
 * client that stops trying.
 *
 * A host that wants the real answer injects `isOnline` instead.
 */
function readNavigatorOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  // Bun's ambient `navigator` type has no DOM lib behind it, so `onLine` is
  // not a known property here even though every real host that defines
  // `navigator` at all (browsers, React Native) does define it.
  const withOnline = navigator as unknown as { onLine?: boolean };
  return withOnline.onLine !== false;
}

/** `WebSocket` as every target spells it: browsers, Bun, and React Native's own. */
function createPlatformSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const adapter: SocketLike = {
    get readyState(): number {
      return ws.readyState;
    },
    send(data: string): void {
      ws.send(data);
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason);
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  ws.onopen = () => adapter.onopen?.();
  ws.onclose = (event) => adapter.onclose?.({ code: event.code, reason: event.reason });
  ws.onerror = (event) => adapter.onerror?.(event);
  ws.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  return adapter;
}

/**
 * Ask the daemon directly whether a token is still a credential.
 *
 * This exists because a client cannot see the status of a websocket upgrade
 * the server refused: a 401 at the handshake and a pulled cable both arrive as
 * an anonymous close, and treating either as the other is a bug in one
 * direction or the other. One authenticated HTTP request separates them, and
 * it is the only thing that can.
 *
 * A 403 counts as valid. The daemon authenticated the token and then declined
 * the scope, which is a live credential answering.
 */
function createCredentialProbe(socketUrl: string, token: string): CredentialProbe {
  return async () => {
    const endpoint = agentsEndpoint(socketUrl);
    if (endpoint === null) return "unknown";
    try {
      const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
      return response.status === 401 ? "rejected" : "valid";
    } catch {
      // Unreachable, blocked, or offline. Says nothing about the token.
      return "unknown";
    }
  };
}

/**
 * `ws://host/v1/socket?x=1#y` becomes `http://host/v1/agents`, on any platform.
 *
 * Exported for the test that pins the mapping. Null means the address was not
 * a websocket URL this client could have connected to in the first place.
 */
export function agentsEndpoint(socketUrl: string): string | null {
  const match = /^(wss?|https?):\/\/([^/?#]+)/.exec(socketUrl);
  if (match === null) return null;
  const [, scheme, authority] = match;
  if (scheme === undefined || authority === undefined || authority.length === 0) return null;
  const secure = scheme === "wss" || scheme === "https";
  return `${secure ? "https" : "http"}://${authority}/v1/agents`;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
