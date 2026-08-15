import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, SCOPE_MANAGE, Store, type Routine } from "@ompd/core";
import { Gateway, GatewayEvents, type SyncSettings } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const gateways: Gateway[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  stores.splice(0).forEach((store) => store.close());
  paths.splice(0).forEach((path) => rmSync(path, { force: true }));
});

async function daemon(settings: SyncSettings = { policyMode: "standard", keepAwake: true }) {
  const path = `/tmp/ompd-sync-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const gateway = new Gateway({
    store,
    supervisor: new Supervisor({ store, policy: new DefaultPolicy(), spawnHost: hosts.spawn }),
    events: new GatewayEvents(),
    port: 0,
    syncConfig: {
      read: () => settings,
      apply: (next) => Object.assign(settings, next),
    },
    skills: { list: async () => [{ name: "deploy", description: "Deploy", kind: "skill", source: "project" }] },
    connectors: { list: async () => [{ name: "github", connected: true, status: "connected" }] },
  });
  gateways.push(gateway);
  const port = await gateway.listen();
  const base = `http://127.0.0.1:${port}`;
  const paired = await fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "sync-test", publicKey: "sync-test-key" }),
  });
  const code = (await paired.json() as { code: string }).code;
  const token = gateway.approvePairing(code, [SCOPE_MANAGE]);
  return {
    store,
    settings,
    token,
    request: (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("content-type", "application/json");
      return fetch(`${base}${path}`, { ...init, headers });
    },
  };
}

const webhookRoutine: Routine = {
  id: "morning-report",
  name: "Morning report",
  enabled: true,
  trigger: { kind: "webhook", secretRef: "webhook-ref-morning-report" },
  prompt: "Prepare the morning report",
  cwd: "/work/project",
  host: { kind: "container", image: "secret-image", repo: "private/repo" },
  singleton: true,
  timeoutSeconds: 90,
  labels: { team: "ops" },
  createdAt: "2026-08-13T00:00:00.000Z",
};

describe("configuration sync", () => {
  test("export excludes credentials, host settings, and a routine host specification", async () => {
    const source = await daemon({ policyMode: "strict", keepAwake: false });
    source.store.upsertRoutine(webhookRoutine);

    const response = await source.request("/v1/sync/export");
    expect(response.status).toBe(200);
    const document = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(document);

    expect(serialized).not.toContain(source.token);
    expect(serialized).not.toContain("secret-image");
    expect(serialized).not.toContain("private/repo");
    const { host: _host, ...exportedRoutine } = webhookRoutine;
    expect(document).toEqual({
      policyMode: "strict",
      keepAwake: false,
      routines: [exportedRoutine],
      skills: [{ name: "deploy", description: "Deploy", kind: "skill", source: "project" }],
      connectors: [{ name: "github", connected: true, status: "connected" }],
    });
    expect((document.routines as Array<Record<string, unknown>>)[0]?.trigger).toEqual(webhookRoutine.trigger);
  });

  test("import into a fresh daemon reproduces exported routine ids, names, and trigger shapes", async () => {
    const source = await daemon({ policyMode: "trusted", keepAwake: false });
    source.store.upsertRoutine(webhookRoutine);
    const document = await (await source.request("/v1/sync/export")).json();
    const target = await daemon();

    const response = await target.request("/v1/sync/import", {
      method: "POST",
      body: JSON.stringify(document),
    });

    expect(response.status).toBe(200);
    expect(target.settings).toEqual({ policyMode: "trusted", keepAwake: false });
    expect(target.store.listRoutines().map(({ id, name, trigger }) => ({ id, name, trigger }))).toEqual([
      { id: webhookRoutine.id, name: webhookRoutine.name, trigger: webhookRoutine.trigger },
    ]);
  });

  test("import rejects a hand-crafted token-shaped field", async () => {
    const target = await daemon();
    const response = await target.request("/v1/sync/import", {
      method: "POST",
      body: JSON.stringify({
        policyMode: "standard",
        keepAwake: true,
        routines: [],
        skills: [],
        connectors: [],
        deviceToken: "stolen",
      }),
    });

    expect(response.status).toBe(400);
    expect(target.store.listRoutines()).toEqual([]);
  });

  test("import rejects a webhook trigger that smuggles a resolved secret", async () => {
    const target = await daemon();
    const { host: _host, ...routine } = webhookRoutine;
    const response = await target.request("/v1/sync/import", {
      method: "POST",
      body: JSON.stringify({
        policyMode: "standard",
        keepAwake: true,
        routines: [{ ...routine, trigger: { ...routine.trigger, resolvedSecret: "never-exported" } }],
        skills: [],
        connectors: [],
      }),
    });

    expect(response.status).toBe(400);
    expect(target.store.listRoutines()).toEqual([]);
  });
});
