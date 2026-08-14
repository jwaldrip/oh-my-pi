/**
 * The connectors catalogue's reshaping of upstream discovery.
 *
 * `MCPManager` is a real class with private connection state that is not
 * practical to construct in a unit test, so `listConnectorCatalog`'s `discover`
 * seam takes the narrow `MCPDiscoveryResult` shape and a plain object literal
 * stands in for it. What matters here is that this module never lets a
 * connector's config -- or a secret embedded in whatever error text a server
 * sends back -- reach the response.
 */

import { describe, expect, test } from "bun:test";
import type { ConnectorStatus } from "@ompd/core";
import { listConnectorCatalog, type MCPDiscoveryResult } from "../src/workspace/connectors.ts";

function fakeManager(
  servers: Record<string, { status: ConnectorStatus; source?: { providerName?: string; level?: string; path?: string } }>,
): { manager: MCPDiscoveryResult["manager"]; disconnectCalls: number[] } {
  const disconnectCalls: number[] = [];
  const manager: MCPDiscoveryResult["manager"] = {
    getAllServerNames: () => Object.keys(servers),
    getConnectionStatus: (name) => servers[name]?.status ?? "disconnected",
    getSource: (name) => servers[name]?.source,
    disconnectAll: async () => {
      disconnectCalls.push(Date.now());
    },
  };
  return { manager, disconnectCalls };
}

describe("listConnectorCatalog", () => {
  test("a down connector reports why, not just that it is down", async () => {
    const { manager, disconnectCalls } = fakeManager({
      flaky: { status: "disconnected", source: { providerName: "Claude Code Marketplace", level: "user" } },
      healthy: { status: "connected", source: { providerName: "Claude Code Marketplace", level: "user" } },
    });

    const connectors = await listConnectorCatalog(undefined, async () => ({
      manager,
      errors: [{ path: "mcp:flaky", error: "connect ECONNREFUSED 127.0.0.1:9999" }],
    }));

    const flaky = connectors.find((c) => c.name === "flaky");
    expect(flaky?.connected).toBe(false);
    expect(flaky?.status).toBe("disconnected");
    expect(flaky?.error).toBe("connect ECONNREFUSED 127.0.0.1:9999");

    // A connector that IS connected reports no error at all -- the field's
    // absence is itself the "nothing is wrong" signal.
    const healthy = connectors.find((c) => c.name === "healthy");
    expect(healthy?.connected).toBe(true);
    expect(healthy?.error).toBeUndefined();

    // The manager is always torn down, so a listing call never leaves a real
    // connection open behind it.
    expect(disconnectCalls).toHaveLength(1);
  });

  test("a secret embedded in a connector's raw error never reaches the response", async () => {
    const secret = "sk-testFAKEFAKEFAKEFAKEFAKEFAKE1234567890";
    const { manager } = fakeManager({
      leaky: { status: "disconnected", source: { providerName: "Claude Code Marketplace", level: "project" } },
    });

    const connectors = await listConnectorCatalog(undefined, async () => ({
      manager,
      // A real server rejecting a bad key can echo it back in its own error
      // text. This is the shape that matters: the secret is not in a config
      // field this module ever reads, it is in the one string field it does.
      errors: [{ path: "mcp:leaky", error: `unauthorized: Authorization: Bearer ${secret} was rejected` }],
    }));

    const serialized = JSON.stringify(connectors);
    expect(serialized).not.toContain(secret);
    expect(connectors.find((c) => c.name === "leaky")?.error).toContain("[redacted]");
  });

  test("never returns a config field, by construction: only the declared ConnectorSummary keys appear", async () => {
    const { manager } = fakeManager({
      svc: { status: "connected", source: { providerName: "Claude Code Marketplace", level: "user", path: "/x" } },
    });

    const connectors = await listConnectorCatalog(undefined, async () => ({ manager, errors: [] }));
    const allowed = new Set(["name", "connected", "status", "providerName", "level", "pluginName", "error"]);
    for (const connector of connectors) {
      for (const key of Object.keys(connector)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  test("sorted by name, and a plugin-cache path yields a pluginName", async () => {
    const { manager } = fakeManager({
      zeta: { status: "connected" },
      alpha: {
        status: "connected",
        source: {
          providerName: "Claude Code Marketplace",
          level: "user",
          path: "/Users/j/.claude/plugins/cache/jutsu-market/cld/mcp-servers/alpha.json",
        },
      },
    });

    const connectors = await listConnectorCatalog(undefined, async () => ({ manager, errors: [] }));
    expect(connectors.map((c) => c.name)).toEqual(["alpha", "zeta"]);
    expect(connectors[0]?.pluginName).toBe("cld");
    expect(connectors[1]?.pluginName).toBeUndefined();
  });
});
