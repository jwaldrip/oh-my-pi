import { beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BoundedMemoryTerminal, BoundedRenderScheduler } from "./helpers/bounded-memory-terminal";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

interface ReplayHarness {
	readonly tempDir: TempDir;
	readonly sessionFile: string;
	readonly manager: SessionManager;
	readonly authStorage: AuthStorage;
	readonly session: AgentSession;
	readonly mode: InteractiveMode;
	readonly terminal: BoundedMemoryTerminal;
	readonly scheduler: BoundedRenderScheduler;
}

beforeAll(async () => {
	await initTheme();
});

function toolCall(index: number) {
	return {
		role: "assistant" as const,
		content: [
			{
				type: "toolCall" as const,
				id: `call-${index}`,
				name: "write",
				arguments: { path: `file-${index}.txt`, content: "" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: index * 2,
	};
}

function toolResult(index: number) {
	return {
		role: "toolResult" as const,
		toolCallId: `call-${index}`,
		toolName: "write",
		content: [{ type: "text" as const, text: `result ${index}` }],
		details: { payload: `details ${index}` },
		isError: false,
		timestamp: index * 2 + 1,
	};
}

async function drainRender(harness: Pick<ReplayHarness, "scheduler" | "terminal">): Promise<void> {
	for (let pass = 0; pass < 4; pass++) {
		harness.scheduler.drain();
		await harness.terminal.flush();
	}
}

async function createHarness(pairCount: number): Promise<ReplayHarness> {
	const tempDir = TempDir.createSync("@session-retention-memory-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const sessionFile = tempDir.join("session.jsonl");
	const writer = await SessionManager.open(sessionFile, tempDir.path(), undefined, {
		initialCwd: tempDir.path(),
		suppressBreadcrumb: true,
	});
	try {
		for (let index = 0; index < pairCount; index++) {
			writer.appendMessage(toolCall(index));
			writer.appendMessage(toolResult(index));
		}
		await writer.flush();
	} finally {
		await writer.close();
	}

	const manager = await SessionManager.open(sessionFile, tempDir.path(), undefined, {
		initialCwd: tempDir.path(),
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	const authStorage = await AuthStorage.create(":memory:");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled model");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated({
			"advisor.enabled": false,
			"async.enabled": false,
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
			"mnemopi.llmMode": "none",
		}),
		modelRegistry: new ModelRegistry(authStorage),
	});
	const scheduler = new BoundedRenderScheduler();
	const terminal = new BoundedMemoryTerminal();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet: true },
	});
	const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, undefined, composer);
	await mode.init({ suppressWelcomeIntro: true });
	const harness = { tempDir, sessionFile, manager, authStorage, session, mode, terminal, scheduler };
	await drainRender(harness);
	return harness;
}

async function disposeHarness(harness: ReplayHarness): Promise<void> {
	harness.mode.stop();
	await harness.session.dispose();
	harness.authStorage.close();
	harness.tempDir.removeSync();
}

async function closeAndRelease(manager: SessionManager): Promise<void> {
	await manager.close();
	manager.releaseRetainedEntries();
}

describe("session retention replay lifecycle", () => {
	it("releases replayed paired tool history while retaining the persisted branch", async () => {
		const harness = await createHarness(8);
		let disposed = false;
		try {
			const expectedMessages = harness.manager.getBranchView().filter(entry => entry.type === "message").length;
			await harness.mode.renderInitialMessages({ clearTerminalHistory: true });
			await drainRender(harness);

			expect(harness.mode.ui.nativeRendering).toBe(true);
			expect(harness.mode.pendingTools.size).toBe(0);
			expect(harness.mode.chatContainer.children.length).toBeGreaterThan(0);
			expect(harness.terminal.metrics().frames).toBeGreaterThan(0);
			expect(harness.terminal.metrics().acknowledgements).toBeGreaterThan(0);

			harness.mode.stop();
			expect(harness.mode.chatContainer.children).toHaveLength(0);
			await harness.session.dispose();
			disposed = true;
			expect(harness.manager.getEntries()).toHaveLength(0);

			const reopened = await SessionManager.open(harness.sessionFile, harness.tempDir.path(), undefined, {
				initialCwd: harness.tempDir.path(),
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			try {
				expect(reopened.getBranchView().filter(entry => entry.type === "message")).toHaveLength(expectedMessages);
			} finally {
				await closeAndRelease(reopened);
			}
		} finally {
			if (!disposed) {
				harness.mode.stop();
				await harness.session.dispose();
			}
			harness.authStorage.close();
			harness.tempDir.removeSync();
		}
	});

	it("disposes a stale staged transcript before accepting a yielded replay replacement", async () => {
		const harness = await createHarness(48);
		try {
			await harness.mode.renderInitialMessages({ clearTerminalHistory: true });
			await drainRender(harness);
			const beforeReplacement = harness.manager.getBranchView().length;
			const originalRender = harness.mode.renderSessionContextIncrementally.bind(harness.mode);
			let appended = false;
			harness.mode.renderSessionContextIncrementally = async (context, options, renderChunk) =>
				await originalRender(context, options, () => {
					if (!appended) {
						harness.manager.appendMessage({ role: "user", content: "replacement entry", timestamp: Date.now() });
						appended = true;
					}
					renderChunk?.();
				});

			let disposeCalls = 0;
			const disposeChildren = TranscriptContainer.prototype.disposeChildren;
			TranscriptContainer.prototype.disposeChildren = function (this: TranscriptContainer): void {
				disposeCalls++;
				disposeChildren.call(this);
			};
			try {
				await harness.mode.renderInitialMessages({ clearTerminalHistory: true });
				await drainRender(harness);
			} finally {
				TranscriptContainer.prototype.disposeChildren = disposeChildren;
			}

			expect(appended).toBe(true);
			expect(disposeCalls).toBeGreaterThanOrEqual(2);
			expect(harness.manager.getBranchView()).toHaveLength(beforeReplacement + 1);
			expect(harness.mode.pendingTools.size).toBe(0);
		} finally {
			await disposeHarness(harness);
		}
	});
});
