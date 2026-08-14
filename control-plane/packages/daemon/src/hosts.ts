/**
 * The daemon's index of live ACP hosts, keyed by session.
 *
 * The supervisor owns agent lifetime and keeps its host pool private, which is
 * correct: nothing should be able to reach around it and drive a session. But
 * a client that renders an OMP session needs two things the supervisor does not
 * expose, and neither is an agent-lifetime concern:
 *
 *   - the session's `configOptions` (the mode and model selectors), and
 *   - a way to set the mode.
 *
 * This sits on the one seam built for exactly this: `SupervisorOptions.spawnHost`,
 * the documented host factory. Wrapping it means every host the supervisor
 * creates is registered here as a side effect of being created, with no access
 * to supervisor internals and no second process. Sessions are keyed by the ACP
 * session id, which the supervisor publishes on the agent row as
 * `acpSessionId`, so the lookup is over public state on both ends.
 *
 * Reads never touch the wire. `session/load` is the only ACP method that
 * returns config, and it means "resume this session", so calling it to answer a
 * GET would risk mutating a live turn to satisfy a read. Instead the config is
 * captured when the session is created and kept current from the
 * `config_option_update` and `current_mode_update` notifications the agent
 * already sends on every change.
 */

import { spawnLocalHost, type AcpClient, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";

/** The config option id carrying the session mode. */
export const MODE_OPTION_ID = "mode";

/** Raised when a session is not served by any host this registry knows. */
export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`no live host serves session ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

export interface SessionConfigChoice {
  value: string;
  name: string;
  description?: string;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  /** Groups related options, e.g. `mode` or `model`. */
  category: string;
  /** Widget hint from the agent, e.g. `select`. */
  type: string;
  currentValue: string;
  options: SessionConfigChoice[];
}

/**
 * The slice of the registry the gateway needs, declared structurally so the
 * two are wired together by whoever builds the daemon rather than by an import.
 */
export interface SessionConfig {
  configFor(sessionId: string): SessionConfigOption[] | undefined;
  setMode(sessionId: string, modeId: string): Promise<SessionConfigOption[]>;
}

export interface HostRegistryOptions {
  /** Underlying factory. Defaults to spawning a real `omp acp` child. */
  spawn?: (opts: SpawnLocalHostOptions) => LocalHost;
}

function parseChoice(raw: unknown): SessionConfigChoice | null {
  if (raw === null || typeof raw !== "object") return null;
  if (!("value" in raw) || typeof raw.value !== "string") return null;
  const name = "name" in raw && typeof raw.name === "string" ? raw.name : raw.value;
  const description =
    "description" in raw && typeof raw.description === "string" ? raw.description : undefined;
  return { value: raw.value, name, description };
}

function parseOption(raw: unknown): SessionConfigOption | null {
  if (raw === null || typeof raw !== "object") return null;
  if (!("id" in raw) || typeof raw.id !== "string") return null;

  const choices: SessionConfigChoice[] = [];
  if ("options" in raw && Array.isArray(raw.options)) {
    for (const entry of raw.options) {
      const choice = parseChoice(entry);
      if (choice) choices.push(choice);
    }
  }

  return {
    id: raw.id,
    name: "name" in raw && typeof raw.name === "string" ? raw.name : raw.id,
    category: "category" in raw && typeof raw.category === "string" ? raw.category : raw.id,
    type: "type" in raw && typeof raw.type === "string" ? raw.type : "select",
    currentValue:
      "currentValue" in raw && typeof raw.currentValue === "string" ? raw.currentValue : "",
    options: choices,
  };
}

/**
 * Pull `configOptions` out of a `session/new`, `session/load`, or
 * `config_option_update` payload. Returns null when the payload carries none,
 * which is different from carrying an empty list.
 */
export function parseConfigOptions(raw: unknown): SessionConfigOption[] | null {
  if (raw === null || typeof raw !== "object") return null;
  if (!("configOptions" in raw) || !Array.isArray(raw.configOptions)) return null;
  const parsed: SessionConfigOption[] = [];
  for (const entry of raw.configOptions) {
    const option = parseOption(entry);
    if (option) parsed.push(option);
  }
  return parsed;
}

export class HostRegistry implements SessionConfig {
  #spawnBase: (opts: SpawnLocalHostOptions) => LocalHost;
  /** ACP session id -> the client whose transport serves it. */
  #clients = new Map<string, AcpClient>();
  /** ACP session id -> its last known config. */
  #config = new Map<string, SessionConfigOption[]>();

  constructor(opts: HostRegistryOptions = {}) {
    this.#spawnBase = opts.spawn ?? spawnLocalHost;
  }

  /**
   * The factory to hand to `Supervisor`. Bound, because the supervisor stores
   * it as a plain function.
   */
  get spawn(): (opts: SpawnLocalHostOptions) => LocalHost {
    return (opts) => this.#register(opts);
  }

  configFor(sessionId: string): SessionConfigOption[] | undefined {
    return this.#config.get(sessionId);
  }

  /**
   * Switch the session mode. Resolves with the config as it stands afterwards.
   *
   * The local cache is updated from the call's own success rather than from the
   * `config_option_update` notification that follows it. The notification is a
   * separate frame arriving on its own schedule, so a caller that read the
   * cache the moment this resolved would otherwise see the previous mode.
   */
  async setMode(sessionId: string, modeId: string): Promise<SessionConfigOption[]> {
    const client = this.#clients.get(sessionId);
    if (!client) throw new UnknownSessionError(sessionId);
    await client.request("session/set_mode", { sessionId, modeId });
    this.#setCurrent(sessionId, MODE_OPTION_ID, modeId);
    return this.#config.get(sessionId) ?? [];
  }

  #register(opts: SpawnLocalHostOptions): LocalHost {
    /** Sessions this host serves, so its death clears exactly its own. */
    const owned = new Set<string>();

    const host = this.#spawnBase({
      ...opts,
      onUpdate: (sessionId, update) => {
        this.#observe(sessionId, update);
        opts.onUpdate?.(sessionId, update);
      },
      onClose: (info) => {
        for (const sessionId of owned) {
          this.#clients.delete(sessionId);
          this.#config.delete(sessionId);
        }
        owned.clear();
        opts.onClose?.(info);
      },
    });

    const client = host.client;
    // `AcpClient.newSession` keeps the session id and drops the rest of the
    // response, and the dropped half is the config this registry exists to
    // serve. This sends the identical `session/new` frame through the same
    // public request path and simply keeps all of the answer.
    client.newSession = async (cwd: string, mcpServers: unknown[] = []): Promise<string> => {
      const raw = await client.request("session/new", { cwd, mcpServers });
      if (raw === null || typeof raw !== "object" || !("sessionId" in raw)) {
        throw new Error("session/new returned no sessionId");
      }
      const sessionId = String(raw.sessionId);
      owned.add(sessionId);
      this.#clients.set(sessionId, client);
      const options = parseConfigOptions(raw);
      if (options) this.#config.set(sessionId, options);
      return sessionId;
    };

    return host;
  }

  /** Keep the cached config current from the agent's own notifications. */
  #observe(sessionId: string, update: unknown): void {
    if (update === null || typeof update !== "object") return;
    if (!("sessionUpdate" in update)) return;

    if (update.sessionUpdate === "config_option_update") {
      const options = parseConfigOptions(update);
      if (options) this.#config.set(sessionId, options);
      return;
    }

    if (
      update.sessionUpdate === "current_mode_update" &&
      "currentModeId" in update &&
      typeof update.currentModeId === "string"
    ) {
      this.#setCurrent(sessionId, MODE_OPTION_ID, update.currentModeId);
    }
  }

  #setCurrent(sessionId: string, optionId: string, value: string): void {
    const options = this.#config.get(sessionId);
    if (!options) return;
    this.#config.set(
      sessionId,
      options.map((option) => (option.id === optionId ? { ...option, currentValue: value } : option)),
    );
  }
}
