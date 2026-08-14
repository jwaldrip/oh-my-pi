import { describe, expect, test } from "bun:test";
import {
	LiveTuiControlLeg,
	type TuiControlSocket,
} from "../../../src/modes/client/tui-control";

class FakeSocket implements TuiControlSocket {
	readonly sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	readyState = 0;

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(frame: unknown): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

describe("LiveTuiControlLeg", () => {
	test("registers the running TUI, hands its ACP transport over exactly once, and acknowledges only after UI release", async () => {
		const socket = new FakeSocket();
		const receivedAcp: string[] = [];
		let completeTakeover: (() => void) | undefined;
		const released = new Promise<void>(resolve => {
			completeTakeover = resolve;
		});
		let handoffs = 0;
		let acp: { send(raw: string): void } | undefined;

		const leg = new LiveTuiControlLeg({
			url: "ws://127.0.0.1:7777/v1/socket?token=local",
			session: { id: "live-session", cwd: "/repo", title: "Live TUI", pid: 42 },
			createSocket: () => socket,
			onTakeover: async transport => {
				handoffs += 1;
				acp = transport;
				transport.onMessage(raw => receivedAcp.push(raw));
				await released;
			},
		});

		leg.start();
		socket.open();
		expect(socket.sent.map(raw => JSON.parse(raw))).toEqual([
			{ t: "tui_register", sessionId: "live-session", cwd: "/repo", title: "Live TUI", pid: 42 },
		]);

		socket.receive({ t: "tui_takeover", sessionId: "live-session" });
		expect(handoffs).toBe(1);
		expect(socket.sent).toHaveLength(1);

		completeTakeover?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(socket.sent.map(raw => JSON.parse(raw))).toContainEqual({ t: "tui_acp_ready", sessionId: "live-session" });

		acp?.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		socket.receive({ t: "tui_acp", sessionId: "live-session", raw: "{\"jsonrpc\":\"2.0\",\"id\":1}" });
		expect(socket.sent.map(raw => JSON.parse(raw))).toContainEqual({
			t: "tui_acp",
			sessionId: "live-session",
			raw: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
		});
		expect(receivedAcp).toEqual(['{"jsonrpc":"2.0","id":1}']);

		socket.receive({ t: "tui_takeover", sessionId: "live-session" });
		expect(handoffs).toBe(1);
	});
});
