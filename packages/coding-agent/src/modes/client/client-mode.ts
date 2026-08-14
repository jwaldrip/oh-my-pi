/**
 * The TUI as a client of ompd, rather than the owner of an agent.
 *
 * This is what makes killing the TUI process harmless: the agent's lifetime
 * belongs to the daemon's `Supervisor`, which spawns and reaps its own child
 * processes independently of any socket attached to it (see
 * `control-plane/packages/daemon/src/supervisor.ts`). This mode never spawns
 * a process per session — `ClientModeComponent` renders whichever agent is
 * "viewed" and `OmpdClient.attach`/`detach` change which agent's updates flow
 * to this process, which is a view change, not a lifecycle event. Killing
 * this process (even with SIGKILL, which cannot be caught) simply drops the
 * socket; the daemon notices nothing beyond one fewer attached client, and
 * the agent's turn — if one was in flight — keeps running.
 *
 * A second client (another `omp client`, the web console, a phone) sees the
 * same agent immediately: the daemon is the single source of truth, and
 * `attach { sinceSeq }` is how any client — this one included, on reattach —
 * catches up on exactly what it missed. `sinceSeq: 0` on first attach asks for
 * the whole transcript rather than nothing.
 *
 * Additive by construction: nothing here touches `interactive-mode.ts` or
 * `session-teardown.ts`. A machine with no daemon running never reaches this
 * module at all — `omp` with no arguments still boots the standalone,
 * process-owns-the-agent TUI exactly as before.
 */

import {
	Container,
	type Focusable,
	Input,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Spacer,
	Text,
	TUI,
} from "@oh-my-pi/pi-tui";
import type { Agent, AgentId, ApprovalChoice } from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import { theme } from "../theme/theme";
import {
	type AgentView,
	type ClientAction,
	type ClientState,
	createClientState,
	reduceClientState,
} from "./client-state";
import { resolveDaemonBaseUrl, resolveDaemonToken, socketUrlFromBase, TOKEN_MISSING_GUIDANCE } from "./daemon-config";
import { formatSessionUpdate } from "./format-update";

export interface ClientModeCallbacks {
	onSubmit: (agentId: AgentId, text: string) => void;
	/** Fired the first time the operator views an agent this client has not attached yet. */
	onAttachNeeded: (agentId: AgentId) => void;
	onApprove: (agentId: AgentId, requestId: string, choice: ApprovalChoice) => void;
	onQuit: () => void;
}

const CHROME_ROWS = 5; // status line + 2 spacers + input line + hint line

/** Renders one agent's live transcript, a status line, an input, and an agent switcher. */
export class ClientModeComponent extends Container implements Focusable {
	focused = false;
	#state: ClientState = createClientState();
	#statusText = new Text("", 0, 0);
	#transcript = new ScrollView([], { height: 10 });
	#hint = new Text("", 0, 0);
	#input = new Input();
	#tui: TUI;
	#callbacks: ClientModeCallbacks;

	constructor(tui: TUI, callbacks: ClientModeCallbacks) {
		super();
		this.#tui = tui;
		this.#callbacks = callbacks;
		this.#input.prompt = "> ";
		this.#input.onSubmit = value => {
			const trimmed = value.trim();
			this.#input.setValue("");
			this.#tui.requestRender();
			if (trimmed.length === 0) return;
			const agentId = this.#state.viewing;
			if (agentId === null) return;
			this.#callbacks.onSubmit(agentId, trimmed);
		};

		this.addChild(this.#statusText);
		this.addChild(this.#transcript);
		this.addChild(new Spacer(1));
		this.addChild(this.#input);
		this.addChild(this.#hint);
		this.#sync();
	}

	dispatch(action: ClientAction): void {
		this.#state = reduceClientState(this.#state, action);
		this.#sync();
		this.#tui.requestRender();
	}

	getState(): ClientState {
		return this.#state;
	}

	#viewing(): AgentView | undefined {
		return this.#state.viewing !== null ? this.#state.agents.get(this.#state.viewing) : undefined;
	}

	#sync(): void {
		const count = this.#state.order.length;
		const connection = `[${this.#state.status}${this.#state.statusReason ? `: ${this.#state.statusReason}` : ""}]`;
		const viewing = this.#viewing();
		const position =
			viewing && this.#state.viewing !== null
				? `${this.#state.order.indexOf(this.#state.viewing) + 1}/${count}  ${viewing.agent.name}  [${viewing.agent.state}]  ${viewing.agent.cwd}`
				: count === 0
					? "no agents"
					: "select an agent";
		this.#statusText.setText(theme.fg("accent", `${connection}  ${position}`));

		const lines =
			viewing && viewing.lines.length > 0
				? viewing.lines.map(line => `#${line.seq} ${line.text}`)
				: [theme.fg("dim", "(no transcript yet)")];
		this.#transcript.setLines(lines);
		this.#transcript.scrollToBottom();

		if (viewing?.pendingApproval) {
			this.#hint.setText(
				theme.fg(
					"warning",
					`approval pending: ${viewing.pendingApproval.tool} -- ${viewing.pendingApproval.title}  (ctrl+y allow / ctrl+n deny)`,
				),
			);
		} else if (this.#state.lastError) {
			this.#hint.setText(theme.fg("error", this.#state.lastError));
		} else {
			this.#hint.setText(theme.fg("dim", "tab/shift+tab switch agent  enter send  ctrl+c quit"));
		}
	}

	override render(width: number): readonly string[] {
		this.#input.focused = this.focused;
		const rows = this.#tui.terminal.rows;
		this.#transcript.setHeight(Math.max(3, rows - CHROME_ROWS));
		return super.render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#callbacks.onQuit();
			return;
		}
		const viewing = this.#viewing();
		if (viewing?.pendingApproval) {
			if (matchesKey(data, "ctrl+y")) {
				this.#callbacks.onApprove(viewing.agent.id, viewing.pendingApproval.requestId, "allow");
				return;
			}
			if (matchesKey(data, "ctrl+n")) {
				this.#callbacks.onApprove(viewing.agent.id, viewing.pendingApproval.requestId, "deny");
				return;
			}
		}
		if (matchesKey(data, "tab")) {
			this.#switch(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.#switch(-1);
			return;
		}
		if (this.#transcript.handleScrollKey(data)) {
			this.#tui.requestRender();
			return;
		}
		this.#input.handleInput(data);
	}

	/**
	 * View change only: no attach call and no process spawn unless this agent
	 * has never been attached by this client before, in which case a single
	 * `attach { sinceSeq: 0 }` asks for its full transcript.
	 */
	#switch(direction: 1 | -1): void {
		this.dispatch({ type: "viewNext", direction });
		const view = this.#viewing();
		if (view && !view.attached) this.#callbacks.onAttachNeeded(view.agent.id);
	}
}

export interface RunClientModeOptions {
	daemonUrl?: string;
	token?: string;
	initialAgentId?: AgentId;
}

/**
 * Boot the client TUI: connect, list agents, view one, and stay attached until
 * the operator quits. Returns after a clean quit; a `SIGKILL` never reaches
 * this function at all, which is the property under test.
 */
export async function runClientMode(options: RunClientModeOptions = {}): Promise<number> {
	const baseUrl = options.daemonUrl ?? resolveDaemonBaseUrl();
	const token = options.token ?? resolveDaemonToken();
	if (token === null) {
		process.stderr.write(`${TOKEN_MISSING_GUIDANCE}\n`);
		return 1;
	}

	const { promise, resolve } = Promise.withResolvers<void>();
	const ui = new TUI(new ProcessTerminal());
	const client = new OmpdClient({ url: socketUrlFromBase(baseUrl), token });
	let quitting = false;

	const quit = (): void => {
		if (quitting) return;
		quitting = true;
		client.close();
		ui.stop();
		resolve();
	};

	const attachIfNeeded = (agentId: AgentId): void => {
		const view = component.getState().agents.get(agentId);
		if (!view || view.attached) return;
		component.dispatch({ type: "attaching", agentId });
		client.attach(agentId, { sinceSeq: 0 });
	};

	const component = new ClientModeComponent(ui, {
		onSubmit: (agentId, text) => client.prompt(agentId, text),
		onAttachNeeded: attachIfNeeded,
		onApprove: (agentId, requestId, choice) => client.decide(agentId, requestId, choice),
		onQuit: quit,
	});

	client.on("status", event => component.dispatch({ type: "status", status: event.state, reason: event.reason }));
	client.on("agents", (event: { agents: Agent[] }) => {
		component.dispatch({ type: "agents", agents: event.agents });
		const state = component.getState();
		const target = options.initialAgentId ?? state.viewing;
		if (target === null || target === undefined || !state.agents.has(target)) return;
		if (target !== state.viewing) component.dispatch({ type: "view", agentId: target });
		attachIfNeeded(target);
	});
	client.on("update", event => {
		component.dispatch({
			type: "line",
			agentId: event.agentId,
			seq: event.seq,
			text: formatSessionUpdate(event.update),
		});
	});
	client.on("approval", event => {
		component.dispatch({
			type: "approval",
			agentId: event.agentId,
			requestId: event.requestId,
			title: event.title,
			tool: event.tool,
		});
	});
	client.on("error", event => component.dispatch({ type: "error", message: event.message }));
	client.on("unauthorized", event => component.dispatch({ type: "error", message: event.reason }));

	ui.addChild(component);
	ui.setFocus(component);
	ui.start();
	client.start();

	await promise;
	return 0;
}
