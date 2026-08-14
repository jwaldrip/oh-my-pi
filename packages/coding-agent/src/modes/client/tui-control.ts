/**
 * The reverse control leg a normal interactive TUI holds open to ompd.
 *
 * The TUI remains the only owner of its AgentSession until an operator asks
 * ompd to take it over. At that point this transport hands the already-open
 * session to an in-process ACP server; no second process ever opens the same
 * session file.
 */

export interface TuiControlSocket {
	readyState: number;
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onclose: (() => void) | null;
	onerror?: (() => void) | null;
}

export interface LiveTuiSessionIdentity {
	id: string;
	cwd: string;
	title?: string;
	pid: number;
}

/** ACP JSON-RPC payloads are opaque here: ACP owns their schema. */
export interface TuiAcpTransport {
	send(raw: string): void;
	onMessage(listener: (raw: string) => void): void;
	onClose(listener: () => void): void;
}

export interface LiveTuiControlLegOptions {
	url: string;
	session: LiveTuiSessionIdentity;
	createSocket?: (url: string) => TuiControlSocket;
	/** Must release terminal ownership and start an ACP server before resolving. */
	onTakeover: (transport: TuiAcpTransport) => Promise<void>;
	onError?: (error: unknown) => void;
}

const SOCKET_OPEN = 1;

/**
 * One authenticated control socket for a live, standalone TUI.
 *
 * It intentionally has no reconnect loop. Before takeover, a missing daemon
 * leaves the local TUI untouched; after takeover, its ACP session belongs to
 * the daemon and a transport close is an ACP disconnect, not an excuse to
 * resume rendering an input surface that no longer owns the session.
 */
export class LiveTuiControlLeg {
	readonly #options: LiveTuiControlLegOptions;
	#socket: TuiControlSocket | undefined;
	#acpMessageListener: ((raw: string) => void) | undefined;
	#acpCloseListener: (() => void) | undefined;
	#takeoverStarted = false;

	constructor(options: LiveTuiControlLegOptions) {
		this.#options = options;
	}

	start(): void {
		if (this.#socket) return;
		try {
			const socket = (this.#options.createSocket ?? createPlatformSocket)(this.#options.url);
			this.#socket = socket;
			socket.onopen = () => this.#register();
			socket.onmessage = event => this.#receive(event.data);
			socket.onclose = () => this.#closeAcp();
			if ("onerror" in socket) socket.onerror = () => this.#closeAcp();
			if (socket.readyState === SOCKET_OPEN) this.#register();
		} catch (error) {
			this.#options.onError?.(error);
		}
	}

	close(): void {
		this.#socket?.close();
		this.#socket = undefined;
		this.#closeAcp();
	}

	#register(): void {
		const { id: sessionId, cwd, title, pid } = this.#options.session;
		this.#send({
			t: "tui_register",
			sessionId,
			cwd,
			...(title === undefined ? {} : { title }),
			pid,
		});
	}

	#receive(raw: string): void {
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null || !("t" in frame)) return;
		if (frame.t === "tui_takeover" && "sessionId" in frame) {
			if (frame.sessionId !== this.#options.session.id || this.#takeoverStarted) return;
			this.#takeoverStarted = true;
			void this.#beginTakeover();
			return;
		}
		if (
			frame.t === "tui_acp" &&
			"sessionId" in frame &&
			frame.sessionId === this.#options.session.id &&
			"raw" in frame &&
			typeof frame.raw === "string"
		) {
			this.#acpMessageListener?.(frame.raw);
		}
	}

	async #beginTakeover(): Promise<void> {
		try {
			await this.#options.onTakeover({
				send: raw => this.#send({ t: "tui_acp", sessionId: this.#options.session.id, raw }),
				onMessage: listener => {
					this.#acpMessageListener = listener;
				},
				onClose: listener => {
					this.#acpCloseListener = listener;
				},
			});
			this.#send({ t: "tui_acp_ready", sessionId: this.#options.session.id });
		} catch (error) {
			this.#options.onError?.(error);
			this.#send({
				t: "tui_takeover_failed",
				sessionId: this.#options.session.id,
				message: error instanceof Error ? error.message : "failed to hand session to ACP",
			});
		}
	}

	#closeAcp(): void {
		const close = this.#acpCloseListener;
		this.#acpCloseListener = undefined;
		this.#acpMessageListener = undefined;
		close?.();
	}

	#send(frame: unknown): void {
		const socket = this.#socket;
		if (!socket || socket.readyState !== SOCKET_OPEN) return;
		try {
			socket.send(JSON.stringify(frame));
		} catch (error) {
			this.#options.onError?.(error);
		}
	}
}

function createPlatformSocket(url: string): TuiControlSocket {
	return new WebSocket(url) as unknown as TuiControlSocket;
}
