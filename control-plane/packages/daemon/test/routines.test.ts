/**
 * Routines: cron evaluation and the run lifecycle.
 *
 * The cron half is where subtle wrongness hides, so it is tested against fixed
 * calendar facts rather than against itself: weekend skips, a period that does
 * not divide its range, month rollover, a leap day four years out, the
 * day-of-month/day-of-week union, and both DST transitions in a real zone.
 *
 * The scheduler half is tested against a scripted ACP peer with an injected
 * clock, so no model is called and no test waits on a wall clock to reach a
 * scheduled time. The properties that matter are the ones that cost money when
 * they break: a run never leaks an agent, one bad routine stays one bad
 * routine, and no run survives the daemon still claiming to be running, which
 * is what keeps a singleton routine firing at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  Store,
  TERMINAL_AGENT_STATES,
  type Actor,
  type AgentId,
  type Routine,
  type Run,
} from "@ompd/core";
import { AcpClient, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";
import { Supervisor } from "../src/supervisor.ts";
import { CronError, Scheduler, hashWebhookSecret, nextFireTime } from "../src/routines/index.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const DENVER = "America/Denver";

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

describe("nextFireTime", () => {
  test("a weekday morning schedule steps over the weekend", () => {
    // 2026-08-07 is a Friday, 2026-08-10 the following Monday.
    const next = nextFireTime("0 9 * * 1-5", new Date("2026-08-07T09:00:00Z"), "UTC");
    expect(next.toISOString()).toBe("2026-08-10T09:00:00.000Z");
  });

  test("a weekday morning schedule fires later the same day when it can", () => {
    const next = nextFireTime("0 9 * * 1-5", new Date("2026-08-06T08:00:00Z"), "UTC");
    expect(next.toISOString()).toBe("2026-08-06T09:00:00.000Z");
  });

  test("a quarter-hour step lands on the quarters", () => {
    expect(nextFireTime("*/15 * * * *", new Date("2026-01-01T00:00:00Z"), "UTC").toISOString()).toBe(
      "2026-01-01T00:15:00.000Z",
    );
    expect(nextFireTime("*/15 * * * *", new Date("2026-01-01T00:46:00Z"), "UTC").toISOString()).toBe(
      "2026-01-01T01:00:00.000Z",
    );
  });

  test("a step that does not divide its range stops at the top instead of wrapping", () => {
    // */7 over 0-59 gives 0,7,...,56. The bug this guards is 56+7=63 wrapping
    // to minute 3 of the same hour.
    expect(nextFireTime("*/7 * * * *", new Date("2026-01-01T00:50:00Z"), "UTC").toISOString()).toBe(
      "2026-01-01T00:56:00.000Z",
    );
    expect(nextFireTime("*/7 * * * *", new Date("2026-01-01T00:56:00Z"), "UTC").toISOString()).toBe(
      "2026-01-01T01:00:00.000Z",
    );
  });

  test("a leap day schedule skips common years entirely", () => {
    expect(nextFireTime("0 0 29 2 *", new Date("2026-01-01T00:00:00Z"), "UTC").toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(nextFireTime("0 0 29 2 *", new Date("2028-03-01T00:00:00Z"), "UTC").toISOString()).toBe(
      "2032-02-29T00:00:00.000Z",
    );
  });

  test("a day-of-month step rolls into the next month rather than past its end", () => {
    // */7 over 1-31 gives 1,8,15,22,29. January has 30 and 31 spare, so the
    // next fire is the 1st of February.
    expect(nextFireTime("0 0 */7 * *", new Date("2026-01-29T00:00:00Z"), "UTC").toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  test("day-of-month and day-of-week together are a union, not an intersection", () => {
    // April 2026: the 13th is a Monday, Fridays fall on the 3rd, 10th, 17th.
    const from = new Date("2026-04-11T00:00:00Z");

    // Both fields restricted: the 13th wins even though it is not a Friday.
    expect(nextFireTime("0 0 13 * 5", from, "UTC").toISOString()).toBe("2026-04-13T00:00:00.000Z");

    // Only day-of-week restricted: the 13th is ignored.
    expect(nextFireTime("0 0 * * 5", from, "UTC").toISOString()).toBe("2026-04-17T00:00:00.000Z");

    // Only day-of-month restricted: the Friday is ignored.
    expect(nextFireTime("0 0 13 * *", from, "UTC").toISOString()).toBe("2026-04-13T00:00:00.000Z");
  });

  test("the union also fires on the weekday leg when it comes first", () => {
    // February 2026: the 6th is a Friday, ahead of the 13th.
    const from = new Date("2026-02-01T00:00:00Z");
    expect(nextFireTime("0 0 13 * 5", from, "UTC").toISOString()).toBe("2026-02-06T00:00:00.000Z");
    expect(nextFireTime("0 0 13 * *", from, "UTC").toISOString()).toBe("2026-02-13T00:00:00.000Z");
  });

  test("a daily schedule across a spring-forward is 23 hours, not 24", () => {
    // Denver moves MST to MDT at 02:00 on 2026-03-08.
    const previous = new Date("2026-03-07T16:00:00Z"); // 09:00 MST
    const next = nextFireTime("0 9 * * *", previous, DENVER);

    expect(next.toISOString()).toBe("2026-03-08T15:00:00.000Z"); // 09:00 MDT
    expect(next.getTime() - previous.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  test("a schedule inside the skipped hour fires when the clock jumps", () => {
    // 02:30 never happens on 2026-03-08 in Denver. Firing at the jump keeps a
    // nightly job from silently losing a day.
    const next = nextFireTime("30 2 * * *", new Date("2026-03-07T12:00:00Z"), DENVER);
    expect(next.toISOString()).toBe("2026-03-08T09:00:00.000Z"); // 03:00 MDT
  });

  test("a schedule inside a repeated hour fires once, on the first occurrence", () => {
    // Denver moves MDT to MST at 02:00 on 2026-11-01, so 01:30 happens twice:
    // 07:30Z and 08:30Z. Firing on both would double-run a nightly job.
    const next = nextFireTime("30 1 * * *", new Date("2026-10-31T20:00:00Z"), DENVER);
    expect(next.toISOString()).toBe("2026-11-01T07:30:00.000Z");

    // And the following fire is the next day, not the repeat.
    expect(nextFireTime("30 1 * * *", next, DENVER).toISOString()).toBe(
      "2026-11-02T08:30:00.000Z",
    );
  });

  test("a fire time inside a repeated hour is never behind the instant asked about", () => {
    // Regression: resolving a wall clock reading to its earliest instant
    // unconditionally returns a past time when `after` is already inside the
    // second pass through the hour, which makes a scheduler re-fire forever.
    const after = new Date("2026-11-01T08:45:00Z"); // 01:45 MST, the second 01:45
    const next = nextFireTime("*/5 * * * *", after, DENVER);

    expect(next.getTime()).toBeGreaterThan(after.getTime());
    expect(next.toISOString()).toBe("2026-11-01T08:50:00.000Z");
  });

  test("results are strictly later than the instant asked about, on the minute", () => {
    const exact = new Date("2026-05-04T10:00:00Z");
    const next = nextFireTime("* * * * *", exact, "UTC");
    expect(next.getTime()).toBeGreaterThan(exact.getTime());
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMilliseconds()).toBe(0);

    // Mid-minute input still advances to the next whole minute.
    const midway = new Date("2026-05-04T10:00:30.500Z");
    expect(nextFireTime("* * * * *", midway, "UTC").toISOString()).toBe("2026-05-04T10:01:00.000Z");
  });

  test("named month and weekday sets are honoured together", () => {
    // Quarterly Monday check: 09:00 on Mondays in January and July only.
    const next = nextFireTime("0 9 * 1,7 1", new Date("2026-02-01T00:00:00Z"), "UTC");
    expect(next.toISOString()).toBe("2026-07-06T09:00:00.000Z");
    expect(next.getUTCDay()).toBe(1);
  });

  test("malformed expressions are rejected rather than silently misread", () => {
    expect(() => nextFireTime("* * * *", new Date(), "UTC")).toThrow(CronError);
    expect(() => nextFireTime("* * * * * *", new Date(), "UTC")).toThrow(/5 fields/);
    expect(() => nextFireTime("60 * * * *", new Date(), "UTC")).toThrow(/outside 0-59/);
    expect(() => nextFireTime("0 24 * * *", new Date(), "UTC")).toThrow(/outside 0-23/);
    expect(() => nextFireTime("0 0 0 * *", new Date(), "UTC")).toThrow(/outside 1-31/);
    expect(() => nextFireTime("30-10 * * * *", new Date(), "UTC")).toThrow(/backwards/);
    expect(() => nextFireTime("*/0 * * * *", new Date(), "UTC")).toThrow(/step/);
    expect(() => nextFireTime("* * * * x", new Date(), "UTC")).toThrow(/not an integer/);
    expect(() => nextFireTime("* * * * *", new Date(), "Mars/Olympus")).toThrow(/unknown timezone/);
  });

  test("Sunday is accepted as both 0 and 7", () => {
    const from = new Date("2026-02-02T00:00:00Z"); // a Monday
    const asZero = nextFireTime("0 0 * * 0", from, "UTC");
    const asSeven = nextFireTime("0 0 * * 7", from, "UTC");
    expect(asSeven.toISOString()).toBe(asZero.toISOString());
    expect(asZero.getUTCDay()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (paths.length) {
    const p = paths.pop() ?? "";
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${p}${suffix}`, { force: true });
  }
});

interface Harness {
  store: Store;
  /** The db file, so a test can reopen it the way the next daemon would. */
  path: string;
  sup: Supervisor;
  fake: FakeHostController;
  scheduler: Scheduler;
  actor: Actor;
  /** Every host the supervisor spawned, so a test can kill one mid-turn. */
  hosts: LocalHost[];
  /** Move the injected clock forward. */
  advance: (ms: number) => void;
}

interface HarnessOptions {
  /**
   * Shortens the ACP transport deadlines so a stalled turn fails fast.
   *
   * Both of them. `session/prompt` has its own deadline in production, far
   * longer than a control-plane request, because a turn contains every
   * approval it raises. A test that wants a hung turn abandoned has to say so
   * for the turn as well, or it waits out the production number.
   */
  transportTimeoutMs?: number;
  tickMs?: number;
  /** Use the real clock instead of the injected one. */
  realClock?: boolean;
  /**
   * Replaces the scripted peer with one that answers nothing at all, so a run
   * hangs where no cancellation can reach it: inside `initialize`, before it
   * has an agent to cancel.
   */
  silentHost?: boolean;
}

function harness(opts: HarnessOptions = {}): Harness {
  const path = `/tmp/ompd-routines-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);

  const fake = createFakeHost();
  const hosts: LocalHost[] = [];
  const spawnHost = (o: SpawnLocalHostOptions): LocalHost => {
    if (opts.silentHost === true) {
      // The supervisor's own options, so only the transport differs: writes go
      // nowhere, so no reply ever arrives and nothing rejects either.
      const host: LocalHost = {
        client: new AcpClient(() => undefined, o),
        pid: 1,
        kill: () => undefined,
        exited: new Promise<number>(() => {}),
      };
      hosts.push(host);
      return host;
    }
    const bound = opts.transportTimeoutMs;
    const host = fake.factory(
      bound === undefined ? o : { ...o, requestTimeoutMs: bound, promptTimeoutMs: bound },
    );
    hosts.push(host);
    return host;
  };

  const sup = new Supervisor({ store, spawnHost });
  sups.push(sup);

  let clock = Date.parse("2026-01-01T00:00:00Z");
  const actor: Actor = { deviceId: "daemon", scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE] };
  const scheduler = new Scheduler({
    store,
    supervisor: sup,
    actor,
    tickMs: opts.tickMs,
    now: opts.realClock ? undefined : () => new Date(clock),
  });

  return {
    store,
    path,
    sup,
    fake,
    scheduler,
    actor,
    hosts,
    advance: (ms) => {
      clock += ms;
    },
  };
}

function defineRoutine(store: Store, over: Partial<Routine> = {}): Routine {
  const routine: Routine = {
    id: `rtn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    name: "nightly",
    enabled: true,
    trigger: { kind: "interval", seconds: 60 },
    prompt: "summarise yesterday",
    cwd: "/work",
    host: { kind: "local" },
    singleton: true,
    labels: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  store.upsertRoutine(routine);
  return routine;
}

async function sleep(ms: number): Promise<void> {
  const done = Promise.withResolvers<void>();
  setTimeout(() => done.resolve(), ms);
  await done.promise;
}

/**
 * Turns the test can hold open and release together, plus a signal for "the
 * Nth turn has arrived". Waiting on arrival rather than polling the store
 * keeps these tests free of tuned delays.
 */
interface HeldTurns {
  /** Resolves once at least `count` turns have reached the agent. */
  reached: (count: number) => Promise<void>;
  release: (stopReason?: string) => void;
}

function holdTurns(fake: FakeHostController): HeldTurns {
  const gate = Promise.withResolvers<{ stopReason: string }>();
  const waiting = new Map<number, PromiseWithResolvers<void>>();
  let seen = 0;

  fake.onPrompt(() => {
    seen++;
    for (const [count, waiter] of waiting) {
      if (seen >= count) waiter.resolve();
    }
    return gate.promise;
  });

  return {
    reached: (count) => {
      if (seen >= count) return Promise.resolve();
      let waiter = waiting.get(count);
      if (!waiter) {
        waiter = Promise.withResolvers<void>();
        waiting.set(count, waiter);
      }
      return waiter.promise;
    },
    release: (stopReason = "end_turn") => gate.resolve({ stopReason }),
  };
}

describe("Scheduler execution", () => {
  test("a successful run records the assistant's own words as its summary", async () => {
    const h = harness();
    h.fake.onPrompt((sessionId) => {
      h.fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "nothing broke overnight" },
      });
      return { stopReason: "end_turn" };
    });
    const routine = defineRoutine(h.store);

    const run = await h.scheduler.runNow(routine.id, h.actor);

    expect(run.state).toBe("succeeded");
    expect(run.summary).toBe("nothing broke overnight");
    expect(run.finishedAt).toBeDefined();
    expect(h.fake.prompts[0]?.text).toBe("summarise yesterday");

    // The agent was created for the routine and then retired.
    const agent = h.store.getAgent(run.agentId ?? "");
    expect(agent?.routineId).toBe(routine.id);
    expect(agent?.state).toBe("stopped");
  });

  test("a valid webhook secret runs through the same lifecycle as a cron fire", async () => {
    const h = harness();
    h.fake.onPrompt(() => ({ stopReason: "end_turn" }));
    const cron = defineRoutine(h.store, { trigger: { kind: "cron", expression: "* * * * *", timezone: "UTC" } });
    const webhook = defineRoutine(h.store, {
      trigger: { kind: "webhook", secretRef: "whsec_nightly" },
      singleton: false,
    });
    h.store.upsertWebhookSecret("whsec_nightly", hashWebhookSecret("correct-secret"));

    await h.scheduler.tick();
    h.advance(60_000);
    await h.scheduler.tick();
    const cronRun = h.store.listRuns(cron.id)[0];

    const result = await h.scheduler.fireWebhook(webhook.id, "correct-secret");

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("correct secret was refused");
    expect(result.run.state).toBe("succeeded");
    expect(result.run.finishedAt).toBeDefined();
    for (const field of ["id", "routineId", "agentId", "state", "startedAt", "finishedAt"]) {
      expect(field in result.run).toBe(field in (cronRun ?? {}));
    }
    expect(h.store.getAgent(result.run.agentId ?? "")?.state).toBe("stopped");
  });

  test("a wrong webhook secret produces no run", async () => {
    const h = harness();
    const routine = defineRoutine(h.store, { trigger: { kind: "webhook", secretRef: "whsec_wrong" } });
    h.store.upsertWebhookSecret("whsec_wrong", hashWebhookSecret("correct-secret"));

    expect(await h.scheduler.fireWebhook(routine.id, "wrong-secret")).toEqual({
      accepted: false,
      reason: "forbidden",
    });
    expect(h.store.listRuns(routine.id)).toHaveLength(0);
  });

  test("two valid webhook deliveries create independent runs", async () => {
    const h = harness();
    h.fake.onPrompt(() => ({ stopReason: "end_turn" }));
    const routine = defineRoutine(h.store, {
      trigger: { kind: "webhook", secretRef: "whsec_repeat" },
      singleton: false,
    });
    h.store.upsertWebhookSecret("whsec_repeat", hashWebhookSecret("repeat-secret"));

    const first = await h.scheduler.fireWebhook(routine.id, "repeat-secret");
    const second = await h.scheduler.fireWebhook(routine.id, "repeat-secret");

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) throw new Error("valid secret was refused");
    expect(first.run.id).not.toBe(second.run.id);
    expect(h.store.listRuns(routine.id)).toHaveLength(2);
  });

  test("a non-webhook routine refuses webhook delivery without a run", async () => {
    const h = harness();
    const routine = defineRoutine(h.store, { trigger: { kind: "cron", expression: "* * * * *", timezone: "UTC" } });

    expect(await h.scheduler.fireWebhook(routine.id, "any-secret")).toEqual({
      accepted: false,
      reason: "not_found",
    });
    expect(h.store.listRuns(routine.id)).toHaveLength(0);
  });

  test("singleton skips while a run is still active and records the skip", async () => {
    const h = harness();
    const turns = holdTurns(h.fake);
    const routine = defineRoutine(h.store, { singleton: true });

    const first = h.scheduler.runNow(routine.id, h.actor);
    // The agent has the prompt, so the run is recorded `running` by now.
    await turns.reached(1);
    expect(h.store.hasActiveRun(routine.id)).toBe(true);

    const second = await h.scheduler.runNow(routine.id, h.actor);
    expect(second.state).toBe("skipped");
    expect(second.agentId).toBeUndefined();
    // The skip must not have stood up a second agent.
    expect(h.store.listAgents()).toHaveLength(1);

    turns.release();
    expect((await first).state).toBe("succeeded");
    expect(h.store.listRuns(routine.id).filter((r) => r.state === "skipped")).toHaveLength(1);
  });

  test("a non-singleton routine runs concurrently instead of skipping", async () => {
    const h = harness();
    const turns = holdTurns(h.fake);
    const routine = defineRoutine(h.store, { singleton: false });

    const first = h.scheduler.runNow(routine.id, h.actor);
    // Let the first run bring the host up before starting the second, so both
    // agents land on one host rather than racing the supervisor into spawning
    // two. Concurrency of the *runs* is what this test is about.
    await turns.reached(1);
    const second = h.scheduler.runNow(routine.id, h.actor);
    await turns.reached(2);

    expect(h.store.listRuns(routine.id).filter((r) => r.state === "running")).toHaveLength(2);

    turns.release();
    expect((await first).state).toBe("succeeded");
    expect((await second).state).toBe("succeeded");
    expect(h.store.listRuns(routine.id).filter((r) => r.state === "skipped")).toHaveLength(0);
  });

  test("a run past its timeout is recorded timed_out and its agent is stopped", async () => {
    const h = harness();
    // A real delay, because the behaviour under test IS a wall-clock deadline.
    h.fake.onPrompt(() => Promise.withResolvers<never>().promise); // never answers
    const routine = defineRoutine(h.store, { timeoutSeconds: 0.05 });

    const run = await h.scheduler.runNow(routine.id, h.actor);

    expect(run.state).toBe("timed_out");
    expect(run.error).toContain("timeout");
    expect(run.finishedAt).toBeDefined();

    // Stopped, not merely abandoned: the timeout path must tear the agent down.
    const agent = h.store.getAgent(run.agentId ?? "");
    expect(agent?.state).toBe("stopped");
    expect(h.store.hasActiveRun(routine.id)).toBe(false);
  });

  test("a turn that rejects is recorded failed and still stops its agent", async () => {
    // The turn rejects outright rather than stalling, so nothing here waits on
    // a clock: the ACP request is answered with the transport closing under it.
    const h = harness();
    h.fake.onPrompt(() => {
      h.hosts[0]?.kill(); // the host dies mid-turn, as a crash would look
      return { stopReason: "never delivered" };
    });
    const routine = defineRoutine(h.store);

    const run = await h.scheduler.runNow(routine.id, h.actor);

    expect(run.state).toBe("failed");
    expect(run.error).toBeDefined();
    expect(run.finishedAt).toBeDefined();

    const agents = h.store.listAgents();
    expect(agents).toHaveLength(1);
    for (const agent of agents) {
      expect(TERMINAL_AGENT_STATES).toContain(agent.state);
    }

    // A run that ended must not keep `hasActiveRun` true, or the routine is
    // wedged for good.
    expect(h.store.hasActiveRun(routine.id)).toBe(false);
  });

  test("a turn that fails while its host survives leaves the agent stopped", async () => {
    // The other half of the failure path: when the host is still there, the
    // agent must be stopped properly rather than merely marked failed. A real
    // ACP transport deadline is the honest way to reject a turn in flight.
    const h = harness({ transportTimeoutMs: 40 });
    h.fake.onPrompt(() => Promise.withResolvers<never>().promise);
    const routine = defineRoutine(h.store);

    const run = await h.scheduler.runNow(routine.id, h.actor);

    expect(run.state).toBe("failed");
    expect(run.error).toContain("timeout");
    expect(h.store.getAgent(run.agentId ?? "")?.state).toBe("stopped");
    expect(h.store.hasActiveRun(routine.id)).toBe(false);
  });

  test("every run is audited, attributed to the device that caused it", async () => {
    const h = harness();
    h.store.addDevice({
      id: "phone",
      name: "phone",
      publicKey: "pk_phone",
      scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const routine = defineRoutine(h.store);

    const run = await h.scheduler.runNow(routine.id, {
      deviceId: "phone",
      scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE],
    });
    expect(run.state).toBe("succeeded");

    const entries = h.store.listAudit().filter((e) => e.action === "routine.run");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorDeviceId).toBe("phone");
    expect(entries[0]?.detail.routineId).toBe(routine.id);
    expect(entries[0]?.detail.runId).toBe(run.id);
    expect(entries[0]?.detail.state).toBe("succeeded");
  });

  test("runNow refuses a caller without manage scope and writes no run", async () => {
    const h = harness();
    const routine = defineRoutine(h.store);

    await expect(
      h.scheduler.runNow(routine.id, { deviceId: "phone", scopes: [SCOPE_PROMPT] }),
    ).rejects.toThrow(/manage/);

    expect(h.store.listRuns(routine.id)).toHaveLength(0);
    expect(h.store.listAgents()).toHaveLength(0);
  });

  test("runNow refuses a disabled routine", async () => {
    const h = harness();
    const routine = defineRoutine(h.store, { enabled: false });

    await expect(h.scheduler.runNow(routine.id, h.actor)).rejects.toThrow(/disabled/);
    expect(h.store.listRuns(routine.id)).toHaveLength(0);
  });

  test("runNow refuses an unknown routine", async () => {
    const h = harness();
    await expect(h.scheduler.runNow("rtn_nope", h.actor)).rejects.toThrow(/unknown routine/);
  });
});

describe("Scheduler ticks", () => {
  test("a newly seen routine is armed, not fired immediately", async () => {
    const h = harness();
    const routine = defineRoutine(h.store, { trigger: { kind: "interval", seconds: 60 } });

    await h.scheduler.tick();
    expect(h.store.listRuns(routine.id)).toHaveLength(0);

    h.advance(60_000);
    await h.scheduler.tick();
    expect(h.store.listRuns(routine.id)).toHaveLength(1);
    expect(h.store.listRuns(routine.id)[0]?.state).toBe("succeeded");
  });

  test("a disabled routine never fires", async () => {
    const h = harness();
    const routine = defineRoutine(h.store, {
      enabled: false,
      trigger: { kind: "interval", seconds: 1 },
    });

    await h.scheduler.tick();
    h.advance(600_000);
    await h.scheduler.tick();
    await h.scheduler.tick();

    expect(h.store.listRuns(routine.id)).toHaveLength(0);
    expect(h.store.listAgents()).toHaveLength(0);
    expect(h.store.listAudit().filter((e) => e.action === "routine.run")).toHaveLength(0);
  });

  test("a cron routine fires on its own schedule", async () => {
    const h = harness();
    const routine = defineRoutine(h.store, {
      trigger: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
    });

    await h.scheduler.tick(); // arms for 2026-01-01T09:00Z
    h.advance(8 * 60 * 60 * 1000); // 08:00Z, not yet
    await h.scheduler.tick();
    expect(h.store.listRuns(routine.id)).toHaveLength(0);

    h.advance(60 * 60 * 1000); // 09:00Z
    await h.scheduler.tick();
    expect(h.store.listRuns(routine.id)).toHaveLength(1);
  });

  test("one routine failing does not stop another due on the same tick", async () => {
    // Both agents share one `omp acp` host, so the failure has to be scoped to
    // a single turn. An ACP request deadline does that; killing the host would
    // take the sibling down with it and prove nothing.
    const h = harness({ transportTimeoutMs: 40 });
    h.fake.onPrompt((_sessionId, text) => {
      if (text === "boom") return Promise.withResolvers<never>().promise;
      return { stopReason: "end_turn" };
    });
    const bad = defineRoutine(h.store, { name: "bad", prompt: "boom" });
    const good = defineRoutine(h.store, { name: "good", prompt: "fine" });

    await h.scheduler.tick();
    h.advance(60_000);
    await h.scheduler.tick();

    expect(h.store.listRuns(bad.id)[0]?.state).toBe("failed");
    expect(h.store.listRuns(good.id)[0]?.state).toBe("succeeded");
  });

  test("a malformed trigger does not stop a healthy routine on the same tick", async () => {
    const h = harness();
    const broken = defineRoutine(h.store, {
      name: "broken",
      trigger: { kind: "cron", expression: "not a cron expression" },
    });
    const good = defineRoutine(h.store, { name: "good" });

    await h.scheduler.tick();
    h.advance(60_000);
    await h.scheduler.tick();

    expect(h.store.listRuns(broken.id)).toHaveLength(0);
    expect(h.store.listRuns(good.id)).toHaveLength(1);
    expect(h.store.listRuns(good.id)[0]?.state).toBe("succeeded");

    // The fault is reported, and reported once rather than every tick.
    const faults = h.store
      .listAudit()
      .filter((e) => e.action === "routine.run" && e.detail.phase === "schedule");
    expect(faults).toHaveLength(1);
    expect(faults[0]?.outcome).toBe("error");
  });

  test("a manual routine is never fired by the clock", async () => {
    const h = harness();
    const routine = defineRoutine(h.store, { trigger: { kind: "manual" } });

    await h.scheduler.tick();
    h.advance(86_400_000);
    await h.scheduler.tick();
    expect(h.store.listRuns(routine.id)).toHaveLength(0);

    // But it still runs on request.
    const run = await h.scheduler.runNow(routine.id, h.actor);
    expect(run.state).toBe("succeeded");
  });

  test("start drives ticks on a timer and stop halts them", async () => {
    // The one place a real clock is the point: this asserts that `start`
    // installs a working timer and `stop` removes it, which no injected clock
    // can demonstrate.
    const h = harness({ tickMs: 5, realClock: true });
    const fired = Promise.withResolvers<void>();
    h.fake.onPrompt(() => {
      fired.resolve();
      return { stopReason: "end_turn" };
    });
    const routine = defineRoutine(h.store, { trigger: { kind: "interval", seconds: 0.02 } });

    h.scheduler.start();
    h.scheduler.start(); // idempotent: must not install a second timer
    await fired.promise;

    h.scheduler.stop();
    await sleep(40); // let anything already in flight settle
    const settled = h.store.listRuns(routine.id).length;
    expect(settled).toBeGreaterThan(0);

    // Many tick intervals pass with the timer cleared, so nothing new may run.
    await sleep(80);
    expect(h.store.listRuns(routine.id).length).toBe(settled);
  });
});

/**
 * Teardown, from the one angle the other tests cannot see.
 *
 * Every test above lets a run finish before it looks at the record. The defect
 * these cover is the opposite case: the daemon goes down while a turn is still
 * in flight, so the run's own teardown writes its terminal record after the
 * store has closed, the write is lost, and the row outlives the process saying
 * `running`. Nothing about that is visible while the process is alive, so these
 * reopen the database the way the next daemon would.
 */
describe("Scheduler shutdown", () => {
  /**
   * Block until the routine's newest row says its turn has started.
   *
   * Deliberately not "start the run and hand back its promise": an async
   * function returning a promise adopts it, so the caller would wait for the
   * whole run instead of for the turn beginning.
   */
  async function untilRunning(h: Harness, routineId: string): Promise<void> {
    while (h.store.listRuns(routineId)[0]?.state !== "running") await sleep(2);
  }

  test("a run in flight when the daemon goes down is terminal before the store closes", async () => {
    const h = harness();
    // Never answers, and never rejects either: the turn is exactly as stuck as
    // one waiting on an approval nobody is left to give.
    h.fake.onPrompt(() => Promise.withResolvers<never>().promise);
    const routine = defineRoutine(h.store, { singleton: true });
    const running = h.scheduler.runNow(routine.id, h.actor);
    await untilRunning(h, routine.id);

    // The daemon's own order: no new work, settle what is in flight, then the
    // hosts, then the store.
    h.scheduler.stop();
    await h.scheduler.drain();
    await h.sup.shutdown();
    h.store.close();

    const reopened = new Store(h.path);
    stores.push(reopened);
    const run = reopened.listRuns(routine.id)[0];
    expect(run?.state).toBe("failed");
    expect(run?.finishedAt).toBeDefined();
    expect(run?.error).toContain("shut down");
    expect(reopened.hasActiveRun(routine.id)).toBe(false);

    await running;
  });

  test("a singleton routine fires again after a run was cut short by shutdown", async () => {
    const h = harness();
    let turns = 0;
    h.fake.onPrompt(() => {
      turns++;
      // Only the first turn hangs, so the second run has something to succeed
      // at. Without it the assertion could not tell "fires again" from "fires
      // again and fails".
      if (turns === 1) return Promise.withResolvers<never>().promise;
      return { stopReason: "end_turn" };
    });
    const routine = defineRoutine(h.store, { singleton: true });
    const running = h.scheduler.runNow(routine.id, h.actor);
    await untilRunning(h, routine.id);

    h.scheduler.stop();
    await h.scheduler.drain();

    // Asserted here, before anything else settles the first run: this is the
    // row the next fire consults, as of the moment the store would close.
    expect(h.store.hasActiveRun(routine.id)).toBe(false);

    // What a restart does: the scheduler is armed again against the same rows.
    h.scheduler.start();
    h.scheduler.stop();

    const next = await h.scheduler.runNow(routine.id, h.actor);
    expect(next.state).toBe("succeeded");
    expect(h.store.listRuns(routine.id).filter((r) => r.state === "skipped")).toHaveLength(0);

    void running;
  });

  test("a run cancellation cannot reach is settled by the drain deadline", async () => {
    // The path the deadline exists for. This run is stuck inside `initialize`,
    // so it has no session to cancel and no host that will ever answer: waiting
    // longer cannot settle it, and only a write from outside the run can.
    const h = harness({ silentHost: true });
    const routine = defineRoutine(h.store, { singleton: true });
    const running = h.scheduler.runNow(routine.id, h.actor);
    while (h.store.listRuns(routine.id).length === 0) await sleep(2);
    expect(h.store.listRuns(routine.id)[0]?.state).toBe("queued");

    h.scheduler.stop();
    const startedAt = Date.now();
    await h.scheduler.drain(30);
    const waited = Date.now() - startedAt;

    // Bounded: a shutdown must not inherit a stuck run's patience.
    expect(waited).toBeLessThan(1_000);
    const settled = h.store.listRuns(routine.id)[0];
    expect(settled?.state).toBe("failed");
    expect(settled?.error).toContain("shut down");
    expect(settled?.finishedAt).toBeDefined();
    expect(h.store.hasActiveRun(routine.id)).toBe(false);

    // The run itself is still suspended in there, and must not resurrect the
    // record if it ever unwinds. Only the assertion above can prove the write
    // came from the drain, so this one proves the drained record is final.
    void running;
    await sleep(20);
    expect(h.store.listRuns(routine.id)[0]?.state).toBe("failed");
    expect(h.store.hasActiveRun(routine.id)).toBe(false);
  });

  test("a run that hung recording its outcome keeps the outcome it reached", async () => {
    // Teardown is where a run writes its record, so a host that never answers
    // `session/close` leaves the run holding a finished outcome the row has
    // never seen: in memory it succeeded, on disk it is still running. The
    // drain has to persist what the run decided rather than overwrite it.
    const h = harness();
    h.fake.onClose(() => Promise.withResolvers<never>().promise);
    const routine = defineRoutine(h.store, { singleton: true });
    const running = h.scheduler.runNow(routine.id, h.actor);
    await untilRunning(h, routine.id);

    h.scheduler.stop();
    await h.scheduler.drain(30);

    const settled = h.store.listRuns(routine.id)[0];
    expect(settled?.state).toBe("succeeded");
    expect(settled?.finishedAt).toBeDefined();
    expect(h.store.hasActiveRun(routine.id)).toBe(false);

    void running;
  });

  test("a fire that arrives after the drain is refused rather than recorded", async () => {
    const h = harness();
    const routine = defineRoutine(h.store);

    await h.scheduler.drain();

    // A request the gateway was still serving as it closed. Refusing is the
    // only answer that cannot leave a row nothing will settle.
    await expect(h.scheduler.runNow(routine.id, h.actor)).rejects.toThrow(/shutting down/);
    expect(h.store.listRuns(routine.id)).toHaveLength(0);
  });

  test("an agent created after the drain is retired instead of prompted", async () => {
    // The race the drain cannot cancel its way out of. A run whose `createAgent`
    // is still in flight has no agent id, so `drain` has nothing to cancel and
    // settles it immediately. If `createAgent` then succeeds, the run used to
    // carry on and prompt, starting a turn against a supervisor and store that
    // were already being torn down.
    //
    // Driven through a stub rather than the fake host because the property is
    // about ordering, and holding `createAgent` open until the drain has
    // finished is the whole test. A timing-based version would pass or fail on
    // machine speed.
    const path = `/tmp/ompd-routines-${crypto.randomUUID()}.db`;
    paths.push(path);
    const store = new Store(path);
    stores.push(store);

    const created = Promise.withResolvers<{ id: AgentId }>();
    const stopped: AgentId[] = [];
    let prompts = 0;
    const stub = {
      createAgent: () => created.promise,
      cancel: async () => undefined,
      prompt: async () => {
        prompts += 1;
        return { stopReason: "end_turn" };
      },
      stopAgent: async (id: AgentId) => {
        stopped.push(id);
      },
    };
    const actor: Actor = { deviceId: "daemon", scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE] };
    const scheduler = new Scheduler({
      store,
      // Only the four methods a run's lifecycle touches, so the test can hold
      // `createAgent` open. Structural typing cannot express that against a
      // concrete class.
      supervisor: stub as unknown as Supervisor,
      actor,
    });

    const routine = defineRoutine(store);
    const running = scheduler.runNow(routine.id, actor);

    try {
      // The run exists and is waiting inside createAgent, so there is no agent
      // to cancel. This is the state the drain has to handle.
      while (store.listRuns(routine.id).length === 0) await sleep(2);
      // A short deadline on purpose: the run cannot settle while createAgent is
      // held, so this exercises the expiry path rather than waiting out the
      // production default.
      await scheduler.drain(50);
    } finally {
      // Always released, so a failed assertion above reports rather than hanging
      // this test on a promise nobody will ever resolve.
      created.resolve({ id: "agt_ffffffffffffffff" });
    }
    await running;

    expect(prompts).toBe(0);
    expect(stopped).toEqual(["agt_ffffffffffffffff"]);

    const [row] = store.listRuns(routine.id);
    expect(row?.state).toBe("failed");
  });
});
