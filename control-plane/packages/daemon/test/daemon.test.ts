/**
 * The composition root, tested for the things only it can get wrong.
 *
 * **Shutdown order.** Every subsystem has its own working teardown; the bug
 * this file exists to catch is running them in the wrong sequence. Closing the
 * gateway after the supervisor would accept a request against hosts that had
 * already been killed, and nothing inside either subsystem can detect that.
 * The order is asserted directly, and then again by consequence: once `stop`
 * has returned, the port is genuinely gone.
 *
 * **The local operator bootstrap.** It writes a credential to disk, so three
 * things matter: the token file is 0600, a restart reuses the one device row
 * rather than leaving a new one behind, and a restart leaves the credential
 * itself alone. The last is the one a naive implementation gets wrong, and it
 * gets it wrong silently: reminting on every start logs out every paired
 * device with no operator action and nothing in the audit log.
 *
 * Nothing here spawns `omp`. The supervisor's host seam is a scripted ACP peer,
 * and voice is off so no test shells out to probe for a speech binary.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import {
  LOCAL_OPERATOR_DEVICE_ID,
  Ompd,
  endpointPath,
  loadConfig,
  type OmpdOptions,
} from "../src/daemon.ts";
import { NO_TARGET } from "../src/browser/bridge.ts";
import {
  base64ToPcm,
  pcmToBase64,
  type PcmAudio,
  type SttEngine,
  type TtsEngine,
} from "../src/voice/index.ts";
import { createFakeHost } from "./fake-host.ts";

const scratch: string[] = [];
const running: Ompd[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function build(home: string, extra: Partial<OmpdOptions> = {}): Ompd {
  const daemon = new Ompd({
    home,
    // Port 0 asks the OS for a free one, so tests never collide with each
    // other or with a daemon the developer left running.
    overrides: { port: 0 },
    spawnHost: createFakeHost().factory,
    voice: false,
    ...extra,
  });
  running.push(daemon);
  return daemon;
}

async function tokenOf(home: string): Promise<string> {
  return (await Bun.file(join(home, "token")).text()).trim();
}

afterEach(async () => {
  // `stop` is idempotent, so cleaning up a daemon a test already stopped costs
  // nothing and leaving one running costs a port.
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  test("defaults to loopback, 7777, standard policy, awake while working, no hub", () => {
    expect(loadConfig(tempDir("ompd-cfg-"))).toEqual({
      host: "127.0.0.1",
      port: 7777,
      policyMode: "standard",
      ompPath: "omp",
      keepAwake: true,
      // Empty by default: dialing out to a hub publishes this machine to
      // whoever holds a paired token, so it stays a deliberate edit.
      hubUrl: "",
    });
  });

  test("the file overrides defaults and flags override the file", () => {
    const home = tempDir("ompd-cfg-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 9000, policyMode: "strict" }));

    expect(loadConfig(home).port).toBe(9000);
    expect(loadConfig(home).policyMode).toBe("strict");
    expect(loadConfig(home, { port: 1234 }).port).toBe(1234);
    // Overriding one field must not discard the file's others.
    expect(loadConfig(home, { port: 1234 }).policyMode).toBe("strict");
  });

  test("an unknown policy mode is refused rather than silently downgraded", () => {
    const home = tempDir("ompd-cfg-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ policyMode: "yolo" }));

    // The failure that matters: a typo must never leave the daemon enforcing a
    // policy nobody chose.
    expect(() => loadConfig(home)).toThrow(/policyMode must be one of/);
  });

  test("malformed config is an error, not a fallback", () => {
    const home = tempDir("ompd-cfg-");
    writeFileSync(join(home, "config.json"), "{ not json");
    expect(() => loadConfig(home)).toThrow(/not valid JSON/);
  });

  test("an out-of-range port is refused", () => {
    const home = tempDir("ompd-cfg-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 70_000 }));
    expect(() => loadConfig(home)).toThrow(/port must be an integer/);
  });
});

describe("lifecycle", () => {
  test("start serves, stop stops, and both are idempotent", async () => {
    const daemon = build(tempDir("ompd-daemon-"));

    const first = await daemon.start();
    expect(first.port).toBeGreaterThan(0);

    // A second start must not bind a second port.
    const second = await daemon.start();
    expect(second.port).toBe(first.port);

    const health = await fetch(`${first.url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    await daemon.stop();
    await daemon.stop();

    // The consequence, not just the call: nothing is listening any more.
    await expect(fetch(`${first.url}/v1/health`)).rejects.toThrow();
  });

  test("the bound address is published while serving and retracted after", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);

    const info = await daemon.start();
    // Written only once a port is real, so nothing can read an address that
    // was never bound. This is how the CLI finds a daemon started on a port
    // the config file has never heard of.
    expect(readFileSync(endpointPath(home), "utf8").trim()).toBe(info.url);

    await daemon.stop();
    expect(existsSync(endpointPath(home))).toBe(false);
  });

  test("a stop racing an unfinished start waits for it and still tears down", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);

    // A signal during startup is the real case: `start` is still binding and
    // writing a token file when the handler fires.
    const started = daemon.start();
    await daemon.stop();
    const info = await started;

    // Startup completed rather than being torn out from under, and then the
    // teardown it waited for actually happened.
    expect(info.port).toBeGreaterThan(0);
    expect(existsSync(endpointPath(home))).toBe(false);
    await expect(fetch(`${info.url}/v1/health`)).rejects.toThrow();
  });

  test("stop after a failed start still brings the pieces down", async () => {
    const home = tempDir("ompd-daemon-");
    // A port already taken is the ordinary way startup fails.
    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const taken = build(home, { overrides: { host: "127.0.0.1", port: blocker.port } });

    await expect(taken.start()).rejects.toThrow();
    // No hang, no throw, and nothing published for a daemon that never served.
    await taken.stop();
    expect(existsSync(endpointPath(home))).toBe(false);

    blocker.stop(true);
  });

  test("stop runs scheduler, then the drain, then gateway, then supervisor", async () => {
    const daemon = build(tempDir("ompd-daemon-"));
    await daemon.start();

    const order: string[] = [];
    const { scheduler, gateway, supervisor } = daemon;

    const stopScheduler = scheduler.stop.bind(scheduler);
    scheduler.stop = () => {
      order.push("scheduler");
      stopScheduler();
    };
    const drainScheduler = scheduler.drain.bind(scheduler);
    scheduler.drain = async (timeoutMs?: number) => {
      order.push("drain");
      await drainScheduler(timeoutMs);
    };
    const closeGateway = gateway.close.bind(gateway);
    gateway.close = async () => {
      order.push("gateway");
      await closeGateway();
    };
    const shutdownSupervisor = supervisor.shutdown.bind(supervisor);
    supervisor.shutdown = async () => {
      order.push("supervisor");
      await shutdownSupervisor();
    };

    await daemon.stop();

    // The supervisor tears down running agents, so everything that could still
    // accept work has to close before it. The reverse loses an in-flight agent
    // with a client watching. The drain sits ahead of both because cancelling a
    // turn needs the host serving it: after the supervisor is down, a run can
    // only wait for a settle that will never arrive.
    expect(order).toEqual(["scheduler", "drain", "gateway", "supervisor"]);

    // Idempotence is about the teardown running once, not merely about `stop`
    // not throwing.
    await daemon.stop();
    expect(order).toEqual(["scheduler", "drain", "gateway", "supervisor"]);
  });

  test("start settles runs a killed daemon left mid-flight", async () => {
    // The case a drain cannot reach: a process that was killed never ran its
    // own teardown, so the row outlives it saying `running`, and `hasActiveRun`
    // keeps a singleton routine silent for good. Startup is the deterministic
    // place to fix that, because nothing can be in flight before the scheduler
    // is armed.
    const daemon = build(tempDir("ompd-daemon-"));
    daemon.store.upsertRun({
      id: "run_orphan",
      routineId: "rtn_nightly",
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(daemon.store.hasActiveRun("rtn_nightly")).toBe(true);

    await daemon.start();

    const settled = daemon.store.listRuns("rtn_nightly")[0];
    expect(settled?.state).toBe("failed");
    expect(settled?.error).toContain("exited");
    expect(settled?.finishedAt).toBeDefined();
    expect(daemon.store.hasActiveRun("rtn_nightly")).toBe(false);
  });

  test("a live agent does not stall or survive shutdown", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);
    const info = await daemon.start();

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await tokenOf(home)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "smoke", cwd: home }),
    });
    expect(created.status).toBe(201);
    expect(daemon.supervisor.listAgents()).toHaveLength(1);

    await daemon.stop();
    await expect(fetch(`${info.url}/v1/agents`)).rejects.toThrow();
  });
});

describe("local operator bootstrap", () => {
  test("first start creates exactly one device and a 0600 token file", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);

    const info = await daemon.start();
    expect(info.bootstrap?.created).toBe(true);

    const devices = daemon.store.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe(LOCAL_OPERATOR_DEVICE_ID);
    expect(devices[0]?.scopes.toSorted()).toEqual(["approve", "manage", "prompt", "read"]);

    // Owner read/write and nothing else. This file is the whole credential.
    expect(statSync(info.bootstrap?.tokenPath ?? "").mode & 0o777).toBe(0o600);

    // And it actually authenticates, which is the only thing that makes the
    // bootstrap worth doing.
    const response = await fetch(`${info.url}/v1/agents`, {
      headers: { authorization: `Bearer ${await tokenOf(home)}` },
    });
    expect(response.status).toBe(200);
  });

  test("a token file left world-readable is corrected on the next start", async () => {
    const home = tempDir("ompd-daemon-");
    const tokenPath = join(home, "token");
    writeFileSync(tokenPath, "stale\n", { mode: 0o644 });

    const daemon = build(home);
    await daemon.start();

    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(await tokenOf(home)).not.toBe("stale");
  });

  test("a restart keeps the token file byte-identical and still accepted", async () => {
    const home = tempDir("ompd-daemon-");

    const first = build(home);
    const firstInfo = await first.start();
    expect(firstInfo.bootstrap?.created).toBe(true);
    expect(firstInfo.bootstrap?.reused).toBe(false);
    const bytes = readFileSync(join(home, "token"));
    await first.stop();

    const second = build(home);
    const secondInfo = await second.start();
    // Neither the row nor the credential is new. A restart is not an operator
    // decision to withdraw anything, so it must withdraw nothing.
    expect(secondInfo.bootstrap?.created).toBe(false);
    expect(secondInfo.bootstrap?.reused).toBe(true);
    expect(second.store.listDevices()).toHaveLength(1);
    expect(readFileSync(join(home, "token")).equals(bytes)).toBe(true);

    const response = await fetch(`${secondInfo.url}/v1/agents`, {
      headers: { authorization: `Bearer ${bytes.toString("utf8").trim()}` },
    });
    expect(response.status).toBe(200);
  });

  test("a paired device survives a restart without re-pairing", async () => {
    // The whole defect this file's bootstrap section used to encode. A phone
    // paired before a restart has to keep working after one; the operator
    // token surviving is only half of it.
    const home = tempDir("ompd-daemon-");

    const first = build(home);
    const firstInfo = await first.start();
    const operator = await tokenOf(home);

    const pairing = await fetch(`${firstInfo.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", publicKey: "pk_phone" }),
    });
    const { code } = (await pairing.json()) as { code: string };
    const granted = await fetch(`${firstInfo.url}/v1/pairings/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ code, scopes: ["read"] }),
    });
    const { token: phone } = (await granted.json()) as { token: string };
    expect(
      (await fetch(`${firstInfo.url}/v1/agents`, { headers: { authorization: `Bearer ${phone}` } }))
        .status,
    ).toBe(200);
    await first.stop();

    const second = build(home);
    const secondInfo = await second.start();
    expect(
      (await fetch(`${secondInfo.url}/v1/agents`, { headers: { authorization: `Bearer ${phone}` } }))
        .status,
    ).toBe(200);
  });

  test("a token file that no longer names a live credential is replaced", async () => {
    const home = tempDir("ompd-daemon-");

    const first = build(home);
    await first.start();
    const original = await tokenOf(home);
    await first.stop();

    // Someone pasted the wrong thing over it, or copied a home directory
    // between machines. Reusing it would lock the operator out of their own
    // daemon with no way back in, which is the one failure the reuse path
    // must not cause.
    writeFileSync(join(home, "token"), "not-a-real-token\n", { mode: 0o600 });

    const second = build(home);
    const info = await second.start();
    expect(info.bootstrap?.reused).toBe(false);
    const replacement = await tokenOf(home);
    expect(replacement).not.toBe("not-a-real-token");
    expect(replacement).not.toBe(original);

    const response = await fetch(`${info.url}/v1/agents`, {
      headers: { authorization: `Bearer ${replacement}` },
    });
    expect(response.status).toBe(200);
  });

  test("a revoked local operator is not resurrected by a restart", async () => {
    const home = tempDir("ompd-daemon-");

    const first = build(home);
    await first.start();
    await first.stop();

    // Revoked out of band, the way `ompd revoke` would have.
    const store = new Store(join(home, "ompd.db"));
    store.revokeDevice(LOCAL_OPERATOR_DEVICE_ID);
    store.close();

    const second = build(home);
    const info = await second.start();
    // Revocation a restart undid would not be revocation.
    expect(info.bootstrap).toBeNull();
    expect(second.store.getDevice(LOCAL_OPERATOR_DEVICE_ID)?.revokedAt).toBeDefined();
  });

  test("a revoked local operator token file is not honoured after the restart", async () => {
    // Revoking the device withdraws its tokens too, so the file on disk must
    // stop being a credential even though its bytes are unchanged. Reuse that
    // trusted the file rather than the registry would hand the machine back.
    const home = tempDir("ompd-daemon-");

    const first = build(home);
    await first.start();
    const token = await tokenOf(home);
    await first.stop();

    const store = new Store(join(home, "ompd.db"));
    store.revokeDevice(LOCAL_OPERATOR_DEVICE_ID);
    store.close();

    const second = build(home);
    const info = await second.start();
    expect(info.bootstrap).toBeNull();

    const response = await fetch(`${info.url}/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});

describe("rotation", () => {
  test("rotating the operator rewrites its token file and kills the old one", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);
    const info = await daemon.start();
    const before = await tokenOf(home);

    const rotated = await fetch(`${info.url}/v1/tokens/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${before}`, "content-type": "application/json" },
    });
    expect(rotated.status).toBe(200);
    const body = (await rotated.json()) as { token: string; tokenPath?: string; revoked: number };
    expect(body.revoked).toBe(1);
    expect(body.tokenPath).toBe(join(home, "token"));

    // The file follows, so a rotation driven from anywhere leaves the CLI on
    // this machine holding a token that works.
    const after = await tokenOf(home);
    expect(after).toBe(body.token);
    expect(after).not.toBe(before);
    expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);

    expect(
      (await fetch(`${info.url}/v1/agents`, { headers: { authorization: `Bearer ${before}` } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`${info.url}/v1/agents`, { headers: { authorization: `Bearer ${after}` } }))
        .status,
    ).toBe(200);
  });

  test("a rotated operator token survives the next restart", async () => {
    // Rotation writes through the same registry the bootstrap reads, or the
    // next start would quietly hand back a third token.
    const home = tempDir("ompd-daemon-");

    const first = build(home);
    const firstInfo = await first.start();
    const rotated = await fetch(`${firstInfo.url}/v1/tokens/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenOf(home)}` },
    });
    const { token } = (await rotated.json()) as { token: string };
    await first.stop();

    const second = build(home);
    const info = await second.start();
    expect(info.bootstrap?.reused).toBe(true);
    expect(await tokenOf(home)).toBe(token);

    const response = await fetch(`${info.url}/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  test("rotating a phone leaves the operator token file untouched", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const pairing = await fetch(`${info.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", publicKey: "pk_phone" }),
    });
    const { code } = (await pairing.json()) as { code: string };
    const granted = await fetch(`${info.url}/v1/pairings/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ code, scopes: ["read"] }),
    });
    const { token: phone } = (await granted.json()) as { token: string };

    const rotated = await fetch(`${info.url}/v1/tokens/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: daemon.store.listDevices().find((d) => d.name === "phone")?.id }),
    });
    const body = (await rotated.json()) as { token: string; tokenPath?: string };
    expect(body.tokenPath).toBeUndefined();
    expect(await tokenOf(home)).toBe(operator);

    expect(
      (await fetch(`${info.url}/v1/agents`, { headers: { authorization: `Bearer ${phone}` } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`${info.url}/v1/agents`, { headers: { authorization: `Bearer ${body.token}` } }))
        .status,
    ).toBe(200);
  });
});

describe("static hosting", () => {
  test("the built client is served from / and deep links get the shell", async () => {
    const root = tempDir("ompd-static-");
    writeFileSync(join(root, "index.html"), "<!doctype html><title>ompd</title>");
    writeFileSync(join(root, "app.js"), "export const x = 1;");

    const daemon = build(tempDir("ompd-daemon-"), { staticRoot: root });
    const info = await daemon.start();

    const shell = await fetch(`${info.url}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("<title>ompd</title>");

    expect((await fetch(`${info.url}/app.js`)).status).toBe(200);

    // A phone reloading a client-side route must not 404.
    const route = await fetch(`${info.url}/agents/agt_1`);
    expect(await route.text()).toContain("<title>ompd</title>");

    // A missing asset stays a 404. Answering it with HTML turns a broken
    // deploy into a parse error somewhere unrelated.
    expect((await fetch(`${info.url}/missing.js`)).status).toBe(404);
  });

  test("static hosting cannot be walked out of", async () => {
    const parent = tempDir("ompd-static-");
    const root = join(parent, "dist");
    writeFileSync(join(parent, "secret.txt"), "TOP-SECRET");
    await Bun.write(join(root, "index.html"), "<!doctype html>");

    const daemon = build(tempDir("ompd-daemon-"), { staticRoot: root });
    const info = await daemon.start();

    for (const attempt of [
      "/../secret.txt",
      "/..%2Fsecret.txt",
      "/%2e%2e/secret.txt",
      "/a/../../secret.txt",
    ]) {
      const response = await fetch(`${info.url}${attempt}`);
      const body = response.ok ? await response.text() : "";
      expect(body).not.toContain("TOP-SECRET");
    }
  });

  test("a file cannot shadow the API", async () => {
    const root = tempDir("ompd-static-");
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    await Bun.write(join(root, "v1", "health"), "not the daemon");

    const daemon = build(tempDir("ompd-daemon-"), { staticRoot: root });
    const info = await daemon.start();

    expect(await (await fetch(`${info.url}/v1/health`)).json()).toMatchObject({ ok: true });
  });
});

describe("operator routes", () => {
  test("approve grants only scopes the approver already holds", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const pair = async (name: string): Promise<string> => {
      const response = await fetch(`${info.url}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, publicKey: `pk_${name}` }),
      });
      const body = (await response.json()) as { code: string };
      return body.code;
    };
    const approve = (token: string, code: string, scopes: string[]): Promise<Response> =>
      fetch(`${info.url}/v1/pairings/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ code, scopes }),
      });

    // The operator holds everything, so it can mint an approver that holds
    // strictly less.
    const approverGrant = await approve(operator, await pair("approver"), ["read", "approve"]);
    expect(approverGrant.status).toBe(200);
    const { token: approver } = (await approverGrant.json()) as { token: string };

    const target = await pair("target");
    const escalation = await approve(approver, target, ["read", "manage"]);
    // A device must never mint one more powerful than itself.
    expect(escalation.status).toBe(403);
    expect(await escalation.json()).toMatchObject({ error: "scope_escalation", missing: ["manage"] });

    // The mirror image, which is what distinguishes enforcement from a route
    // that simply fails: within its own scopes the same approver works, and
    // the refused attempt did not burn the code.
    const allowed = await approve(approver, target, ["read"]);
    expect(allowed.status).toBe(200);
    expect(daemon.store.listDevices().find((d) => d.name === "target")?.scopes).toEqual(["read"]);
  });

  test("a device without approve scope cannot approve at all", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const pairing = await fetch(`${info.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", publicKey: "pk" }),
    });
    const { code } = (await pairing.json()) as { code: string };

    const granted = await fetch(`${info.url}/v1/pairings/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ code, scopes: ["read", "prompt"] }),
    });
    const { token: phone } = (await granted.json()) as { token: string };

    const second = await fetch(`${info.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "other", publicKey: "pk2" }),
    });
    const { code: otherCode } = (await second.json()) as { code: string };

    const refused = await fetch(`${info.url}/v1/pairings/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone}`, "content-type": "application/json" },
      body: JSON.stringify({ code: otherCode, scopes: ["read"] }),
    });
    expect(refused.status).toBe(403);
    expect(daemon.store.listDevices().some((d) => d.name === "other")).toBe(false);
  });

  test("revoking a device stops its token on the next request", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const pairing = await fetch(`${info.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", publicKey: "pk" }),
    });
    const { code } = (await pairing.json()) as { code: string };
    const granted = await fetch(`${info.url}/v1/pairings/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ code, scopes: ["read"] }),
    });
    const { token: phone } = (await granted.json()) as { token: string };

    expect((await fetch(`${info.url}/v1/agents`, { headers: { authorization: `Bearer ${phone}` } })).status).toBe(200);

    const phoneId = daemon.store.listDevices().find((d) => d.name === "phone")?.id ?? "";
    const revoked = await fetch(`${info.url}/v1/devices/${phoneId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(revoked.status).toBe(200);

    expect((await fetch(`${info.url}/v1/agents`, { headers: { authorization: `Bearer ${phone}` } })).status).toBe(401);
    // The row stays, marked, so revoking remains auditable.
    expect(daemon.store.listDevices().find((d) => d.id === phoneId)?.revokedAt).toBeDefined();
  });

  test("status reports uptime and agents by state", async () => {
    const home = tempDir("ompd-daemon-");
    const daemon = build(home);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "one", cwd: home }),
    });

    const status = await fetch(`${info.url}/v1/status`, {
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      version: "0.1.0",
      agents: { total: 1, byState: { idle: 1 } },
    });
  });
});

type Frame = Record<string, unknown>;

interface TestSocket {
  frames: Frame[];
  send(frame: unknown): void;
  /** Resolves with the first frame matching, including ones already arrived. */
  next(match: (frame: Frame) => boolean): Promise<Frame>;
  /** Resolves once `predicate` holds, re-checked as frames arrive. */
  until(predicate: () => boolean): Promise<void>;
  close(): void;
}

/**
 * A connected client socket.
 *
 * Waits are re-checked against frames that already arrived, so a test can
 * never register interest in something that just happened and then hang.
 */
async function socketFor(port: number, token: string): Promise<TestSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${token}`);
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();

  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
    for (const waiter of [...waiters]) waiter();
  });
  const open = Promise.withResolvers<void>();
  ws.addEventListener("open", () => open.resolve());
  await open.promise;

  const settle = <T,>(check: () => T | null): Promise<T> => {
    const done = Promise.withResolvers<T>();
    const attempt = (): void => {
      const value = check();
      if (value === null) return;
      waiters.delete(attempt);
      done.resolve(value);
    };
    waiters.add(attempt);
    attempt();
    return done.promise;
  };

  return {
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (match) => settle(() => frames.find(match) ?? null),
    until: (predicate) => settle(() => (predicate() ? true : null)).then(() => undefined),
    close: () => ws.close(),
  };
}

/** Run the real two-step pairing and return the minted token. */
async function pairDevice(
  base: string,
  approver: string,
  name: string,
  scopes: string[],
): Promise<string> {
  const begun = await fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, publicKey: `pk_${name}` }),
  });
  const { code } = (await begun.json()) as { code: string };

  const approved = await fetch(`${base}/v1/pairings/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${approver}`, "content-type": "application/json" },
    body: JSON.stringify({ code, scopes }),
  });
  const { token } = (await approved.json()) as { token: string };
  return token;
}

describe("WebView composition", () => {
  test("mounts the per-agent MCP server and round-trips a tool call through the registered device", async () => {
    const home = tempDir("ompd-webview-");
    const fake = createFakeHost();
    const daemon = new Ompd({
      home,
      overrides: { port: 0 },
      spawnHost: fake.factory,
      voice: false,
    });
    running.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "browser-worker", cwd: home }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: { id: string } };

    expect(fake.newRequests).toHaveLength(1);
    const descriptor = fake.newRequests[0]?.mcpServers[0] as
      | { name?: unknown; type?: unknown; url?: unknown }
      | undefined;
    expect(descriptor).toMatchObject({ name: "ompd-webview", type: "http" });
    expect(descriptor?.url).toBeString();

    const phone = await socketFor(info.port, operator);
    phone.send({ t: "attach", agentId: agent.id });
    phone.send({ t: "webview_register", agentId: agent.id });
    phone.send({ t: "ping" });
    await phone.next((frame) => frame.t === "pong");
    // A rejected register would otherwise surface only as a five-second hang
    // below, which reads as a slow test rather than a refused registration.
    expect(phone.frames.filter((frame) => frame.t === "error")).toEqual([]);

    const call = fetch(String(descriptor?.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "webview_observe", arguments: {} },
      }),
    });
    // Racing the two sides turns "the bridge answered without ever reaching a
    // device" into that message, instead of a timeout that says nothing.
    const first = await Promise.race([
      phone
        .next((frame) => frame.t === "webview_action")
        .then((frame) => ({ kind: "action" as const, frame })),
      call.then((response) => ({ kind: "response" as const, response })),
    ]);
    if (first.kind !== "action") {
      throw new Error(
        `the MCP call settled before dispatch: ${first.response.status} ${await first.response.text()}`,
      );
    }
    const action = first.frame;
    expect(action).toMatchObject({
      t: "webview_action",
      agentId: agent.id,
      action: { kind: "observe" },
    });
    phone.send({
      t: "webview_result",
      agentId: agent.id,
      requestId: action.requestId,
      result: {
        kind: "observe",
        observation: {
          url: "https://example.com",
          title: "Example",
          settled: true,
          tree: { tag: "body", ref: "n0", text: "hello" },
        },
      },
    });

    const response = await call;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(body.result?.isError).toBe(false);
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "{}")).toMatchObject({
      kind: "observe",
      observation: { url: "https://example.com", title: "Example" },
    });
  });

  test("fails an in-flight action when the registered device disconnects", async () => {
    const home = tempDir("ompd-webview-");
    const fake = createFakeHost();
    const daemon = new Ompd({
      home,
      overrides: { port: 0 },
      spawnHost: fake.factory,
      voice: false,
    });
    running.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "browser-worker", cwd: home }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };
    const url = String(
      (fake.newRequests[0]?.mcpServers[0] as { url?: unknown } | undefined)?.url,
    );

    const phone = await socketFor(info.port, operator);
    phone.send({ t: "attach", agentId: agent.id });
    phone.send({ t: "webview_register", agentId: agent.id });
    phone.send({ t: "ping" });
    await phone.next((frame) => frame.t === "pong");

    const call = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "webview_observe", arguments: {} },
      }),
    });
    // Dispatched, so the bridge is holding a pending row: this is the state
    // that would otherwise wait out the full device timeout.
    await phone.next((frame) => frame.t === "webview_action");
    phone.close();

    const body = (await (await call).json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe(NO_TARGET);
  });
});

describe("voice wiring", () => {
  test("a transcript that fails to prompt reaches the client as an error", async () => {
    const home = tempDir("ompd-daemon-");
    // Deterministic speech: the engine is the seam, so this runs on a machine
    // with no speech binaries at all.
    const stt: SttEngine = {
      name: "test",
      transcribe: () => Promise.resolve("build the thing"),
    };
    // Never reached here: the prompt fails before anything is spoken back.
    const tts: TtsEngine = {
      name: "test",
      // Yields nothing: the prompt fails before synthesis is reached.
      async *stream(): AsyncIterable<PcmAudio> {},
    };
    const daemon = build(home, { voice: true, stt, tts });
    const info = await daemon.start();
    const token = await tokenOf(home);

    const socket = new WebSocket(`ws://127.0.0.1:${info.port}/v1/socket?token=${token}`);
    const frames: Array<Record<string, unknown>> = [];
    const errored = Promise.withResolvers<Record<string, unknown>>();
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.t === "error") errored.resolve(frame);
    });
    const open = Promise.withResolvers<void>();
    socket.addEventListener("open", () => open.resolve());
    await open.promise;

    // No such agent, so the prompt behind the transcript is guaranteed to fail.
    const audio = pcmToBase64(new Int16Array(16_000).fill(4000));
    socket.send(JSON.stringify({ t: "audio", agentId: "agt_missing", pcm: audio }));
    socket.send(JSON.stringify({ t: "audio_end", agentId: "agt_missing" }));

    const failure = await errored.promise;
    // The transcript arrived first, so the operator saw the daemon hear them.
    // Swallowing the prompt rejection would end the story there, with a phone
    // showing words that never became a turn.
    expect(frames.some((frame) => frame.t === "transcript")).toBe(true);
    expect(String(failure.message)).toContain("agt_missing");

    socket.close();
  });

  test("the device that spoke hears the answer, and nobody else does", async () => {
    const home = tempDir("ompd-daemon-");
    const fake = createFakeHost();
    const spoken: string[] = [];
    const daemon = build(home, {
      voice: true,
      spawnHost: fake.factory,
      stt: { name: "test", transcribe: () => Promise.resolve("what is the status") },
      tts: {
        name: "test",
        async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
          for (const segment of segments) {
            spoken.push(segment);
            // One sample per character, so the frame's length identifies which
            // text was synthesised without decoding it.
            yield { pcm: new Int16Array(segment.length).fill(1), sampleRate: 16_000 };
          }
        },
      },
    });
    const info = await daemon.start();
    const operator = await tokenOf(home);

    fake.onPrompt((sessionId) => {
      fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "everything is green" },
      });
      return { stopReason: "end_turn" };
    });

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "voice", cwd: home }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };

    // A second device, attached to the same agent, that only ever types.
    const listener = await pairDevice(info.url, operator, "desktop", ["read", "prompt"]);

    const phone = await socketFor(info.port, operator);
    const desktop = await socketFor(info.port, listener);

    phone.send({ t: "audio", agentId: agent.id, pcm: pcmToBase64(new Int16Array(16_000).fill(4000)) });
    phone.send({ t: "audio_end", agentId: agent.id });

    const speech = await phone.next((frame) => frame.t === "speech");
    expect(speech.agentId).toBe(agent.id);
    // Exactly the turn's answer, synthesised once.
    expect(spoken).toEqual(["everything is green"]);
    expect(String(speech.pcm).length).toBeGreaterThan(0);

    // The desktop is attached to the same agent and never spoke, so it must
    // not be handed audio it did not ask for.
    expect(desktop.frames.some((frame) => frame.t === "speech")).toBe(false);

    phone.close();
    desktop.close();
  });

  test("a typed prompt turns that device's voice back off", async () => {
    const home = tempDir("ompd-daemon-");
    const fake = createFakeHost();
    const synthesised: string[] = [];
    const daemon = build(home, {
      voice: true,
      spawnHost: fake.factory,
      stt: { name: "test", transcribe: () => Promise.resolve("out loud") },
      tts: {
        name: "test",
        async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
          for (const segment of segments) {
            synthesised.push(segment);
            yield { pcm: new Int16Array(8).fill(1), sampleRate: 16_000 };
          }
        },
      },
    });
    const info = await daemon.start();
    const operator = await tokenOf(home);

    fake.onPrompt((sessionId) => {
      fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "an answer" },
      });
      return { stopReason: "end_turn" };
    });

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "voice", cwd: home }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };

    const phone = await socketFor(info.port, operator);
    phone.send({ t: "audio", agentId: agent.id, pcm: pcmToBase64(new Int16Array(16_000).fill(4000)) });
    phone.send({ t: "audio_end", agentId: agent.id });
    await phone.next((frame) => frame.t === "speech");
    expect(synthesised).toHaveLength(1);

    // Now the same device types. The modality follows what the operator just
    // demonstrated they want, so the next answer is silent.
    phone.send({ t: "prompt", agentId: agent.id, text: "and this one typed" });
    await phone.until(() => daemon.store.listAgents()[0]?.state === "idle");

    expect(synthesised).toHaveLength(1);
    expect(phone.frames.filter((frame) => frame.t === "speech")).toHaveLength(1);
    phone.close();
  });

  test("a 22050Hz engine still reaches the client at the 16kHz the wire promises", async () => {
    const home = tempDir("ompd-daemon-");
    const fake = createFakeHost();
    // What macOS `say` emits. Sent unchanged it would not fail, it would play
    // slowly and an octave down, which sounds like a bad model rather than a
    // bad conversion.
    const engineRate = 22_050;
    const seconds = 1;
    const daemon = build(home, {
      voice: true,
      spawnHost: fake.factory,
      stt: { name: "test", transcribe: () => Promise.resolve("say something") },
      tts: {
        name: "test",
        async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
          // One second per segment, so the assertion below is about the rate
          // conversion and not about how the reply happened to be segmented.
          for (const _segment of segments) {
            yield {
              pcm: new Int16Array(engineRate * seconds).fill(1000),
              sampleRate: engineRate,
            };
          }
        },
      },
    });
    const info = await daemon.start();
    const operator = await tokenOf(home);

    fake.onPrompt((sessionId) => {
      fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one second of speech" },
      });
      return { stopReason: "end_turn" };
    });

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "rate", cwd: home }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };

    const phone = await socketFor(info.port, operator);
    phone.send({ t: "audio", agentId: agent.id, pcm: pcmToBase64(new Int16Array(16_000).fill(4000)) });
    phone.send({ t: "audio_end", agentId: agent.id });

    const speech = await phone.next((frame) => frame.t === "speech");
    // A second of audio has to arrive as a second of audio at the rate the
    // client will play it, not as 22050 samples a browser stretches to 1.38s.
    expect(base64ToPcm(String(speech.pcm)).length).toBe(16_000 * seconds);
    phone.close();
  });

  test("a reply survives the socket that asked for it going away", async () => {
    const home = tempDir("ompd-daemon-");
    const fake = createFakeHost();
    const answered = Promise.withResolvers<void>();
    const daemon = build(home, {
      voice: true,
      spawnHost: fake.factory,
      stt: { name: "test", transcribe: () => Promise.resolve("take your time") },
      tts: {
        name: "test",
        async *stream(segments: Iterable<string>): AsyncIterable<PcmAudio> {
          for (const _segment of segments) {
            yield { pcm: new Int16Array(16).fill(1), sampleRate: 16_000 };
          }
        },
      },
    });
    const info = await daemon.start();
    const operator = await tokenOf(home);

    // Held open until the first socket is gone, so the reply is produced for a
    // device whose connection died mid-turn: a phone changing networks.
    fake.onPrompt(async (sessionId) => {
      await answered.promise;
      fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "still here" },
      });
      return { stopReason: "end_turn" };
    });

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "reconnect", cwd: home }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };

    const first = await socketFor(info.port, operator);
    first.send({ t: "audio", agentId: agent.id, pcm: pcmToBase64(new Int16Array(16_000).fill(4000)) });
    first.send({ t: "audio_end", agentId: agent.id });
    await first.next((frame) => frame.t === "transcript");

    // The phone loses signal, then comes back on a new socket.
    first.close();
    const second = await socketFor(info.port, operator);
    answered.resolve();

    // Voice belongs to the device, so the answer finds it again. Keyed on the
    // socket, this reply would have been synthesised into a closed connection.
    const speech = await second.next((frame) => frame.t === "speech");
    expect(speech.agentId).toBe(agent.id);
    second.close();
  });

  test("the spoken form is derived without a speech engine at all", async () => {
    const home = tempDir("ompd-daemon-");
    const fake = createFakeHost();
    // Voice off entirely: no bridge, no engines, nothing to synthesise with.
    // A phone that does its own text-to-speech wants the prose, and a daemon
    // on a machine with no speech stack still knows what the agent said.
    const daemon = build(home, { voice: false, spawnHost: fake.factory });
    const info = await daemon.start();
    const operator = await tokenOf(home);

    fake.onPrompt((sessionId) => {
      fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done. Here is the patch:\n\n```ts\nconst x = 1;\n```\n" },
      });
      // Thoughts are not the answer, so they must not be spoken.
      fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "considering whether to explain further" },
      });
      return { stopReason: "end_turn" };
    });

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "quiet", cwd: home }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };

    await daemon.supervisor.prompt(agent.id, "do the thing", {
      deviceId: LOCAL_OPERATOR_DEVICE_ID,
      scopes: ["read", "prompt", "manage", "approve"],
    });

    const spoken = daemon.spokenReply(agent.id, 0);
    // The prose survives; the code fence does not, because reading a diff
    // aloud is noise.
    expect(spoken).not.toBeNull();
    expect(spoken?.text).toContain("Done");
    expect(spoken?.text).not.toContain("const x = 1");
    expect(spoken?.text).not.toContain("considering whether");
    // The sequence is what lets a client tell turns apart and skip a replayed
    // summary, so it has to be real rather than defaulted.
    expect(spoken?.seq).toBeGreaterThan(0);
  });

  test("a turn with nothing speakable in it reports null rather than silence", async () => {
    const home = tempDir("ompd-daemon-");
    const fake = createFakeHost();
    const daemon = build(home, { voice: false, spawnHost: fake.factory });
    const info = await daemon.start();
    const operator = await tokenOf(home);

    fake.onPrompt((sessionId) => {
      fake.emitUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "```\nnothing but a fence\n```" },
      });
      return { stopReason: "end_turn" };
    });

    const created = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "fenced", cwd: home }),
    });
    const { agent } = (await created.json()) as { agent: { id: string } };

    await daemon.supervisor.prompt(agent.id, "show me", {
      deviceId: LOCAL_OPERATOR_DEVICE_ID,
      scopes: ["read", "prompt", "manage", "approve"],
    });

    // Null, not an empty string: the caller has to tell "nothing to say" from
    // "say nothing", or a phone announces an empty utterance.
    expect(daemon.spokenReply(agent.id, 0)).toBeNull();
  });
});
