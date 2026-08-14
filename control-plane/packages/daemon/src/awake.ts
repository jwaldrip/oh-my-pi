/**
 * Keep the Mac awake while an agent is actually working.
 *
 * The point of running this daemon at all is that you start something from
 * your phone and it is still running when you look again. A Mac that goes to
 * idle sleep mid-turn kills the host process and the turn with it, so the
 * daemon has to say "not now" for exactly as long as there is work in flight.
 *
 * Scoped, not blanket. An always-on assertion is rude to a battery and would
 * be a lie about what the daemon needs: an idle daemon needs nothing. So the
 * assertion follows agent state and is released the moment the last one
 * settles.
 *
 * Idle sleep only, never display sleep. Preventing the screen from sleeping
 * would be a visible, annoying side effect of work happening in the
 * background, and it buys nothing.
 *
 * This cannot wake a Mac that is already asleep. Nothing running on the
 * machine can. It keeps a waking Mac awake, and that is the whole claim.
 */

import type { Agent, AgentState } from "@ompd/core";

/**
 * States in which an agent is doing something, or is about to.
 *
 * `waiting` counts, and that is deliberate: an agent blocked on an approval is
 * the case where someone is away from the machine, deciding on a phone. Going
 * to sleep underneath that decision is the exact failure this prevents.
 */
export const WORKING_AGENT_STATES: readonly AgentState[] = [
  "provisioning",
  "starting",
  "busy",
  "waiting",
];

/** The part of a spawned process this needs. Narrow so a test can fake it. */
export interface AwakeProcess {
  kill: () => void;
  readonly exited: Promise<unknown>;
}

export interface SleepGuardOptions {
  /** `keepAwake` from the config. False makes every call a no-op. */
  enabled?: boolean;
  /**
   * The pid the assertion is tied to. `caffeinate -w` exits when that process
   * does, so a daemon killed with SIGKILL cannot leave an assertion held.
   */
  pid?: number;
  /** Injected so a test never spawns a real `caffeinate`. */
  spawn?: (command: string[]) => AwakeProcess;
  onLog?: (line: string) => void;
}

export class SleepGuard {
  #enabled: boolean;
  #command: string[];
  #spawn: (command: string[]) => AwakeProcess;
  #onLog: (line: string) => void;
  #process: AwakeProcess | null = null;

  constructor(opts: SleepGuardOptions = {}) {
    this.#enabled = opts.enabled ?? true;
    this.#onLog = opts.onLog ?? (() => {});

    // `-i` prevents idle system sleep and nothing else. `-w <pid>` is the
    // safety catch: caffeinate waits on the daemon and exits with it, so the
    // assertion cannot survive a crash, a kill -9, or a launchd restart.
    this.#command = ["caffeinate", "-i", "-w", String(opts.pid ?? process.pid)];

    this.#spawn =
      opts.spawn ??
      ((command) =>
        Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
  }

  /** True while an assertion is held. */
  get held(): boolean {
    return this.#process !== null;
  }

  /** The exact command held, so a test and `pmset -g assertions` can agree. */
  get command(): readonly string[] {
    return this.#command;
  }

  /**
   * Take or drop the assertion to match the agent list.
   *
   * Driven off the supervisor's `onAgentsChanged`, which fires on every state
   * transition, so this is the whole control loop: no timers, no polling, and
   * no second source of truth about what is running.
   */
  update(agents: readonly Agent[]): void {
    const working = agents.some((agent) => WORKING_AGENT_STATES.includes(agent.state));
    if (working) this.#acquire();
    else this.release();
  }

  release(): void {
    const held = this.#process;
    if (held === null) return;

    // Cleared before the kill, so a listener reacting to the exit cannot see a
    // guard that still claims to hold something.
    this.#process = null;
    held.kill();
    this.#onLog("released the idle-sleep assertion: no agent is working");
  }

  #acquire(): void {
    if (!this.#enabled || this.#process !== null) return;

    let started: AwakeProcess;
    try {
      started = this.#spawn(this.#command);
    } catch (err) {
      // No caffeinate, which is every non-macOS host. Said once and then never
      // again, because the alternative is a line per state transition.
      this.#enabled = false;
      this.#onLog(
        `cannot hold an idle-sleep assertion (${err instanceof Error ? err.message : err}); ` +
          "work will not keep this machine awake",
      );
      return;
    }

    this.#process = started;
    // If caffeinate dies on its own, the guard has to notice. Believing it
    // holds an assertion it does not is worse than never having taken one:
    // nothing would ever try again.
    void started.exited.then(() => {
      if (this.#process === started) this.#process = null;
    });

    this.#onLog("holding an idle-sleep assertion while an agent is working");
  }
}
