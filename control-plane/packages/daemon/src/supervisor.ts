/**
 * The supervisor owns agent lifetime.
 *
 * This is the inversion the whole control plane rests on: an agent belongs to
 * the daemon, not to whichever client happened to create it. A phone losing
 * signal must not kill a build.
 *
 * It is also where the approval rule is enforced. `session/request_permission`
 * arrives here, and the answer is decided by `Policy.evaluate()` -- a client's
 * reply is only ever consulted to break a `prompt` tie, and only from a device
 * carrying the approve scope.
 */

import {
  AcpClient,
  DEFAULT_PROMPT_TIMEOUT_MS,
  parseApprovalPrompt,
  spawnLocalHost,
  type AcpOptionId,
  type ElicitationOutcome,
  type ElicitationRequest,
  type LocalHost,
  type PermissionRequest,
  type SpawnLocalHostOptions,
} from "@ompd/acp";
import {
  DefaultPolicy,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  TERMINAL_AGENT_STATES,
  toAcpOption,
  type Actor,
  type Agent,
  type AgentId,
  type AgentState,
  type HostRef,
  type HostSpec,
  type Policy,
  type PolicyDecision,
  type Store,
} from "@ompd/core";
import type { HostHandle, Provisioner } from "./provisioner/types.ts";

/** Thrown when an actor lacks the scope for an operation, or its device is revoked. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface PendingApproval {
  requestId: string;
  agentId: AgentId;
  tool: string;
  title: string;
  input: unknown;
  resolve: (choice: { choice: "allow" | "deny"; scope?: "once" | "always"; actor: Actor }) => void;
}

interface GateResult {
  option: AcpOptionId;
  reason: string;
}

export interface SupervisorEvents {
  onUpdate?: (agentId: AgentId, seq: number, update: unknown) => void;
  onAgentsChanged?: (agents: Agent[]) => void;
  onApprovalNeeded?: (p: Omit<PendingApproval, "resolve">) => void;
}

export interface SupervisorOptions {
  store: Store;
  policy?: Policy;
  events?: SupervisorEvents;
  /** How long a `prompt` decision waits for a human before failing closed. */
  approvalTimeoutMs?: number;
  /**
   * Deadline for one `session/prompt`. Raised automatically when it would not
   * comfortably outlast the approvals a turn can raise; see
   * `APPROVALS_PER_TURN_BUDGET`.
   */
  promptTimeoutMs?: number;
  ompPath?: string;
  onLog?: (line: string) => void;
  /**
   * Host factory seam. Defaults to spawning a real `omp acp` child.
   *
   * Exists so the permission path can be exercised deterministically against a
   * scripted ACP peer. The alternative -- only ever testing against a live
   * model -- makes the most security-critical code in the system the least
   * covered, because those tests are slow, costly, and non-deterministic.
   */
  spawnHost?: (opts: SpawnLocalHostOptions) => LocalHost;
  /**
   * Serves every host kind other than `local`.
   *
   * Optional, and its absence is not a fallback: without it a non-local spec
   * is refused. An operator who asked for a container and silently got a
   * process on the daemon's machine has lost the isolation they asked for and
   * has no way to tell.
   */
  provisioner?: Provisioner;
  /**
   * Per-agent ACP `mcpServers` entries, mounted on both `session/new` and
   * `session/load`. `undefined` (the default) mounts nothing extra.
   *
   * `@ompd/daemon/src/browser`'s WebView MCP server is the first consumer:
   * `mcpServerDescriptor(webViewMcpServer, agentId)` wrapped in an array.
   * Applying it on both paths is load-bearing: resuming a session must restore
   * its tool surface, not silently produce an agent that remembers using a
   * browser but can no longer call it.
   */
  mcpServersFor?: (agentId: AgentId) => unknown[];
}

export interface CreateAgentInput {
  name: string;
  cwd: string;
  host?: HostSpec;
  routineId?: string;
  labels?: Record<string, string>;
}

/**
 * Resume an existing on-disk session under a daemon-owned agent.
 *
 * `sessionId` identifies the session, never a machine (see
 * control-plane/docs/portability.md#the-constraint-this-document-exists-to-impose,
 * point 1): it is only ever looked up on the host this call runs against,
 * through that host's own on-disk session store, exactly like `newSession`'s
 * cwd is. Nothing here assumes the session was created by, or previously
 * served by, this daemon -- only that a `.jsonl` matching `sessionId` is
 * resolvable from `cwd` on the machine the spawned `omp acp` runs on. A
 * caller resuming a session teleported from elsewhere re-roots `cwd` first;
 * this method does not know or care where the session came from.
 */
export interface ResumeAgentInput {
  name: string;
  cwd: string;
  sessionId: string;
  host?: HostSpec;
  routineId?: string;
  labels?: Record<string, string>;
}

/** The gateway's one-socket ACP transport to an already-running TUI. */
export interface LiveTuiAcpTransport {
  send(raw: string): void;
  onMessage(listener: (raw: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface TakeOverTuiSessionInput {
  sessionId: string;
  name: string;
  cwd: string;
  pid: number;
}

interface HostEntry {
  /**
   * Key into `#hosts`. A pid for a local host, and `<kind>:<id>` for a
   * provisioned one, because a provisioned host's pid belongs to the local end
   * of `docker exec` or `ssh` rather than to the thing that has to be
   * destroyed, and pids are reused.
   */
  key: string;
  host: LocalHost;
  spec: HostSpec;
  /** What the agent records. Carries the container or machine id, not the pid. */
  ref: HostRef;
  /** Present only for provisioned hosts; `destroy` releases the container. */
  handle: HostHandle | undefined;
  /** Agents served by this host process. */
  agents: Set<AgentId>;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * How many full-length approvals one turn is assumed to be able to raise.
 *
 * The turn deadline and the approval deadline used to be the same number, so
 * `session/prompt` gave up at the instant the first unanswered approval would
 * have failed closed. That is the worst of both: the caller sees a transport
 * error instead of a policy denial, and the approval row is left `pending`
 * with no decision ever written to it. The turn must outlast the approvals it
 * contains, and a turn can contain more than one.
 */
const APPROVALS_PER_TURN_BUDGET = 10;

/**
 * The choices OMP's tool approval offers, verbatim and in order.
 *
 * An elicitation is identified by what it offers, never by how it is worded.
 * These lists are literal constants inside the host; the prose beside them is
 * a rendering that any release may reword.
 */
const TOOL_APPROVAL_CHOICES = ["Approve", "Deny"] as const;
/** The choices OMP's plan approval offers. */
const PLAN_APPROVAL_CHOICES = ["Approve and execute", "Refine plan"] as const;
const PLAN_APPROVAL_PREFIX = "Approve plan ";
/** Joined so a question is recognised in one comparison, order included. */
const CHOICE_SEP = "\u0000";
const TOOL_APPROVAL_KEY = TOOL_APPROVAL_CHOICES.join(CHOICE_SEP);
const PLAN_APPROVAL_KEY = PLAN_APPROVAL_CHOICES.join(CHOICE_SEP);

/**
 * Ordering for "most restrictive wins" when one call names several targets.
 * A call is only as safe as its worst target.
 */
const SEVERITY: Record<PolicyDecision["action"], number> = { allow: 0, prompt: 1, deny: 2 };

export class Supervisor {
  #store: Store;
  #policy: Policy;
  #events: SupervisorEvents;
  #approvalTimeout: number;
  #promptTimeout: number;
  #ompPath: string | undefined;
  #onLog: ((line: string) => void) | undefined;
  #spawnHost: (opts: SpawnLocalHostOptions) => LocalHost;
  #provisioner: Provisioner | undefined;
  #mcpServersFor: ((agentId: AgentId) => unknown[]) | undefined;

  /** Keyed by `HostEntry.key`. One `omp acp` process serves many agents. */
  #hosts = new Map<string, HostEntry>();
  /** agentId -> `HostEntry.key` */
  #agentHost = new Map<AgentId, string>();
  /** ACP session id -> agentId, for routing session/update. */
  #sessionAgent = new Map<string, AgentId>();
  #pending = new Map<string, PendingApproval>();

  constructor(opts: SupervisorOptions) {
    this.#store = opts.store;
    this.#policy = opts.policy ?? new DefaultPolicy();
    this.#events = opts.events ?? {};
    this.#approvalTimeout = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    // A floor applied to the normal turn deadline, never a replacement for it.
    // Deriving the turn deadline from the approval window alone would let a
    // short approval timeout shrink the time a model is allowed to think, and
    // a healthy turn would then die of a transport error.
    this.#promptTimeout = Math.max(
      opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      this.#approvalTimeout * APPROVALS_PER_TURN_BUDGET,
    );
    this.#ompPath = opts.ompPath;
    this.#spawnHost = opts.spawnHost ?? spawnLocalHost;
    this.#provisioner = opts.provisioner;
    this.#mcpServersFor = opts.mcpServersFor;
  }

  listAgents(): Agent[] {
    return this.#store.listAgents();
  }

  /**
   * Authorization boundary. The supervisor is privileged, so it resolves the
   * actor itself rather than trusting a caller -- a gateway bug, a future
   * second front-end, or a routine invoking this directly must all hit the
   * same gate.
   *
   * The caller-supplied `actor.scopes` are treated as a *claim*, never as
   * truth. Scopes come from the paired device row, so forging an actor with an
   * unknown id and a generous scope list buys nothing. Returns the resolved
   * actor; callers must use it in place of the one they passed in.
   */
  #authorize(actor: Actor, scope: string, action: string, agentId?: AgentId): Actor {
    const deny = (reason: string): never => {
      this.#store.audit({
        action: "approval.decide",
        agentId,
        actorDeviceId: actor.deviceId,
        outcome: "denied",
        detail: { action, reason },
      });
      throw new UnauthorizedError(`${action}: ${reason}`);
    };

    // `daemon` is the internal actor for automatic decisions. It has no device
    // row and is unreachable from the network, so it is the one exemption.
    if (actor.deviceId === "daemon") {
      if (!actor.scopes.includes(scope)) deny(`missing ${scope} scope`);
      return actor;
    }

    const device = this.#store.getDevice(actor.deviceId);
    if (!device) deny("unknown device");
    if (device?.revokedAt) deny("device revoked");

    const granted = device?.scopes ?? [];
    if (!granted.includes(scope)) deny(`missing ${scope} scope`);
    return { deviceId: device?.id ?? actor.deviceId, scopes: granted };
  }

  pendingApprovals(): Array<Omit<PendingApproval, "resolve">> {
    return [...this.#pending.values()].map(({ resolve: _resolve, ...rest }) => rest);
  }

  // -- lifecycle -----------------------------------------------------------

  async createAgent(input: CreateAgentInput, actor: Actor): Promise<Agent> {
    const who = this.#authorize(actor, SCOPE_MANAGE, "agent.create");
    const spec: HostSpec = input.host ?? { kind: "local" };
    if (spec.kind !== "local" && this.#provisioner === undefined) {
      // Container and cloud hosts are the provisioner's job. Failing loudly
      // beats silently running a "cloud" agent on the operator's laptop.
      throw new Error(`host kind ${spec.kind} requires the provisioner`);
    }
    const entry = await this.#hostFor(spec, input.cwd, who);
    return await this.#bindAgentToSession(input, spec, entry, who, {}, (sessionEntry, agentId) =>
      sessionEntry.host.client.newSession(input.cwd, this.#mcpServersFor?.(agentId) ?? []),
    );
  }

  /**
   * Resume an existing on-disk session under a new daemon-owned agent, via
   * ACP `session/load`. See {@link ResumeAgentInput} for what "existing"
   * means here: `sessionId` is looked up on whichever host `cwd` resolves to
   * when the spawned `omp acp` opens it, not against anything this daemon
   * remembers creating.
   *
   * Refuses a session id this daemon already has an agent holding: loading it
   * twice would point two ACP hosts at the same session file with no lock
   * between them (upstream `SessionManager` has none -- see session-manager.ts),
   * and the second writer would corrupt the first one's transcript instead of
   * observing it. A session that is `live-tui` in some other, unmanaged OMP
   * process is the identical hazard from the other direction, and this
   * daemon has no lock file to detect it from here. That is a real,
   * un-hidden constraint, not an oversight: resuming a session this daemon
   * does not already know is idle is the caller's responsibility (informed by
   * the session index's live/dormant status), the same "opt-in, not forced"
   * shape `/collab` has for taking over a session live in a terminal.
   */
  async resumeAgent(input: ResumeAgentInput, actor: Actor): Promise<Agent> {
    const who = this.#authorize(actor, SCOPE_MANAGE, "agent.resume");
    const heldBy = this.#sessionAgent.get(input.sessionId);
    if (heldBy) {
      throw new Error(`session ${input.sessionId} is already held by agent ${heldBy}`);
    }
    const spec: HostSpec = input.host ?? { kind: "local" };
    if (spec.kind !== "local" && this.#provisioner === undefined) {
      throw new Error(`host kind ${spec.kind} requires the provisioner`);
    }
    const entry = await this.#hostFor(spec, input.cwd, who);
    return await this.#bindAgentToSession(input, spec, entry, who, { resumed: true }, async (sessionEntry, agentId) => {
      await sessionEntry.host.client.loadSession(
        input.sessionId,
        input.cwd,
        this.#mcpServersFor?.(agentId) ?? [],
      );
      return input.sessionId;
    });
  }

  /**
   * Claim the ACP leg owned by one already-running TUI.
   *
   * The TUI created its AgentSession before the daemon was involved. `loadSession`
   * is therefore an in-process adoption by the ACP server, not a second OMP
   * process reopening that session's JSONL.
   */
  async takeOverTuiSession(
    input: TakeOverTuiSessionInput,
    transport: LiveTuiAcpTransport,
    actor: Actor,
  ): Promise<Agent> {
    const who = this.#authorize(actor, SCOPE_MANAGE, "agent.takeover");
    const heldBy = this.#sessionAgent.get(input.sessionId);
    if (heldBy) throw new Error(`session ${input.sessionId} is already held by agent ${heldBy}`);

    const key = `tui:${input.sessionId}`;
    if (this.#hosts.has(key)) throw new Error(`session ${input.sessionId} is already being taken over`);

    const client = new AcpClient(raw => transport.send(raw), {
      onPermission: req => this.#onPermission(req),
      onElicitation: req => this.#onElicitation(req),
      onUpdate: (sessionId, update) => this.#onUpdate(sessionId, update),
      onLog: this.#onLog,
      promptTimeoutMs: this.#promptTimeout,
      onClose: () => this.#onHostClosed(key),
    });
    transport.onMessage(raw => client.ingest(`${raw}\n`));
    let resolveExited: (code: number) => void = () => {};
    const exited = new Promise<number>(resolve => {
      resolveExited = resolve;
    });
    transport.onClose(() => {
      client.close({ code: null, stderr: "TUI control socket closed" });
      resolveExited(0);
    });

    const spec: HostSpec = { kind: "local" };
    const host: LocalHost = { client, pid: input.pid, kill: () => transport.close(), exited };
    const entry: HostEntry = {
      key,
      host,
      spec,
      ref: { kind: "local", id: key, spec },
      handle: undefined,
      agents: new Set(),
    };
    // Register before `initialize`: if the TUI socket closes while its
    // initialize response is in flight, the AcpClient close callback can
    // remove this entry instead of leaving a dead host in the table.
    this.#hosts.set(key, entry);
    try {
      await client.initialize();
    } catch (err) {
      await this.#releaseHost(entry);
      throw err;
    }
    this.#store.audit({
      action: "host.provision",
      outcome: "ok",
      detail: { kind: "live-tui", pid: input.pid, hostId: key },
    });
    return await this.#bindAgentToSession(
      { name: input.name, cwd: input.cwd, sessionId: input.sessionId },
      spec,
      entry,
      who,
      { takeover: "live-tui" },
      async sessionEntry => {
        await sessionEntry.host.client.loadSession(input.sessionId, input.cwd);
        return input.sessionId;
      },
    );
  }

  /**
   * Shared tail of `createAgent`/`resumeAgent`: allocate the agent row,
   * obtain an ACP session id through `openSession` (new or loaded), and wire
   * it into the same routing tables and `#hostFor`-installed permission/
   * elicitation callbacks either caller goes through. There is exactly one
   * path from an ACP session id to the policy gate; this is what keeps it
   * that way as a second creation path is added.
   */
  async #bindAgentToSession(
    input: CreateAgentInput | ResumeAgentInput,
    spec: HostSpec,
    entry: HostEntry,
    who: Actor,
    auditDetail: Record<string, unknown>,
    openSession: (entry: HostEntry, agentId: AgentId) => Promise<string>,
  ): Promise<Agent> {
    const id: AgentId = `agt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const agent: Agent = {
      id,
      name: input.name,
      state: "starting",
      host: entry.ref,
      cwd: input.cwd,
      createdAt: now,
      lastActiveAt: now,
      routineId: input.routineId,
      labels: input.labels ?? {},
    };
    this.#store.upsertAgent(agent);

    let sessionId: string;
    try {
      sessionId = await openSession(entry, id);
    } catch (err) {
      // The host answered `initialize` but cannot serve this session. Release
      // it if it serves nobody else: a provisioned container that no handle
      // points at is never reclaimed, and the agent row must not be left
      // claiming a host that is gone.
      if (entry.agents.size === 0) await this.#releaseHost(entry);
      this.#setState(id, "failed");
      throw err;
    }
    agent.acpSessionId = sessionId;
    agent.state = "idle";
    this.#store.upsertAgent(agent);

    this.#agentHost.set(id, entry.key);
    this.#sessionAgent.set(sessionId, id);
    entry.agents.add(id);

    this.#store.audit({
      action: "agent.create",
      agentId: id,
      actorDeviceId: who.deviceId,
      outcome: "ok",
      detail: { cwd: input.cwd, host: spec.kind, sessionId, ...auditDetail },
    });
    this.#events.onAgentsChanged?.(this.listAgents());
    return agent;
  }

  /**
   * Send a prompt. Resolves when the turn settles, but the agent keeps running
   * regardless of whether the caller is still listening.
   */
  async prompt(agentId: AgentId, text: string, actor: Actor): Promise<{ stopReason: string }> {
    const who = this.#authorize(actor, SCOPE_PROMPT, "agent.prompt", agentId);
    const { agent, entry } = this.#resolve(agentId);
    if (!agent.acpSessionId) throw new Error(`agent ${agentId} has no session`);

    this.#setState(agentId, "busy");
    this.#store.audit({
      action: "agent.prompt",
      agentId,
      actorDeviceId: who.deviceId,
      outcome: "ok",
      detail: { chars: text.length },
    });
    try {
      return await entry.host.client.prompt(agent.acpSessionId, text);
    } finally {
      // Only return to idle if the agent is still live. A turn can be
      // abandoned by stopAgent or by its host dying, and both write a terminal
      // state while this call is still unwinding. Writing idle unconditionally
      // would resurrect a dead agent into something a client renders as ready
      // to accept work.
      const current = this.#store.getAgent(agentId);
      if (current && !TERMINAL_AGENT_STATES.includes(current.state)) {
        this.#setState(agentId, "idle");
      }
    }
  }

  async cancel(agentId: AgentId, actor: Actor): Promise<void> {
    this.#authorize(actor, SCOPE_PROMPT, "agent.cancel", agentId);
    const { agent, entry } = this.#resolve(agentId);
    if (agent.acpSessionId) await entry.host.client.cancel(agent.acpSessionId);
  }

  async stopAgent(agentId: AgentId, actor: Actor): Promise<void> {
    this.#authorize(actor, SCOPE_MANAGE, "agent.stop", agentId);
    const { agent, entry } = this.#resolve(agentId);
    if (agent.acpSessionId) await entry.host.client.closeSession(agent.acpSessionId);
    entry.agents.delete(agentId);
    this.#setState(agentId, "stopped");
    this.#store.audit({ action: "agent.stop", agentId, outcome: "ok" });

    // A host with no agents left is dead weight; reclaim it.
    if (entry.agents.size === 0) await this.#releaseHost(entry);
    this.#events.onAgentsChanged?.(this.listAgents());
  }

  async shutdown(): Promise<void> {
    const entries = [...this.#hosts.values()];
    this.#hosts.clear();
    for (const entry of entries) entry.host.kill();
    // Killing the local end of `docker exec` stops the remote `omp acp`, but
    // it leaves the container running. Awaited rather than fired off, so a
    // daemon shutting down does not race its own teardown and leak one.
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.handle === undefined) return;
        await this.#destroyHandle(entry.handle);
      }),
    );
  }

  // -- approvals -----------------------------------------------------------

  /**
   * Record a client's answer to a pending approval.
   *
   * Returns false when the request is unknown, already settled, or the actor
   * lacks approve scope. It never throws, because the caller is a websocket
   * frame handler and a malformed frame must not take the daemon down.
   */
  decide(
    requestId: string,
    choice: "allow" | "deny",
    scope: "once" | "always",
    actor: Actor,
  ): boolean {
    // Authorization is checked before the request lookup, so an unauthorized
    // caller cannot probe which request ids exist. It is reported as a boolean
    // rather than thrown because this is called straight from a websocket
    // frame handler and a hostile frame must not take the daemon down.
    let who: Actor;
    try {
      who = this.#authorize(actor, SCOPE_APPROVE, "approval.decide");
    } catch {
      return false;
    }
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    pending.resolve({ choice, scope, actor: who });
    return true;
  }

  async gateAction(input: {
    agentId: AgentId;
    tool: string;
    title: string;
    input: unknown;
  }): Promise<{ allowed: boolean; reason: string }> {
    const agent = this.#store.getAgent(input.agentId);
    if (!agent) return { allowed: false, reason: `no such agent: ${input.agentId}` };
    const result = await this.#gate({
      agentId: input.agentId,
      agent,
      requestId: `wva_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tool: input.tool,
      title: input.title,
      input: input.input,
      probes: [input.input],
    });
    return { allowed: result.option.startsWith("allow"), reason: result.reason };
  }

  /**
   * The ACP permission hook, gate 1.
   *
   * Covers bash, delete and move. It never fires for `write`, `multi_edit` or
   * `ast_edit`, and for `edit` only on a delete or a rename, which is why
   * `#onElicitation` exists alongside it.
   */
  async #onPermission(req: PermissionRequest): Promise<AcpOptionId> {
    const agentId = this.#sessionAgent.get(req.sessionId);
    const agent = agentId ? this.#store.getAgent(agentId) : null;
    if (!agent || !agentId) {
      // An unmapped session is not something to gamble on.
      return "reject_once";
    }

    const tool = req.toolCall.kind === "execute" ? "bash" : (req.toolCall.kind ?? "unknown");
    const input = req.toolCall.rawInput ?? {};

    const result = await this.#gate({
      agentId,
      agent,
      requestId: req.toolCall.toolCallId,
      tool,
      title: req.toolCall.title,
      input,
      probes: [input],
    });
    return result.option;
  }

  /**
   * OMP's internal approval gate, gate 2, reached over `elicitation/create`.
   *
   * This is the only channel on which an ordinary file write is visible. Gate
   * 1 does not carry one, by upstream design: omp 17.2.12 deliberately stopped
   * requesting ACP permission for `edit`, `write` and `ast_edit` unless the
   * call deletes or moves something.
   *
   * The cost is that gate 2 does not hand over a tool call. It hands over the
   * string it would have shown a human. `parseApprovalPrompt` reads the target
   * back out of it; anything it cannot read is denied rather than guessed at.
   */
  async #onElicitation(req: ElicitationRequest): Promise<ElicitationOutcome> {
    const agentId = this.#sessionAgent.get(req.sessionId);
    const agent = agentId ? this.#store.getAgent(agentId) : null;
    if (!agent || !agentId) return { action: "decline" };

    // Questions are told apart by the choices offered, never by their prose.
    // The choice lists are literal constants inside the host; the message is a
    // rendering that a release is free to reword.
    const offered = req.enumValues.join(CHOICE_SEP);
    if (offered === TOOL_APPROVAL_KEY) {
      return await this.#gateElicitedToolCall(agentId, agent, req);
    }

    // The one compatibility case. Before the client advertised elicitation,
    // the host could not ask this and took the plan as approved. Declining now
    // would silently stop plan mode working, and the plan itself mutates
    // nothing: every tool call it leads to is gated on its own.
    if (offered === PLAN_APPROVAL_KEY && req.message.startsWith(PLAN_APPROVAL_PREFIX)) {
      return { action: "accept", value: PLAN_APPROVAL_CHOICES[0] };
    }

    // Everything else: extension prompts, free text, confirmations. Declining
    // reproduces exactly what a client with no elicitation capability
    // produces, so nothing that used to work changes, and no consent is
    // invented for a question ompd does not understand.
    this.#onLog?.(`elicitation declined, unrecognised choices: ${JSON.stringify(req.enumValues)}`);
    return { action: "decline" };
  }

  async #gateElicitedToolCall(
    agentId: AgentId,
    agent: Agent,
    req: ElicitationRequest,
  ): Promise<ElicitationOutcome> {
    const parsed = parseApprovalPrompt(req.message);
    if (!parsed) {
      // Approve/Deny, but not a tool approval we can read. Declining is a
      // denial to the host, which is the only safe reading of a question we
      // cannot describe to an operator.
      this.#onLog?.(`elicitation declined, unparseable approval prompt for agent ${agentId}`);
      return { action: "decline" };
    }

    // No toolCallId is carried on this channel, so the approval row gets its
    // own id. Nothing correlates it back to a gate 1 row because nothing has
    // to: each gate is a separate decision on the same call.
    const requestId = `elc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const input = {
      tool: parsed.tool,
      paths: parsed.paths,
      uriTargets: parsed.uriTargets,
      command: parsed.command,
      /** The prompt verbatim, so an operator decides on what omp actually said. */
      prompt: req.message,
    };
    const title = `${parsed.tool}: ${parsed.paths[0] ?? parsed.uriTargets[0] ?? parsed.command ?? "no stated target"}`;

    if (parsed.truncated) {
      // omp elides long values. A target we can only see part of cannot be
      // workspace-checked and cannot be shown to an operator honestly either.
      this.#store.openApproval({ requestId, agentId, tool: parsed.tool, title, input });
      this.#settle(agentId, requestId, parsed.tool, "deny", "opaque:truncated", null, null);
      return { action: "decline" };
    }

    const probes: unknown[] = [];
    if (parsed.command !== null) probes.push({ command: parsed.command });
    for (const path of parsed.paths) probes.push({ path });
    if (parsed.uriTargets.length > 0) {
      // A URI target such as `xd://ast_edit` or `local://plan.md` is a
      // dispatch into an OMP namespace, not a filesystem path. Where it lands
      // is not derivable here, so it is never handed to a lexical workspace
      // check that would happily call `xd://ast_edit` a file inside the
      // workspace. An empty input instead, which policy answers with its own
      // default: ask a human. Aggregation is most-restrictive, so a call
      // naming both a workspace file and an opaque target is decided on the
      // opaque one and cannot be auto-allowed on the strength of the file.
      probes.push({});
    }
    // A tool that stated no target at all is in the same position: unknowable,
    // so a human decides.
    if (probes.length === 0) probes.push({});

    const result = await this.#gate({
      agentId,
      agent,
      requestId,
      tool: parsed.tool,
      title,
      input,
      probes,
    });
    return result.option.startsWith("allow")
      ? { action: "accept", value: TOOL_APPROVAL_CHOICES[0] }
      : { action: "accept", value: TOOL_APPROVAL_CHOICES[1] };
  }

  /**
   * One decision, whichever gate asked for it. Everything about the security
   * model funnels here.
   *
   * `probes` is evaluated in full and the most restrictive verdict wins. A
   * single call can name several targets, and a call is only as safe as its
   * worst one.
   */
  async #gate(args: {
    agentId: AgentId;
    agent: Agent;
    requestId: string;
    tool: string;
    title: string;
    input: unknown;
    probes: unknown[];
  }): Promise<GateResult> {
    const { agentId, agent, requestId, tool, title, input } = args;
    this.#store.openApproval({ requestId, agentId, tool, title, input });

    // The daemon itself is the actor for the automatic decision. A client's
    // scopes only matter once we reach the `prompt` branch below.
    const daemonActor: Actor = { deviceId: "daemon", scopes: ["read", "prompt", "approve"] };
    // Seeded with a denial rather than an allow, so a caller that somehow
    // arrives with nothing to decide about gets refused instead of waved
    // through. The first real verdict replaces it; later ones only tighten.
    let decision: PolicyDecision = { action: "deny", reason: "nothing to decide about", rule: "empty" };
    let decided = false;
    for (const probe of args.probes) {
      const next = this.#policy.evaluate({ agent, tool, input: probe, actor: daemonActor });
      if (!decided || SEVERITY[next.action] > SEVERITY[decision.action]) {
        decision = next;
        decided = true;
      }
    }

    if (decision.action !== "prompt") {
      this.#settle(
        agentId,
        requestId,
        tool,
        decision.action === "allow" ? "allow" : "deny",
        decision.rule ?? decision.action,
        decision.reason,
        null,
      );
      return { option: toAcpOption(decision), reason: decision.reason };
    }

    // Ask a human. Fail closed on timeout: an unattended agent must not be
    // able to wait out the gate. Restore the state this particular gate
    // interrupted, because WebView MCP requests can arrive while an agent is
    // idle as well as from inside a busy turn.
    const stateBeforeApproval = agent.state;
    this.#setState(agentId, "waiting");
    const answer = await new Promise<{
      choice: "allow" | "deny";
      scope?: "once" | "always";
      actor: Actor;
    } | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve(null);
      }, this.#approvalTimeout);

      this.#pending.set(requestId, {
        requestId,
        agentId,
        tool,
        title,
        input,
        resolve: (v) => {
          clearTimeout(timer);
          this.#pending.delete(requestId);
          resolve(v);
        },
      });

      this.#events.onApprovalNeeded?.({ requestId, agentId, tool, title, input });
    });
    if (this.#store.getAgent(agentId)?.state === "waiting") {
      this.#setState(agentId, stateBeforeApproval);
    }

    const option = toAcpOption(
      decision,
      answer ? { choice: answer.choice, scope: answer.scope } : undefined,
    );
    const allowed = option.startsWith("allow");
    this.#store.resolveApproval(
      requestId,
      allowed ? "allow" : "deny",
      answer?.scope ?? "once",
      answer ? "operator" : "timeout",
      answer?.actor.deviceId ?? null,
    );
    this.#store.audit({
      action: "approval.decide",
      agentId,
      actorDeviceId: answer?.actor.deviceId ?? null,
      outcome: allowed ? "ok" : "denied",
      detail: { requestId, tool, rule: decision.rule, timedOut: answer === null },
    });
    return {
      option,
      reason:
        answer === null
          ? "operator approval timed out"
          : answer.choice === "allow"
            ? "approved by operator"
            : "denied by operator",
    };
  }

  /** Close out an approval nobody was asked about, and record why. */
  #settle(
    agentId: AgentId,
    requestId: string,
    tool: string,
    outcome: "allow" | "deny",
    rule: string,
    reason: string | null,
    deviceId: string | null,
  ): void {
    this.#store.resolveApproval(requestId, outcome, "once", rule, deviceId);
    this.#store.audit({
      action: "approval.decide",
      agentId,
      outcome: outcome === "allow" ? "ok" : "denied",
      detail: { requestId, tool, rule, reason, automatic: true },
    });
  }

  // -- internals -----------------------------------------------------------

  async #hostFor(spec: HostSpec, cwd: string, actor: Actor): Promise<HostEntry> {
    // One host per cwd keeps a crash blast-radius to the agents sharing a repo,
    // which is also the natural boundary for OMP's own project config.
    for (const entry of this.#hosts.values()) {
      if (entry.spec.kind !== spec.kind) continue;
      if (!entry.host.client.agentInfo || entry.agents.size >= 16) continue;
      // A provisioned host is reused only for an identical spec. Two container
      // specs naming different images are two different sandboxes, and two
      // different TTLs are two different leases.
      if (
        spec.kind !== "local" &&
        (entry.spec.image !== spec.image ||
          entry.spec.repo !== spec.repo ||
          entry.spec.ref !== spec.ref ||
          entry.spec.ttlSeconds !== spec.ttlSeconds)
      ) {
        continue;
      }
      return entry;
    }

    let handle: HostHandle | undefined;
    if (spec.kind !== "local") {
      const provisioner = this.#provisioner;
      // `createAgent` already refused this, but `#hostFor` is the only place
      // that decides where a process comes from, so the invariant is asserted
      // where it is relied on rather than only where it is currently reached.
      if (provisioner === undefined) {
        throw new Error(`host kind ${spec.kind} requires the provisioner`);
      }
      handle = await provisioner.provision(spec, actor);
    }

    // Assigned below, and read only when the host closes, which cannot happen
    // before this function has returned it.
    let key = "";
    const opts: SpawnLocalHostOptions = {
      cwd,
      // A provisioned host resolves omp on the far side, so the daemon's own
      // path means nothing to it; its handle owns that decision.
      ompPath: handle === undefined ? this.#ompPath : undefined,
      onPermission: (req) => this.#onPermission(req),
      // Gate 2. Required for the same reason `onPermission` is: a host that
      // falls back to OMP's own default answer is the hole this closes.
      onElicitation: (req) => this.#onElicitation(req),
      // A turn must outlast the approvals it raises, or an unanswered
      // approval surfaces as a transport error instead of a recorded denial.
      promptTimeoutMs: this.#promptTimeout,
      onUpdate: (sessionId, update) => this.#onUpdate(sessionId, update),
      onLog: this.#onLog,
      onClose: () => this.#onHostClosed(key),
    };

    let host: LocalHost;
    try {
      host = handle === undefined ? this.#spawnHost(opts) : handle.spawn(opts);
      await host.client.initialize();
    } catch (err) {
      // A container that came up but whose ACP host never answered is held by
      // nobody. Release it here or it runs until the machine is rebooted.
      if (handle !== undefined) await this.#destroyHandle(handle);
      throw err;
    }

    const ref: HostRef = handle?.ref ?? { kind: "local", id: String(host.pid), spec };
    key = handle === undefined ? String(host.pid) : `${ref.kind}:${ref.id}`;

    const entry: HostEntry = { key, host, spec, ref, handle, agents: new Set() };
    this.#hosts.set(key, entry);
    this.#store.audit({
      action: "host.provision",
      outcome: "ok",
      detail: { kind: spec.kind, pid: host.pid, hostId: ref.id },
    });
    return entry;
  }

  /**
   * Drop a host that serves nobody.
   *
   * Untracks first, so a caller racing `#onHostClosed` cannot tear the same
   * host down twice. A provisioned host is also destroyed, because killing the
   * local end of `docker exec` stops the remote `omp acp` and leaves the
   * container running.
   */
  async #releaseHost(entry: HostEntry): Promise<void> {
    this.#hosts.delete(entry.key);
    entry.host.kill();
    if (entry.handle !== undefined) await this.#destroyHandle(entry.handle);
  }

  async #destroyHandle(handle: HostHandle): Promise<void> {
    // Unreachable with an undefined provisioner: a handle only exists because
    // one produced it. Optional-called rather than asserted because a throw
    // here would mask the caller's own error.
    await this.#provisioner?.destroy(handle.ref.id);
  }

  #onUpdate(sessionId: string, update: unknown): void {
    const agentId = this.#sessionAgent.get(sessionId);
    if (!agentId) return;
    const seq = this.#store.appendUpdate(agentId, update);
    this.#events.onUpdate?.(agentId, seq, update);
  }

  /**
   * The ACP stream died on its own: the child crashed, or something outside
   * ompd removed the container.
   *
   * A provisioned host is still destroyed, because the stream dying says
   * nothing about the container: `docker exec` exits when `omp acp` does and
   * leaves it running. `destroy` on an id the provisioner no longer tracks is
   * a no-op, so the case where the container is what died costs nothing.
   */
  #onHostClosed(key: string): void {
    const entry = this.#hosts.get(key);
    if (!entry) return;
    this.#hosts.delete(key);
    for (const agentId of entry.agents) this.#setState(agentId, "failed");
    if (entry.handle !== undefined) {
      void this.#destroyHandle(entry.handle).catch((err: unknown) => {
        this.#onLog?.(`host ${entry.ref.id}: destroy after close failed: ${String(err)}`);
      });
    }
    this.#events.onAgentsChanged?.(this.listAgents());
  }

  #setState(agentId: AgentId, state: AgentState): void {
    this.#store.setAgentState(agentId, state);
    this.#events.onAgentsChanged?.(this.listAgents());
  }

  #resolve(agentId: AgentId): { agent: Agent; entry: HostEntry } {
    const agent = this.#store.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    const hostId = this.#agentHost.get(agentId);
    const entry = hostId ? this.#hosts.get(hostId) : undefined;
    if (!entry) throw new Error(`agent ${agentId} has no live host`);
    return { agent, entry };
  }
}
