import {
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  type Actor,
  type HostMount,
  type HostSpec,
  type QueuedIntent,
} from "@ompd/core";
import { Supervisor } from "../supervisor.ts";

/** The narrow remote surface a local delegate needs to drain a replica queue. */
export interface IntentPeer {
  pullPendingIntents(): Promise<QueuedIntent[]>;
  /**
   * Atomically claim one pending intent before execution.
   * Returns false if the intent is no longer pending (already claimed or delivered).
   */
  claimIntent(id: string): Promise<boolean>;
  acknowledgeDelivered(ids: readonly string[]): Promise<void>;
}

export interface HttpIntentPeerOptions {
  /** Base URL of the replica gateway, never a hub URL. */
  url: string;
  /** Dedicated sync credential, not a paired-device bearer token. */
  token: string;
  fetch?: typeof fetch;
}

/**
 * HTTP adapter around the sync endpoints. It parses the replica's response
 * before it reaches the supervisor, because the peer is outside this daemon's
 * execution boundary.
 */
export class HttpIntentPeer implements IntentPeer {
  #url: string;
  #token: string;
  #fetch: typeof fetch;

  constructor(opts: HttpIntentPeerOptions) {
    if (opts.url.trim() === "") throw new Error("intent peer URL is required");
    if (opts.token === "") throw new Error("intent peer token is required");
    this.#url = opts.url.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
  }

  async pullPendingIntents(): Promise<QueuedIntent[]> {
    const response = await this.#fetch(`${this.#url}/v1/sync/intents`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) throw new Error(`intent pull failed: ${response.status}`);

    const body = await response.json();
    const fields = objectFields(body, "intent pull response");
    if (!Array.isArray(fields.intents)) throw new Error("intent pull returned invalid JSON");
    return fields.intents.map(parseQueuedIntent);
  }

  async claimIntent(id: string): Promise<boolean> {
    const response = await this.#fetch(`${this.#url}/v1/sync/intents/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id }),
    });
    if (response.status === 409) return false;
    if (!response.ok) throw new Error(`intent claim failed: ${response.status}`);
    return true;
  }

  async acknowledgeDelivered(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const response = await this.#fetch(`${this.#url}/v1/sync/intents/ack`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error(`intent acknowledgement failed: ${response.status}`);
  }
}

export interface QueuedIntentDrainerOptions {
  supervisor: Supervisor;
  peer: IntentPeer;
  onError?: (error: Error) => void;
}

/**
 * The only bridge from replica intent storage to execution. The delegate dials
 * the replica, claims each intent immediately before its supervisor call,
 * executes through its own supervisor using the originating actor, then
 * acknowledges an intent only after its local action settles.
 */
export class QueuedIntentDrainer {
  #supervisor: Supervisor;
  #peer: IntentPeer;
  #onError: ((error: Error) => void) | undefined;
  #timer: Timer | null = null;
  #inFlight: Promise<number> | null = null;

  constructor(opts: QueuedIntentDrainerOptions) {
    this.#supervisor = opts.supervisor;
    this.#peer = opts.peer;
    this.#onError = opts.onError;
  }

  /** Poll immediately, then at a fixed interval until `stop` is called. */
  start(intervalMs = 5_000): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("intent poll interval must be positive");
    if (this.#timer !== null) return;
    const poll = () => void this.drain().catch((error: unknown) => this.#report(error));
    poll();
    this.#timer = setInterval(poll, intervalMs);
  }

  /**
   * Stop polling and wait for any in-flight drain to finish before returning.
   * Callers that shut the supervisor down after this are guaranteed that no
   * drain is still touching it.
   */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#inFlight !== null) await this.#inFlight.catch(() => undefined);
  }

  /**
   * Execute eligible intents in source order. Each intent is claimed
   * immediately before its supervisor call so a crash mid-batch cannot
   * redeliver an already-executed prompt. Failures leave only that intent
   * claimed (not pending) for later operator reconciliation.
   */
  async drain(): Promise<number> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.#doDrain();
    try {
      return await this.#inFlight;
    } finally {
      this.#inFlight = null;
    }
  }

  async #doDrain(): Promise<number> {
    let delivered = 0;
    for (const intent of await this.#peer.pullPendingIntents()) {
      if (intent.action !== "new-agent" && !this.#supervisor.ownsAgent(intent.agentId)) continue;
      try {
        // Claim first. If another drain already claimed this intent, skip it.
        const claimed = await this.#peer.claimIntent(intent.id);
        if (!claimed) continue;

        await this.#execute(intent);
        await this.#peer.acknowledgeDelivered([intent.id]);
        delivered += 1;
      } catch (error) {
        this.#report(error);
      }
    }
    return delivered;
  }

  async #execute(intent: QueuedIntent): Promise<void> {
    // The originating actorDeviceId is the only identity the supervisor may
    // authorize against. Scopes are empty here; Supervisor re-reads the
    // device row and its live scopes/revocation state. A missing or revoked
    // device refuses delivery rather than inventing authority.
    const actor: Actor = { deviceId: intent.actorDeviceId, scopes: [] };

    switch (intent.action) {
      case "prompt": {
        const fields = objectFields(intent.payload, `intent ${intent.id} prompt payload`);
        const text = stringField(fields, "text");
        if (text.length === 0) throw new Error(`intent ${intent.id} prompt text is empty`);
        await this.#supervisor.prompt(intent.agentId, text, actor);
        return;
      }
      case "cancel":
        await this.#supervisor.cancel(intent.agentId, actor);
        return;
      case "decide": {
        const fields = objectFields(intent.payload, `intent ${intent.id} decision payload`);
        const requestId = stringField(fields, "requestId");
        const choice = stringField(fields, "choice");
        const scope = stringField(fields, "scope");
        if ((choice !== "allow" && choice !== "deny") || (scope !== "once" && scope !== "always")) {
          throw new Error(`intent ${intent.id} has an invalid approval decision`);
        }
        // A timed-out approval is already terminal. It is still delivered: a
        // retry cannot make a closed approval pending again.
        const accepted = this.#supervisor.decide(requestId, choice, scope, actor);
        if (!accepted) {
          throw new Error(`intent ${intent.id} decision refused: unknown request or missing approve scope`);
        }
        return;
      }
      case "new-agent": {
        // Always prove the originating actor still holds manage scope, even
        // when the reserved agent already exists and we skip re-creation.
        this.#supervisor.authorize(actor, SCOPE_MANAGE, "agent.create", intent.agentId);
        // An acknowledgement lost after creation must not create a second ACP
        // session on the retry. The reserved id is the idempotency boundary.
        if (this.#supervisor.ownsAgent(intent.agentId)) return;
        const payload = newAgentPayload(intent.payload, intent.id);
        await this.#supervisor.createAgent({ id: intent.agentId, ...payload }, actor);
        return;
      }
      default: {
        const exhaustive: never = intent.action;
        throw new Error(`unsupported queued intent action: ${String(exhaustive)}`);
      }
    }
  }

  #report(error: unknown): void {
    this.#onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function objectFields(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function parseQueuedIntent(value: unknown): QueuedIntent {
  const fields = objectFields(value, "queued intent");
  const id = stringField(fields, "id");
  const agentId = stringField(fields, "agentId");
  const actorDeviceId = stringField(fields, "actorDeviceId");
  const action = stringField(fields, "action");
  if (action !== "prompt" && action !== "decide" && action !== "cancel" && action !== "new-agent") {
    throw new Error(`unsupported queued intent action: ${action}`);
  }
  const createdAt = stringField(fields, "createdAt");
  const status = stringField(fields, "status");
  if (status !== "pending" && status !== "claimed" && status !== "delivered") {
    throw new Error(`unsupported queued intent status: ${status}`);
  }
  return {
    id,
    agentId,
    actorDeviceId,
    action,
    payload: fields.payload,
    createdAt,
    status,
    ...(typeof fields.seq === "number" ? { seq: fields.seq } : {}),
  };
}

function newAgentPayload(
  payload: unknown,
  intentId: string,
): {
  name: string;
  cwd: string;
  host?: HostSpec;
  routineId?: string;
  labels?: Record<string, string>;
} {
  const fields = objectFields(payload, `intent ${intentId} new-agent payload`);
  const name = stringField(fields, "name");
  const cwd = stringField(fields, "cwd");
  if (name.length === 0 || cwd.length === 0) {
    throw new Error(`intent ${intentId} new-agent payload requires name and cwd`);
  }
  return {
    name,
    cwd,
    ...(fields.host !== undefined ? { host: parseHostSpec(fields.host, intentId) } : {}),
    ...(typeof fields.routineId === "string" ? { routineId: fields.routineId } : {}),
    ...(fields.labels !== undefined ? { labels: stringMap(fields.labels, `intent ${intentId} labels`) } : {}),
  };
}

function parseHostSpec(value: unknown, intentId: string): HostSpec {
  const fields = objectFields(value, `intent ${intentId} host`);
  const kind = stringField(fields, "kind");
  if (kind !== "local" && kind !== "container" && kind !== "cloud") {
    throw new Error(`intent ${intentId} has unsupported host kind: ${kind}`);
  }
  return {
    kind,
    ...(typeof fields.image === "string" ? { image: fields.image } : {}),
    ...(typeof fields.repo === "string" ? { repo: fields.repo } : {}),
    ...(fields.mounts !== undefined ? { mounts: parseMounts(fields.mounts, intentId) } : {}),
  };
}

function parseMounts(value: unknown, intentId: string): HostMount[] {
  if (!Array.isArray(value)) throw new Error(`intent ${intentId} host mounts must be an array`);
  return value.map((entry, index) => {
    const fields = objectFields(entry, `intent ${intentId} host mount ${index}`);
    return {
      hostPath: stringField(fields, "hostPath"),
      containerPath: stringField(fields, "containerPath"),
      ...(fields.readOnly === true ? { readOnly: true as const } : {}),
    };
  });
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const fields = objectFields(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(fields)) {
    if (typeof entry !== "string") throw new Error(`${label} are invalid`);
    result[key] = entry;
  }
  return result;
}
