/**
 * Live check that a routine fires on the real system clock and completes a real
 * agent turn.
 *
 * `packages/daemon/test/routines.test.ts` drives the scheduler with an injected
 * clock and a scripted peer, so it proves the decision logic and nothing about
 * the timer. This runs a real daemon on its own home and port, seeds routines
 * that come due within the next couple of minutes, and waits on the wall clock.
 * Everything it asserts is something a fake cannot show:
 *
 * - a `setInterval` tick actually notices a cron expression coming due
 * - a run transitions queued -> running -> terminal against real time
 * - a real `omp acp` agent leaves a file on disk, which outlives the process
 * - `singleton` skips a fire while the previous run is genuinely still going
 * - a routine that fails does not stop the timer; the next one still fires
 * - the host process, its gate-config overlay, and the run record are settled
 *
 * The load-bearing part is the approval accounting. A run that succeeded is not
 * evidence that policy allowed anything. Measured against the shipped omp
 * 17.2.12 binary, its ACP permission wrapper consults a table
 * `{bash, edit, delete, move}` keyed by tool *name*, and then a descriptor
 * helper that returns nothing unless the call is a `bash` command, a `delete`,
 * a `move`, or an `edit` that resolves to one of those. So `write`,
 * `multi_edit`, and any content-only `edit` execute with no
 * `session/request_permission` at all, and ompd's policy engine never sees
 * them.
 *
 * That is why every tool call the turn made is inventoried from the `updates`
 * table and joined against the `approvals` table by tool call id. A filesystem
 * side effect with no matching approval row is a gate that never fired, not a
 * policy that said yes, and this check fails on it. `docs/acp-approval-gate.md`
 * names that trap in the abstract; this is what detects it.
 *
 * Costs real model tokens. Phase `singleton` deliberately spends most of its
 * wall clock sitting at an unanswered approval gate.
 *
 * Usage:
 *   bun run scripts/check-routine-live.ts                    # both phases
 *   bun run scripts/check-routine-live.ts --phase write
 *   bun run scripts/check-routine-live.ts --phase singleton
 *   bun run scripts/check-routine-live.ts --port 7793 --keep
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type AgentId, type ApprovalRecord, type Routine, type Run } from "@ompd/core";
import { Ompd, nextFireTime } from "@ompd/daemon";
import { coverFor, MUTATING_KINDS, subjectsOf, uncoveredMutations } from "./gate-correlation.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Poll interval for the run watcher. Fast enough to catch `queued`. */
const WATCH_POLL_MS = 200;
/** How often the watcher prints a wall-clock heartbeat. */
const HEARTBEAT_MS = 10_000;
/** Grace for killed hosts to actually leave the process table. */
const REAP_GRACE_MS = 1_500;

/**
 * Lead time before the write routine's cron minute. Four scheduler ticks plus
 * room for startup, so the routine is demonstrably armed and idle before it
 * comes due and the fire cannot be confused with a start-up side effect.
 */
const CRON_LEAD_MS = 70_000;

/**
 * How a call is paired with its approval row lives in `gate-correlation.ts`,
 * along with the reason an identity join cannot work. It is a separate module
 * because it is unit tested: this probe reported a fully closed write gate as a
 * hole for as long as the join was wrong, and nothing here would have caught it.
 */

interface Options {
  phase: "write" | "singleton" | "all";
  port: number;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { phase: "all", port: 7793, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      opts.keep = true;
      continue;
    }
    const value = argv[i + 1];
    if (arg === "--phase") {
      if (value !== "write" && value !== "singleton" && value !== "all") {
        throw new Error(`--phase must be write, singleton, or all (got ${String(value)})`);
      }
      opts.phase = value;
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0) throw new Error("--port must be an integer");
      opts.port = port;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${String(arg)}`);
  }
  return opts;
}

/** Wall clock to millisecond precision, which is the whole point of this check. */
function stamp(at: Date = new Date()): string {
  return at.toISOString().slice(11, 23);
}

function log(message: string): void {
  console.log(`[${stamp()}] ${message}`);
}

function section(title: string): void {
  console.log("");
  console.log(`== ${title} ${"=".repeat(Math.max(2, 70 - title.length))}`);
}

function echo(prefix: string, text: string): void {
  for (const line of text.split("\n")) console.log(`${prefix}${line}`);
}

type RoutineSeed = Partial<Routine> & Pick<Routine, "id" | "name" | "trigger" | "prompt" | "cwd">;

function seedRoutine(input: RoutineSeed): Routine {
  return {
    enabled: true,
    host: { kind: "local" },
    singleton: true,
    labels: {},
    createdAt: new Date().toISOString(),
    ...input,
  };
}

/**
 * `omp acp` children of this process, which is where the hosts live.
 *
 * Scoped by parent pid rather than by name: this machine may be running other
 * daemons, and a census that counted theirs would report a leak on every run.
 */
async function hostProcesses(): Promise<string[]> {
  const pgrep = Bun.spawn(["pgrep", "-P", String(process.pid)], { stdout: "pipe", stderr: "ignore" });
  const listed = (await new Response(pgrep.stdout).text()).trim();
  await pgrep.exited;
  if (listed.length === 0) return [];

  const found: string[] = [];
  for (const pid of listed.split("\n").map((line) => line.trim())) {
    if (pid.length === 0) continue;
    const ps = Bun.spawn(["ps", "-o", "command=", "-p", pid], { stdout: "pipe", stderr: "ignore" });
    const command = (await new Response(ps.stdout).text()).trim();
    await ps.exited;
    if (/\bacp\b/.test(command)) found.push(`${pid}  ${command}`);
  }
  return found;
}

/** Gate-config overlays in the temp dir: one per live host, litter otherwise. */
function gateDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("ompd-gate-"))
    .toSorted();
}

/** Run the real CLI against this daemon, so the operator-visible view is real. */
async function cli(home: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "packages/cli/src/main.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, OMPD_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return `${out}${err}`.trimEnd();
}

interface ToolCall {
  id: string;
  kind: string;
  title: string;
  rawInput: string;
  /** Parsed subject of the call, which is what the approval join uses. */
  paths: string[];
  command: string | null;
}

/**
 * Every tool call the agent announced, read back out of the replay log.
 *
 * This is the other half of the approval evidence. The approvals table only
 * holds calls that reached ompd; this holds calls that happened. The difference
 * between the two sets is the part nobody was asked about.
 */
function toolCalls(daemon: Ompd, agentId: AgentId): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const record of daemon.store.updatesSince(agentId, 0)) {
    const payload = record.payload;
    if (payload === null || typeof payload !== "object") continue;
    if (!("sessionUpdate" in payload) || payload.sessionUpdate !== "tool_call") continue;
    if (!("toolCallId" in payload) || typeof payload.toolCallId !== "string") continue;
    const kind = "kind" in payload && typeof payload.kind === "string" ? payload.kind : "unknown";
    const title = "title" in payload && typeof payload.title === "string" ? payload.title : "";
    const rawInput = "rawInput" in payload ? JSON.stringify(payload.rawInput) : "undefined";
    const subject = subjectsOf("rawInput" in payload ? payload.rawInput : null);
    calls.set(payload.toolCallId, {
      id: payload.toolCallId,
      kind,
      title,
      rawInput,
      paths: subject.paths,
      command: subject.command,
    });
  }
  return [...calls.values()];
}

/**
 * Join the tool calls against the approvals and report the gap.
 *
 * Returns the mutating calls that never reached ompd's gate, which the caller
 * treats as a failure rather than a footnote.
 */
function reportGate(calls: ToolCall[], approvals: ApprovalRecord[]): ToolCall[] {
  if (calls.length === 0) console.log("  the turn announced no tool calls at all");
  for (const call of calls) {
    const cover = coverFor(call, approvals);
    const gate =
      cover.length > 0
        ? `asked (${cover.map((row) => row.rule || "pending").join(", ")})`
        : MUTATING_KINDS[call.kind] === true
          ? "NEVER ASKED"
          : "not gated, non-mutating";
    console.log(`  kind=${call.kind.padEnd(8)} gate=${gate}  ${call.title}`);
    console.log(`      rawInput ${call.rawInput.slice(0, 200)}`);
  }
  const ungated = uncoveredMutations(calls, approvals);

  if (approvals.length === 0) {
    console.log("  the approvals table holds nothing for this agent");
    return ungated;
  }
  for (const record of approvals) {
    // An undecided row reads back with an empty rule and no decided_at, because
    // the columns are nullable and `listApprovals` fills a conservative default.
    const undecided = record.decidedAt === "";
    const waited = undecided
      ? "still pending"
      : `${((new Date(record.decidedAt).getTime() - new Date(record.createdAt).getTime()) / 1000).toFixed(1)}s`;
    console.log(
      `  approval tool=${record.tool}  decision=${undecided ? "pending" : record.decision}  rule=${record.rule === "" ? "-" : record.rule}  actor=${record.actorDeviceId ?? "none"}  waited=${waited}`,
    );
    console.log(`      title  ${record.title}`);
    console.log(`      input  ${JSON.stringify(record.input).slice(0, 240)}`);
  }
  return ungated;
}

interface Observed {
  /** Latest record per run id, in the order the runs were first seen. */
  latest: Map<string, Run>;
  /** Every state each run was observed in, in order. The transition evidence. */
  trail: Map<string, string[]>;
}

/**
 * Poll the store until `done` says so, logging every run state transition with
 * a wall-clock timestamp.
 *
 * The store is polled rather than an event hook subscribed to, because what
 * matters is the recorded history an operator would later read, not that an
 * in-memory callback fired.
 */
async function watch(
  daemon: Ompd,
  routineIds: string[],
  budgetMs: number,
  done: (seen: Observed) => boolean,
  label: string,
): Promise<Observed> {
  const seen: Observed = { latest: new Map(), trail: new Map() };
  const deadline = Date.now() + budgetMs;
  let nextHeartbeat = Date.now() + HEARTBEAT_MS;

  while (Date.now() < deadline) {
    for (const routineId of routineIds) {
      for (const run of daemon.store.listRuns(routineId)) {
        const before = seen.latest.get(run.id);
        seen.latest.set(run.id, run);
        if (before === undefined) {
          seen.trail.set(run.id, [run.state]);
          log(`run ${run.id} (${routineId}) appeared in state ${run.state}`);
          continue;
        }
        if (before.state === run.state && before.agentId === run.agentId) continue;
        if (before.state !== run.state) seen.trail.get(run.id)?.push(run.state);
        const agent = run.agentId === undefined ? "" : ` agent=${run.agentId}`;
        const detail = run.error === undefined ? "" : ` error=${run.error}`;
        log(`run ${run.id} ${before.state} -> ${run.state}${agent}${detail}`);
      }
    }

    if (done(seen)) return seen;

    if (Date.now() >= nextHeartbeat) {
      nextHeartbeat = Date.now() + HEARTBEAT_MS;
      const states = [...seen.latest.values()].map((run) => run.state).toSorted();
      const left = Math.round((deadline - Date.now()) / 1000);
      log(`waiting on ${label}; ${left}s left; runs=[${states.join(",")}]`);
    }
    await Bun.sleep(WATCH_POLL_MS);
  }
  return seen;
}

function reportRuns(daemon: Ompd, routineId: string): void {
  const runs = daemon.store.listRuns(routineId);
  if (runs.length === 0) {
    console.log(`  ${routineId}: no runs`);
    return;
  }
  for (const run of runs.toReversed()) {
    const finished =
      run.finishedAt === undefined ? "unfinished" : `finished ${stamp(new Date(run.finishedAt))}`;
    const agent = run.agentId === undefined ? "" : `  ${run.agentId}`;
    console.log(
      `  ${routineId}: ${run.id}  ${run.state.padEnd(9)}  started ${stamp(new Date(run.startedAt))}  ${finished}${agent}`,
    );
    if (run.error !== undefined) console.log(`      error   ${run.error}`);
    if (run.summary !== undefined) {
      console.log(`      summary ${run.summary.replaceAll("\n", " ").slice(0, 200)}`);
    }
  }
}

/**
 * Reopen the closed store and report any run left mid-flight.
 *
 * A row stuck in `queued` or `running` outlives the daemon, and `hasActiveRun`
 * is what a singleton routine consults on every fire, so a stranded row silences
 * that routine for good. Checked after `stop` because that is when it happens.
 */
function reportStranded(home: string, routineIds: string[], failures: string[]): void {
  const store = new Store(join(home, "ompd.db"));
  try {
    for (const routineId of routineIds) {
      const stranded = store
        .listRuns(routineId)
        .filter((run) => run.state === "queued" || run.state === "running");
      const active = store.hasActiveRun(routineId);
      console.log(`  ${routineId}: ${stranded.length} mid-flight run(s), hasActiveRun=${active}`);
      for (const run of stranded) {
        console.log(`      ${run.id} still ${run.state}, started ${stamp(new Date(run.startedAt))}`);
      }
      if (stranded.length > 0) {
        failures.push(
          `${routineId} left ${stranded.length} run(s) in ${stranded[0]?.state}; hasActiveRun stays true and a singleton routine never fires again`,
        );
      }
    }
  } finally {
    store.close();
  }
}

/**
 * Census both leak dimensions, fail on either, and remove what this run created.
 *
 * The removal is deliberate and does not soften the verdict: the failure is
 * already recorded by the time anything is deleted. Leaving the litter behind to
 * prove a point would just make the next run's baseline wrong.
 */
async function reportLeaks(
  baselineHosts: string[],
  baselineGates: string[],
  failures: string[],
): Promise<void> {
  await Bun.sleep(REAP_GRACE_MS);
  const hosts = await hostProcesses();
  const gates = gateDirs();
  console.log(`  acp children after stop: ${hosts.length} (baseline ${baselineHosts.length})`);
  for (const line of hosts) console.log(`    ${line}`);
  console.log(`  gate dirs after stop: ${gates.length} (baseline ${baselineGates.length})`);
  if (hosts.length > baselineHosts.length) {
    failures.push(`${hosts.length - baselineHosts.length} acp host process(es) leaked`);
  }

  const leaked = gates.filter((dir) => !baselineGates.includes(dir));
  if (leaked.length === 0) return;
  failures.push(
    `${leaked.length} gate config dir(s) leaked: ${leaked.join(", ")} (spawnLocalHost writes the overlay before Bun.spawn, and cleanup hangs off proc.exited, so a spawn that throws never removes it)`,
  );
  for (const dir of leaked) {
    const path = join(tmpdir(), dir);
    rmSync(path, { recursive: true, force: true });
    console.log(`    removed leaked ${path}: exists=${existsSync(path)}`);
  }
}

function cleanUp(dirs: string[], keep: boolean, failures: string[]): void {
  if (keep) {
    for (const dir of dirs) log(`keeping ${dir}`);
    return;
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
    const still = existsSync(dir);
    log(`removed ${dir}: exists=${still}`);
    if (still) failures.push(`cleanup left ${dir} behind`);
  }
}

interface PhaseResult {
  name: string;
  failures: string[];
  findings: string[];
}

/**
 * Phase `write`: a cron routine fires on its own, completes a turn, leaves a
 * file behind, and is torn down -- while a failing routine and a malformed one
 * keep coming due beside it.
 */
async function phaseWrite(port: number, keep: boolean): Promise<PhaseResult> {
  section("phase write: a cron routine fires, writes a file, and is torn down");

  const home = mkdtempSync(join(tmpdir(), "ompd-routine-live-home-"));
  const work = mkdtempSync(join(tmpdir(), "ompd-routine-live-work-"));
  const missing = join(work, "no-such-directory");
  const marker = join(work, "routine-marker.txt");
  const nonce = `live-${crypto.randomUUID().slice(0, 8)}`;

  const baselineHosts = await hostProcesses();
  const baselineGates = gateDirs();
  log(`home ${home}`);
  log(`work ${work}`);
  log(`baseline: ${baselineHosts.length} acp children, ${baselineGates.length} gate dirs`);

  const daemon = new Ompd({
    home,
    overrides: { port, host: "127.0.0.1" },
    repoRoot: REPO_ROOT,
    onLog: (line) => console.log(`    daemon| ${line}`),
  });

  // Computed before start so the lead is measured from the moment the scheduler
  // arms, not from whenever the seeding finished.
  const fireAt = new Date(Math.ceil((Date.now() + CRON_LEAD_MS) / 60_000) * 60_000);
  const expression = `${fireAt.getMinutes()} ${fireAt.getHours()} * * *`;

  const writeId = "rt_live_write";
  const failId = "rt_live_badcwd";
  const brokenId = "rt_live_broken";

  daemon.store.upsertRoutine(
    seedRoutine({
      id: writeId,
      name: "live-write-marker",
      trigger: { kind: "cron", expression },
      cwd: work,
      timeoutSeconds: 240,
      prompt:
        `Use your write tool to create the file ${marker} with exactly this single line of content:\n` +
        `${nonce}\n` +
        "Do not use bash, and do not create any other file. That is the entire task.",
    }),
  );
  daemon.store.upsertRoutine(
    seedRoutine({
      id: failId,
      name: "live-bad-cwd",
      trigger: { kind: "interval", seconds: 20 },
      cwd: missing,
      timeoutSeconds: 60,
      prompt: "Reply with the single word: ok",
    }),
  );
  daemon.store.upsertRoutine(
    seedRoutine({
      id: brokenId,
      name: "live-broken-cron",
      trigger: { kind: "cron", expression: "banana * * * *" },
      cwd: work,
      prompt: "Reply with the single word: ok",
    }),
  );

  const findings: string[] = [];
  const failures: string[] = [];

  const info = await daemon.start();
  log(`daemon listening at ${info.url}, pid ${process.pid}, policy ${daemon.config.policyMode}`);
  log(
    `cron "${expression}" is due at ${stamp(fireAt)}, ${((fireAt.getTime() - Date.now()) / 1000).toFixed(1)}s from now`,
  );
  log(`the cron evaluator agrees: next fire ${stamp(nextFireTime(expression, new Date()))}`);

  try {
    section("what the operator sees before anything has fired");
    echo("    ", await cli(home, "routines"));

    // The failing routine is on a 20s interval, so it comes due first and keeps
    // coming due. Waiting for one failure before the cron routine is even armed
    // to fire is what makes the later success evidence of isolation, not luck.
    const early = await watch(
      daemon,
      [failId],
      90_000,
      (s) => [...s.latest.values()].some((run) => run.state === "failed"),
      "the bad-cwd routine to fail at least once",
    );
    const earlyFailures = [...early.latest.values()].filter((run) => run.state === "failed");
    if (earlyFailures.length === 0) {
      failures.push("the bad-cwd routine never produced a failed run");
    } else {
      findings.push(
        `the bad-cwd routine failed ${earlyFailures.length} time(s) before the cron routine came due`,
      );
    }

    const observed = await watch(
      daemon,
      [writeId],
      300_000,
      (s) => [...s.latest.values()].some((run) => run.finishedAt !== undefined),
      "the cron routine to fire and settle",
    );

    section("run history for every routine in this phase");
    for (const id of [writeId, failId, brokenId]) reportRuns(daemon, id);

    const writeRuns = daemon.store.listRuns(writeId);
    const writeRun = writeRuns[0];
    if (writeRun === undefined) {
      failures.push("the cron routine never fired");
    } else {
      const trail = observed.trail.get(writeRun.id) ?? [];
      console.log(`  observed transitions: ${trail.join(" -> ")}`);
      if (!trail.includes("running")) {
        failures.push(`the run was never observed running (trail: ${trail.join(" -> ")})`);
      }

      const drift = (new Date(writeRun.startedAt).getTime() - fireAt.getTime()) / 1000;
      findings.push(
        `the cron routine fired at ${stamp(new Date(writeRun.startedAt))}, ${drift.toFixed(1)}s after its cron minute, and ended ${writeRun.state}`,
      );
      if (drift < 0) failures.push("the run started before its cron minute");
      if (drift > 20) failures.push(`the run started ${drift.toFixed(1)}s late; the tick is 15s`);
      if (writeRun.state !== "succeeded") {
        failures.push(`the run ended ${writeRun.state}, not succeeded`);
      }

      section("the side effect on disk");
      let wrote = false;
      if (existsSync(marker)) {
        const body = readFileSync(marker, "utf8");
        console.log(`  ${marker}`);
        echo("    | ", body.trimEnd());
        wrote = body.includes(nonce);
        if (wrote) {
          findings.push(`the agent wrote ${marker} containing the nonce ${nonce}`);
        } else {
          failures.push(`${marker} exists but does not contain the nonce ${nonce}`);
        }
      } else {
        console.log(`  ${marker} does not exist`);
        failures.push("the unattended run left no file on disk");
      }

      section("every tool call the turn made, joined against the approvals");
      const approvals =
        writeRun.agentId === undefined ? [] : daemon.store.listApprovals(writeRun.agentId);
      const calls = writeRun.agentId === undefined ? [] : toolCalls(daemon, writeRun.agentId);
      const ungated = reportGate(calls, approvals);

      if (wrote && approvals.length === 0) {
        failures.push(
          "the run wrote a file and ompd's policy engine was never asked: session/request_permission never fired, so the write was neither allowed nor denied by policy, it was simply ungated",
        );
        findings.push(
          "the unattended run completed a filesystem task with zero approval rows, so the gate did not fire for it at all",
        );
      }
      if (ungated.length > 0) {
        failures.push(
          `${ungated.length} mutating tool call(s) ran without reaching the gate: ${ungated.map((c) => `${c.kind}/${c.title}`).join("; ")}`,
        );
      }
      const automatic = approvals.filter(
        (a) => a.decision === "allow" && a.actorDeviceId === null && a.decidedAt !== "",
      );
      if (automatic.length > 0) {
        findings.push(
          `policy allowed ${automatic.length} tool call(s) unattended, by rule ${[...new Set(automatic.map((a) => a.rule))].join(", ")}`,
        );
      }

      section("teardown: the agent the run created");
      const agent = writeRun.agentId === undefined ? null : daemon.store.getAgent(writeRun.agentId);
      if (agent === null) {
        failures.push("the run recorded no agent");
      } else {
        console.log(
          `  ${agent.id}  state=${agent.state}  host=${agent.host.kind}:${agent.host.id}  cwd=${agent.cwd}`,
        );
        if (agent.state !== "stopped") failures.push(`the run's agent is ${agent.state}, not stopped`);
        findings.push(`the run's agent ended in state ${agent.state}`);
      }
    }

    section("the malformed cron expression");
    const brokenRuns = daemon.store.listRuns(brokenId);
    const brokenAudit = daemon.store
      .listAudit(500)
      .filter((entry) => entry.detail.routineId === brokenId);
    console.log(`  runs: ${brokenRuns.length}`);
    for (const entry of brokenAudit) {
      console.log(`  audit ${entry.ts} ${entry.outcome} ${JSON.stringify(entry.detail)}`);
    }
    if (brokenRuns.length !== 0) failures.push("a malformed cron expression produced a run");
    if (brokenAudit.length !== 1) {
      failures.push(`expected exactly one audit row for the broken routine, got ${brokenAudit.length}`);
    } else {
      findings.push("the malformed cron expression was reported once and never again");
    }

    section("failure isolation: the timer survived both failures");
    const failRuns = daemon.store.listRuns(failId);
    const states = [...new Set(failRuns.map((run) => run.state))].join("/");
    console.log(`  bad-cwd runs recorded: ${failRuns.length}, all ${states}`);
    const pivot = writeRun === undefined ? Date.now() : new Date(writeRun.startedAt).getTime();
    const before = failRuns.filter((run) => new Date(run.startedAt).getTime() < pivot).length;
    const after = failRuns.filter((run) => new Date(run.startedAt).getTime() > pivot).length;
    console.log(`  ${before} came due before the successful run, ${after} after it`);
    if (before === 0) failures.push("no failing run preceded the successful one");
    findings.push(
      `${before} failing run(s) before and ${after} after the successful one; the timer never stopped`,
    );
  } finally {
    section("shutdown and leak census");
    const live = await hostProcesses();
    console.log(`  acp children while the daemon is up: ${live.length}`);
    for (const line of live) console.log(`    ${line}`);

    await daemon.stop();
    log("daemon stopped");
    await reportLeaks(baselineHosts, baselineGates, failures);

    section("run records that outlived the daemon");
    reportStranded(home, [writeId, failId, brokenId], failures);

    cleanUp([home, work], keep, failures);
  }

  return { name: "write", failures, findings };
}

/**
 * Phase `singleton`: a routine whose work outlasts its own interval, so the
 * next fire has something live to skip.
 *
 * The work outlasts the interval because of the approval gate rather than a
 * long prompt: an unanswered `prompt` decision blocks for the supervisor's full
 * approval timeout, which is both deterministic and the thing this phase is
 * really here to measure.
 */
async function phaseSingleton(port: number, keep: boolean): Promise<PhaseResult> {
  section("phase singleton: an overlapping fire is skipped, and the gate is timed");

  const home = mkdtempSync(join(tmpdir(), "ompd-routine-live-home-"));
  const work = mkdtempSync(join(tmpdir(), "ompd-routine-live-work-"));
  const marker = join(work, "bash-marker.txt");

  const baselineHosts = await hostProcesses();
  const baselineGates = gateDirs();
  log(`home ${home}`);
  log(`work ${work}`);

  const daemon = new Ompd({
    home,
    overrides: { port, host: "127.0.0.1" },
    repoRoot: REPO_ROOT,
    onLog: (line) => console.log(`    daemon| ${line}`),
  });

  const bashId = "rt_live_bash";
  daemon.store.upsertRoutine(
    seedRoutine({
      id: bashId,
      name: "live-bash-marker",
      // Every minute, so a run that outlives a minute has a fire to skip.
      trigger: { kind: "cron", expression: "* * * * *" },
      cwd: work,
      timeoutSeconds: 200,
      prompt:
        "Use your bash tool to run exactly this command:\n" +
        `touch ${marker}\n` +
        "That is the entire task. Do not use any other tool.",
    }),
  );

  const findings: string[] = [];
  const failures: string[] = [];

  const info = await daemon.start();
  log(`daemon listening at ${info.url}, policy ${daemon.config.policyMode}`);

  try {
    // A skip alone would not prove the first run was still live, so wait for
    // both: a skipped fire, and the first run reaching a terminal state.
    await watch(
      daemon,
      [bashId],
      420_000,
      (s) => {
        const runs = [...s.latest.values()];
        const skipped = runs.some((run) => run.state === "skipped");
        const settled = runs.some((run) => run.state !== "skipped" && run.finishedAt !== undefined);
        return skipped && settled;
      },
      "one skipped fire and the first run settling",
    );

    section("run history");
    reportRuns(daemon, bashId);

    const runs = daemon.store.listRuns(bashId).toReversed();
    const real = runs.filter((run) => run.state !== "skipped");
    const skipped = runs.filter((run) => run.state === "skipped");
    const first = real[0];

    if (first === undefined) {
      failures.push("the routine never produced a real run");
      return { name: "singleton", failures, findings };
    }

    const startedAt = new Date(first.startedAt).getTime();
    const finishedAt =
      first.finishedAt === undefined ? Date.now() : new Date(first.finishedAt).getTime();
    const held = (finishedAt - startedAt) / 1000;
    findings.push(`the first run held the routine for ${held.toFixed(1)}s, ending ${first.state}`);
    if (held < 60) {
      failures.push(`the first run lasted ${held.toFixed(1)}s, so it never outlasted its own minute`);
    }

    const overlapping = skipped.filter((run) => {
      const at = new Date(run.startedAt).getTime();
      return at > startedAt && at <= finishedAt;
    });
    console.log(`  skipped fires while the first run was live: ${overlapping.length}`);
    for (const skip of overlapping) console.log(`    ${skip.id} at ${stamp(new Date(skip.startedAt))}`);
    if (overlapping.length === 0) {
      failures.push("no fire was skipped while the first run was still going");
    } else {
      findings.push(`${overlapping.length} fire(s) skipped while the first run was still going`);
    }

    section("every tool call the turn made, joined against the approvals");
    const approvals = first.agentId === undefined ? [] : daemon.store.listApprovals(first.agentId);
    const calls = first.agentId === undefined ? [] : toolCalls(daemon, first.agentId);
    const ungated = reportGate(calls, approvals);
    if (ungated.length > 0) {
      failures.push(
        `${ungated.length} mutating tool call(s) ran without reaching the gate: ${ungated.map((c) => `${c.kind}/${c.title}`).join("; ")}`,
      );
    }
    if (approvals.length === 0) {
      findings.push("no approval was requested at all, so the gate was never reached");
    } else {
      const pending = approvals.filter((a) => a.decidedAt === "");
      const denied = approvals.filter((a) => a.decision === "deny" && a.decidedAt !== "");
      const noAnswer = denied.filter((a) => a.actorDeviceId === null);
      findings.push(
        `${approvals.length} approval(s) requested, ${denied.length} decided as deny (${noAnswer.length} of those by the daemon's own timeout), ${pending.length} never decided at all`,
      );
      // An approval that never resolves means the supervisor's fail-closed
      // timeout never ran: the turn died under it, so the gate did not deny the
      // call, the transport did, and the audit trail records no decision.
      if (pending.length > 0) {
        failures.push(
          `${pending.length} approval(s) left permanently pending: the ACP request timeout and the supervisor's approval timeout are both 120000ms, so session/prompt gives up at the same instant the approval would have failed closed, and no decision is ever recorded`,
        );
      }
    }

    section("the side effect the bash route was asked for");
    if (existsSync(marker)) {
      console.log(`  ${marker} exists`);
      findings.push(`${marker} exists, so the bash route completed unattended`);
    } else {
      console.log(`  ${marker} does not exist`);
      findings.push(`${marker} was never created: the bash route cannot complete unattended`);
    }

    section("teardown");
    const agent = first.agentId === undefined ? null : daemon.store.getAgent(first.agentId);
    if (agent === null) {
      failures.push("the run recorded no agent");
    } else {
      console.log(`  ${agent.id}  state=${agent.state}`);
      if (agent.state !== "stopped") failures.push(`the run's agent is ${agent.state}, not stopped`);
    }
  } finally {
    section("shutdown and leak census");
    await daemon.stop();
    log("daemon stopped");
    await reportLeaks(baselineHosts, baselineGates, failures);

    section("run records that outlived the daemon");
    reportStranded(home, [bashId], failures);

    cleanUp([home, work], keep, failures);
  }

  return { name: "singleton", failures, findings };
}

const opts = parseArgs(process.argv.slice(2));
// Both phases bind the same port, so they run one after the other by design.
const results: PhaseResult[] = [];
if (opts.phase === "write" || opts.phase === "all") results.push(await phaseWrite(opts.port, opts.keep));
if (opts.phase === "singleton" || opts.phase === "all") {
  results.push(await phaseSingleton(opts.port, opts.keep));
}

section("findings");
for (const result of results) {
  for (const finding of result.findings) console.log(`  [${result.name}] ${finding}`);
}

const failures = results.flatMap((r) => r.failures.map((f) => `[${r.name}] ${f}`));
console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log("");
  console.log(`VERDICT fail: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("VERDICT ok: routines fire on the real clock, complete real turns, and clean up");
