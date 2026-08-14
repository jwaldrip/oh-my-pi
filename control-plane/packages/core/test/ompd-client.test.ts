/**
 * Comprehensive test suite for OmpdClient.
 *
 * Consolidates the former web, app, and core suites into a single authority for:
 * - Exponential backoff with jitter and collision avoidance
 * - Lossless resume, sequence watermarks, reattach replay, and gap detection
 * - Credential probing and rejected-token session termination
 * - Server and client frame delivery, unknown frame resilience, and error handling
 * - Outbound frame construction, offline queuing rules, and connection liveness
 * - Status event reporting
 * - REST agentsEndpoint URL resolution
 * - Embedded WebView registration, lifecycle replay order, and frame dispatch
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentId, ClientFrame, ServerFrame, WebViewAction, WebViewActionResult } from "../src/contracts.ts";
import {
  agentsEndpoint,
  computeBackoffDelay,
  OmpdClient,
  type BackoffOptions,
  type ClientErrorEvent,
  type CredentialVerdict,
  type Scheduler,
  type SocketCloseInfo,
  type SocketLike,
  type StatusEvent,
  type UnauthorizedEvent,
  type UpdateEvent,
  type WebViewActionEvent,
} from "../src/ompd-client.ts";

const AGENT: AgentId = "agt_0123456789abcdef";

const AGENT_RECORD: Agent = {
  id: AGENT,
  name: "foundation",
  state: "busy",
  host: { kind: "local", id: "4242", spec: { kind: "local" } },
  cwd: "/work/ompd",
  createdAt: "2026-08-10T10:00:00.000Z",
  lastActiveAt: "2026-08-10T10:05:00.000Z",
  labels: {},
};

// ---------------------------------------------------------------------------
// Test Doubles
// ---------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  closedWith: SocketCloseInfo | null = null;

  onopen: (() => void) | null = null;
  onclose: ((info: SocketCloseInfo) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    const frame: ClientFrame = JSON.parse(data);
    this.sent.push(frame);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The server accepted the connection. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver a server frame or arbitrary payload to the client. */
  deliver(frame: ServerFrame | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Simulate network drop (abrupt close with code 1006). */
  drop(reason = "connection reset"): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code: 1006, reason };
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason });
  }

  framesOfType<T extends ClientFrame["t"]>(t: T): Extract<ClientFrame, { t: T }>[] {
    const matches: Extract<ClientFrame, { t: T }>[] = [];
    for (const frame of this.sent) {
      if (frame.t === t) matches.push(frame as Extract<ClientFrame, { t: T }>);
    }
    return matches;
  }
}

interface ScheduledTask {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  done: boolean;
}

class ManualClock {
  readonly tasks: ScheduledTask[] = [];

  readonly schedule: Scheduler = (fn, ms) => {
    const task: ScheduledTask = { fn, ms, cancelled: false, done: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  /** Runs the oldest pending scheduled task and returns its delay in ms. */
  runNext(): number {
    for (const task of this.tasks) {
      if (task.cancelled || task.done) continue;
      task.done = true;
      task.fn();
      return task.ms;
    }
    throw new Error("no pending scheduled task");
  }

  pendingDelays(): number[] {
    return this.tasks.filter((task) => !task.cancelled && !task.done).map((task) => task.ms);
  }
}

interface Harness {
  client: OmpdClient;
  clock: ManualClock;
  sockets: FakeSocket[];
  updates: UpdateEvent[];
  errors: ClientErrorEvent[];
  statuses: StatusEvent[];
  unauthorized: UnauthorizedEvent[];
  webviews: WebViewActionEvent[];
  probes: () => number;
  answerProbes: () => Promise<void>;
  latest: () => FakeSocket;
}

interface HarnessOptions {
  backoff?: Partial<BackoffOptions>;
  random?: () => number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  verdict?: CredentialVerdict;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  const updates: UpdateEvent[] = [];
  const errors: ClientErrorEvent[] = [];
  const statuses: StatusEvent[] = [];
  const unauthorized: UnauthorizedEvent[] = [];
  const webviews: WebViewActionEvent[] = [];
  const verdict = options.verdict ?? "unknown";
  const answers: Array<Promise<CredentialVerdict>> = [];

  const client = new OmpdClient({
    url: "ws://127.0.0.1:7717/v1/socket",
    token: "tok_test",
    backoff: options.backoff,
    random: options.random ?? (() => 0),
    schedule: clock.schedule,
    pingIntervalMs: options.pingIntervalMs ?? 15_000,
    pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
    isOnline: () => true,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    probeCredential: () => {
      const answer = Promise.resolve(verdict);
      answers.push(answer);
      return answer;
    },
  });

  client.on("update", (event) => updates.push(event));
  client.on("error", (event) => errors.push(event));
  client.on("status", (event) => statuses.push(event));
  client.on("unauthorized", (event) => unauthorized.push(event));
  client.on("webview_action", (event) => webviews.push(event));

  return {
    client,
    clock,
    sockets,
    updates,
    errors,
    statuses,
    unauthorized,
    webviews,
    probes: () => answers.length,
    answerProbes: async () => {
      for (const answer of answers) await answer.then(() => undefined);
    },
    latest: () => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("no socket has been created");
      return socket;
    },
  };
}

/** Brings a fresh socket up: accepted, authenticated, hello. */
function bringUp(h: Harness, agents: Agent[] = [AGENT_RECORD]): FakeSocket {
  const socket = h.latest();
  socket.accept();
  socket.deliver({ t: "hello", deviceId: "dev_test", agents });
  return socket;
}

/** Replays update log from sinceSeq with optional overlap. */
function replay(socket: FakeSocket, log: string[], sinceSeq: number | undefined, overlap = 0): void {
  const from = Math.max(0, (sinceSeq ?? 0) - overlap);
  for (let index = from; index < log.length; index += 1) {
    socket.deliver({ t: "update", agentId: AGENT, seq: index + 1, update: log[index] });
  }
}

function lastAttachSeq(socket: FakeSocket): number | undefined {
  const attaches = socket.framesOfType("attach");
  const last = attaches.at(-1);
  if (!last) throw new Error("no attach frame was sent");
  return last.sinceSeq;
}

// ---------------------------------------------------------------------------
// 1. Backoff
// ---------------------------------------------------------------------------

describe("backoff", () => {
  const options: BackoffOptions = { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0.3 };

  test("grows exponentially and stops at the ceiling", () => {
    const noJitter = () => 0;
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 20].map((attempt) =>
      computeBackoffDelay(attempt, options, noJitter),
    );

    expect(delays.slice(0, 7)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(delays.at(-1)).toBe(30_000);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(options.maxMs);
  });

  test("jitter only ever shortens a wait, so the ceiling still holds", () => {
    const floor = Math.round(options.maxMs * (1 - options.jitter));
    expect(computeBackoffDelay(20, options, () => 1)).toBe(floor);
    expect(computeBackoffDelay(20, options, () => 0)).toBe(options.maxMs);
    for (const sample of [0, 0.17, 0.5, 0.83, 1]) {
      const delay = computeBackoffDelay(20, options, () => sample);
      expect(delay).toBeLessThanOrEqual(options.maxMs);
      expect(delay).toBeGreaterThanOrEqual(floor);
    }
  });

  test("two consecutive reconnect delays are never identical", () => {
    const h = harness({
      backoff: { baseMs: 1_000, maxMs: 1_000, factor: 2, jitter: 0.4 },
      random: () => 0.5,
    });
    h.client.start();

    const scheduled: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      bringUp(h);
      h.latest().drop();
      const pending = h.clock.pendingDelays();
      const delay = pending.at(-1);
      expect(delay).toBeDefined();
      scheduled.push(delay ?? -1);
      h.clock.runNext();
    }

    for (let index = 1; index < scheduled.length; index += 1) {
      expect(scheduled[index]).not.toBe(scheduled[index - 1]);
    }
    for (const delay of scheduled) {
      expect(delay).toBeLessThanOrEqual(1_000);
      expect(delay).toBeGreaterThanOrEqual(600);
    }
  });

  test("a successful hello resets the growth", () => {
    const h = harness({ backoff: { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0 } });
    h.client.start();

    bringUp(h);
    h.latest().drop();
    expect(h.clock.pendingDelays().at(-1)).toBe(500);
    h.clock.runNext();

    // Second attempt fails before hello, so growth continues.
    h.latest().accept();
    h.latest().drop();
    expect(h.clock.pendingDelays().at(-1)).toBe(1_000);
    h.clock.runNext();

    // This attempt completes hello, resetting backoff to base.
    bringUp(h);
    h.latest().drop();
    expect(h.clock.pendingDelays().at(-1)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 2. Reconnect and Resume
// ---------------------------------------------------------------------------

describe("reconnect and resume", () => {
  test("reattaches from the watermark, with no gap and no duplicate", () => {
    const h = harness({ backoff: { baseMs: 250, maxMs: 5_000, factor: 2, jitter: 0.25 } });
    h.client.start();

    const log = ["one", "two", "three"];
    const first = bringUp(h);
    h.client.attach(AGENT);

    expect(lastAttachSeq(first)).toBeUndefined();
    replay(first, log, undefined);
    expect(h.updates.map((event) => event.seq)).toEqual([1, 2, 3]);

    first.drop("signal lost");
    log.push("four", "five", "six");

    h.clock.runNext();
    const second = h.latest();
    expect(second).not.toBe(first);
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    expect(lastAttachSeq(second)).toBe(3);

    replay(second, log, 3, 1);

    const seqs = h.updates.map((event) => event.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(h.updates.map((event) => event.update)).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(h.errors.filter((error) => error.code === "seq_gap")).toEqual([]);
    expect(h.client.watermark(AGENT)).toBe(6);
  });

  test("attach with an explicit sinceSeq asks for exactly that watermark", () => {
    const h = harness();
    h.client.start();
    bringUp(h);

    h.client.attach(AGENT, { sinceSeq: 3 });
    expect(lastAttachSeq(h.latest())).toBe(3);
  });

  test("an explicit sinceSeq of zero asks for the whole transcript", () => {
    const h = harness();
    h.client.start();
    bringUp(h);

    h.client.attach(AGENT, { sinceSeq: 0 });
    expect(lastAttachSeq(h.latest())).toBe(0);
  });

  test("a duplicate update at or below the watermark is dropped, not re-delivered", () => {
    const h = harness();
    const seen: number[] = [];
    h.client.on("update", (event) => seen.push(event.seq));

    h.client.start();
    bringUp(h);
    h.client.attach(AGENT, { sinceSeq: 0 });

    const socket = h.latest();
    socket.deliver({ t: "update", agentId: AGENT, seq: 4, update: "four" });
    socket.deliver({ t: "update", agentId: AGENT, seq: 4, update: "four-dup" });
    socket.deliver({ t: "update", agentId: AGENT, seq: 3, update: "three-stale" });
    socket.deliver({ t: "update", agentId: AGENT, seq: 5, update: "five" });

    expect(seen).toEqual([4, 5]);
    expect(h.client.watermark(AGENT)).toBe(5);
  });

  test("survives repeated drops without losing its place", () => {
    const h = harness({ backoff: { baseMs: 100, maxMs: 1_000, factor: 2, jitter: 0.5 } });
    h.client.start();

    const log: string[] = [];
    bringUp(h);
    h.client.attach(AGENT);

    for (let round = 0; round < 5; round += 1) {
      log.push(`chunk-${round}-a`, `chunk-${round}-b`);
      const socket = h.latest();
      replay(socket, log, h.client.watermark(AGENT), 1);
      socket.drop();
      h.clock.runNext();
      const next = h.latest();
      next.accept();
      next.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });
      expect(lastAttachSeq(next)).toBe(log.length);
    }

    const seqs = h.updates.map((event) => event.seq);
    expect(seqs).toEqual(Array.from({ length: 10 }, (_value, index) => index + 1));
    expect(h.errors.filter((error) => error.code === "seq_gap")).toEqual([]);
  });

  test("keeps a separate watermark per agent", () => {
    const other: AgentId = "agt_fedcba9876543210";
    const h = harness();
    h.client.start();
    bringUp(h);

    h.client.attach(AGENT);
    h.client.attach(other);

    const first = h.latest();
    first.deliver({ t: "update", agentId: AGENT, seq: 1, update: "a1" });
    first.deliver({ t: "update", agentId: AGENT, seq: 2, update: "a2" });
    first.deliver({ t: "update", agentId: other, seq: 1, update: "b1" });

    first.drop();
    h.clock.runNext();
    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    const attaches = second.framesOfType("attach");
    expect(attaches).toEqual([
      { t: "attach", agentId: AGENT, sinceSeq: 2 },
      { t: "attach", agentId: other, sinceSeq: 1 },
    ]);
  });

  test("reports a gap rather than hiding it, and still delivers", () => {
    const h = harness();
    h.client.start();
    bringUp(h);
    h.client.attach(AGENT);

    const socket = h.latest();
    socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "a" });
    socket.deliver({ t: "update", agentId: AGENT, seq: 5, update: "e" });

    const gaps = h.errors.filter((error) => error.code === "seq_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.message).toContain("2..4");
    expect(h.updates.map((event) => event.seq)).toEqual([1, 5]);
  });
});

// ---------------------------------------------------------------------------
// 3. Rejected Credentials
// ---------------------------------------------------------------------------

describe("a rejected credential", () => {
  test("an ordinary drop keeps reconnecting and never gives up", async () => {
    const h = harness({ verdict: "unknown" });
    h.client.start();
    bringUp(h);

    h.latest().drop("signal lost");
    await h.answerProbes();

    expect(h.unauthorized).toEqual([]);
    expect(h.clock.pendingDelays()).toHaveLength(1);
    h.clock.runNext();
    expect(h.sockets).toHaveLength(2);
  });

  test("a handshake the daemon refused stops the loop and says why", async () => {
    const h = harness({ verdict: "rejected" });
    h.client.start();

    h.latest().drop("closed before hello");
    expect(h.probes()).toBe(1);
    await h.answerProbes();

    expect(h.unauthorized).toHaveLength(1);
    expect(h.unauthorized[0]?.reason).toContain("rejected");
    expect(h.clock.pendingDelays()).toEqual([]);
    expect(h.client.connectionState).toBe("offline");
  });

  test("a drop after hello is a dropped link, not a dead credential", async () => {
    const h = harness({ verdict: "rejected" });
    h.client.start();
    bringUp(h);

    h.latest().drop("signal lost");
    await h.answerProbes();

    expect(h.probes()).toBe(0);
    expect(h.unauthorized).toEqual([]);
    expect(h.clock.pendingDelays()).toHaveLength(1);
  });

  test("a scope refusal is not a dead credential", async () => {
    const h = harness({ verdict: "valid" });
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({
      t: "error",
      agentId: AGENT,
      code: "unauthorized",
      message: "decision refused: unknown request or missing approve scope",
    });
    await h.answerProbes();

    expect(h.probes()).toBe(1);
    expect(h.unauthorized).toEqual([]);
    expect(h.errors.at(-1)?.code).toBe("unauthorized");
    expect(socket.closedWith).toBeNull();
  });

  test("an unauthorized frame the daemon confirms ends the session", async () => {
    const h = harness({ verdict: "rejected" });
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "error", code: "unauthorized", message: "device dev_phone is revoked" });
    await h.answerProbes();

    expect(h.unauthorized).toHaveLength(1);
    expect(h.unauthorized[0]?.reason).toContain("revoked");
    expect(socket.closedWith?.code).toBe(4001);
    expect(h.clock.pendingDelays()).toEqual([]);
  });

  test("a flurry of refusals asks the daemon once", async () => {
    const h = harness({ verdict: "rejected" });
    h.client.start();
    const socket = bringUp(h);

    for (let i = 0; i < 5; i += 1) {
      socket.deliver({ t: "error", code: "unauthorized", message: "no" });
    }
    expect(h.probes()).toBe(1);

    await h.answerProbes();
    expect(h.unauthorized).toHaveLength(1);
  });

  test("reconnectNow does not restart a client the daemon has cut off", async () => {
    const h = harness({ verdict: "rejected" });
    h.client.start();

    h.latest().drop("closed before hello");
    await h.answerProbes();
    const before = h.sockets.length;

    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(before);
    expect(h.probes()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Frame Handling
// ---------------------------------------------------------------------------

describe("frame handling", () => {
  test("an error frame surfaces on the emitter and leaves the socket up", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);
    h.client.attach(AGENT);

    socket.deliver({ t: "error", agentId: AGENT, message: "policy denied that tool", code: "policy" });

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toEqual({ message: "policy denied that tool", code: "policy", agentId: AGENT });
    expect(socket.closedWith).toBeNull();
    expect(h.sockets).toHaveLength(1);
    expect(h.client.connectionState).toBe("connected");

    socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "still flowing" });
    expect(h.updates.map((event) => event.update)).toEqual(["still flowing"]);
  });

  test("an unknown frame type is ignored rather than thrown", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);
    h.client.attach(AGENT);

    expect(() => {
      socket.deliver({ t: "telemetry", agentId: AGENT, samples: [1, 2, 3] });
    }).not.toThrow();

    expect(h.errors).toEqual([]);
    expect(socket.closedWith).toBeNull();

    socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "after the unknown" });
    expect(h.updates.map((event) => event.update)).toEqual(["after the unknown"]);
  });

  test("malformed payloads are reported without killing the connection", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    expect(() => socket.onmessage?.({ data: "{not json" })).not.toThrow();
    expect(() => socket.onmessage?.({ data: JSON.stringify({ nope: true }) })).not.toThrow();
    expect(() => socket.onmessage?.({ data: new Uint8Array([1, 2]) })).not.toThrow();

    expect(h.errors.map((error) => error.code)).toEqual(["bad_frame", "bad_frame", "bad_frame"]);
    expect(socket.closedWith).toBeNull();
    expect(h.client.connectionState).toBe("connected");
  });

  test("speech and transcript frames are delivered to listeners, not swallowed", () => {
    const h = harness();
    const speech: Array<{ agentId: string; pcm: string }> = [];
    const transcripts: Array<{ text: string; final: boolean }> = [];
    h.client.on("speech", (event) => speech.push({ agentId: event.agentId, pcm: event.pcm }));
    h.client.on("transcript", (event) => transcripts.push({ text: event.text, final: event.final }));
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "speech", agentId: AGENT, pcm: "AAAA" });
    socket.deliver({ t: "transcript", agentId: AGENT, text: "hello", final: true });

    expect(speech).toEqual([{ agentId: AGENT, pcm: "AAAA" }]);
    expect(transcripts).toEqual([{ text: "hello", final: true }]);
    expect(h.errors).toEqual([]);
  });

  test("a say frame reaches listeners as text, with the seq it derives from", () => {
    const h = harness();
    const said: Array<{ agentId: string; seq: number; text: string }> = [];
    h.client.on("say", (event) => {
      said.push({ agentId: event.agentId, seq: event.seq, text: event.text });
    });
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "say", agentId: AGENT, seq: 12, text: "Twelve tests passing." });

    expect(said).toEqual([{ agentId: AGENT, seq: 12, text: "Twelve tests passing." }]);
    expect(h.errors).toEqual([]);
  });

  test("say carries its own seq so a replayed summary is not spoken twice", () => {
    const h = harness();
    const seqs: number[] = [];
    h.client.on("say", (event) => seqs.push(event.seq));
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "say", agentId: AGENT, seq: 12, text: "Done." });
    socket.deliver({ t: "say", agentId: AGENT, seq: 12, text: "Done." });
    socket.deliver({ t: "say", agentId: AGENT, seq: 19, text: "Also done." });

    expect(seqs).toEqual([12, 12, 19]);
  });

  test("a client with no say listener is unharmed by a say frame", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    expect(() => socket.deliver({ t: "say", agentId: AGENT, seq: 3, text: "hi" })).not.toThrow();
    expect(h.errors).toEqual([]);
    expect(socket.closedWith).toBeNull();
  });

  test("a client with no voice listener is unharmed by a speech frame", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    expect(() => socket.deliver({ t: "speech", agentId: AGENT, pcm: "AAAA" })).not.toThrow();
    expect(h.errors).toEqual([]);
    expect(socket.closedWith).toBeNull();
  });

  test("a listener that throws cannot take the connection down", () => {
    const h = harness();
    h.client.on("update", () => {
      throw new Error("view is broken");
    });
    h.client.start();
    const socket = bringUp(h);
    h.client.attach(AGENT);

    expect(() => socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "x" })).not.toThrow();
    expect(socket.closedWith).toBeNull();
    expect(h.updates.map((event) => event.seq)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// 5. Outbound Frames
// ---------------------------------------------------------------------------

describe("outbound frames", () => {
  test("prompt, cancel, and decide are shaped as the contract says", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    h.client.prompt(AGENT, "ship it");
    h.client.prompt(AGENT, "look at this", ["data:image/png;base64,AAAA"]);
    h.client.cancel(AGENT);
    h.client.decide(AGENT, "req_1", "allow", "always");
    h.client.decide(AGENT, "req_2", "deny");

    expect(socket.sent).toEqual([
      { t: "prompt", agentId: AGENT, text: "ship it" },
      { t: "prompt", agentId: AGENT, text: "look at this", images: ["data:image/png;base64,AAAA"] },
      { t: "cancel", agentId: AGENT },
      { t: "decide", agentId: AGENT, requestId: "req_1", choice: "allow", scope: "always" },
      { t: "decide", agentId: AGENT, requestId: "req_2", choice: "deny" },
    ]);
  });

  test("the token travels in the query string, not the body", () => {
    const h = harness();
    h.client.start();
    expect(h.latest().url).toBe("ws://127.0.0.1:7717/v1/socket?token=tok_test");
  });

  test("a prompt sent while disconnected is refused out loud, not queued", () => {
    const h = harness();
    h.client.start();
    bringUp(h);
    h.latest().drop();

    h.client.prompt(AGENT, "this must not be replayed later");

    expect(h.errors.some((error) => error.code === "offline")).toBe(true);
    h.clock.runNext();
    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });
    expect(second.framesOfType("prompt")).toEqual([]);
  });

  test("an attach issued while offline is resent on the next hello", () => {
    const h = harness();
    h.client.start();
    h.client.attach(AGENT);
    expect(h.errors).toEqual([]);

    const socket = bringUp(h);
    expect(socket.framesOfType("attach")).toEqual([{ t: "attach", agentId: AGENT }]);
  });

  test("an instruction lost to a closed socket is reported; a ping is not", () => {
    const h = harness({ pingIntervalMs: 15_000 });
    const errors: string[] = [];
    h.client.on("error", (event) => errors.push(event.message));

    h.client.start();
    const socket = h.latest();
    socket.accept();
    socket.readyState = 3;

    h.client.prompt(AGENT, "do the thing");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("prompt");

    h.client.attach(AGENT);
    expect(errors.length).toBe(1);

    h.clock.runNext();
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("prompt");
  });
});

// ---------------------------------------------------------------------------
// 6. Liveness
// ---------------------------------------------------------------------------

describe("liveness", () => {
  test("a missing pong is treated as a dead link and triggers a reconnect", () => {
    const h = harness({ pingIntervalMs: 15_000, pongTimeoutMs: 10_000 });
    h.client.start();
    const socket = bringUp(h);

    expect(h.clock.runNext()).toBe(15_000);
    expect(socket.framesOfType("ping")).toEqual([{ t: "ping" }]);
    expect(h.clock.runNext()).toBe(10_000);

    expect(h.errors.some((error) => error.code === "timeout")).toBe(true);
    expect(socket.closedWith?.code).toBe(4000);
    expect(h.statuses.at(-1)?.state).toBe("reconnecting");
  });

  test("a pong clears the deadline and the link stays up", () => {
    const h = harness({ pingIntervalMs: 15_000, pongTimeoutMs: 10_000 });
    h.client.start();
    const socket = bringUp(h);

    h.clock.runNext();
    socket.deliver({ t: "pong" });

    expect(h.clock.pendingDelays()).toEqual([15_000]);
    expect(socket.closedWith).toBeNull();
    expect(h.client.connectionState).toBe("connected");
  });

  test("close stops reconnecting", () => {
    const h = harness();
    h.client.start();
    bringUp(h);

    h.client.close();
    expect(h.statuses.at(-1)?.state).toBe("offline");
    expect(h.clock.pendingDelays()).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  test("reconnectNow skips a pending wait but never a connect in flight", () => {
    const h = harness({ backoff: { baseMs: 30_000, maxMs: 30_000, factor: 1, jitter: 0 } });
    h.client.start();
    bringUp(h);
    h.client.attach(AGENT);

    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(1);

    h.latest().drop();
    expect(h.clock.pendingDelays()).toEqual([30_000]);

    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(2);
    expect(h.clock.pendingDelays()).toEqual([]);

    h.client.reconnectNow();
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(2);

    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });
    expect(lastAttachSeq(second)).toBeUndefined();
    expect(h.client.connectionState).toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// 7. Status Reporting
// ---------------------------------------------------------------------------

describe("status", () => {
  test("reports connecting, connected, then reconnecting with a delay", () => {
    const h = harness({ backoff: { baseMs: 800, maxMs: 5_000, factor: 2, jitter: 0 } });
    h.client.start();
    expect(h.statuses.map((event) => event.state)).toEqual(["connecting"]);

    bringUp(h);
    expect(h.statuses.at(-1)?.state).toBe("connected");

    h.latest().drop("signal lost");
    const last = h.statuses.at(-1);
    expect(last?.state).toBe("reconnecting");
    expect(last?.delayMs).toBe(800);
    expect(last?.reason).toBe("signal lost");
  });

  test("says offline rather than reconnecting when the device has no network", () => {
    const clock = new ManualClock();
    const sockets: FakeSocket[] = [];
    const statuses: StatusEvent[] = [];
    let online = true;

    const client = new OmpdClient({
      url: "ws://127.0.0.1:7717/v1/socket",
      token: "tok_test",
      backoff: { baseMs: 300, maxMs: 1_000, factor: 2, jitter: 0 },
      random: () => 0,
      schedule: clock.schedule,
      isOnline: () => online,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    client.on("status", (event) => statuses.push(event));

    client.start();
    const socket = sockets.at(-1);
    socket?.accept();
    socket?.deliver({ t: "hello", deviceId: "dev_test", agents: [] });

    online = false;
    socket?.drop();

    expect(statuses.at(-1)?.state).toBe("offline");
    expect(statuses.at(-1)?.delayMs).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 8. Credential Probe & agentsEndpoint Mapping
// ---------------------------------------------------------------------------

describe("credential probe & agentsEndpoint mapping", () => {
  test("agentsEndpoint maps a socket address onto the daemon's http origin", () => {
    expect(agentsEndpoint("ws://127.0.0.1:7717/v1/socket")).toBe("http://127.0.0.1:7717/v1/agents");
    expect(agentsEndpoint("ws://127.0.0.1:7717/v1/socket?token=x")).toBe("http://127.0.0.1:7717/v1/agents");
    expect(agentsEndpoint("wss://ompd.example.com/v1/socket")).toBe("https://ompd.example.com/v1/agents");
    expect(agentsEndpoint("wss://home.example:443/v1/socket?token=x#frag")).toBe(
      "https://home.example:443/v1/agents",
    );
    expect(agentsEndpoint("https://host/anything")).toBe("https://host/v1/agents");
  });

  test("an address that is not a socket url yields nothing to probe", () => {
    expect(agentsEndpoint("not a url")).toBeNull();
    expect(agentsEndpoint("ws://")).toBeNull();
    expect(agentsEndpoint("file:///etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. WebView Surface
// ---------------------------------------------------------------------------

describe("webView surface", () => {
  test("registerWebView sends a webview_register frame", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    h.client.registerWebView(AGENT);

    expect(socket.sent).toEqual([{ t: "webview_register", agentId: AGENT }]);
  });

  test("hello re-sends attach before webview_register for each agent after reconnect", () => {
    const agent2: AgentId = "agt_9876543210fedcba";
    const h = harness();
    h.client.start();
    const first = bringUp(h);

    h.client.attach(AGENT);
    h.client.registerWebView(AGENT);
    h.client.attach(agent2);
    h.client.registerWebView(agent2);

    first.drop();
    h.clock.runNext();

    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    const sent = second.sent;
    const attach1Idx = sent.findIndex((f) => f.t === "attach" && f.agentId === AGENT);
    const attach2Idx = sent.findIndex((f) => f.t === "attach" && f.agentId === agent2);
    const reg1Idx = sent.findIndex((f) => f.t === "webview_register" && f.agentId === AGENT);
    const reg2Idx = sent.findIndex((f) => f.t === "webview_register" && f.agentId === agent2);

    expect(attach1Idx).toBeGreaterThan(-1);
    expect(attach2Idx).toBeGreaterThan(-1);
    expect(reg1Idx).toBeGreaterThan(-1);
    expect(reg2Idx).toBeGreaterThan(-1);

    // The daemon refuses registrations for agents this socket has not attached.
    expect(attach1Idx).toBeLessThan(reg1Idx);
    expect(attach1Idx).toBeLessThan(reg2Idx);
    expect(attach2Idx).toBeLessThan(reg1Idx);
    expect(attach2Idx).toBeLessThan(reg2Idx);
  });

  test("detach clears the webview registration so a later hello does not re-register", () => {
    const h = harness();
    h.client.start();
    const first = bringUp(h);

    h.client.attach(AGENT);
    h.client.registerWebView(AGENT);
    h.client.detach(AGENT);

    first.drop();
    h.clock.runNext();

    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    expect(second.framesOfType("webview_register")).toEqual([]);
  });

  test("unregisterWebView sends a webview_unregister frame and stops replay", () => {
    const h = harness();
    h.client.start();
    const first = bringUp(h);

    h.client.attach(AGENT);
    h.client.registerWebView(AGENT);
    h.client.unregisterWebView(AGENT);

    expect(first.framesOfType("webview_unregister")).toEqual([{ t: "webview_unregister", agentId: AGENT }]);

    first.drop();
    h.clock.runNext();

    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    expect(second.framesOfType("webview_register")).toEqual([]);
  });

  test("inbound webview_action emits an event and webViewResult sends a webview_result frame", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);
    h.client.attach(AGENT);

    const actionData: WebViewAction = { kind: "click", ref: "btn" };
    socket.deliver({
      t: "webview_action",
      agentId: AGENT,
      requestId: "req_wv_1",
      action: actionData,
    });

    expect(h.webviews).toEqual([
      {
        agentId: AGENT,
        requestId: "req_wv_1",
        action: actionData,
      },
    ]);

    const resultData: WebViewActionResult = { kind: "ack", url: "https://example.com", title: "Example" };
    h.client.webViewResult(AGENT, "req_wv_1", resultData);

    expect(socket.framesOfType("webview_result")).toEqual([
      {
        t: "webview_result",
        agentId: AGENT,
        requestId: "req_wv_1",
        result: resultData,
      },
    ]);
  });

  test("losing webview_register to a closed socket does not raise an error while webview_result does", () => {
    const h = harness();
    const errors: string[] = [];
    h.client.on("error", (event) => errors.push(event.message));
    h.client.start();
    const first = bringUp(h);

    h.client.attach(AGENT);
    first.readyState = 3;
    h.client.registerWebView(AGENT);
    expect(errors).toEqual([]);

    const resultData: WebViewActionResult = { kind: "error", message: "webview destroyed" };
    h.client.webViewResult(AGENT, "req_wv_2", resultData);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("webview_result");

    first.drop();
    h.clock.runNext();
    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    expect(second.framesOfType("webview_register")).toEqual([{ t: "webview_register", agentId: AGENT }]);
  });
});
