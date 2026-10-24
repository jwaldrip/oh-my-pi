import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  SCOPE_MANAGE,
  SCOPE_READ,
  Store,
  type OmpModelRolesResponse,
  type OmpSettingsResponse,
} from "@ompd/core";
import { Gateway } from "../src/gateway/index.ts";
import type { OmpSettingsController } from "../src/omp-settings.ts";
import type { Supervisor } from "../src/supervisor.ts";

const paths: string[] = [];
const gateways: Gateway[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

interface Harness {
  gateway: Gateway;
  request(path: string, token: string, init?: RequestInit): Promise<Response>;
  pair(scopes: string[]): Promise<string>;
}

async function harness(controller: OmpSettingsController): Promise<Harness> {
  const path = `/tmp/ompd-gateway-omp-settings-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const gateway = new Gateway({
    supervisor: {} as Supervisor,
    store,
    ompSettings: controller,
    port: 0,
  });
  gateways.push(gateway);
  const port = await gateway.listen();
  const base = `http://127.0.0.1:${port}`;

  return {
    gateway,
    pair: async (scopes) => {
      const response = await fetch(`${base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test device", publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const body = (await response.json()) as { code: string };
      return gateway.approvePairing(body.code, scopes);
    },
    request: (requestPath, token, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("content-type", "application/json");
      return fetch(`${base}${requestPath}`, { ...init, headers });
    },
  };
}

describe("OMP settings gateway routes", () => {
  test("gives readers a redacted settings snapshot while reserving changes for manage scope", async () => {
    let settings: OmpSettingsResponse = { settings: { modelRoleStorage: "global" } };
    const controller: OmpSettingsController = {
      readSettings: async () => settings,
      updateSettings: async (next) => {
        settings = { settings: { ...settings.settings, ...next.settings } };
        return settings;
      },
      readRoles: async () => ({
        roles: { default: null, smol: null, slow: null, plan: null, task: null },
        cycleOrder: ["default", "smol", "slow", "plan"],
      }),
      updateRoles: async () => {
        throw new Error("not used by this test");
      },
    };
    const service = await harness(controller);
    const reader = await service.pair([SCOPE_READ]);
    const operator = await service.pair([SCOPE_READ, SCOPE_MANAGE]);

    const readable = await service.request("/v1/omp/settings", reader);
    expect(readable.status).toBe(200);
    expect(await readable.json()).toEqual({ settings: { modelRoleStorage: "global" } });

    const forbidden = await service.request("/v1/omp/settings", reader, {
      method: "POST",
      body: JSON.stringify({ settings: { modelRoleStorage: "project" } }),
    });
    expect(forbidden.status).toBe(403);

    const saved = await service.request("/v1/omp/settings", operator, {
      method: "POST",
      body: JSON.stringify({ settings: { modelRoleStorage: "project" } }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ settings: { modelRoleStorage: "project" } });
  });

  test("reads and updates every supported model role through the same scope boundary", async () => {
    let roles: OmpModelRolesResponse = {
      roles: { default: "openai/gpt", smol: null, slow: null, plan: null, task: null },
      cycleOrder: ["default", "smol", "slow", "plan"],
    };
    const controller: OmpSettingsController = {
      readSettings: async () => ({ settings: {} }),
      updateSettings: async () => ({ settings: {} }),
      readRoles: async () => roles,
      updateRoles: async (next) => {
        roles = { ...roles, roles: { ...roles.roles, ...next.roles }, cycleOrder: next.cycleOrder ?? roles.cycleOrder };
        return roles;
      },
    };
    const service = await harness(controller);
    const operator = await service.pair([SCOPE_READ, SCOPE_MANAGE]);

    const response = await service.request("/v1/omp/roles", operator, {
      method: "POST",
      body: JSON.stringify({ roles: { task: "anthropic/claude" }, cycleOrder: ["default", "smol", "slow", "plan"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      roles: { default: "openai/gpt", smol: null, slow: null, plan: null, task: "anthropic/claude" },
      cycleOrder: ["default", "smol", "slow", "plan"],
    });
  });
});
