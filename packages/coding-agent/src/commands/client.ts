/**
 * `omp client`: attach to a running ompd as a client instead of owning a
 * session. See `modes/client/client-mode.ts` for why this makes killing the
 * TUI harmless to whatever the daemon is running.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { clientHelp as commandHelp } from "../cli/command-help";
import { runClientMode } from "../modes/client/client-mode";
import { initTheme } from "../modes/theme/theme";

export default class Client extends Command {
	static description = commandHelp.description;

	static args = {
		agentId: Args.string({
			description: "Agent id to view first (defaults to the daemon's first live agent)",
			required: false,
		}),
	};

	static flags = {
		daemon: Flags.string({ description: "Daemon base URL, overriding OMPD_URL / ~/.ompd/endpoint" }),
		token: Flags.string({ description: "Device token, overriding OMPD_TOKEN / ~/.ompd/token" }),
	};

	static examples = [
		"# Attach to the daemon and view its first live agent\n  omp client",
		"# Attach to a specific agent\n  omp client agt_1a2b3c4d5e6f7a8b",
		"# Point at a daemon on a non-default port\n  omp client --daemon http://127.0.0.1:4242",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Client);
		await initTheme();
		const exitCode = await runClientMode({
			daemonUrl: flags.daemon,
			token: flags.token,
			initialAgentId: args.agentId,
		});
		process.exitCode = exitCode;
	}
}
