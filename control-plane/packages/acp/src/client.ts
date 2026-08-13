/**
 * ACP (Agent Client Protocol) client for `omp acp`.
 *
 * Transport-agnostic by construction: it consumes a write function and is fed
 * decoded text, so a local pipe, `docker exec -i`, and a tunnelled cloud socket
 * are all the same thing to it. See `spawnLocalHost` for the local case.
 *
 * Three rules are enforced here and nowhere else:
 *
 * 1. **Never race a stream read.** A single pump owns the reader for the
 *    lifetime of the connection. Racing `read()` against a timeout orphans the
 *    pending read and silently drops frames, so the shape that permits it is
 *    simply not available.
 * 2. **Every outbound frame is serialized.** Inbound messages are dispatched
 *    concurrently (a slow policy callback must not block unrelated traffic),
 *    which means several handlers can want to write at once. All writes funnel
 *    through one queue so two JSON-RPC frames can never interleave on stdin.
 * 3. **Both approval channels are answered by caller-supplied callbacks.**
 *    There is no default for either, so a host with no policy attached cannot
 *    be constructed. `session/request_permission` is one channel;
 *    `elicitation/create` is the other, and it is the only one that fires for
 *    an ordinary file write. See `docs/acp-approval-gate.md`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


export type JsonRpcId = number | string;

export type AcpOptionId = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  rawInput?: unknown;
  content?: unknown[];
  locations?: unknown[];
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface AcpSessionSummary {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  _meta?: { messageCount?: number; size?: number };
}

export interface AcpCloseInfo {
  code: number | null;
  stderr: string;
}

export interface PromptResult {
  stopReason: string;
}

/**
 * A question OMP's internal approval gate, or anything else inside the host,
 * asks of the client's UI. For a tool approval `enumValues` is
 * `["Approve", "Deny"]` and `message` is the rendered prompt; see
 * `parseApprovalPrompt`.
 */
export interface ElicitationRequest {
  sessionId: string;
  message: string;
  /**
   * The choices offered, when the requested schema is an enum. Empty for a
   * free-text or boolean elicitation. This is what identifies a question,
   * because it is a literal constant in the host and prose is not.
   */
  enumValues: string[];
  /** The raw schema, for a caller that needs more than the enum. */
  requestedSchema: unknown;
}

/**
 * `accept` answers the question. `decline` reproduces, exactly, what a client
 * that never advertised the elicitation capability produces: the host's
 * `select` resolves to undefined, `confirm` to false. Declining is therefore
 * never a way to accidentally consent.
 */
export type ElicitationOutcome = { action: "accept"; value: string } | { action: "decline" };

export interface AcpClientOptions {
  /** Answers `session/request_permission`. Required: there is no safe default. */
  onPermission: (req: PermissionRequest) => Promise<AcpOptionId>;
  /**
   * Answers `elicitation/create`. Required for the same reason as
   * `onPermission`, and more urgently: this is the channel a `write` arrives
   * on, so a host without it has no gate on ordinary file mutation at all.
   */
  onElicitation: (req: ElicitationRequest) => Promise<ElicitationOutcome>;
  /** Receives every `session/update` notification. */
  onUpdate?: (sessionId: string, update: unknown) => void;
  /** Called once the transport closes for any reason. */
  onClose?: (info: AcpCloseInfo) => void;
  /** Diagnostics sink. */
  onLog?: (line: string) => void;
  /** Deadline for control-plane requests: initialize, session/new, and friends. */
  requestTimeoutMs?: number;
  /**
   * Deadline for `session/prompt` alone.
   *
   * Separate from `requestTimeoutMs` because a turn is not a request. A turn
   * contains model time plus every approval it raises, and each approval can
   * take a human's full deciding window. One deadline for both means the turn
   * expires while somebody is still looking at their phone, and the caller
   * gets a transport error where it should have got a recorded denial.
   */
  promptTimeoutMs?: number;
  /** Hard cap on a single inbound line. Guards against an unbounded buffer. */
  maxLineBytes?: number;
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/**
 * An hour. A turn is model time plus every approval it raises, and this is the
 * deadline that says the host has stopped answering rather than that the work
 * is taking a while.
 *
 * Exported because the supervisor computes its own floor from the approval
 * window and must start from this number, not from zero. Deriving the turn
 * deadline from the approval window alone makes a short approval timeout
 * shrink the time a model is allowed to think, which is a different thing
 * entirely and produces transport errors on perfectly healthy turns.
 */
export const DEFAULT_PROMPT_TIMEOUT_MS = 3_600_000;

export class AcpClient {
  #rawWrite: (line: string) => void | Promise<void>;
  #opts: AcpClientOptions;
  #nextId = 1;
  #pending = new Map<JsonRpcId, Pending>();
  #closed = false;
  #timeout: number;
  #promptTimeout: number;
  #maxLine: number;
  #initialized: unknown = null;
  #buf = "";
  /** Tail of the outbound write chain. Guarantees frames never interleave. */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(write: (line: string) => void | Promise<void>, opts: AcpClientOptions) {
    this.#rawWrite = write;
    this.#opts = opts;
    this.#timeout = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#promptTimeout = opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.#maxLine = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  get agentInfo(): unknown {
    return this.#initialized;
  }

  /** Serialize one JSON-RPC frame onto the transport. */
  #send(obj: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new AcpError("transport closed"));
    const line = JSON.stringify(obj) + "\n";
    const attempt = this.#writeChain.then(() => this.#rawWrite(line));
    // Keep the chain alive after a failed write so one error does not wedge
    // every subsequent frame; the failure still surfaces to this caller.
    this.#writeChain = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt.then(() => undefined);
  }

  /**
   * Feed raw decoded text from the transport. The caller's pump owns the
   * reader; this only parses and dispatches.
   */
  ingest(text: string): void {
    this.#buf += text;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.#opts.onLog?.(`unparseable frame: ${line.slice(0, 200)}`);
        continue;
      }
      void this.#dispatch(msg);
    }
    if (this.#buf.length > this.#maxLine) {
      // A line this long is a malfunctioning peer, not a big transcript; the
      // alternative is growing this buffer until the daemon dies.
      const overflow = this.#buf.length;
      this.#buf = "";
      this.#opts.onLog?.(`inbound line exceeded ${this.#maxLine}B (${overflow}B), buffer dropped`);
      this.close({ code: null, stderr: "inbound frame overflow" });
    }
  }

  async #dispatch(msg: unknown): Promise<void> {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    // Response to something we sent.
    if (m.id !== undefined && m.method === undefined) {
      const pending = this.#pending.get(m.id as JsonRpcId);
      if (!pending) return;
      this.#pending.delete(m.id as JsonRpcId);
      clearTimeout(pending.timer);
      if (m.error) {
        const e = m.error as { code: number; message: string; data?: unknown };
        pending.reject(new AcpError(e.message, e.code, e.data));
      } else {
        pending.resolve(m.result);
      }
      return;
    }

    // Notification from the agent.
    if (m.id === undefined && typeof m.method === "string") {
      if (m.method === "session/update") {
        const p = m.params as { sessionId?: string; update?: unknown } | undefined;
        if (p?.sessionId) this.#opts.onUpdate?.(p.sessionId, p.update ?? p);
      }
      return;
    }

    // Request from the agent: we must answer.
    if (m.id !== undefined && typeof m.method === "string") {
      await this.#serve(m.id as JsonRpcId, m.method, m.params);
    }
  }

  async #serve(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      if (method === "session/request_permission") {
        const req = params as PermissionRequest;
        const optionId = await this.#opts.onPermission(req);
        // Only answer with an option the agent actually offered; an unknown id
        // can be treated as a protocol error and wedge the turn.
        const offered = new Set((req.options ?? []).map((o) => o.optionId));
        const chosen = offered.has(optionId)
          ? optionId
          : optionId.startsWith("allow")
            ? "allow_once"
            : "reject_once";
        await this.#send({
          jsonrpc: "2.0",
          id,
          result: { outcome: { outcome: "selected", optionId: chosen } },
        });
        return;
      }
      if (method === "elicitation/create") {
        const p = (params ?? {}) as {
          sessionId?: string;
          message?: string;
          requestedSchema?: { properties?: { value?: { enum?: unknown } } };
        };
        const raw = p.requestedSchema?.properties?.value?.enum;
        const outcome = await this.#opts.onElicitation({
          sessionId: p.sessionId ?? "",
          message: p.message ?? "",
          enumValues: Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [],
          requestedSchema: p.requestedSchema,
        });
        await this.#send({
          jsonrpc: "2.0",
          id,
          result:
            outcome.action === "accept"
              ? { action: "accept", content: { value: outcome.value } }
              : { action: "decline" },
        });
        return;
      }
      // Everything else is declined explicitly rather than left to time out.
      await this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unsupported method: ${method}` },
      });
    } catch (err) {
      this.#opts.onLog?.(`handler for ${method} threw: ${String(err)}`);
      // Fail closed: a policy callback that throws must never become an allow.
      // For an elicitation that means declining, which is exactly what a
      // client with no elicitation capability produces, and which the host
      // reads as a denial.
      const body =
        method === "session/request_permission"
          ? { result: { outcome: { outcome: "selected", optionId: "reject_once" } } }
          : method === "elicitation/create"
            ? { result: { action: "decline" } }
            : { error: { code: -32603, message: String(err) } };
      await this.#send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
    }
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed) throw new AcpError("transport closed");
    const id = this.#nextId++;
    const deadline = timeoutMs ?? this.#timeout;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AcpError(`timeout after ${deadline}ms: ${method}`));
      }, deadline);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.#send({ jsonrpc: "2.0", id, method, params });
    } catch (err) {
      const p = this.#pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.#pending.delete(id);
      }
      throw err;
    }
    return (await promise) as T;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#send({ jsonrpc: "2.0", method, params });
  }

  // -- protocol surface ----------------------------------------------------

  async initialize(): Promise<unknown> {
    // Minimal client capabilities on purpose: declining fs and terminal keeps
    // file and shell work inside the agent, where it stays behind the
    // permission hook. Advertising them would move that work to us and route
    // it around the gate.
    this.#initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Not optional, and not a convenience. OMP's internal approval gate
        // asks through the UI context, and the UI context only speaks when
        // this is advertised. Without it the gate resolves to its default,
        // which denies every call it covers and tells the client nothing --
        // and the tools it covers include `write`, which the ACP permission
        // hook never sees at all.
        elicitation: { form: {} },
      },
    });
    return this.#initialized;
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const r = await this.request<{ sessionId: string }>("session/new", { cwd, mcpServers });
    return r.sessionId;
  }

  async listSessions(): Promise<AcpSessionSummary[]> {
    const r = await this.request<{ sessions?: AcpSessionSummary[] }>("session/list", {});
    return r.sessions ?? [];
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<void> {
    await this.request("session/load", { sessionId, cwd, mcpServers });
  }

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    return await this.request<PromptResult>(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      this.#promptTimeout,
    );
  }

  async cancel(sessionId: string): Promise<void> {
    await this.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId }).catch(() => {});
  }

  close(info: AcpCloseInfo = { code: null, stderr: "" }): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new AcpError("transport closed"));
    }
    this.#pending.clear();
    this.#opts.onClose?.(info);
  }
}

// ---------------------------------------------------------------------------
// Local host
// ---------------------------------------------------------------------------

export interface LocalHost {
  client: AcpClient;
  pid: number;
  kill(): void;
  exited: Promise<number>;
}

export interface SpawnLocalHostOptions extends AcpClientOptions {
  cwd?: string;
  ompPath?: string;
  extraArgs?: string[];
}

/**
 * The OMP configuration under which every privileged tool reaches ompd's
 * policy. Determined experimentally against omp 17.2.12; `docs/acp-approval-gate.md`
 * carries the measurements and `scripts/probe-elicitation-gate.ts` reproduces
 * them.
 *
 * omp has two independent approval gates and neither one covers everything.
 *
 * **Gate 1, the ACP permission wrapper.** Emits `session/request_permission`.
 * Armed whenever `tools.approvalMode` is not `yolo`, but only for the four
 * tool names in its own table: bash, edit, delete, move. It never fires for
 * `write` or `ast_edit`, and for `edit` it fires only when the call deletes or
 * renames a file. A content-only edit is invisible to it. This is deliberate
 * upstream behaviour, changed in omp 17.2.12, not a misconfiguration.
 *
 * **Gate 2, the internal approval gate.** Wraps every tool and asks through
 * the runner's UI context, which in a headless ACP host is the elicitation
 * bridge. It is armed per tool by `tools.approval.<tool>: prompt`.
 *
 * So the split below is not a preference, it is the only split available:
 *
 * - bash, delete and move go to gate 1 with `allow`, which disarms gate 2 for
 *   them. Gate 1 is the better channel where it works, because it carries
 *   structured `rawInput` and resolved `locations` rather than a rendered
 *   string.
 * - write, edit, multi_edit and ast_edit go to gate 2 with `prompt`, because
 *   for those gate 1 either never fires or fires only for a subset. `edit`
 *   consequently asks twice on a delete or a rename, once per gate; both
 *   answers come from the same policy, so the cost is a duplicate question and
 *   not a divergent decision.
 * - `multi_edit` does not exist in omp 17.2.12. The entry is kept so that if
 *   the tool returns it arrives armed rather than silent.
 *
 * Gate 2 only speaks if the client advertises `elicitation.form`, which
 * `AcpClient.initialize` does. Without that it resolves to its default, which
 * denies, and tells the client nothing at all.
 */
export const GATE_CONFIG_YAML = `# Written by ompd. Do not edit.
#
# approvalMode must not be yolo: a non-yolo mode is what keeps OMP's ACP
# permission wrapper (gate 1) armed, so session/request_permission still fires.
#
# bash, delete and move are 'allow' because gate 1 covers them completely and
# carries structured input. 'allow' disarms OMP's internal gate for them so the
# same call is not approved twice.
#
# write, edit, multi_edit and ast_edit are 'prompt' because gate 1 does not
# cover them: it has no entry for write, multi_edit or ast_edit, and for edit it
# fires only on a delete or a rename. 'prompt' arms OMP's internal gate, which
# reaches ompd as elicitation/create because the client advertises
# elicitation.form. Setting any of these to 'allow' is what let a remote client
# write anywhere on the machine without policy ever running.
tools:
  approvalMode: always-ask
  approval:
    bash: allow
    delete: allow
    move: allow
    write: prompt
    edit: prompt
    multi_edit: prompt
    ast_edit: prompt
`;

/**
 * Args that would disable or weaken the permission hook. `--config` is included
 * because an overlay loaded after ours could set `approvalMode: yolo` and
 * silently remove the gate.
 */
const FORBIDDEN_HOST_ARGS = /^--(approval-mode|auto-approve|yolo|no-tools|tools|config)(=|$)/;

export interface GateConfigFile {
  /** Path to pass as `--config`. */
  path: string;
  /** Private directory holding it; remove this, not just the file. */
  dir: string;
}

/**
 * Remove a gate overlay directory.
 *
 * Best effort: a failed unlink leaves litter, while throwing here would replace
 * whatever error sent us down the cleanup path with a less useful one.
 */
function removeGateDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Write the gate config to a private directory and return its location.
 *
 * Synchronous on purpose. An async write racing the spawn below would let the
 * child read a missing or partial overlay and fall back to the user's global
 * config -- which on a machine configured with `approvalMode: yolo` means an
 * ACP host that never asks permission. That failure is silent and unsafe, so
 * the file must exist in full before the child is created.
 *
 * `mkdtempSync` rather than a fixed directory: it creates a fresh 0700
 * directory with an unpredictable name in one atomic step. A shared
 * `/tmp/ompd-gate` would be hijackable, because `mkdirSync` does not change the
 * mode of a directory that already exists, so another local user could
 * pre-create it world-writable and plant a symlink for us to follow. Replacing
 * this overlay disarms the approval gate, which makes it worth the care.
 *
 * The `wx` flag refuses to follow or overwrite anything already at the path.
 */
function writeGateConfig(): GateConfigFile {
  const dir = mkdtempSync(join(tmpdir(), "ompd-gate-"));
  try {
    const path = join(dir, "gate.yml");
    writeFileSync(path, GATE_CONFIG_YAML, { mode: 0o600, flag: "wx" });
    if (readFileSync(path, "utf8") !== GATE_CONFIG_YAML) {
      throw new AcpError(`gate config at ${path} did not persist intact`);
    }
    return { path, dir };
  } catch (err) {
    // The directory outlives this frame, but a caller that never receives its
    // path can never remove it. No child has read it yet either, so this is one
    // of the two points where removing it at once is both safe and necessary.
    removeGateDir(dir);
    throw err;
  }
}

/**
 * Spawn `omp acp` as a child process and wire it to an AcpClient.
 *
 * The gate configuration is owned by ompd and passed as a `--config` overlay,
 * which outranks the user's global config. That matters: a machine whose global
 * config sets `tools.approvalMode: yolo` would otherwise get an ACP host that
 * never asks permission at all.
 *
 * Callers may pass `extraArgs`, but not to touch any of that. Offending args
 * are rejected rather than quietly dropped, because a silently ungated host
 * looks identical to a safe one.
 */
export function spawnLocalHost(opts: SpawnLocalHostOptions): LocalHost {
  const extra = opts.extraArgs ?? [];
  const offending = extra.find((a) => FORBIDDEN_HOST_ARGS.test(a));
  if (offending) {
    throw new AcpError(
      `extraArgs may not override the approval gate (got ${JSON.stringify(offending)})`,
    );
  }

  const gate = writeGateConfig();

  // `Bun.spawn` throws synchronously for a missing or unexecutable binary and
  // for a `cwd` that does not exist. The overlay is already on disk by then and
  // its path has gone nowhere, so this exit has to remove it by hand. Safe here
  // for the same reason as above: no child exists to be reading it.
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([opts.ompPath ?? "omp", "acp", "--config", gate.path, ...extra], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd ?? process.cwd(),
    });
  } catch (err) {
    removeGateDir(gate.dir);
    throw err;
  }

  // Tied to the child's exit rather than to the connection bookkeeping below,
  // and registered ahead of all of it so no later wiring can strand the
  // overlay. The child's exit is also the earliest safe moment: while it lives
  // it owns `--config`, and an overlay that vanished underneath it would drop
  // the host back onto the user's global config, which may not gate at all.
  void proc.exited.then(() => removeGateDir(gate.dir));

  const enc = new TextEncoder();
  const client = new AcpClient(async (line) => {
    proc.stdin.write(enc.encode(line));
    await proc.stdin.flush();
  }, opts);

  let stderr = "";
  // One pump owns stdout for the connection's lifetime. Never raced.
  void (async () => {
    const dec = new TextDecoder();
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        client.ingest(dec.decode(value, { stream: true }));
      }
    } catch (err) {
      opts.onLog?.(`stdout pump: ${String(err)}`);
    }
  })();

  void (async () => {
    const dec = new TextDecoder();
    const reader = proc.stderr.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        stderr = (stderr + chunk).slice(-8192);
        opts.onLog?.(chunk.trimEnd());
      }
    } catch {
      /* stderr is diagnostics only */
    }
  })();

  const exited = proc.exited.then((code) => {
    client.close({ code, stderr });
    return code;
  });

  return { client, pid: proc.pid, kill: () => proc.kill(), exited };
}
