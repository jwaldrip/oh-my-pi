/**
 * A scripted ACP peer.
 *
 * It speaks the real wire protocol through the real `AcpClient`, so everything
 * under test -- framing, correlation, the permission callback, write
 * serialization -- is production code. Only the subprocess is replaced.
 *
 * This exists because the most security-critical path in ompd is also the one
 * a live-model test covers worst: slow, costly, and non-deterministic. Here the
 * agent's behaviour is chosen by the test.
 */

import { AcpClient, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";

export interface ScriptedToolCall {
  toolCallId: string;
  title: string;
  /** ACP tool kind. `execute` maps to the bash tool in the supervisor. */
  kind: string;
  rawInput: unknown;
}

export interface FakeHostController {
  /** The factory to hand to `Supervisor`. */
  factory: (opts: SpawnLocalHostOptions) => LocalHost;
  /** Ask the client for permission exactly as `omp acp` would. Resolves to the option id. */
  requestPermission(sessionId: string, call: ScriptedToolCall): Promise<string>;
  /**
   * Ask an `elicitation/create` exactly as OMP's internal approval gate does.
   *
   * Resolves to the value the client chose, or `<declined>` when it declined,
   * which is what the real host reads as a denial. This is the only channel a
   * `write` is visible on, so it is the one the write gate is tested through.
   */
  elicit(sessionId: string, message: string, enumValues: string[]): Promise<string>;
  /** Push a `session/update` notification. */
  emitUpdate(sessionId: string, update: unknown): void;
  /** Session ids handed out by `session/new`, in order. */
  sessions: string[];
  /** Full `session/new` params, used to prove daemon-provided MCP mounts. */
  newRequests: Array<{ cwd: string; mcpServers: unknown[] }>;
  /**
   * Session ids the peer was asked to load via `session/load`, in order.
   * Kept separate from `sessions` on purpose: a resume that mistakenly
   * minted a fresh session would show up in `sessions`, not here, and a test
   * asserting `sessions` stayed empty is how "resumed, not restarted" is
   * proven at the wire level.
   */
  loads: string[];
  /** Full `session/load` params, used to prove restored tool mounts. */
  loadRequests: Array<{ sessionId: string; cwd: string; mcpServers: unknown[] }>;
  /** Every `session/prompt` the supervisor sent. */
  prompts: Array<{ sessionId: string; text: string }>;
  /** Session ids the peer was told to cancel, in order. */
  cancels: string[];
  /** Current mode per session, as `session/set_mode` left it. */
  modeOf(sessionId: string): string;
  /** Set the reply a `session/prompt` resolves with. */
  onPrompt(fn: (sessionId: string, text: string) => Promise<unknown> | unknown): void;
  /**
   * Set what `session/close` does. Answers immediately by default.
   *
   * A peer that never answers is how teardown hangs, which is the only way to
   * reach a run that has decided its outcome but has not recorded it yet.
   */
  onClose(fn: (sessionId: string) => Promise<unknown> | unknown): void;
}

export function createFakeHost(): FakeHostController {
  let nextSession = 1;
  let nextId = 10_000;
  // The supervisor keys its host pool by pid, and it spawns concurrently: two
  // overlapping createAgent calls both find the pool empty and both spawn. One
  // shared pid would collide there and one shared client would let the second
  // host silently steal the first one's transport.
  let nextPid = 424_242;
  let latest: AcpClient | null = null;
  const sessions: string[] = [];
  const newRequests: Array<{ cwd: string; mcpServers: unknown[] }> = [];
  const loads: string[] = [];
  const loadRequests: Array<{ sessionId: string; cwd: string; mcpServers: unknown[] }> = [];
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const waiters = new Map<number | string, (result: unknown) => void>();
  /** Which host serves each session, so a frame reaches the right transport. */
  const sessionClients = new Map<string, AcpClient>();
  const cancels: string[] = [];
  /** Mode per session, mirroring what `omp acp` reports in `configOptions`. */
  const modes = new Map<string, string>();
  /**
   * In-flight prompts, so `session/cancel` can settle the turn the way a real
   * agent does: the pending `session/prompt` answers with a cancelled stop
   * reason rather than being abandoned.
   */
  const inFlight = new Map<string, PromiseWithResolvers<unknown>>();
  let promptHandler: (sessionId: string, text: string) => Promise<unknown> | unknown = () => ({
    stopReason: "end_turn",
  });
  let closeHandler: (sessionId: string) => Promise<unknown> | unknown = () => ({});

  /** Deliver a frame to one host's client as if it came off the wire. */
  const toClient = (client: AcpClient | null, obj: unknown): void => {
    client?.ingest(JSON.stringify(obj) + "\n");
  };

  /**
   * The host serving a session. Unknown ids fall back to the most recent host,
   * which is what a single-host test has always relied on.
   */
  const routeTo = (sessionId: string): AcpClient | null => {
    return sessionClients.get(sessionId) ?? latest;
  };

  /** The `configOptions` block, shaped exactly as `omp acp` reports it. */
  const configFor = (sessionId: string): unknown[] => {
    return [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: modes.get(sessionId) ?? "default",
        options: [
          { value: "default", name: "Default", description: "Standard ACP headless mode" },
          { value: "plan", name: "Plan", description: "Read-only planning mode" },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "anthropic/claude-opus-5",
        options: [{ value: "anthropic/claude-opus-5", name: "Claude Opus 5" }],
      },
    ];
  };

  // Handles frames the supervisor's client sends *to* the fake agent.
  const fromClient = async (client: AcpClient, line: string): Promise<void> => {
    const msg = JSON.parse(line) as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
    };

    // A response to a request the fake agent made (i.e. our permission ask).
    if (msg.id !== undefined && msg.method === undefined) {
      waiters.get(msg.id)?.(msg.result);
      waiters.delete(msg.id);
      return;
    }

    if (msg.method === "initialize") {
      toClient(client, {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake", version: "0" },
          agentCapabilities: { loadSession: true },
        },
      });
      return;
    }

    if (msg.method === "session/new") {
      newRequests.push({
        cwd: String(msg.params?.cwd),
        mcpServers: Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [],
      });
      const sessionId = `sess_${nextSession++}`;
      sessions.push(sessionId);
      sessionClients.set(sessionId, client);
      modes.set(sessionId, "default");
      // Real `omp acp` answers with the mode and model selectors alongside the
      // id. Returning only the id here would let a client that drops the rest
      // of the response pass its tests and still be wrong against the peer.
      toClient(client, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId, configOptions: configFor(sessionId) },
      });
      return;
    }

    if (msg.method === "session/load") {
      // Real `omp acp` resolves this against an on-disk session file matching
      // `sessionId` and replays its transcript as `session/update` frames
      // before answering; `sessionId` is never minted here the way
      // `session/new` mints one. That distinction (`loads` vs `sessions`) is
      // the thing a "resume, don't restart" test asserts on.
      const sessionId = String(msg.params?.sessionId);
      loads.push(sessionId);
      loadRequests.push({
        sessionId,
        cwd: String(msg.params?.cwd),
        mcpServers: Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [],
      });
      sessionClients.set(sessionId, client);
      if (!modes.has(sessionId)) modes.set(sessionId, "default");
      toClient(client, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { configOptions: configFor(sessionId), modes: [] },
      });
      return;
    }

    if (msg.method === "session/set_mode") {
      const sessionId = String(msg.params?.sessionId);
      const modeId = String(msg.params?.modeId);
      modes.set(sessionId, modeId);
      toClient(client, { jsonrpc: "2.0", id: msg.id, result: {} });
      // Both notifications the real peer emits, in the order it emits them.
      toClient(client, {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeId } },
      });
      toClient(client, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: configFor(sessionId) },
        },
      });
      return;
    }

    if (msg.method === "session/prompt") {
      const sessionId = String(msg.params?.sessionId);
      const blocks = msg.params?.prompt as Array<{ text?: string }> | undefined;
      const text = blocks?.[0]?.text ?? "";
      prompts.push({ sessionId, text });

      // Raced against cancellation rather than simply awaited, because that is
      // the property under test: a cancel has to settle a turn that is still
      // streaming, not wait politely for it to finish on its own.
      const cancelled = Promise.withResolvers<unknown>();
      inFlight.set(sessionId, cancelled);
      const result = await Promise.race([
        Promise.resolve(promptHandler(sessionId, text)),
        cancelled.promise,
      ]);
      inFlight.delete(sessionId);
      toClient(client, { jsonrpc: "2.0", id: msg.id, result });
      return;
    }

    if (msg.method === "session/cancel") {
      const sessionId = String(msg.params?.sessionId);
      cancels.push(sessionId);
      inFlight.get(sessionId)?.resolve({ stopReason: "cancelled" });
      return;
    }

    if (msg.method === "session/close") {
      const result = await Promise.resolve(closeHandler(String(msg.params?.sessionId)));
      toClient(client, { jsonrpc: "2.0", id: msg.id, result });
      return;
    }

    // Anything else that expects an answer gets an empty one.
    if (msg.id !== undefined) {
      toClient(client, { jsonrpc: "2.0", id: msg.id, result: {} });
    }
  };

  const factory = (opts: SpawnLocalHostOptions): LocalHost => {
    const pid = nextPid++;
    const client: AcpClient = new AcpClient((line) => {
      // Detach so the client is never re-entered from inside its own write.
      queueMicrotask(() => void fromClient(client, line));
    }, opts);
    latest = client;
    return {
      client,
      pid,
      // Bound to this host's own client, so killing one host cannot close
      // another's transport.
      kill: () => client.close({ code: 0, stderr: "" }),
      exited: new Promise<number>(() => {}),
    };
  };

  return {
    factory,
    sessions,
    newRequests,
    loads,
    loadRequests,
    prompts,
    cancels,
    modeOf: (sessionId) => modes.get(sessionId) ?? "default",
    onPrompt: (fn) => {
      promptHandler = fn;
    },
    onClose: (fn) => {
      closeHandler = fn;
    },
    emitUpdate: (sessionId, update) => {
      toClient(routeTo(sessionId), {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update },
      });
    },
    requestPermission: (sessionId, call) =>
      new Promise<string>((resolve) => {
        const id = nextId++;
        waiters.set(id, (result) => {
          const outcome = (result as { outcome?: { optionId?: string } } | undefined)?.outcome;
          resolve(outcome?.optionId ?? "<none>");
        });
        toClient(routeTo(sessionId), {
          jsonrpc: "2.0",
          id,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { ...call, status: "pending", content: [], locations: [] },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
              { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
            ],
          },
        });
      }),
    elicit: (sessionId, message, enumValues) =>
      new Promise<string>((resolve) => {
        const id = nextId++;
        waiters.set(id, (result) => {
          const r = result as { action?: string; content?: { value?: unknown } } | undefined;
          // `accept` with a value is a choice. Anything else is what the real
          // host sees when a client has nothing to say, and it denies.
          resolve(
            r?.action === "accept" && typeof r.content?.value === "string"
              ? r.content.value
              : "<declined>",
          );
        });
        toClient(routeTo(sessionId), {
          jsonrpc: "2.0",
          id,
          method: "elicitation/create",
          // Shaped exactly as omp's elicitation bridge sends it: a form whose
          // single `value` property carries the enum. A client that reads the
          // choices from anywhere else would pass against a looser fake and
          // fail against the real host.
          params: {
            mode: "form",
            sessionId,
            message,
            requestedSchema: {
              type: "object",
              properties: { value: { type: "string", enum: enumValues } },
              required: ["value"],
            },
          },
        });
      }),
  };
}
