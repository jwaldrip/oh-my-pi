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
 * the replica, executes through its own supervisor, then acknowledges an
 * intent only after its local action settles.
 */
export class QueuedIntentDrainer {
  #supervisor: Supervisor;
  #peer: IntentPeer;
  #onError: ((error: Error) => void) | undefined;
  #draining = false;
  #timer: Timer | null = null;

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

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Execute eligible intents in source order. Failures leave only that intent
   * pending for a later poll, while unrelated later requests still drain.
   */
  async drain(): Promise<number> {
    if (this.#draining) return 0;
    this.#draining = true;
    try {
      const delivered: string[] = [];
      for (const intent of await this.#peer.pullPendingIntents()) {
        if (intent.action !== "new-agent" && !this.#supervisor.ownsAgent(intent.agentId)) continue;
        try {
          await this.#execute(intent);
          delivered.push(intent.id);
        } catch (error) {
          this.#report(error);
        }
      }
      if (delivered.length > 0) await this.#peer.acknowledgeDelivered(delivered);
      return delivered.length;
    } finally {
      this.#draining = false;
    }
  }

  async #execute(intent: QueuedIntent): Promise<void> {
    switch (intent.action) {
      case "prompt": {
        const fields = objectFields(intent.payload, `intent ${intent.id} prompt payload`);
        const text = stringField(fields, "text");
        if (text.length === 0) throw new Error(`intent ${intent.id} prompt text is empty`);
        await this.#supervisor.prompt(intent.agentId, text, daemonActor(SCOPE_PROMPT));
        return;
      }
      case "cancel":
        await this.#supervisor.cancel(intent.agentId, daemonActor(SCOPE_PROMPT));
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
        this.#supervisor.decide(requestId, choice, scope, daemonActor(SCOPE_APPROVE));
        return;
      }
      case "new-agent": {
        // An acknowledgement lost after creation must not create a second ACP
        // session on the retry. The reserved id is the idempotency boundary.
        if (this.#supervisor.ownsAgent(intent.agentId)) return;
        const payload = newAgentPayload(intent.payload, intent.id);
        await this.#supervisor.createAgent({ id: intent.agentId, ...payload }, daemonActor(SCOPE_MANAGE));
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

/** Internal actor reserved for a local delegate executing an already-authorized intent. */
function daemonActor(scope: string): Actor {
  return { deviceId: "daemon", scopes: [scope] };
}

function objectFields(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new Error(`queued intent payload is missing ${key}`);
  return value;
}

function parseQueuedIntent(value: unknown): QueuedIntent {
  const fields = objectFields(value, "queued intent");
  const id = stringField(fields, "id");
  const agentId = stringField(fields, "agentId");
  const actorDeviceId = stringField(fields, "actorDeviceId");
  const action = stringField(fields, "action");
  const createdAt = stringField(fields, "createdAt");
  const status = stringField(fields, "status");
  if (
    (action !== "prompt" && action !== "decide" && action !== "cancel" && action !== "new-agent") ||
    status !== "pending" ||
    !("payload" in fields)
  ) {
    throw new Error("queued intent has invalid fields");
  }
  return { id, agentId, actorDeviceId, action, payload: fields.payload, createdAt, status };
}

function newAgentPayload(payload: unknown, intentId: string): {
  name: string;
  cwd: string;
  host?: HostSpec;
  routineId?: string;
  labels?: Record<string, string>;
} {
  const fields = objectFields(payload, `intent ${intentId} new-agent payload`);
  const name = stringField(fields, "name");
  const cwd = stringField(fields, "cwd");
  if (name.length === 0 || cwd.length === 0) throw new Error(`intent ${intentId} new-agent fields are empty`);

  const result: {
    name: string;
    cwd: string;
    host?: HostSpec;
    routineId?: string;
    labels?: Record<string, string>;
  } = { name, cwd };
  if (fields.host !== undefined) result.host = parseHostSpec(fields.host, intentId);
  if (fields.routineId !== undefined) result.routineId = stringField(fields, "routineId");
  if (fields.labels !== undefined) result.labels = stringMap(fields.labels, `intent ${intentId} labels`);
  return result;
}

function parseHostSpec(value: unknown, intentId: string): HostSpec {
  const fields = objectFields(value, `intent ${intentId} host`);
  if (fields.kind !== "local" && fields.kind !== "container" && fields.kind !== "cloud") {
    throw new Error(`intent ${intentId} host is invalid`);
  }
  const result: HostSpec = { kind: fields.kind };
  for (const key of ["image", "repo", "ref"] as const) {
    if (fields[key] !== undefined) result[key] = stringField(fields, key);
  }
  if (fields.ttlSeconds !== undefined) {
    if (typeof fields.ttlSeconds !== "number" || !Number.isFinite(fields.ttlSeconds)) {
      throw new Error(`intent ${intentId} host ttlSeconds is invalid`);
    }
    result.ttlSeconds = fields.ttlSeconds;
  }
  if (fields.mounts !== undefined) result.mounts = parseMounts(fields.mounts, intentId);
  return result;
}

function parseMounts(value: unknown, intentId: string): HostMount[] {
  if (!Array.isArray(value)) throw new Error(`intent ${intentId} host mounts are invalid`);
  return value.map((mount) => {
    const fields = objectFields(mount, `intent ${intentId} host mount`);
    const hostPath = stringField(fields, "hostPath");
    if (fields.mode !== undefined && fields.mode !== "ro" && fields.mode !== "rw") {
      throw new Error(`intent ${intentId} host mount is invalid`);
    }
    return fields.mode === undefined ? { hostPath } : { hostPath, mode: fields.mode };
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
