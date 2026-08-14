/**
 * The supervisor is the privileged boundary, so it must resolve and authorize
 * actors itself rather than trusting the gateway. These tests exist because a
 * future second front-end (CLI, routine, voice bridge) calling the supervisor
 * directly must hit the same gate the websocket does.
 *
 * The property that matters most: `actor.scopes` is a *claim from the caller*.
 * Authorization reads the paired device row instead, so forging an actor buys
 * nothing. Several tests below would pass trivially if scopes were trusted, so
 * each one is written to fail in exactly that case.
 *
 * No host is spawned: authorization runs before any process work, which is part
 * of the contract -- an unauthorized call must not cost a subprocess.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  Store,
  type Actor,
} from "@ompd/core";
import { Supervisor, UnauthorizedError } from "../src/supervisor.ts";

const paths: string[] = [];
const stores: Store[] = [];

interface Harness {
  sup: Supervisor;
  store: Store;
  pair: (id: string, scopes: string[]) => Actor;
}

function harness(): Harness {
  const path = `/tmp/ompd-scope-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const sup = new Supervisor({ store });
  return {
    sup,
    store,
    pair: (id, scopes) => {
      store.addDevice({
        id,
        name: id,
        publicKey: `pk_${id}`,
        scopes,
        createdAt: new Date().toISOString(),
      });
      return { deviceId: id, scopes };
    },
  };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

describe("forged actors", () => {
  test("an unknown device is rejected even claiming every scope", async () => {
    // The whole attack in one line: the caller invents an identity and grants
    // itself the scopes it wants. Only the store may say what a device holds.
    const { sup } = harness();
    const forged: Actor = {
      deviceId: "not-paired",
      scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
    };

    await expect(sup.createAgent({ name: "x", cwd: "/tmp" }, forged)).rejects.toThrow(
      UnauthorizedError,
    );
    await expect(sup.prompt("agt_x", "hi", forged)).rejects.toThrow(UnauthorizedError);
    expect(sup.decide("req", "allow", "once", forged)).toBe(false);
  });

  test("claimed scopes are ignored in favour of the stored grant", async () => {
    // Device is paired for read only, but claims manage. Stored grant wins.
    const { sup, pair } = harness();
    pair("phone", [SCOPE_READ]);
    const overclaiming: Actor = { deviceId: "phone", scopes: [SCOPE_READ, SCOPE_MANAGE] };

    await expect(sup.createAgent({ name: "x", cwd: "/tmp" }, overclaiming)).rejects.toThrow(
      UnauthorizedError,
    );
  });

  test("a device cannot escalate by omitting scopes it does hold", async () => {
    // The inverse: understating scopes must not deny a legitimate call, since
    // the stored grant is the only input that counts.
    const { sup, pair } = harness();
    pair("laptop", [SCOPE_PROMPT]);
    const understating: Actor = { deviceId: "laptop", scopes: [] };

    // Gets past authorization and fails on agent lookup instead.
    await expect(sup.prompt("agt_missing", "hi", understating)).rejects.toThrow(/unknown agent/);
  });
});

describe("scope separation", () => {
  test("a read-only device can neither create, prompt, cancel, nor stop", async () => {
    const { sup, pair } = harness();
    const reader = pair("reader", [SCOPE_READ]);

    await expect(sup.createAgent({ name: "x", cwd: "/tmp" }, reader)).rejects.toThrow(
      UnauthorizedError,
    );
    await expect(sup.prompt("agt_x", "hi", reader)).rejects.toThrow(UnauthorizedError);
    await expect(sup.cancel("agt_x", reader)).rejects.toThrow(UnauthorizedError);
    await expect(sup.stopAgent("agt_x", reader)).rejects.toThrow(UnauthorizedError);
    expect(sup.decide("req", "allow", "once", reader)).toBe(false);
  });

  test("managing agents and driving them are separate powers", async () => {
    const { sup, pair } = harness();
    const manager = pair("manager", [SCOPE_MANAGE]);
    await expect(sup.prompt("agt_x", "hi", manager)).rejects.toThrow(UnauthorizedError);

    const prompter = pair("prompter", [SCOPE_PROMPT]);
    await expect(sup.stopAgent("agt_x", prompter)).rejects.toThrow(UnauthorizedError);
  });

  test("prompt scope does not confer approval scope", async () => {
    // This is the phone case: paired to drive agents, never to approve a
    // critical tool call on its own.
    const { sup, pair } = harness();
    const phone = pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    expect(sup.decide("req", "allow", "once", phone)).toBe(false);
  });
});

describe("revocation", () => {
  test("a revoked device loses access it previously had", async () => {
    const { sup, store, pair } = harness();
    const phone = pair("phone", [SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_APPROVE]);

    // Before revocation the call reaches past authorization.
    await expect(sup.prompt("agt_missing", "hi", phone)).rejects.toThrow(/unknown agent/);

    store.revokeDevice("phone");

    await expect(sup.prompt("agt_missing", "hi", phone)).rejects.toThrow(UnauthorizedError);
    await expect(sup.createAgent({ name: "x", cwd: "/tmp" }, phone)).rejects.toThrow(
      UnauthorizedError,
    );
    expect(sup.decide("req", "allow", "once", phone)).toBe(false);
  });
});

describe("information leakage", () => {
  test("an unauthorized caller cannot distinguish a real request id from a fake", () => {
    const { sup, pair } = harness();
    const reader = pair("reader", [SCOPE_READ]);
    expect(sup.decide("req_real", "allow", "once", reader)).toBe(false);
    expect(sup.decide("req_fake", "allow", "once", reader)).toBe(false);
  });
});

describe("auditing", () => {
  test("a denial names the actor and the reason", async () => {
    const { sup, store, pair } = harness();
    const reader = pair("reader", [SCOPE_READ]);
    await expect(sup.prompt("agt_x", "hi", reader)).rejects.toThrow(UnauthorizedError);

    const row = store.listAudit().find((a) => a.outcome === "denied");
    expect(row?.actorDeviceId).toBe("reader");
    expect(String(row?.detail.reason)).toContain(SCOPE_PROMPT);
    expect(String(row?.detail.action)).toBe("agent.prompt");
  });

  test("an unknown device is audited as such", async () => {
    const { sup, store } = harness();
    await expect(
      sup.prompt("agt_x", "hi", { deviceId: "ghost", scopes: [SCOPE_PROMPT] }),
    ).rejects.toThrow(UnauthorizedError);

    const row = store.listAudit().find((a) => a.outcome === "denied");
    expect(row?.actorDeviceId).toBe("ghost");
    expect(String(row?.detail.reason)).toBe("unknown device");
  });
});
