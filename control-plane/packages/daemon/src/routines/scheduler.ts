/**
 * Scheduled and triggered agent runs.
 *
 * A routine is a prompt plus a trigger. Firing one means standing up a fresh
 * agent, prompting it, and tearing it down again, recording the whole thing as
 * `Run`. Four properties are load bearing:
 *
 * - **A run never leaks an agent.** Teardown is in a `finally`, and if the
 *   supervisor cannot stop the agent the record is forced terminal anyway.
 *   Otherwise a routine that fails nightly quietly accumulates live hosts.
 * - **A run never leaks a record.** `drain` settles whatever is still in flight
 *   on the way out, because a row left at `running` outlives the process and
 *   keeps `hasActiveRun` true, which silences a singleton routine for good.
 * - **One bad routine is one bad routine.** A malformed trigger or a failing
 *   run must not stop the timer or the other routines due on the same tick.
 * - **Time is injected.** Scheduling decisions read `now()`, so the logic is
 *   testable without waiting on a clock.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  TERMINAL_AGENT_STATES,
  type Actor,
  type AgentId,
  type Routine,
  type Run,
  type Store,
} from "@ompd/core";
import { joinAssistantText, type PromptResult } from "@ompd/acp";
import { UnauthorizedError, type Supervisor } from "../supervisor.ts";
import { nextFireTime } from "./cron.ts";

const DEFAULT_TICK_MS = 15_000;
const SUMMARY_MAX_CHARS = 2_000;
/** Longest teardown will wait for an abandoned turn to finish unwinding. */
const SETTLE_GRACE_MS = 500;
/**
 * Longest `drain` waits for the runs it cancelled before settling them itself.
 *
 * A bound rather than an open wait: a turn that ignores cancellation would
 * otherwise turn "one routine is wedged" into "the daemon will not exit".
 */
const DRAIN_TIMEOUT_MS = 5_000;
/** Recorded on a run the drain cut short, so the row says why it never finished. */
const INTERRUPTED = "cancelled: the daemon shut down while this run was in flight";

/** Creating an agent needs manage; prompting and cancelling need prompt. */
const REQUIRED_SCOPES: readonly string[] = [SCOPE_MANAGE, SCOPE_PROMPT];

export interface SchedulerOptions {
  store: Store;
  supervisor: Supervisor;
  /** Actor for timer-driven runs. Needs manage and prompt scope. */
  actor: Actor;
  tickMs?: number;
  now?: () => Date;
}

/** Everything a `routine.run` audit row needs, including who caused it. */
interface RunAuditInput {
  actor: Actor;
  routineId: string;
  runId?: string;
  agentId?: AgentId;
  outcome: "ok" | "denied" | "error";
  detail: Record<string, unknown>;
}

interface TurnOutcome {
  result: PromptResult | "timed_out";
  /**
   * Set only when the turn was abandoned at its deadline, and resolves once it
   * has finished unwinding.
   *
   * This exists because `Supervisor.prompt` writes `idle` from a `finally` as
   * it unwinds, which for an abandoned turn lands *after* teardown has already
   * marked the agent stopped, leaving a dead agent looking live. An async
   * `finally` runs before its own promise settles, so waiting on the turn is a
   * guaranteed ordering rather than a hopeful one.
   */
  settling?: Promise<void>;
}

interface Inflight {
  /** The live record. `drain` mutates and persists this when it has to. */
  run: Run;
  /** Settles once the run's own teardown has written its terminal record. */
  finished: Promise<Run>;
  /**
   * Set by `drain`. Past this the turn's outcome is not the routine's: it was
   * cancelled to get the daemon down, and a turn that acknowledges a
   * cancellation politely is still a run that did not do its job.
   */
  interrupted: boolean;
  /**
   * Set when `drain` gave up waiting and wrote the terminal record itself. That
   * record is final: a run resuming afterwards must not write over it, least of
   * all with the `running` it writes on the way to a state that may never come.
   */
  settled: boolean;
}

/**
 * `not_found` intentionally covers absent, disabled, and non-webhook routines
 * so a bearer of an unrelated secret cannot use this endpoint as a routine
 * catalogue. The comparison still happens in all cases below.
 */
export type WebhookFireResult =
  | { accepted: true; run: Run }
  | { accepted: false; reason: "not_found" | "forbidden" };

const WEBHOOK_DUMMY_HASH = createHash("sha256").update("ompd webhook dummy").digest("hex");

/** Hash the one-time plaintext produced by the operator-facing mint route. */
export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
const WEBHOOK_DUMMY_SECRET_REF = "__webhook_absent__";

function webhookSecretMatches(presented: string, expectedHash: string | null): boolean {
  const actual = Buffer.from(hashWebhookSecret(presented), "hex");
  const expected = Buffer.from(expectedHash ?? WEBHOOK_DUMMY_HASH, "hex");
  return timingSafeEqual(actual, expected);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class Scheduler {
  #store: Store;
  #supervisor: Supervisor;
  #actor: Actor;
  #tickMs: number;
  #now: () => Date;
  #timer: Timer | null = null;

  /** routineId -> epoch ms at which it next comes due. */
  #dueAt = new Map<string, number>();
  /**
   * routineId -> the trigger that failed to parse. Keeps a broken expression
   * from writing an audit row on every tick, while still re-reporting once the
   * operator edits it.
   */
  #broken = new Map<string, string>();
  /**
   * runId -> the record and the promise that settles it, for every run still in
   * flight. `drain` needs the record itself and not just the promise: a run
   * whose turn never answers has to be settled from outside.
   */
  #inflight = new Map<string, Inflight>();
  /**
   * Set by `drain`, cleared by `start`. Past the drain a run has nowhere to
   * record itself: the store is closing behind it. Refusing is the only answer
   * that cannot leave a row claiming a routine is still going.
   */
  #draining = false;

  constructor(opts: SchedulerOptions) {
    this.#store = opts.store;
    this.#supervisor = opts.supervisor;
    this.#actor = opts.actor;
    this.#tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.#now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.#draining = false;
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    // Arm everything now rather than a full interval from now, so a routine
    // due inside the first window is not missed.
    void this.tick();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Settle every in-flight run, and return with none left mid-flight.
   *
   * Belongs between "stop scheduling" and "kill the hosts": cancelling a turn
   * needs the host that is serving it. Cancelling rather than only waiting is
   * what makes this converge, because a turn blocked on an unanswered approval
   * settles on its own only when that approval times out, which is far longer
   * than a shutdown should take.
   *
   * Whatever the bound catches is forced terminal here, while the store is
   * still open. The invariant is that no run is left at `running` on the way
   * out, by any path, not that the wait usually finishes.
   */
  async drain(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
    this.#draining = true;

    // Cancelled together rather than one at a time: `session/cancel` is a
    // notification, so this waits only on the writes, and one host refusing its
    // write must not delay the next run's cancellation.
    await Promise.allSettled(
      [...this.#inflight.values()].map((entry) => {
        entry.interrupted = true;
        if (entry.run.agentId === undefined) return Promise.resolve();
        return this.#supervisor.cancel(entry.run.agentId, this.#actor);
      }),
    );

    if (this.#inflight.size > 0) {
      const expiry = Promise.withResolvers<void>();
      const timer = setTimeout(() => expiry.resolve(), timeoutMs);
      try {
        const settling = Promise.allSettled(
          [...this.#inflight.values()].map((entry) => entry.finished),
        );
        await Promise.race([settling, expiry.promise]);
      } finally {
        clearTimeout(timer);
      }
    }

    const at = this.#now().toISOString();
    for (const entry of this.#inflight.values()) {
      const { run } = entry;
      if (run.state === "queued" || run.state === "running") {
        // A mid-flight run carries no error of its own yet: every path that
        // sets one has already reached a terminal state.
        run.state = "failed";
        run.error = INTERRUPTED;
      }
      // Anything else here decided its outcome and then hung on the way to
      // recording it, so the row still says `running` while the record in hand
      // says otherwise. Persist what the run actually decided rather than
      // overwriting a real outcome with this one.
      run.finishedAt ??= at;
      entry.settled = true;
      this.#store.upsertRun(run);
    }
  }

  /**
   * One scheduling pass: fire every enabled routine whose next fire time has
   * passed, then re-arm it.
   *
   * Public because it is the deterministic seam. With an injected clock a
   * caller drives scheduling exactly, without sleeping.
   */
  async tick(): Promise<void> {
    const at = this.#now().getTime();
    const routines = this.#store.listRoutines();
    const live = new Set<string>();
    const due: Routine[] = [];

    for (const routine of routines) {
      if (!routine.enabled) {
        // Disarm, so re-enabling re-arms from that moment instead of firing
        // for every occurrence missed while it was off.
        this.#dueAt.delete(routine.id);
        continue;
      }
      live.add(routine.id);

      try {
        const scheduled = this.#dueAt.get(routine.id);
        if (scheduled === undefined) {
          // First sight. Arm for the next occurrence rather than firing now,
          // so adding a routine never triggers an immediate run.
          const first = this.#nextDue(routine, at);
          if (first !== null) this.#dueAt.set(routine.id, first);
          this.#broken.delete(routine.id);
          continue;
        }
        if (scheduled > at) continue;

        const following = this.#nextDue(routine, at);
        if (following === null) this.#dueAt.delete(routine.id);
        else this.#dueAt.set(routine.id, following);
        due.push(routine);
      } catch (err) {
        const fingerprint = JSON.stringify(routine.trigger);
        if (this.#broken.get(routine.id) !== fingerprint) {
          this.#broken.set(routine.id, fingerprint);
          this.#audit({
            actor: this.#actor,
            routineId: routine.id,
            outcome: "error",
            detail: { error: errorText(err), phase: "schedule" },
          });
        }
      }
    }

    for (const id of [...this.#dueAt.keys()]) {
      if (!live.has(id)) this.#dueAt.delete(id);
    }

    // Each run is isolated: one throwing must not cancel its siblings, which
    // `Promise.all` would do on the first rejection.
    await Promise.all(
      due.map(async (routine) => {
        try {
          await this.#execute(routine, this.#actor);
        } catch (err) {
          this.#audit({
            actor: this.#actor,
            routineId: routine.id,
            outcome: "error",
            detail: { error: errorText(err), phase: "execute" },
          });
        }
      }),
    );
  }

  /** Run a routine immediately, outside its schedule. */
  async runNow(routineId: string, actor: Actor): Promise<Run> {
    // Checked before the lookup so an unauthorized caller cannot probe which
    // routine ids exist. The supervisor authorizes again from the device row;
    // this is the cheap first gate, not the authority.
    for (const scope of REQUIRED_SCOPES) {
      if (!actor.scopes.includes(scope)) {
        throw new UnauthorizedError(`routine.run: missing ${scope} scope`);
      }
    }

    const routine = this.#store.listRoutines().find((r) => r.id === routineId);
    if (!routine) throw new Error(`unknown routine ${routineId}`);
    if (!routine.enabled) throw new Error(`routine ${routineId} is disabled`);
    return await this.#execute(routine, actor);
  }


  /**
   * Fire one webhook routine without introducing a device identity for an
   * external service. The per-routine secret is its complete authority.
   */
  async fireWebhook(routineId: string, presentedSecret: string): Promise<WebhookFireResult> {
    const routine = this.#store.listRoutines().find((candidate) => candidate.id === routineId);
    const secretRef =
      routine?.trigger.kind === "webhook" ? routine.trigger.secretRef : WEBHOOK_DUMMY_SECRET_REF;
    const secret = this.#store.getWebhookSecret(secretRef);
    const matched = webhookSecretMatches(presentedSecret, secret?.secretHash ?? null);

    if (routine === undefined || !routine.enabled || routine.trigger.kind !== "webhook") {
      this.#audit({
        actor: this.#actor,
        routineId,
        outcome: "denied",
        detail: { trigger: "webhook", reason: "not_found" },
      });
      return { accepted: false, reason: "not_found" };
    }
    if (!matched) {
      this.#audit({
        actor: this.#actor,
        routineId,
        outcome: "denied",
        detail: { trigger: "webhook", reason: "forbidden" },
      });
      return { accepted: false, reason: "forbidden" };
    }
    return { accepted: true, run: await this.#execute(routine, this.#actor) };
  }


  /** Epoch ms of the next fire, or null for triggers the clock does not drive. */
  #nextDue(routine: Routine, fromMs: number): number | null {
    const trigger = routine.trigger;
    if (trigger.kind === "cron") {
      return nextFireTime(trigger.expression, new Date(fromMs), trigger.timezone).getTime();
    }
    if (trigger.kind === "interval") {
      if (!Number.isFinite(trigger.seconds) || trigger.seconds <= 0) {
        throw new Error(`interval trigger needs positive seconds, got ${trigger.seconds}`);
      }
      return fromMs + trigger.seconds * 1000;
    }
    // manual and webhook are driven from outside the clock.
    return null;
  }

  /**
   * Run a routine once, tracked so shutdown can settle it.
   *
   * The record is created here rather than inside the run itself so `drain`
   * holds the same `Run` object the run will settle, and can force it terminal
   * when the run cannot.
   */
  async #execute(routine: Routine, actor: Actor): Promise<Run> {
    // A fire that arrives after the drain, from a request the gateway was still
    // serving as it closed, would write a row nothing is left to settle.
    if (this.#draining) throw new Error("the scheduler is shutting down");

    const run: Run = {
      id: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      routineId: routine.id,
      state: "queued",
      startedAt: this.#now().toISOString(),
    };

    const finished = this.#executeRun(run, routine, actor);
    this.#inflight.set(run.id, { run, finished, interrupted: false, settled: false });
    try {
      return await finished;
    } finally {
      this.#inflight.delete(run.id);
    }
  }

  async #executeRun(run: Run, routine: Routine, actor: Actor): Promise<Run> {
    if (routine.singleton && this.#store.hasActiveRun(routine.id)) {
      run.state = "skipped";
      run.finishedAt = run.startedAt;
      this.#recordRun(run);
      this.#audit({
        actor,
        routineId: routine.id,
        runId: run.id,
        outcome: "ok",
        detail: { state: "skipped", reason: "previous run still active" },
      });
      return run;
    }

    // Written before the agent exists so a concurrent tick sees an active run
    // and skips, rather than racing a second agent into the same workspace.
    this.#recordRun(run);

    let agentId: AgentId | undefined;
    let settling: Promise<void> | undefined;
    try {
      const agent = await this.#supervisor.createAgent(
        {
          name: routine.name,
          cwd: routine.cwd,
          host: routine.host,
          routineId: routine.id,
          labels: routine.labels,
        },
        actor,
      );
      agentId = agent.id;
      run.agentId = agent.id;
      run.state = "running";
      this.#recordRun(run);

      // The drain can finish while `createAgent` is still in flight: a run with
      // no agent yet has nothing to cancel, so it is marked interrupted and
      // settled without waiting. Prompting now would start a turn after the
      // daemon decided it was drained, against a supervisor and store that are
      // being torn down. Returning here leaves the `finally` to retire the agent
      // that was created, which is the only cleanup it needs.
      if (this.#draining || this.#inflight.get(run.id)?.interrupted === true) {
        run.state = "failed";
        run.error = INTERRUPTED;
        return run;
      }

      const turn = await this.#promptWithDeadline(agent.id, routine, actor);
      settling = turn.settling;
      if (turn.result === "timed_out") {
        run.state = "timed_out";
        run.error = `exceeded timeout of ${routine.timeoutSeconds}s`;
      } else if (this.#inflight.get(run.id)?.interrupted === true) {
        // The turn ended because the drain cancelled it, so its stop reason
        // describes the shutdown rather than the work the routine asked for.
        run.state = "failed";
        run.error = INTERRUPTED;
      } else {
        run.state = "succeeded";
        run.summary = this.#summarize(agent.id, turn.result.stopReason);
      }
    } catch (err) {
      run.state = "failed";
      run.error = errorText(err);
    } finally {
      if (agentId) {
        try {
          await this.#retireAgent(agentId, actor, settling);
        } catch (err) {
          // Teardown is allowed to fail; losing the run record is not. The
          // record is the only durable evidence the run happened, and a run
          // stranded in `running` would keep `hasActiveRun` true and wedge a
          // singleton routine permanently.
          if (!run.error) run.error = errorText(err);
        }
      }
      run.finishedAt = this.#now().toISOString();
      this.#recordRun(run);
      this.#audit({
        actor,
        routineId: routine.id,
        runId: run.id,
        agentId,
        outcome: run.state === "succeeded" ? "ok" : "error",
        detail: { state: run.state, error: run.error },
      });
    }

    return run;
  }

  /**
   * Persist a run record, unless `drain` already settled this run.
   *
   * A drained record is final. Without this, a run that resumes after the drain
   * gave up on it writes `running` again and then waits for a terminal state
   * that may never arrive, which is the row that outlives the process.
   */
  #recordRun(run: Run): void {
    if (this.#inflight.get(run.id)?.settled === true) return;
    this.#store.upsertRun(run);
  }

  async #promptWithDeadline(
    agentId: AgentId,
    routine: Routine,
    actor: Actor,
  ): Promise<TurnOutcome> {
    const turn = this.#supervisor.prompt(agentId, routine.prompt, actor);
    const seconds = routine.timeoutSeconds;
    if (seconds === undefined || !(seconds > 0)) return { result: await turn };

    const deadline = Promise.withResolvers<"timed_out">();
    const timer = setTimeout(() => deadline.resolve("timed_out"), seconds * 1000);
    try {
      const outcome = await Promise.race([turn, deadline.promise]);
      if (outcome !== "timed_out") return { result: outcome };
    } finally {
      clearTimeout(timer);
    }

    // The turn is still in flight and will reject once teardown closes the
    // transport under it. Swallow that so it lands handled, and keep the handle
    // so teardown can wait for the unwind instead of racing it.
    const settling = turn.then(
      () => undefined,
      () => undefined,
    );
    try {
      await this.#supervisor.cancel(agentId, actor);
    } catch {
      // Best effort. The agent is being stopped either way.
    }
    return { result: "timed_out", settling };
  }

  /** Final assistant text for the run listing, falling back to the stop reason. */
  #summarize(agentId: AgentId, stopReason: string): string {
    const joined = joinAssistantText(
      this.#store.updatesSince(agentId, 0).map((record) => record.payload),
    );
    if (joined.length === 0) return stopReason;
    if (joined.length <= SUMMARY_MAX_CHARS) return joined;
    return `${joined.slice(0, SUMMARY_MAX_CHARS)}...`;
  }

  async #retireAgent(agentId: AgentId, actor: Actor, settling?: Promise<void>): Promise<void> {
    let stopped = false;
    try {
      await this.#supervisor.stopAgent(agentId, actor);
      stopped = true;
    } catch {
      // The host may already be gone, which is exactly when a leak would go
      // unnoticed. Fall through and settle the record ourselves.
    }

    // Let an abandoned turn finish unwinding, so its trailing `idle` write
    // cannot land after the check below. Bounded, because a peer that never
    // answers must not hold teardown open for good.
    if (settling) {
      const grace = Promise.withResolvers<void>();
      const timer = setTimeout(() => grace.resolve(), SETTLE_GRACE_MS);
      try {
        await Promise.race([settling, grace.promise]);
      } finally {
        clearTimeout(timer);
      }
    }

    const agent = this.#store.getAgent(agentId);
    if (agent && !TERMINAL_AGENT_STATES.includes(agent.state)) {
      this.#store.setAgentState(agentId, stopped ? "stopped" : "failed");
    }
  }

  #audit(input: RunAuditInput): void {
    try {
      this.#store.audit({
        action: "routine.run",
        agentId: input.agentId,
        // The caller's device, not the scheduler's. An operator-triggered run
        // attributed to the daemon would make the audit trail useless for the
        // one question it exists to answer.
        actorDeviceId: input.actor.deviceId,
        outcome: input.outcome,
        detail: { routineId: input.routineId, runId: input.runId, ...input.detail },
      });
    } catch {
      // Auditing must never be the reason a tick dies.
    }
  }
}
