/**
 * The connectors catalogue.
 *
 * `discoverMCPServers` is upstream's own resolution and connection of every
 * configured MCP server -- this module does not reimplement discovery, it
 * only reshapes the result into `ConnectorSummary` and tears the connections
 * back down. A listing call is a point-in-time health check, not a
 * subscription: the daemon holds no MCP connection open between calls, so
 * every listing pays the cost of a real connect attempt and reports what
 * actually happened, not a cached guess.
 *
 * Never a place a connector's config reaches: `.mcp.json` entries routinely
 * carry bearer tokens, OAuth client secrets, and API keys in `env` or
 * `headers`, and `ConnectorSummary` has no field for any of it. `redactString`
 * additionally scrubs the one field that touches arbitrary text -- `error` --
 * because a server's own rejection message can echo back what it was sent.
 */

import { discoverMCPServers } from "@oh-my-pi/pi-coding-agent";
import { redactString, type ConnectorStatus, type ConnectorSummary, type WorkspaceSourceLevel } from "@ompd/core";

/** See the identical helper in `./skills.ts`; duplicated rather than shared because MCP source metadata has no `Skill`-shaped source to import a type from. */
function pluginNameFromPath(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	const cacheMatch = /[/\\]plugins[/\\]cache[/\\][^/\\]+[/\\]([^/\\]+)[/\\]/.exec(path);
	if (cacheMatch?.[1] !== undefined) return cacheMatch[1];
	const pluginMatch = /[/\\]plugins[/\\]([^/\\]+)[/\\]/.exec(path);
	return pluginMatch?.[1];
}

function connectorLevel(value: string | undefined): WorkspaceSourceLevel | undefined {
	return value === "user" || value === "project" || value === "native" ? value : undefined;
}

/**
 * The slice of `discoverMCPServers`'s result this module actually reads.
 * Declared structurally, the same reason `RoutineRunner` is in the gateway:
 * the real `MCPManager` class satisfies it without a cast, and a test can
 * build a plain object literal instead of standing up a real one.
 */
export interface MCPDiscoveryResult {
	manager: {
		getAllServerNames(): string[];
		getConnectionStatus(name: string): ConnectorStatus;
		getSource(name: string): { providerName?: string; level?: string; path?: string } | undefined;
		disconnectAll(): Promise<void>;
	};
	errors: Array<{ path: string; error: string }>;
}

/**
 * Enumerate configured MCP servers and their live connection health.
 *
 * `cwd` scopes discovery exactly as it would for a running agent working in
 * that directory; omitted, upstream falls back to its own project-directory
 * default. Every call connects and then disconnects: nothing here is cached,
 * and the manager `discoverMCPServers` returns is never handed back to the
 * caller, so there is no way to reach its config through this function even
 * by accident.
 *
 * `discover` defaults to the real upstream call; a test supplies a stand-in
 * satisfying `MCPDiscoveryResult` instead of spawning real MCP server
 * processes, the same seam `Supervisor.spawnHost` uses for the same reason.
 */
export async function listConnectorCatalog(
	cwd?: string,
	discover: (cwd?: string) => Promise<MCPDiscoveryResult> = discoverMCPServers,
): Promise<ConnectorSummary[]> {
	const { manager, errors } = await discover(cwd);
	try {
		const errorByServer = new Map(errors.map((e) => [e.path.replace(/^mcp:/, ""), e.error]));
		const summaries: ConnectorSummary[] = manager.getAllServerNames().map((name) => {
			const status: ConnectorStatus = manager.getConnectionStatus(name);
			const source = manager.getSource(name);
			const rawError = status === "connected" ? undefined : errorByServer.get(name);
			const pluginName = pluginNameFromPath(source?.path);
			return {
				name,
				connected: status === "connected",
				status,
				...(source?.providerName === undefined ? {} : { providerName: source.providerName }),
				...(connectorLevel(source?.level) === undefined ? {} : { level: connectorLevel(source?.level) }),
				...(pluginName === undefined ? {} : { pluginName }),
				...(rawError === undefined ? {} : { error: redactString(rawError) }),
			};
		});
		summaries.sort((a, b) => a.name.localeCompare(b.name));
		return summaries;
	} finally {
		// Torn down unconditionally, success or failure: a listing call must
		// never be the reason an MCP server process is still running after it
		// returns.
		await manager.disconnectAll();
	}
}
