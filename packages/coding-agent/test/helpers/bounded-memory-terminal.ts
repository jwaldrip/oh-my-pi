import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import type {
	Terminal,
	TerminalAppearance,
	TerminalAppearanceRequestToken,
	TerminalStartOptions,
	TspHelloHandler,
} from "@oh-my-pi/pi-tui/terminal";
import type { RenderScheduler, RenderTimer } from "@oh-my-pi/pi-tui/tui";
import { TSP_KINDS } from "@oh-my-pi/pi-wire";

interface ScheduledTask {
	readonly callback: () => void;
	readonly due: number;
	cancelled: boolean;
}

/**
 * Deterministic render scheduler whose queue is emptied after every probe phase.
 * It retains callbacks only until the caller drains the current phase.
 */
export class BoundedRenderScheduler implements RenderScheduler {
	#now = 0;
	#immediate: (() => void)[] = [];
	#renders: ScheduledTask[] = [];

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediate.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const task: ScheduledTask = {
			callback,
			due: this.#now + Math.max(0, delayMs),
			cancelled: false,
		};
		this.#renders.push(task);
		return { cancel: () => (task.cancelled = true) };
	}

	/** Run all callbacks ready at the current clock time, without retaining their closures. */
	drain(): void {
		for (let guard = 0; guard < 10_000; guard++) {
			const immediate = this.#immediate;
			this.#immediate = [];
			for (const callback of immediate) callback();

			let nextIndex = -1;
			for (let index = 0; index < this.#renders.length; index++) {
				const task = this.#renders[index]!;
				if (!task.cancelled && task.due <= this.#now) {
					nextIndex = index;
					break;
				}
			}
			if (nextIndex === -1) {
				this.#renders = this.#renders.filter(task => !task.cancelled);
				if (this.#immediate.length === 0) return;
				continue;
			}
			const [task] = this.#renders.splice(nextIndex, 1);
			if (!task?.cancelled) task.callback();
		}
		throw new Error("bounded render scheduler did not settle");
	}
}

export interface BoundedTerminalMetrics {
	readonly writes: number;
	readonly wireBytes: number;
	readonly largestWriteBytes: number;
	readonly frames: number;
	readonly acknowledgements: number;
	readonly pendingOutputBytes: number;
}

export interface BoundedMemoryTerminalOptions {
	/** Enable the Tern Surface Protocol path rather than the ordinary row renderer. */
	readonly native?: boolean;
}

const FRAME_PREFIX_BYTES = 1024;

/**
 * A TSP terminal that acknowledges frames but never records frames, documents,
 * payloads, or terminal output. Its counters are deliberately scalar-only so a
 * memory probe cannot mistake harness capture for product retention.
 */
export class BoundedMemoryTerminal implements Terminal {
	readonly #columns: number;
	readonly #rows: number;
	readonly #native: boolean;
	#onInput: ((data: string) => void) | undefined;
	#helloCallbacks: TspHelloHandler[] = [];
	#hello: TspHello | undefined;
	#probePending = false;
	#stopped = false;
	#writes = 0;
	#wireBytes = 0;
	#largestWriteBytes = 0;
	#frames = 0;
	#acknowledgements = 0;
	#lastAcknowledgedFrame: string | undefined;

	constructor(columns = 120, rows = 40, options: BoundedMemoryTerminalOptions = {}) {
		this.#columns = columns;
		this.#rows = rows;
		this.#native = options.native ?? true;
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	get kittyEnableSequence(): string | null {
		return null;
	}

	get appearance(): TerminalAppearance | undefined {
		return "dark";
	}

	get pendingOutputBytes(): number {
		return 0;
	}

	get tspExpected(): boolean {
		return this.#native;
	}

	get tspProbePending(): boolean {
		return this.#probePending;
	}

	start(onInput: (data: string) => void, _onResize: () => void, _onDisconnect?: () => void, _options?: TerminalStartOptions): void {
		this.#onInput = onInput;
		this.#stopped = false;
		this.#probePending = this.#native;
		if (!this.#native) return;
		queueMicrotask(() => {
			if (this.#stopped || !this.#probePending) return;
			this.#probePending = false;
			this.#hello = {
				r: "hello",
				v: 1,
				term: "bounded-memory-probe",
				kinds: TSP_KINDS,
				features: ["blobs", "settle", "adopt", "dock"],
				apc: 16 * 1024,
				credits: 256,
				cols: this.#columns,
				dark: true,
			};
			for (const callback of this.#helloCallbacks) callback(this.#hello);
		});
	}

	enableInput(): void {}

	stop(): void {
		this.#stopped = true;
		this.#probePending = false;
		this.#onInput = undefined;
		this.#helloCallbacks = [];
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		const bytes = Buffer.byteLength(data, "utf8");
		this.#writes++;
		this.#wireBytes += bytes;
		this.#largestWriteBytes = Math.max(this.#largestWriteBytes, bytes);
		this.#acknowledgeFrame(data);
	}

	onTspHello(callback: TspHelloHandler): void {
		this.#helloCallbacks.push(callback);
		if (this.#hello !== undefined) callback(this.#hello);
	}

	moveBy(_lines: number): void {}
	hideCursor(_force?: boolean): void {}
	showCursor(_force?: boolean): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void): void {}
	refreshAppearance(_requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void {}

	metrics(): BoundedTerminalMetrics {
		return {
			writes: this.#writes,
			wireBytes: this.#wireBytes,
			largestWriteBytes: this.#largestWriteBytes,
			frames: this.#frames,
			acknowledgements: this.#acknowledgements,
			pendingOutputBytes: 0,
		};
	}

	/** Deliver queued TSP acknowledgements without retaining terminal bytes. */
	async flush(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
	}

	#acknowledgeFrame(data: string): void {
		const start = data.indexOf("\x1b_tsp;f;");
		if (start === -1) return;
		const prefix = data.slice(start, Math.min(data.length, start + FRAME_PREFIX_BYTES));
		const match = /"sf":"([^"\\]+)","s":(\d+)/.exec(prefix);
		if (!match) return;
		const surface = match[1]!;
		const sequence = Number(match[2]);
		if (!Number.isSafeInteger(sequence) || sequence <= 0) return;
		const frame = `${surface}:${sequence}`;
		if (frame === this.#lastAcknowledgedFrame) return;
		this.#lastAcknowledgedFrame = frame;
		this.#frames++;
		queueMicrotask(() => {
			if (this.#stopped) return;
			this.#acknowledgements++;
			this.#onInput?.(`\x1b_tsp;e;${JSON.stringify({ ev: "ack", sf: surface, s: sequence })}\x1b\\`);
		});
	}
}
