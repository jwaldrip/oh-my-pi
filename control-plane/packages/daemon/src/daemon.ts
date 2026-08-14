/**
 * The composition root.
 *
 * Six slices were built against fixed contracts and none of them knows the
 * others exist. This is the one file that does: it opens the store, builds the
 * policy, and hands each subsystem exactly the collaborators it declared. Every
 * wiring decision that could otherwise be made twice, differently, is made here
 * once.
 *
 * Two of those decisions are load bearing.
 *
 * **Shutdown is ordered, and the order is not cosmetic.** The scheduler stops
 * first so no new run is queued, then the runs already in flight are drained
 * while the hosts serving them are still up: cancelling a turn needs its host,
 * and a run that cannot write its terminal record outlives the daemon as a row
 * stuck in `running`. The gateway closes next so no new request arrives, and
 * only then does the supervisor tear down running agents. Closing the gateway
 * after the supervisor would accept a request against a supervisor that had
 * already killed its hosts, which is how an in-flight agent is lost with a
 * client watching.
 *
 * **The local operator device is minted from the filesystem, not from
 * pairing.** Every API call needs a paired device, and the machine's own
 * operator has no way to pair with a daemon they cannot yet call. Writing a
 * token to a 0600 file under `~/.ompd` requires local filesystem access, which
 * already implies the ability to run arbitrary code as this user, so it grants
 * nothing that was not already held. It is a convenience for someone who is
 * already the operator, never a way in for someone who is not.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { joinAssistantText, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";
import {
  DEFAULT_DAEMON_PORT,
  DefaultPolicy,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  Store,
  type Actor,
  type AgentId,
  type Device,
  type EndpointOffer,
  type ServerFrame,
} from "@ompd/core";
import type { TunnelDaemon } from "@ompd/tunnel";
import { SleepGuard, type AwakeProcess } from "./awake.ts";
import { createTunnelDialer } from "./tunnel/dial.ts";
import { identityPath, loadIdentity } from "./tunnel/identity.ts";
import { reachableEndpoints } from "./endpoints.ts";
import { EvolutionEngine, ProposalStore } from "./evolution/index.ts";
import { HttpIntentPeer, QueuedIntentDrainer, type IntentPeer } from "./federation/queued-intents.ts";
import { Gateway, GatewayEvents, type VoiceHandler } from "./gateway/index.ts";
import { homeIdFor } from "./home-id.ts";
import { HostRegistry } from "./hosts.ts";
import { ContainerBackend, HostProvisioner, LocalBackend } from "./provisioner/index.ts";
import { Scheduler } from "./routines/index.ts";
import { SessionIndex } from "./sessions/session-index.ts";
import { Supervisor } from "./supervisor.ts";
import { listConnectorCatalog, listSkillCatalog, TaskManager } from "./workspace/index.ts";
import {
  NO_TARGET,
  WebViewBridge,
  type WebViewApprovalGate,
  type WebViewDispatch,
} from "./browser/bridge.ts";
import {
  mcpServerDescriptor,
  startWebViewMcpServer,
  type WebViewMcpServer,
} from "./browser/mcp-server.ts";
import {
  speakableSegments,
  selectSttEngine,
  selectTtsEngine,
  VoiceBridge,
  type SttEngine,
  type TtsEngine,
} from "./voice/index.ts";

export const OMPD_VERSION = "0.1.0";

/**
 * The key voice mode is held under.
 *
 * A device may be speaking to one agent and typing at another, so neither
 * half is sufficient alone. The separator is a null byte because neither an
 * agent id nor a device id can contain one, which is what stops two innocent
 * pairs from colliding into a third.
 */
function voiceKey(agentId: AgentId, deviceId: string): string {
  return `${agentId}\u0000${deviceId}`;
}

/**
 * Ceiling on a spoken summary.
 *
 * A client reads this out. Roughly two minutes of speech is already more than
 * anyone wants unprompted, and an uncapped one would let a verbose turn hold
 * a phone hostage.
 */
const SAY_MAX_CHARS = 1_200;

export interface SpokenReply {
  /** Sanitised, capped prose. Safe to hand straight to a speech engine. */
  text: string;
  /** Last update the text derives from, so a client can tell turns apart. */
  seq: number;
}

/** Cut at the last word boundary at or before `limit`, so speech does not stop mid-word. */
function truncateOnWord(text: string, limit: number): string {
  const clipped = text.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return lastSpace > limit / 2 ? clipped.slice(0, lastSpace) : clipped;
}

/**
 * Stable id for the machine's own operator.
 *
 * Stable rather than random so a restart reuses the row instead of leaving a
 * trail of orphaned devices, and so "does the local operator exist" is a
 * primary-key lookup rather than a scan with a heuristic in it.
 */
export const LOCAL_OPERATOR_DEVICE_ID = "dev_local_operator";

/** The local operator holds everything; it is the machine's own account. */
const LOCAL_OPERATOR_SCOPES: readonly string[] = [
  SCOPE_READ,
  SCOPE_PROMPT,
  SCOPE_MANAGE,
  SCOPE_APPROVE,
];

const POLICY_MODES: readonly string[] = ["strict", "standard", "trusted"];

export interface OmpdConfig {
  /**
   * Loopback. Binding anywhere else publishes a daemon that runs arbitrary
   * code as this user to whoever can reach the interface, so it is a
   * deliberate edit rather than a default.
   */
  host: string;
  port: number;
  policyMode: "strict" | "standard" | "trusted";
  /** The `omp` binary hosts are spawned from. */
  ompPath: string;
  /**
   * Hold a macOS idle-sleep assertion while any agent is working.
   *
   * On by default, because a turn started from a phone that dies when the Mac
   * goes idle is the failure mode that makes remote use pointless. Scoped to
   * work in flight rather than always on, so an idle daemon costs nothing.
   */
  keepAwake: boolean;
  /**
   * Hub to dial out to, or empty for none.
   *
   * Empty by default: reaching this daemon from elsewhere stays a deliberate
   * act. Set it and the daemon holds an outbound connection to that hub, which
   * is how a laptop behind NAT becomes reachable without opening a port.
   */
  hubUrl: string;
  /**
   * When true, this daemon is a cloud replica: authorized writes for agents it
   * does not own are queued rather than executed. Requires replicaSyncToken.
   */
  replica: boolean;
  /**
   * Dedicated sync credential for `/v1/sync/intents*`. Empty means no sync
   * surface. Distinct from paired-device bearer tokens.
   */
  replicaSyncToken: string;
  /**
   * Base URL of a cloud replica this local delegate drains. Empty means no
   * drain. Requires intentPeerToken.
   */
  intentPeerUrl: string;
  /**
   * Sync token presented to intentPeerUrl. Empty means no drain.
   */
  intentPeerToken: string;
  /**
   * Delegate poll cadence in milliseconds. 0 means the drainer default.
   */
  intentPollIntervalMs: number;
}

export const DEFAULT_CONFIG: OmpdConfig = {
  host: "127.0.0.1",
  port: DEFAULT_DAEMON_PORT,
  policyMode: "standard",
  ompPath: "omp",
  keepAwake: true,
  hubUrl: "",
  replica: false,
  replicaSyncToken: "",
  intentPeerUrl: "",
  intentPeerToken: "",
  intentPollIntervalMs: 0,
};

export interface OmpdOptions {
  /** State directory. Defaults to `~/.ompd`. */
  home?: string;
  /** Overrides applied on top of the config file, for CLI flags. */
  overrides?: Partial<OmpdConfig>;
  /**
   * Built web client served from `/`. Defaults to the workspace's
   * `packages/web/dist` when it has been built, and to API-only when it has not.
   */
  staticRoot?: string;
  /** Repository the evolution engine proposes against. Defaults to the cwd. */
  repoRoot?: string;
  /** Host factory seam, so a test never spawns a real `omp acp`. */
  spawnHost?: (opts: SpawnLocalHostOptions) => LocalHost;
  /** Approval deadline seam for deterministic composition tests. */
  approvalTimeoutMs?: number;
  /**
   * Optional replica queue owned by another daemon. Its presence turns this
   * daemon into the local delegate that periodically drains that peer.
   */
  intentPeer?: IntentPeer;
  /** Delegate poll cadence for `intentPeer`; defaults to the drainer cadence. */
  intentPollIntervalMs?: number;
  /** Power-assertion seam, so a test never spawns a real `caffeinate`. */
  spawnAwake?: (command: string[]) => AwakeProcess;
  /** Skips speech-engine probing, which shells out. */
  voice?: boolean;
  /**
   * Pre-selected speech engines, used instead of probing.
   *
   * The same kind of seam as `spawnHost`: it exists so the voice path can be
   * exercised on a machine that has no speech binaries at all, and so an
   * embedder can supply its own.
   */
  stt?: SttEngine;
  tts?: TtsEngine;
  onLog?: (line: string) => void;
}

export interface LocalOperatorBootstrap {
  deviceId: string;
  tokenPath: string;
  /** True when this start created the device row rather than reusing it. */
  created: boolean;
  /**
   * True when the token already on disk was still valid and was left alone.
   * False means this start wrote a new one, which invalidates the old.
   */
  reused: boolean;
}

export interface OmpdStartInfo {
  port: number;
  url: string;
  /**
   * Where a device can actually reach this daemon, as of this start.
   *
   * Returned rather than looked up afterward because `url` is the bind
   * address, and `0.0.0.0` is a sentinel meaning "every interface" rather than
   * a destination anything can open. A caller printing a banner needs the real
   * set, and asking the daemon over HTTP for it would mean resolving an
   * endpoint file that a foreground start has only just written.
   */
  endpoints: EndpointOffer[];
  /** Null when the local operator device exists but has been revoked. */
  bootstrap: LocalOperatorBootstrap | null;
}

export interface SignalHandlerOptions {
  /** Defaults to `process.exit`. Injected so a test can watch the code. */
  exit?: (code: number) => void;
}

/**
 * Read `<home>/config.json`, merged over the defaults.
 *
 * A file that exists and is wrong is an error, never a silent fallback: a
 * daemon that quietly ran under `standard` because someone typoed `strict`
 * would be enforcing a policy nobody chose.
 */
export function loadConfig(home: string, overrides: Partial<OmpdConfig> = {}): OmpdConfig {
  const path = join(home, "config.json");
  let fromFile: Partial<OmpdConfig> = {};

  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    fromFile = parsed as Partial<OmpdConfig>;
  }

  const merged: OmpdConfig = { ...DEFAULT_CONFIG, ...fromFile, ...overrides };

  if (typeof merged.host !== "string" || merged.host.length === 0) {
    throw new Error(`${path}: host must be a non-empty string`);
  }
  if (!Number.isInteger(merged.port) || merged.port < 0 || merged.port > 65_535) {
    throw new Error(`${path}: port must be an integer between 0 and 65535`);
  }
  if (!POLICY_MODES.includes(merged.policyMode)) {
    throw new Error(
      `${path}: policyMode must be one of ${POLICY_MODES.join(", ")}, got ${String(merged.policyMode)}`,
    );
  }
  if (typeof merged.ompPath !== "string" || merged.ompPath.length === 0) {
    throw new Error(`${path}: ompPath must be a non-empty string`);
  }
  if (typeof merged.keepAwake !== "boolean") {
    throw new Error(`${path}: keepAwake must be true or false, got ${String(merged.keepAwake)}`);
  }
  if (typeof merged.hubUrl !== "string") {
    throw new Error(`${path}: hubUrl must be a string, got ${String(merged.hubUrl)}`);
  }
  if (merged.hubUrl !== "" && !/^wss?:\/\//.test(merged.hubUrl)) {
    // A hub reached over plain http is one anything on the path can answer for.
    // The sealed channel would still refuse an impostor, but failing here names
    // the misconfiguration rather than surfacing it as a handshake that never
    // completes.
    throw new Error(`${path}: hubUrl must be a ws:// or wss:// URL, got ${merged.hubUrl}`);
  }
  if (typeof merged.replica !== "boolean") {
    throw new Error(`${path}: replica must be true or false, got ${String(merged.replica)}`);
  }
  if (typeof merged.replicaSyncToken !== "string") {
    throw new Error(`${path}: replicaSyncToken must be a string, got ${String(merged.replicaSyncToken)}`);
  }
  if (merged.replica && merged.replicaSyncToken === "") {
    throw new Error(`${path}: replica requires a non-empty replicaSyncToken`);
  }
  if (typeof merged.intentPeerUrl !== "string") {
    throw new Error(`${path}: intentPeerUrl must be a string, got ${String(merged.intentPeerUrl)}`);
  }
  if (typeof merged.intentPeerToken !== "string") {
    throw new Error(`${path}: intentPeerToken must be a string, got ${String(merged.intentPeerToken)}`);
  }
  if (merged.intentPeerUrl !== "" && !/^https?:\/\//.test(merged.intentPeerUrl)) {
    throw new Error(`${path}: intentPeerUrl must be an http:// or https:// URL, got ${merged.intentPeerUrl}`);
  }
  if ((merged.intentPeerUrl === "") !== (merged.intentPeerToken === "")) {
    throw new Error(`${path}: intentPeerUrl and intentPeerToken must both be set or both be empty`);
  }
  if (
    typeof merged.intentPollIntervalMs !== "number" ||
    !Number.isFinite(merged.intentPollIntervalMs) ||
    merged.intentPollIntervalMs < 0 ||
    !Number.isInteger(merged.intentPollIntervalMs)
  ) {
    throw new Error(
      `${path}: intentPollIntervalMs must be a non-negative integer, got ${String(merged.intentPollIntervalMs)}`,
    );
  }

  return merged;
}

/**
 * Create the state directory 0700 if it is not there.
 *
 * Shared with the CLI, which has to write a log file into it before the
 * daemon's own constructor has had a chance to run.
 */
export function ensureHome(home: string): string {
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask, and this directory holds a
    // credential, so the permission is asserted rather than requested.
    chmodSync(home, 0o700);
  }
  return home;
}

/**
 * Where the daemon records the address it is actually serving.
 *
 * Runtime state, not configuration: written at `listen` and removed at `stop`,
 * the way a pid file is. It exists because a daemon started with `--port 0`,
 * or with a `--port` that never reached the config file, is otherwise
 * unfindable by the next command someone types.
 */
export function endpointPath(home: string): string {
  return join(home, "endpoint");
}

export class Ompd {
  #home: string;
  #config: OmpdConfig;
  #onLog: (line: string) => void;
  #voiceEnabled: boolean;

  #store: Store;
  #proposals: ProposalStore;
  #events: GatewayEvents;
  #hosts: HostRegistry;
  #supervisor: Supervisor;
  #provisioner: HostProvisioner;
  #scheduler: Scheduler;
  #tasks: TaskManager;
  #sessionIndex: SessionIndex;
  #evolution: EvolutionEngine;
  #gateway: Gateway;
  #queuedIntentDrainer: QueuedIntentDrainer | undefined;
  #intentPollIntervalMs: number | undefined;
  /**
   * The port the gateway actually bound, read back from `listen()`.
   *
   * `#config.port` may be `0`, a request for whatever the OS hands back, so
   * anything that has to name this daemon's real address, `/v1/endpoints`
   * included, reads this instead of the config value.
   */
  #boundPort: number | undefined;
  #sleepGuard: SleepGuard;
  /** The outbound leg, when a hub is configured. */
  #tunnel: TunnelDaemon | undefined;
  #webViewBridge: WebViewBridge;
  #webViewMcpServer: WebViewMcpServer | undefined;

  #stt: SttEngine | undefined;
  #tts: TtsEngine | undefined;
  #starting: Promise<OmpdStartInfo> | undefined;
  #stopping: Promise<void> | undefined;

  /**
   * `agentId + deviceId` pairs currently in voice mode.
   *
   * Keyed on the device rather than on the socket or the agent, and that
   * choice is the whole design. Socket-keyed would go mute every time a phone
   * changed networks, which is the failure this daemon exists to prevent.
   * Agent-keyed would push synthesized audio at a desktop that only ever
   * typed. A device is the thing that asked to be spoken to.
   */
  #voiced = new Set<string>();
  /** Live bridges by device, so a reconnect is spoken to on its new socket. */
  #bridges = new Map<string, Set<VoiceBridge>>();
  /**
   * Highest update seq seen per agent, so a reply can be read back as the
   * updates a turn produced rather than the agent's whole history.
   */
  #lastSeq = new Map<AgentId, number>();

  /**
   * Opens local state and builds every subsystem. Touches the filesystem and
   * nothing else; the network is `start`'s job.
   */
  constructor(opts: OmpdOptions = {}) {
    this.#home = ensureHome(opts.home ?? join(homedir(), ".ompd"));

    this.#config = loadConfig(this.#home, opts.overrides);
    this.#onLog = opts.onLog ?? (() => {});
    this.#voiceEnabled = opts.voice ?? true;
    // Set here, not in `start`, because the guard there decides whether to
    // probe by asking whether these are already filled.
    this.#stt = opts.stt;
    this.#tts = opts.tts;

    this.#store = new Store(join(this.#home, "ompd.db"));
    this.#proposals = new ProposalStore(join(this.#home, "proposals.db"));
    this.#events = new GatewayEvents();

    // The watermark a spoken reply is read from. Recorded off the same fan-out
    // the gateway uses, so the boundary of a turn is observed rather than
    // recomputed by scanning an agent's whole update history.
    this.#events.add({ onUpdate: (agentId, seq) => void this.#lastSeq.set(agentId, seq) });
    // Subscribed to the event fan-out rather than reaching into the
    // supervisor: the supervisor already announces every state transition, and
    // a power assertion is exactly the kind of concern that should observe
    // that stream instead of being wired into the thing producing it.
    this.#sleepGuard = new SleepGuard({
      enabled: this.#config.keepAwake,
      onLog: this.#onLog,
      spawn: opts.spawnAwake,
    });
    this.#events.add({ onAgentsChanged: (agents) => this.#sleepGuard.update(agents) });

    // Hosts are named here so the provisioner and supervisor share one
    // registry: a container agent's session would otherwise be the only kind
    // the gateway could not answer a mode query for. Keeping every spawn on
    // the daemon's own machine is the whole point of that refusal.
    this.#hosts = new HostRegistry({ spawn: opts.spawnHost });

    // The backends are named here rather than left to the provisioner's
    // defaults for one reason: they have to spawn through the registry above,
    // or a container agent's session would be the only kind the gateway could
    // not answer a mode query for.
    this.#provisioner = new HostProvisioner({
      store: this.#store,
      workspace: opts.repoRoot ?? process.cwd(),
      backends: {
        local: new LocalBackend({ ompPath: this.#config.ompPath, spawn: this.#hosts.spawn }),
        container: new ContainerBackend({
          workspace: opts.repoRoot ?? process.cwd(),
          home: this.#home,
          spawn: this.#hosts.spawn,
        }),
      },
      onLog: this.#onLog,
    });

    const policy = new DefaultPolicy({ mode: this.#config.policyMode });
    let sendWebViewAction: WebViewDispatch["send"] = () => false;
    let requestWebViewApproval: WebViewApprovalGate["request"] = () =>
      Promise.resolve({ allowed: false, reason: "approval supervisor is not available" });
    this.#webViewBridge = new WebViewBridge({
      policy,
      store: this.#store,
      dispatch: {
        send: (agentId, requestId, action) => sendWebViewAction(agentId, requestId, action),
      },
      approvals: {
        request: (input) => requestWebViewApproval(input),
      },
    });

    this.#supervisor = new Supervisor({
      store: this.#store,
      policy,
      events: this.#events,
      approvalTimeoutMs: opts.approvalTimeoutMs,
      ompPath: this.#config.ompPath,
      spawnHost: this.#hosts.spawn,
      provisioner: this.#provisioner,
      onLog: this.#onLog,
      mcpServersFor: (agentId) => {
        const server = this.#webViewMcpServer;
        if (server === undefined) throw new Error("webview MCP server is not started");
        return [mcpServerDescriptor(server, agentId)];
      },
    });
    const intentPeer =
      opts.intentPeer ??
      (this.#config.intentPeerUrl !== ""
        ? new HttpIntentPeer({
            url: this.#config.intentPeerUrl,
            token: this.#config.intentPeerToken,
          })
        : undefined);
    if (intentPeer !== undefined) {
      this.#queuedIntentDrainer = new QueuedIntentDrainer({
        supervisor: this.#supervisor,
        peer: intentPeer,
        onError: (error) => this.#onLog(`queued intent drain failed: ${error.message}`),
      });
      this.#intentPollIntervalMs =
        opts.intentPollIntervalMs ??
        (this.#config.intentPollIntervalMs > 0 ? this.#config.intentPollIntervalMs : undefined);
    }
    requestWebViewApproval = ({ agentId, tool, title, action }) =>
      this.#supervisor.gateAction({ agentId, tool, title, input: action });

    // Timer-driven runs act as the machine's own operator. The supervisor
    // re-reads the device row on every call, so revoking that device stops
    // scheduled runs too rather than leaving a privileged ghost behind.
    this.#scheduler = new Scheduler({
      store: this.#store,
      supervisor: this.#supervisor,
      actor: { deviceId: LOCAL_OPERATOR_DEVICE_ID, scopes: [...LOCAL_OPERATOR_SCOPES] },
    });
    this.#evolution = new EvolutionEngine({
      store: this.#store,
      proposals: this.#proposals,
      repoRoot: opts.repoRoot ?? process.cwd(),
    });
    this.#tasks = new TaskManager({ store: this.#store, supervisor: this.#supervisor });
    this.#sessionIndex = new SessionIndex({ store: this.#store });

    this.#gateway = new Gateway({
      supervisor: this.#supervisor,
      store: this.#store,
      events: this.#events,
      onError: (err) => this.#onLog(`unhandled request error: ${err.stack ?? err.message}`),
      host: this.#config.host,
      port: this.#config.port,
      version: OMPD_VERSION,
      // Lets `ompd start` tell "that is me already running" from "something
      // else owns this port", instead of adopting any healthy listener.
      homeId: homeIdFor(this.#home),
      routines: this.#scheduler,
      sessions: this.#hosts,
      sessionIndex: this.#sessionIndex,
      endpoints: () => this.#reachableEndpoints(),
      onWebViewResult: (agentId, requestId, result) =>
        this.#webViewBridge.resolveResult(agentId, requestId, result),
      onWebViewUnavailable: (agentId) => this.#webViewBridge.cancelAgent(agentId, NO_TARGET),
      staticRoot: opts.staticRoot ?? defaultStaticRoot(),
      skills: { list: listSkillCatalog },
      connectors: { list: listConnectorCatalog },
      tasks: this.#tasks,
      // A rotation can be driven from any device, including a phone. The one
      // credential that also lives on disk has to follow, or `ompd rotate`
      // from the console leaves the CLI on this machine holding a token the
      // daemon has just withdrawn.
      onTokenRotated: (deviceId, token) => {
        if (deviceId !== LOCAL_OPERATOR_DEVICE_ID) return undefined;
        writeFileSync(this.tokenPath, `${token}\n`, { mode: 0o600 });
        chmodSync(this.tokenPath, 0o600);
        this.#onLog(`rotated the local operator token; rewrote ${this.tokenPath} (mode 0600)`);
        return this.tokenPath;
      },
      // A typed prompt from a device turns its voice off for that agent. The
      // modality follows what the operator just demonstrated they want, which
      // needs no setting and no timer.
      onTextPrompt: (agentId, actor) => this.#voiced.delete(voiceKey(agentId, actor.deviceId)),
      voice: this.#voiceEnabled ? (send, actor) => this.#openVoice(send, actor) : undefined,
      ...(this.#config.replicaSyncToken !== ""
        ? {
            federation: {
              replica: this.#config.replica,
              syncToken: this.#config.replicaSyncToken,
            },
          }
        : {}),
    });
    sendWebViewAction = (agentId, requestId, action) =>
      this.#gateway.sendWebViewAction(agentId, requestId, action);
  }

  /**
   * Every way a device can reach this daemon right now, recomputed per
   * request rather than cached at construction so a hub dialed after boot is
   * reflected without a restart.
   *
   * Identity is read here, never created: minting one as a side effect of
   * listing endpoints would hand a hub-less daemon a daemon id nobody asked
   * for. `loadIdentity` only runs when `hubUrl` is set, and only once the
   * identity file is confirmed to already exist.
   */
  #reachableEndpoints(): EndpointOffer[] {
    const { host, hubUrl } = this.#config;
    // `#config.port` may be `0`, a request for whatever the OS hands back;
    // the seam has to name the address the gateway actually bound.
    const port = this.#boundPort ?? this.#config.port;
    const daemonId =
      hubUrl !== "" && existsSync(identityPath(this.#home)) ? loadIdentity(this.#home).daemonId : undefined;
    return reachableEndpoints({ host, port, hubUrl, daemonId });
  }

  /**
   * Build the voice bridge for one socket and register it against its device.
   *
   * The registry is what makes a spoken reply survive a reconnect: the pair
   * that asked to be spoken to is remembered by device, and this is where the
   * device's current socket is found again.
   */
  #openVoice(send: (frame: ServerFrame) => void, actor: Actor): VoiceHandler {
    const bridge = new VoiceBridge({
      send,
      stt: this.#stt,
      tts: this.#tts,
      // Speech is a prompt like any other: the supervisor authorizes it
      // against the device row rather than trusting the bridge.
      //
      // The promise is returned rather than swallowed. The bridge awaits this
      // callback inside the same try that guards transcription and emits
      // exactly one error frame for either, so returning it is what makes a
      // rejected prompt visible to the phone. Catching here would log the
      // failure and leave the operator watching a transcript that never
      // became a turn.
      onTranscript: async (agentId, text, speaker) => {
        // Speaking is what puts this pair in voice mode, and it is recorded
        // before the turn rather than after, so a reply still reaches a device
        // whose socket dropped while the agent was thinking.
        this.#voiced.add(voiceKey(agentId, speaker.deviceId));
        const from = this.#lastSeq.get(agentId) ?? 0;
        await this.#supervisor.prompt(agentId, text, speaker);
        await this.#announceReply(agentId, speaker.deviceId, from);
      },
      onLog: this.#onLog,
    });

    const forDevice = this.#bridges.get(actor.deviceId) ?? new Set<VoiceBridge>();
    forDevice.add(bridge);
    this.#bridges.set(actor.deviceId, forDevice);

    return {
      handleFrame: (frame, who) => bridge.handleFrame(frame, who),
      close: () => {
        forDevice.delete(bridge);
        if (forDevice.size === 0) this.#bridges.delete(actor.deviceId);
        // Voice mode itself is deliberately not cleared. The device is still
        // the one having a spoken conversation; it just has no socket this
        // instant.
        bridge.close();
      },
    };
  }

  /**
   * The speakable form of a turn's answer, or null when there is nothing worth
   * saying.
   *
   * Derived without touching a speech engine, deliberately. Synthesis is one
   * consumer of this text and increasingly the less important one: a phone
   * with its own voice wants the prose, not the audio, and a daemon on a
   * machine with no TTS at all still knows what the agent said. Keeping the
   * derivation here rather than inside the bridge is what lets that text be
   * sent on its own.
   *
   * Only the updates this turn produced are read, so an agent answering its
   * tenth question does not recite the previous nine.
   */
  spokenReply(agentId: AgentId, fromSeq: number): SpokenReply | null {
    const records = this.#store.updatesSince(agentId, fromSeq);
    if (records.length === 0) return null;

    const reply = joinAssistantText(records.map((record) => record.payload));
    if (reply.length === 0) return null;

    // OMP's own markdown-to-speech transform, so the daemon and the terminal
    // say the same words. A turn that was only a code fence produces no
    // speakable segments, and silence is the right answer there.
    const spoken = speakableSegments(reply).join(" ");
    if (spoken.length === 0) return null;

    // Capped at the source. A client is going to read this out; handing it an
    // unbounded transcript would have a phone talking for a quarter of an hour
    // with no way to know it was going to.
    const text =
      spoken.length <= SAY_MAX_CHARS ? spoken : `${truncateOnWord(spoken, SAY_MAX_CHARS)}...`;

    // The last update the text actually derives from, so a client can tell
    // turns apart and refuse to say one twice.
    const seq = records[records.length - 1]?.seq ?? fromSeq;
    return { text, seq };
  }

  /**
   * Announce a turn's answer as prose, and speak it to a device that asked to
   * be spoken to.
   *
   * The text goes out either way, because that is the path a phone with its
   * own voice uses and it needs no speech engine on this machine. Synthesis is
   * the fallback for a client that has no voice of its own, and only a device
   * that spoke first gets it.
   */
  async #announceReply(agentId: AgentId, deviceId: string, fromSeq: number): Promise<void> {
    const reply = this.spokenReply(agentId, fromSeq);
    if (reply === null) return;

    this.#events.emitSay({ agentId, seq: reply.seq, text: reply.text });

    if (!this.#voiced.has(voiceKey(agentId, deviceId))) return;
    // Every live socket this device holds. Usually one; two means the operator
    // has the app open twice and both should hear the answer.
    for (const bridge of this.#bridges.get(deviceId) ?? []) {
      // `speak` emits its own error frame on synthesis failure, which is not
      // this function's to re-report.
      await bridge.speak(agentId, reply.text);
    }
  }

  get home(): string {
    return this.#home;
  }

  get config(): OmpdConfig {
    return { ...this.#config };
  }

  get tokenPath(): string {
    return join(this.#home, "token");
  }

  get store(): Store {
    return this.#store;
  }

  get supervisor(): Supervisor {
    return this.#supervisor;
  }

  get gateway(): Gateway {
    return this.#gateway;
  }

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  get provisioner(): HostProvisioner {
    return this.#provisioner;
  }

  get evolution(): EvolutionEngine {
    return this.#evolution;
  }

  get sleepGuard(): SleepGuard {
    return this.#sleepGuard;
  }

  /**
   * Bring the daemon up. Idempotent: a second call returns the first result
   * rather than binding a second port.
   */
  async start(): Promise<OmpdStartInfo> {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<OmpdStartInfo> {
    if (this.#voiceEnabled && (this.#stt === undefined || this.#tts === undefined)) {
      // Probed once here rather than per socket: selection shells out to find
      // the speech binaries, and doing that on every connection would put a
      // subprocess in the path of opening a page. Engines handed in at
      // construction skip the probe entirely.
      const [stt, tts] = await Promise.all([
        selectSttEngine({ onLog: this.#onLog }),
        selectTtsEngine({ onLog: this.#onLog }),
      ]);
      this.#stt ??= stt;
      this.#tts ??= tts;
    }

    this.#webViewMcpServer ??= startWebViewMcpServer(this.#webViewBridge);

    const bootstrap = this.#bootstrapLocalOperator();
    const port = await this.#gateway.listen();
    this.#boundPort = port;
    const url = `http://${this.#config.host}:${port}`;
    // Published only once the port is real, so nothing can read an address
    // that was never bound. This is what lets the CLI find a daemon started
    // on a port the config file has never heard of.
    writeFileSync(endpointPath(this.#home), `${url}\n`);

    // Dialed after the gateway is listening, so a session that arrives
    // immediately has something to terminate into. A hub that is down is not a
    // startup failure: the dialer retries forever and the daemon is fully
    // usable over loopback meanwhile.
    if (this.#config.hubUrl !== "") {
      const identity = loadIdentity(this.#home);
      this.#tunnel = createTunnelDialer({
        hubUrl: this.#config.hubUrl,
        identity,
        gateway: this.#gateway,
        store: this.#store,
        onLog: this.#onLog,
      });
      this.#tunnel.start();
      this.#onLog(`dialing hub ${this.#config.hubUrl} as ${identity.daemonId}`);
    }
    // A run left mid-flight by a process that was killed cannot settle itself,
    // and until something does, `hasActiveRun` keeps a singleton routine
    // silent. Reconciled before the scheduler is armed, so nothing this
    // rewrites can be a run of this daemon's own.
    const interrupted = this.#store.failInterruptedRuns(
      "the daemon exited while this run was in flight",
    );
    if (interrupted > 0) {
      this.#onLog?.(`settled ${interrupted} run(s) left mid-flight by a previous daemon`);
    }
    this.#scheduler.start();
    if (this.#queuedIntentDrainer !== undefined) {
      if (this.#intentPollIntervalMs === undefined) this.#queuedIntentDrainer.start();
      else this.#queuedIntentDrainer.start(this.#intentPollIntervalMs);
    }

    return { port, url, endpoints: this.#reachableEndpoints(), bootstrap };
  }

  /**
   * Take the daemon down in the one order that does not drop work.
   *
   * Idempotent by memoising the first attempt, so a second signal, a CLI
   * shutdown racing a signal, and a test calling it twice all await the same
   * teardown instead of running it again against half-closed subsystems.
   */
  async stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    // A signal can arrive while `start` is still probing engines, binding, or
    // writing the token file. Tearing down underneath it would close the store
    // and then let the rest of startup run against it, so teardown waits for
    // startup to settle either way: a start that failed still leaves a
    // half-built daemon that has to come down.
    if (this.#starting !== undefined) await this.#starting.catch(() => undefined);

    try {
      // 1. No new scheduled work, and wait for any in-flight drain before
      //    the supervisor it touches is shut down.
      await this.#queuedIntentDrainer?.stop();
      this.#scheduler.stop();
      // 2. Settle the runs already in flight, before anything they depend on
      //    goes away: cancelling a turn needs the host serving it, and a run
      //    that cannot write its terminal record leaves a row claiming the
      //    routine is still going, which silences a singleton for good. The
      //    scheduler refuses fires from here on, so a request the gateway is
      //    still serving cannot slip a new run in behind this.
      await this.#scheduler.drain();
      // 3. No new client work. Sockets die here, which is survivable: agent
      //    lifetime never belonged to a connection.
      await this.#gateway.close();
      // Between the two: the tunnel is a client of the gateway, so it stops
      // once the gateway has, and before the hosts it was carrying frames for.
      this.#tunnel?.stop();
      this.#tunnel = undefined;
      // 4. Only now tear down what is running. Any earlier and a request could
      //    still arrive for a host that had already been killed.
      await this.#supervisor.shutdown();
      await this.#provisioner.close();
      this.#webViewMcpServer?.close();
      this.#webViewMcpServer = undefined;

      // Retracted after the gateway is closed, never before: a file saying
      // "here" while the port is still accepting would be the wrong lie in the
      // more dangerous direction.
      rmSync(endpointPath(this.#home), { force: true });

      this.#proposals.close();
      this.#store.close();
    } finally {
      // Unconditional. A teardown that threw part-way through must not leave
      // the machine unable to sleep, and this is the one step whose effect is
      // on the operating system rather than on this process.
      this.#sleepGuard.release();
    }
  }

  /**
   * Stop once on SIGINT or SIGTERM.
   *
   * Opt-in rather than automatic, because a library that hijacks process
   * signals on construction is unusable inside anything else. The CLI calls it;
   * a test does not have to.
   */
  installSignalHandlers(opts: SignalHandlerOptions = {}): void {
    const exit = opts.exit ?? ((code: number) => process.exit(code));
    let handled = false;

    const onSignal = (signal: string): void => {
      // A second Ctrl-C must not start a second teardown. `stop` is already
      // idempotent; this keeps the second signal from also calling `exit`.
      if (handled) return;
      handled = true;
      this.#onLog(`received ${signal}, shutting down`);
      void this.stop().then(
        () => exit(0),
        (err: unknown) => {
          this.#onLog(`shutdown failed: ${err instanceof Error ? err.message : err}`);
          exit(1);
        },
      );
    };

    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  /**
   * Give the machine's own operator a usable token, reusing the one on disk.
   *
   * Token hashes are persisted, so the credential in `<home>/token` outlives
   * the process that wrote it. A restart that reissued anyway would rewrite a
   * file nothing asked it to touch and invalidate whatever the operator had
   * already copied into a shell profile or a second terminal. So the file is
   * checked against the registry first: if it still names a live credential
   * for this device, the start says nothing and changes nothing.
   *
   * The row is created once. Only a missing, stale, or unreadable file mints.
   */
  #bootstrapLocalOperator(): LocalOperatorBootstrap | null {
    const existing = this.#store.getDevice(LOCAL_OPERATOR_DEVICE_ID);

    if (existing?.revokedAt) {
      // Deliberately not resurrected. Revocation that a restart undid would not
      // be revocation.
      this.#onLog(
        `the local operator device was revoked at ${existing.revokedAt}; ` +
          `CLI commands need a token from a paired device until it is removed`,
      );
      return null;
    }

    const created = existing === null;
    if (created) {
      const device: Device = {
        id: LOCAL_OPERATOR_DEVICE_ID,
        name: "local operator",
        // No keypair: this device's authority is filesystem access, and a key
        // generated here and stored beside the token would only look like one.
        publicKey: "local",
        scopes: [...LOCAL_OPERATOR_SCOPES],
        createdAt: new Date().toISOString(),
      };
      this.#store.addDevice(device);
      this.#store.audit({
        action: "device.pair",
        actorDeviceId: device.id,
        outcome: "ok",
        detail: { name: device.name, scopes: device.scopes, origin: "local_bootstrap" },
      });
    }

    const tokenPath = this.tokenPath;
    if (!created && this.#reuseLocalOperatorToken(tokenPath)) {
      return { deviceId: LOCAL_OPERATOR_DEVICE_ID, tokenPath, created: false, reused: true };
    }

    const token = this.#gateway.issueToken(LOCAL_OPERATOR_DEVICE_ID);
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    // The mode above only applies at creation, so a file that already existed
    // keeps whatever mode it had. Asserting it here is what keeps a token from
    // staying world-readable because it was once created that way.
    chmodSync(tokenPath, 0o600);

    this.#onLog(
      created
        ? `minted the local operator device and wrote its token to ${tokenPath} (mode 0600)`
        : `the local operator token was missing or no longer valid; wrote a new one to ${tokenPath} (mode 0600)`,
    );

    return { deviceId: LOCAL_OPERATOR_DEVICE_ID, tokenPath, created, reused: false };
  }

  /**
   * True when `<home>/token` already holds a live credential for the operator
   * device, in which case the file is left exactly as it is.
   *
   * Its mode is still asserted. A token that survives restarts is worth more
   * to whoever can read it than one that did not, so the one thing this path
   * will not do is leave a long-lived credential world-readable because some
   * earlier command relaxed it.
   */
  #reuseLocalOperatorToken(tokenPath: string): boolean {
    if (!existsSync(tokenPath)) return false;

    let token: string;
    try {
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {
      return false;
    }
    if (token.length === 0) return false;
    if (!this.#gateway.hasLiveToken(LOCAL_OPERATOR_DEVICE_ID, token)) return false;

    chmodSync(tokenPath, 0o600);
    return true;
  }
}

/**
 * The workspace's built web client, or undefined when it has not been built.
 *
 * Resolved from this file rather than the cwd, so the daemon serves the UI
 * shipped alongside it no matter where it was started from. Inside a compiled
 * binary this resolves into the bundle and finds nothing, which is correct:
 * `packages/web/dist` is a local build artifact that no clone starts with, so
 * the console is served when it has been built and the API is served always.
 */
function defaultStaticRoot(): string | undefined {
  const dist = resolve(import.meta.dir, "../../web/dist");
  return existsSync(join(dist, "index.html")) ? dist : undefined;
}
