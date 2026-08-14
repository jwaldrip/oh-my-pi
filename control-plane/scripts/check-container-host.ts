/**
 * Prove the container host backend, end to end, against a real container.
 *
 * The unit tests for `ContainerBackend` mock the runtime, so they can only show
 * that the right argv was assembled. This drives the whole path: a daemon on
 * its own port and home, `POST /v1/agents` with a `kind: "container"` spec, an
 * `omp acp` inside the container, and the approval gate answered over the
 * client websocket.
 *
 * The gate is the part worth the trouble. `spawnLocalHost` writes the overlay
 * described in `docs/acp-approval-gate.md` to a path on the daemon's machine,
 * which does not exist inside the container; `gate-wrapper.ts` copies it across
 * and byte-verifies it. Nothing about that had ever been watched against a real
 * container, and the image below deliberately carries the operator's global
 * `tools.approvalMode: yolo`, the setting that makes omp skip the ACP
 * permission hook entirely. If the overlay does not arrive, the container runs
 * ungated and the deny round passes while enforcing nothing, which is why the
 * allow round and the overlay comparison both exist.
 *
 * Everything it creates is removed, including on the failure path: the
 * container, the workspace, the daemon home, and the image unless
 * `--keep-image` is given.
 *
 * Usage:
 *   bun run scripts/check-container-host.ts [--keep-image] [--image <tag>]
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CONFIG_YAML } from "../packages/acp/src/index.ts";
import type { Agent, AgentState } from "../packages/core/src/index.ts";
import { Ompd } from "../packages/daemon/src/index.ts";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** The operator's own OMP home, and the only two files read out of it. */
const OMP_AGENT_DB = join(homedir(), ".omp", "agent", "agent.db");
const OMP_CONFIG = join(homedir(), ".omp", "agent", "config.yml");

/**
 * The only provider credential copied into the container.
 *
 * Narrowed to one on purpose. An image that turns out to be hostile then has a
 * single model credential to steal rather than every model and MCP token on
 * the machine.
 */
const CONTAINER_PROVIDER = "anthropic";

/**
 * Tables emptied out of the snapshot before it is handed over. None of them is
 * needed to reach a model, and `usage_history` carries the operator's account
 * email while `cache` carries whatever the last runs asked for.
 */
const PRIVATE_TABLES: readonly string[] = [
  "cache",
  "usage_history",
  "usage_cost_history",
  "client_usage",
  "clients",
  "model_perf",
  "model_usage",
];

/** Markers live in the container's own /tmp, never in the mounted workspace. */
const DENY_MARKER = "/tmp/ompd-container-check-deny.txt";
const ALLOW_MARKER = "/tmp/ompd-container-check-allow.txt";

const TURN_TIMEOUT_MS = 300_000;
const APPROVAL_TIMEOUT_MS = 180_000;

interface Options {
  image: string;
  keepImage: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ApprovalFrame {
  requestId: string;
  agentId: string;
  tool: string;
  title: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
let step = 0;

function record(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  return ok;
}

function phase(title: string): void {
  step += 1;
  console.log(`\n-- ${step}. ${title}`);
}

async function run(argv: string[]): Promise<RunResult> {
  const child = spawn(argv[0] ?? "", argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err) }));
  child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  return await promise;
}

function parseOptions(argv: string[]): Options {
  let image = "ompd-container-host:probe";
  let keepImage = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep-image") {
      keepImage = true;
    } else if (arg === "--image") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--image needs a tag");
      image = next;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { image, keepImage };
}

/**
 * Build the probe image if it is not already present, and report whether this
 * run is the one that created it, because only that run may remove it.
 *
 * The omp release is downloaded into a throwaway build context rather than kept
 * in the repo: it is 150MB, and which build is correct depends on the
 * container's architecture rather than the checkout's.
 */
async function ensureImage(image: string): Promise<boolean> {
  if ((await run(["docker", "image", "inspect", image])).code === 0) {
    console.log(`  image ${image} already present, leaving it alone`);
    return false;
  }

  const arch = (await run(["docker", "info", "--format", "{{.Architecture}}"])).stdout.trim();
  const target = arch === "aarch64" || arch === "arm64" ? "arm64" : "x64";
  const version = (await run(["omp", "--version"])).stdout.trim().replace(/^omp\//, "");
  if (version === "") throw new Error("omp --version returned nothing; is omp on PATH?");

  const context = mkdtempSync(join(tmpdir(), "ompd-container-build-"));
  try {
    const url = `https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-linux-${target}`;
    console.log(`  downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`downloading omp-linux-${target} failed: ${res.status}`);
    writeFileSync(join(context, "omp"), Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    cpSync(join(SCRIPTS_DIR, "container-host.Dockerfile"), join(context, "Dockerfile"));
    cpSync(join(SCRIPTS_DIR, "omp-home-shim.sh"), join(context, "omp-home-shim.sh"));

    console.log(`  building ${image} for linux/${target}`);
    const built = await run(["docker", "build", "-t", image, context]);
    if (built.code !== 0) throw new Error(`docker build failed: ${built.stderr.slice(-800)}`);
    return true;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/**
 * Seed an OMP home for the container inside the workspace.
 *
 * A `.backup` rather than a file copy, because the operator's omp is very
 * likely running and a WAL database copied byte for byte is not guaranteed to
 * open. Everything except one provider's credential is then deleted from the
 * snapshot, and the result is asserted rather than assumed: a prune that
 * silently matched nothing would hand the container every token on the machine.
 *
 * `config.yml` is copied unchanged on purpose, `tools.approvalMode: yolo` and
 * all. That setting is what makes omp skip the ACP permission hook, so a
 * container that still asks is proof the daemon's overlay outranked it.
 */
async function seedOmpHome(workspace: string): Promise<void> {
  if (!existsSync(OMP_AGENT_DB)) throw new Error(`no omp credentials at ${OMP_AGENT_DB}`);

  const seed = join(workspace, ".omp-home", ".omp", "agent");
  mkdirSync(seed, { recursive: true, mode: 0o700 });
  const db = join(seed, "agent.db");

  const copied = await run(["sqlite3", OMP_AGENT_DB, `.backup '${db}'`]);
  if (copied.code !== 0) throw new Error(`sqlite3 .backup failed: ${copied.stderr.trim()}`);

  const statements = [
    `delete from auth_credentials where provider <> '${CONTAINER_PROVIDER}';`,
    "delete from auth_credential_blocks where credential_id not in (select id from auth_credentials);",
    "delete from auth_credential_refresh_leases where credential_id not in (select id from auth_credentials);",
    ...PRIVATE_TABLES.map((table) => `delete from ${table};`),
    "vacuum;",
  ];
  const pruned = await run(["sqlite3", db, statements.join("\n")]);
  if (pruned.code !== 0) throw new Error(`pruning the snapshot failed: ${pruned.stderr.trim()}`);

  const left = await run([
    "sqlite3",
    db,
    "select coalesce(group_concat(distinct provider), '(none)') from auth_credentials;",
  ]);
  const providers = left.stdout.trim();
  if (providers !== CONTAINER_PROVIDER) {
    throw new Error(`snapshot still holds credentials for ${providers}`);
  }
  console.log(`  credentials handed to the container: ${providers}`);

  cpSync(OMP_CONFIG, join(seed, "config.yml"));
  chmodSync(db, 0o600);
}

async function api(
  base: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return await fetch(`${base}${path}`, { ...init, headers });
}

/** A client websocket, authenticated and attached, with an approval queue. */
class Client {
  #ws: WebSocket;
  #approvals: ApprovalFrame[] = [];
  #waiters: Array<(a: ApprovalFrame | null) => void> = [];
  #errors: string[] = [];
  #failures: string[] = [];
  #hello = Promise.withResolvers<string>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.t === "hello") {
        this.#hello.resolve(String(frame.deviceId));
        return;
      }
      if (frame.t === "approval") {
        const approval: ApprovalFrame = {
          requestId: String(frame.requestId),
          agentId: String(frame.agentId),
          tool: String(frame.tool),
          title: String(frame.title),
        };
        const waiter = this.#waiters.shift();
        if (waiter) waiter(approval);
        else this.#approvals.push(approval);
        return;
      }
      if (frame.t === "update") {
        // `docs/acp-approval-gate.md`: a refusal from omp's own approval gate
        // reads "Tool call denied by user: bash", and one from the ACP
        // permission hook reads "Tool call rejected by user (bash)". Both stop
        // the tool, so the text is the only thing that says which gate ran.
        const update = frame.update as { sessionUpdate?: string; status?: string } | null;
        if (update?.sessionUpdate === "tool_call_update" && update.status === "failed") {
          this.#failures.push(JSON.stringify(frame.update));
        }
        return;
      }
      if (frame.t === "error") this.#errors.push(String(frame.message));
    });
  }

  /**
   * Resolves once the daemon has answered `hello`, which is the only proof the
   * token was accepted: an unauthenticated socket is closed rather than
   * refused, and a script that skipped this would read the silence that follows
   * as "no approval was ever requested".
   */
  static async open(base: string, token: string): Promise<Client> {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/v1/socket?token=${token}`);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve());
    ws.addEventListener("error", () => opened.reject(new Error("websocket failed to open")));
    await opened.promise;
    const client = new Client(ws);
    await client.#hello.promise;
    return client;
  }

  get errors(): readonly string[] {
    return this.#errors;
  }

  /** Every `tool_call_update` that reported failure, as raw JSON. */
  get failures(): readonly string[] {
    return this.#failures;
  }

  send(frame: Record<string, unknown>): void {
    this.#ws.send(JSON.stringify(frame));
  }

  /** Null on timeout, which is a finding to report rather than a crash. */
  async nextApproval(ms: number): Promise<ApprovalFrame | null> {
    const queued = this.#approvals.shift();
    if (queued) return queued;
    const { promise, resolve } = Promise.withResolvers<ApprovalFrame | null>();
    const timer = setTimeout(() => {
      this.#waiters = this.#waiters.filter((waiter) => waiter !== resolve);
      resolve(null);
    }, ms);
    this.#waiters.push((approval) => {
      clearTimeout(timer);
      resolve(approval);
    });
    return await promise;
  }

  close(): void {
    this.#ws.close();
  }
}

/**
 * Poll until the agent settles, and report which state it settled in.
 *
 * `failed` and `stopped` end the wait but are not success: a host that died
 * mid-turn also leaves no marker file behind, and reading that as a denial is
 * exactly the mistake `docs/acp-approval-gate.md` warns about.
 */
async function settle(base: string, token: string, agentId: string, ms: number): Promise<AgentState> {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = (await (await api(base, token, "/v1/agents")).json()) as { agents: Agent[] };
    const agent = body.agents.find((candidate) => candidate.id === agentId);
    const state = agent?.state;
    if (state === "idle" || state === "failed" || state === "stopped") return state;
    if (Date.now() > deadline) throw new Error(`agent ${agentId} never settled (state=${state})`);
    await Bun.sleep(1000);
  }
}

async function main(): Promise<number> {
  const opts = parseOptions(process.argv.slice(2));
  const home = mkdtempSync(join(tmpdir(), "ompd-container-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "ompd-container-ws-"));
  let daemon: Ompd | undefined;
  let client: Client | undefined;
  let hostNetwork = "";
  let containerId = "";
  let builtImage = false;
  /**
   * Everything this run puts outside its own temp directories, so the finally
   * block can take it all back. The canary is deliberately in the operator's
   * home, which is the whole point of it, and a probe that left it there would
   * be doing the thing it exists to prove is impossible.
   */
  const hostSideFiles: string[] = [
    join(homedir(), `.ompd-escape-canary-${process.pid}`),
    join(homedir(), "ompd-escape-test"),
  ];

  try {
    phase("preflight");
    const runtime = await run(["docker", "--version"]);
    if (!record("docker responds", runtime.code === 0, runtime.stdout.trim())) return 1;
    builtImage = await ensureImage(opts.image);
    record("probe image available", true, opts.image);

    phase("seed the container's OMP home");
    await seedOmpHome(workspace);
    record("credential snapshot written", true, join(workspace, ".omp-home"));

    phase("start a daemon on its own port and home");
    daemon = new Ompd({
      home,
      overrides: { port: 0, host: "127.0.0.1" },
      repoRoot: workspace,
      voice: false,
      onLog: (line) => console.log(`  [daemon] ${line}`),
    });
    const started = await daemon.start();
    const base = started.url;
    const token = readFileSync(join(home, "token"), "utf8").trim();
    record("daemon listening", true, `${base} home=${home}`);

    phase("provision a container host through POST /v1/agents");
    const before = await run(["docker", "ps", "-a", "--format", "{{.ID}}  {{.Image}}  {{.Status}}"]);
    console.log(`  docker ps -a before:\n${before.stdout.trimEnd() || "    (none)"}`);

    const created = await api(base, token, "/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "container-check",
        cwd: workspace,
        host: { kind: "container", image: opts.image },
      }),
    });
    const createdBody = (await created.json()) as { agent?: Agent; error?: string };
    if (!createdBody.agent) {
      record("agent created", false, `${created.status} ${createdBody.error ?? ""}`);
      return 1;
    }
    const agent = createdBody.agent;
    containerId = agent.host.id;
    record("agent created", created.status === 201, `${agent.id}`);
    record("host kind is container", agent.host.kind === "container", `${agent.host.kind}:${containerId.slice(0, 12)}`);
    record("agent reached idle", agent.state === "idle", `state=${agent.state}`);

    const running = await run(["docker", "inspect", "--format", "{{.State.Running}}", containerId]);
    record("container is running", running.stdout.trim() === "true", running.stdout.trim());

    phase("the gate overlay crossed into the container");
    const remote = `/tmp/ompd-${containerId.slice(0, 12)}/gate.yml`;
    const overlay = await run(["docker", "exec", containerId, "cat", remote]);
    record("overlay is present on the far side", overlay.code === 0, remote);
    record("overlay is byte-identical", overlay.stdout === GATE_CONFIG_YAML, `${overlay.stdout.length} bytes`);

    phase("the container is not privileged");
    const cfg = await run([
      "docker",
      "inspect",
      "--format",
      "{{.HostConfig.Privileged}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}|{{.HostConfig.SecurityOpt}}|{{.Config.User}}|{{.HostConfig.PidsLimit}}",
      containerId,
    ]);
    const [privileged, readonlyRoot, capDrop, securityOpt, user, pids] = cfg.stdout.trim().split("|");
    record("not privileged", privileged === "false", `Privileged=${privileged}`);
    record("root filesystem is read-only", readonlyRoot === "true", `ReadonlyRootfs=${readonlyRoot}`);
    record("all capabilities dropped", capDrop === "[ALL]", `CapDrop=${capDrop}`);
    record("no-new-privileges is set", String(securityOpt).includes("no-new-privileges"), `SecurityOpt=${securityOpt}`);
    record("runs as a named non-root user", user !== "" && user !== "0:0", `User=${user}`);
    record("pids are bounded", Number(pids) > 0, `PidsLimit=${pids}`);

    const whoami = await run(["docker", "exec", containerId, "id", "-u"]);
    record("the process is not uid 0", whoami.stdout.trim() !== "0", `id -u = ${whoami.stdout.trim()}`);

    const nets = await run([
      "docker",
      "inspect",
      "--format",
      "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}",
      containerId,
    ]);
    const joined = nets.stdout.trim();
    // Validated before it is ever used as a filter or an argument to rm: an
    // empty name matches every network, which would turn the teardown check
    // into a query about the whole machine.
    const named = /^ompd-[A-Za-z0-9]+$/.exec(joined.split(" ")[0] ?? "");
    hostNetwork = named?.[0] ?? "";
    record(
      "on exactly one network of its own, not the shared default bridge",
      hostNetwork !== "" && joined.split(/\s+/).filter(Boolean).length === 1,
      `networks=${joined || "(none)"}`,
    );

    phase("escape attempts");
    // Run through `docker exec`, which enters the container with exactly the
    // user and capability set the agent's bash tool inherits, since that tool
    // runs as a child of the `omp acp` this same mechanism started.
    const hostHome = homedir();

    const outsideWrite = await run([
      "docker",
      "exec",
      containerId,
      "sh",
      "-c",
      `echo escaped > ${hostHome}/ompd-escape-test`,
    ]);
    record(
      "cannot write outside the mounted workspace",
      outsideWrite.code !== 0 && !existsSync(join(hostHome, "ompd-escape-test")),
      outsideWrite.stderr.trim().slice(0, 90),
    );

    const rootWrite = await run(["docker", "exec", containerId, "sh", "-c", "echo escaped > /etc/ompd-escape"]);
    record("cannot write the image's own filesystem", rootWrite.code !== 0, rootWrite.stderr.trim().slice(0, 90));

    // A canary rather than only `~/.ssh`, because a machine without one would
    // make that test pass while proving nothing.
    const canary = hostSideFiles[0] ?? join(hostHome, ".ompd-escape-canary");
    writeFileSync(canary, "a secret the container must not reach\n", { mode: 0o600 });
    const readCanary = await run(["docker", "exec", containerId, "sh", "-c", `cat ${canary}`]);
    record("cannot read a file outside the workspace", readCanary.code !== 0, readCanary.stderr.trim().slice(0, 90));

    const sshDir = join(hostHome, ".ssh");
    if (existsSync(sshDir)) {
      const readSsh = await run(["docker", "exec", containerId, "sh", "-c", `ls -a ${sshDir}`]);
      record("the host's ~/.ssh is not visible in the container", readSsh.code !== 0, readSsh.stderr.trim().slice(0, 90));
    } else {
      console.log(`  (no ${sshDir} on this machine, so that attempt would prove nothing and is skipped)`);
    }

    // /dev/tcp is a bash builtin, so reaching for the daemon needs no network
    // tooling in the image. A container reaches its host by more than one name
    // and only the obvious one is isolated.
    const port = new URL(base).port;
    const loopback = await run([
      "docker",
      "exec",
      containerId,
      "bash",
      "-c",
      `timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}'`,
    ]);
    record(`ompd is not on the container's own loopback`, loopback.code !== 0, `exit ${loopback.code}`);

    // Measured, not asserted. Docker for Mac publishes the host under a name
    // that reaches services bound to 127.0.0.1, and a container that must also
    // reach a model endpoint cannot be cut off from the network without a
    // proxy in the path. So the question is not whether the daemon is
    // reachable but whether reaching it is worth anything, which is what the
    // two checks below settle.
    const viaHost = await run([
      "docker",
      "exec",
      containerId,
      "bash",
      "-c",
      `timeout 5 bash -c 'exec 3<>/dev/tcp/host.docker.internal/${port}'`,
    ]);
    if (viaHost.code !== 0) {
      record("the daemon's port is unreachable from the container", true, "no host route to it");
    } else {
      const unauth = await run([
        "docker",
        "exec",
        containerId,
        "bash",
        "-c",
        `timeout 5 bash -c 'exec 3<>/dev/tcp/host.docker.internal/${port}; printf "GET /v1/agents HTTP/1.1\\r\\nHost: ompd\\r\\nConnection: close\\r\\n\\r\\n" >&3; head -1 <&3'`,
      ]);
      record(
        "the daemon refuses the reachable container without a token",
        /401|403/.test(unauth.stdout),
        unauth.stdout.trim() || "(no status line)",
      );
    }

    const stealToken = await run(["docker", "exec", containerId, "sh", "-c", `cat ${join(home, "token")}`]);
    record("the daemon's token is not reachable from the container", stealToken.code !== 0, `exit ${stealToken.code}`);

    // The other half of the boundary: the workspace it was given must still
    // work, and what it writes there must belong to the operator rather than
    // to root.
    const inside = await run([
      "docker",
      "exec",
      containerId,
      "sh",
      "-c",
      `echo ok > ${workspace}/written-by-the-agent`,
    ]);
    record("can still write its own workspace", inside.code === 0 && existsSync(join(workspace, "written-by-the-agent")), "");
    const owner = statSync(join(workspace, "written-by-the-agent"), { throwIfNoEntry: false });
    record("workspace writes belong to the operator", owner?.uid === process.getuid?.(), `uid=${owner?.uid}`);

    phase("deny a bash call");
    client = await Client.open(base, token);
    client.send({ t: "attach", agentId: agent.id });
    client.send({
      t: "prompt",
      agentId: agent.id,
      text: `Use your bash tool to run exactly: touch ${DENY_MARKER}\nThat is the entire task. Do not use any other tool, and do not retry if it is refused.`,
    });

    const denyAsk = await client.nextApproval(APPROVAL_TIMEOUT_MS);
    if (
      !record(
        "permission request reached ompd",
        denyAsk !== null,
        denyAsk ? `tool=${denyAsk.tool} title=${denyAsk.title.slice(0, 60)}` : "no approval frame arrived",
      )
    ) {
      console.log("\n  The gate did not survive the trip. Everything below would also pass");
      console.log("  against an ungated host, so the run stops here.");
      return 1;
    }
    client.send({ t: "decide", agentId: agent.id, requestId: denyAsk?.requestId, choice: "deny", scope: "once" });

    const afterDeny = await settle(base, token, agent.id, TURN_TIMEOUT_MS);
    record("agent survived the denial", afterDeny === "idle", `state=${afterDeny}`);
    const denyText = client.failures.join(" ");
    console.log(`  tool failure text: ${denyText.slice(0, 240) || "(none reported)"}`);
    record(
      "denial came from the ACP hook, not omp's own gate",
      !/denied by user/.test(denyText),
      /rejected by user/.test(denyText)
        ? "saw 'rejected by user', which is gate 1"
        : "no gate-2 wording present",
    );
    const denied = await run(["docker", "exec", containerId, "test", "-f", DENY_MARKER]);
    record("denied command did not run", denied.code !== 0, `${DENY_MARKER} exists=${denied.code === 0}`);

    phase("allow a bash call");
    client.send({
      t: "prompt",
      agentId: agent.id,
      text: `Use your bash tool to run exactly: uname -s > ${ALLOW_MARKER}\nThat is the entire task. Do not use any other tool.`,
    });
    const allowAsk = await client.nextApproval(APPROVAL_TIMEOUT_MS);
    if (!record("second permission request reached ompd", allowAsk !== null, allowAsk?.tool ?? "none")) return 1;
    client.send({ t: "decide", agentId: agent.id, requestId: allowAsk?.requestId, choice: "allow", scope: "once" });

    const afterAllow = await settle(base, token, agent.id, TURN_TIMEOUT_MS);
    record("agent settled after the allow", afterAllow === "idle", `state=${afterAllow}`);
    const body = await run(["docker", "exec", containerId, "cat", ALLOW_MARKER]);
    record("allowed command ran", body.code === 0, `${ALLOW_MARKER} readable=${body.code === 0}`);
    record("it ran inside the container", body.stdout.trim() === "Linux", `uname -s = ${body.stdout.trim() || "(empty)"}`);

    phase("audit");
    const audit = (await (await api(base, token, "/v1/audit?limit=200")).json()) as {
      entries: Array<{ action: string; outcome: string }>;
    };
    const decisions = audit.entries.filter((entry) => entry.action === "approval.decide");
    record(
      "both decisions are in the audit log",
      decisions.some((d) => d.outcome === "denied") && decisions.some((d) => d.outcome === "ok"),
      decisions.map((d) => d.outcome).join(",") || "(none)",
    );
    record("no socket errors", client.errors.length === 0, client.errors.join(" | "));

    phase("destroy");
    const stopped = await api(base, token, `/v1/agents/${agent.id}`, { method: "DELETE" });
    record("agent stopped", stopped.status === 200, String(stopped.status));

    const after = await run(["docker", "ps", "-a", "--format", "{{.ID}}  {{.Image}}  {{.Status}}"]);
    console.log(`  docker ps -a after:\n${after.stdout.trimEnd() || "    (none)"}`);
    record("container removed", !after.stdout.includes(containerId.slice(0, 12)), containerId.slice(0, 12));

    if (hostNetwork === "") {
      record("its network was removed with it", false, "never captured a valid network name");
    } else {
      const netsLeft = await run(["docker", "network", "ls", "--format", "{{.Name}}", "--filter", `name=${hostNetwork}`]);
      record("its network was removed with it", netsLeft.stdout.trim() === "", hostNetwork);
    }
  } finally {
    // Each step is guarded on its own: one failing cleanup must not skip the
    // rest, and a probe that leaks a container is worse than a probe that
    // fails.
    try {
      client?.close();
    } catch (err) {
      console.log(`  cleanup: closing the socket failed: ${String(err)}`);
    }
    try {
      await daemon?.stop();
    } catch (err) {
      console.log(`  cleanup: stopping the daemon failed: ${String(err)}`);
    }
    if (containerId) {
      const still = await run(["docker", "ps", "-aq", "--filter", `id=${containerId}`]);
      if (still.stdout.trim() !== "") {
        const forced = await run(["docker", "rm", "--force", containerId]);
        console.log(`  cleanup: force-removed a surviving container (exit ${forced.code})`);
      }
    }
    if (hostNetwork) {
      const left = await run(["docker", "network", "ls", "-q", "--filter", `name=${hostNetwork}`]);
      if (left.stdout.trim() !== "") {
        const forced = await run(["docker", "network", "rm", hostNetwork]);
        console.log(`  cleanup: removed a surviving network ${hostNetwork} (exit ${forced.code})`);
      }
    }
    for (const dir of [workspace, home]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.log(`  cleanup: removing ${dir} failed: ${String(err)}`);
      }
    }
    for (const path of hostSideFiles) {
      if (!existsSync(path)) continue;
      try {
        rmSync(path, { force: true });
        console.log(`  cleanup: removed ${path}`);
      } catch (err) {
        console.log(`  cleanup: removing ${path} failed, remove it by hand: ${String(err)}`);
      }
    }
    if (builtImage && !opts.keepImage) {
      const removed = await run(["docker", "rmi", "--force", opts.image]);
      console.log(`  cleanup: removed image ${opts.image} (exit ${removed.code})`);
    }
    console.log("  cleanup: workspace and daemon home removed");
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failed.length} ok, ${failed.length} failed`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
