/**
 * The idle-sleep assertion.
 *
 * The property under test is not "caffeinate was spawned". It is that the
 * assertion exists for exactly as long as there is work in flight and not one
 * moment longer, because both failures are bad in different ways: dropping it
 * early kills a turn someone started from their phone, and holding it late
 * leaves a laptop that will not sleep with nothing to show for it.
 *
 * So the interesting cases are the transitions and the edges. One agent going
 * busy takes one assertion, a second agent does not take a second, an agent
 * blocked on an approval still counts as work, a caffeinate that dies on its
 * own is noticed rather than assumed, and a daemon that stops while a turn is
 * still running releases anyway.
 *
 * Nothing here spawns a real `caffeinate`. The spawn seam is injected, and the
 * command it would have run is asserted directly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentState } from "@ompd/core";
import { SleepGuard, type AwakeProcess } from "../src/awake.ts";
import { Ompd } from "../src/daemon.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const scratch: string[] = [];
const running: Ompd[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeCaffeinate {
  spawn: (command: string[]) => AwakeProcess;
  /** Every command the guard tried to run, in order. */
  commands: string[][];
  /** How many of those are still alive. */
  alive: () => number;
  /** Kill the most recent one from outside, as the OS could. */
  die: () => void;
}

function fakeCaffeinate(): FakeCaffeinate {
  const commands: string[][] = [];
  const live = new Set<AwakeProcess>();
  let last: { proc: AwakeProcess; settle: () => void } | null = null;

  return {
    commands,
    alive: () => live.size,
    die: () => last?.settle(),
    spawn: (command) => {
      commands.push(command);
      const exit = Promise.withResolvers<number>();
      const proc: AwakeProcess = {
        exited: exit.promise,
        kill: () => {
          live.delete(proc);
          exit.resolve(0);
        },
      };
      live.add(proc);
      last = {
        proc,
        settle: () => {
          live.delete(proc);
          exit.resolve(0);
        },
      };
      return proc;
    },
  };
}

function agent(id: string, state: AgentState): Agent {
  return {
    id,
    name: id,
    state,
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    labels: {},
  };
}

describe("the idle-sleep assertion", () => {
  test("nothing is held while every agent is idle", () => {
    const fake = fakeCaffeinate();
    const guard = new SleepGuard({ spawn: fake.spawn });

    guard.update([agent("agt_a", "idle"), agent("agt_b", "stopped")]);

    expect(guard.held).toBe(false);
    expect(fake.commands).toEqual([]);
  });

  test("it prevents idle sleep only, and dies with the daemon", () => {
    const fake = fakeCaffeinate();
    const guard = new SleepGuard({ spawn: fake.spawn, pid: 4242 });

    guard.update([agent("agt_a", "busy")]);

    // `-i` and not `-d`: work happening in the background is no reason to hold
    // someone's screen on. `-w` is the safety catch, so a daemon killed with
    // SIGKILL cannot strand an assertion.
    expect(fake.commands).toEqual([["caffeinate", "-i", "-w", "4242"]]);
    expect(guard.command).toEqual(["caffeinate", "-i", "-w", "4242"]);
  });

  test("one assertion covers any number of working agents", () => {
    const fake = fakeCaffeinate();
    const guard = new SleepGuard({ spawn: fake.spawn });

    guard.update([agent("agt_a", "busy")]);
    guard.update([agent("agt_a", "busy"), agent("agt_b", "starting")]);
    guard.update([agent("agt_a", "busy"), agent("agt_b", "busy")]);

    expect(fake.commands).toHaveLength(1);
    expect(fake.alive()).toBe(1);
  });

  test("it is released as soon as the last agent settles", () => {
    const fake = fakeCaffeinate();
    const guard = new SleepGuard({ spawn: fake.spawn });

    guard.update([agent("agt_a", "busy")]);
    expect(guard.held).toBe(true);

    guard.update([agent("agt_a", "idle")]);
    expect(guard.held).toBe(false);
    expect(fake.alive()).toBe(0);
  });

  test("an agent blocked on an approval still counts as work", () => {
    const fake = fakeCaffeinate();
    const guard = new SleepGuard({ spawn: fake.spawn });

    // This is the case that matters most: someone is away from the machine,
    // deciding on a phone. Sleeping underneath that decision loses the turn.
    guard.update([agent("agt_a", "waiting")]);

    expect(guard.held).toBe(true);
  });

  test("keepAwake off never spawns anything", () => {
    const fake = fakeCaffeinate();
    const guard = new SleepGuard({ spawn: fake.spawn, enabled: false });

    guard.update([agent("agt_a", "busy")]);

    expect(guard.held).toBe(false);
    expect(fake.commands).toEqual([]);
  });

  test("a caffeinate that dies on its own is noticed, and the next turn retries", async () => {
    const fake = fakeCaffeinate();
    const guard = new SleepGuard({ spawn: fake.spawn });

    guard.update([agent("agt_a", "busy")]);
    fake.die();
    // The exit handler is a microtask; believing an assertion is still held
    // when it is not would mean never taking another one.
    await Promise.resolve();
    expect(guard.held).toBe(false);

    guard.update([agent("agt_a", "busy")]);
    expect(fake.commands).toHaveLength(2);
  });

  test("a host with no caffeinate says so once and stops trying", () => {
    const said: string[] = [];
    const guard = new SleepGuard({
      onLog: (line) => said.push(line),
      spawn: () => {
        throw new Error("no such file or directory: caffeinate");
      },
    });

    guard.update([agent("agt_a", "busy")]);
    guard.update([agent("agt_a", "idle")]);
    guard.update([agent("agt_b", "busy")]);

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("cannot hold an idle-sleep assertion");
  });
});

interface AwakeHarness {
  daemon: Ompd;
  host: FakeHostController;
}

describe("the daemon holds it across a real turn", () => {
  function build(fake: FakeCaffeinate): AwakeHarness {
    const home = mkdtempSync(join(tmpdir(), "ompd-awake-"));
    scratch.push(home);
    const host = createFakeHost();
    const daemon = new Ompd({
      home,
      overrides: { port: 0 },
      spawnHost: host.factory,
      spawnAwake: fake.spawn,
      voice: false,
    });
    running.push(daemon);
    return { daemon, host };
  }

  test("a prompt takes the assertion and settling releases it", async () => {
    const fake = fakeCaffeinate();
    const { daemon, host } = build(fake);
    const info = await daemon.start();
    const actor = { deviceId: info.bootstrap?.deviceId ?? "", scopes: ["read", "prompt", "manage"] };

    const created = await daemon.supervisor.createAgent({ cwd: "/tmp", name: "t" }, actor);
    // A new agent lands on idle, so nothing is held before there is a turn.
    expect(daemon.sleepGuard.held).toBe(false);

    const turn = Promise.withResolvers<unknown>();
    host.onPrompt(() => turn.promise);
    const prompted = daemon.supervisor.prompt(created.id, "go", actor);

    // The supervisor announces `busy` synchronously before the prompt leaves,
    // so by here the guard has already reacted.
    expect(daemon.sleepGuard.held).toBe(true);

    turn.resolve({ stopReason: "end_turn" });
    await prompted;
    expect(daemon.sleepGuard.held).toBe(false);
  });

  test("stopping while a turn is in flight still releases it", async () => {
    const fake = fakeCaffeinate();
    const { daemon, host } = build(fake);
    const info = await daemon.start();
    const actor = { deviceId: info.bootstrap?.deviceId ?? "", scopes: ["read", "prompt", "manage"] };

    const created = await daemon.supervisor.createAgent({ cwd: "/tmp", name: "t" }, actor);
    const turn = Promise.withResolvers<unknown>();
    host.onPrompt(() => turn.promise);
    const prompted = daemon.supervisor.prompt(created.id, "go", actor);
    expect(daemon.sleepGuard.held).toBe(true);

    await daemon.stop();

    // The turn never settled. Tying the release to teardown rather than to the
    // turn is what keeps a killed daemon from leaving the machine awake.
    expect(daemon.sleepGuard.held).toBe(false);
    expect(fake.alive()).toBe(0);

    turn.resolve({ stopReason: "cancelled" });
    await prompted.catch(() => undefined);
  });
});
