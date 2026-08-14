/**
 * Gives a task a first-class identity.
 *
 * A task is a named prompt against a session that already exists, tracked
 * through its own lifecycle row so a sidebar can render it as a card. It is
 * deliberately thin: every privileged act it performs -- sending the prompt,
 * cancelling it -- goes through `Supervisor`, which re-authorizes from the
 * actor's device row and is where the policy engine is reached. This module
 * adds naming and a pollable lifecycle; it adds no second path to an agent,
 * and in particular no shortcut that runs a skill outside the ordinary
 * prompt path. See `Task` in `@ompd/core` for why this is a table of its own
 * rather than fields bolted onto `Agent`.
 */

import type { Actor, AgentId, Store, Task, TaskState } from "@ompd/core";
import { TERMINAL_AGENT_STATES } from "@ompd/core";

/** The stop reason ACP hosts report when a cancel notification actually stopped the turn. */
const CANCELLED_STOP_REASON = "cancelled";

export interface TaskPrompter {
  prompt(agentId: AgentId, text: string, actor: Actor): Promise<{ stopReason: string }>;
  cancel(agentId: AgentId, actor: Actor): Promise<void>;
}

export interface CreateTaskInput {
  title: string;
  prompt: string;
  agentId: AgentId;
  /**
   * Display metadata only. See `Task.skillName` in `@ompd/core`: the daemon
   * never branches on this field, and invoking a skill is exactly the same
   * call as any other task.
   */
  skillName?: string;
  labels?: Record<string, string>;
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`task ${id} not found`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskManager {
  #store: Store;
  #sup: TaskPrompter;

  constructor(opts: { store: Store; supervisor: TaskPrompter }) {
    this.#store = opts.store;
    this.#sup = opts.supervisor;
  }

  get(id: string): Task | null {
    const task = this.#store.getTask(id);
    return task ? this.#withDerivedState(task) : null;
  }

  list(agentId?: string): Task[] {
    return this.#store.listTasks(agentId).map((t) => this.#withDerivedState(t));
  }

  /**
   * `waiting` is never a value the store holds; it is computed here from
   * whether the owning agent is currently blocked on an approval while the
   * task is otherwise still `running`. A task that settled (`done`, `failed`,
   * `canceled`) is never overridden, because a stored terminal outcome is
   * ground truth and an agent later reused for other work must not appear to
   * reopen it.
   */
  #withDerivedState(task: Task): Task {
    if (task.state !== "running") return task;
    const agent = this.#store.getAgent(task.agentId);
    if (agent?.state === "waiting") return { ...task, state: "waiting" };
    return task;
  }

  /**
   * Create the task row and hand its prompt to the owning session.
   *
   * Not awaited to completion: a task started from a sidebar has to appear
   * immediately, while the turn it names is still in flight. Settlement is
   * written to the row when `TaskPrompter.prompt` resolves or rejects, which
   * is the identical call, and therefore the identical policy-gated path, a
   * plain prompt takes -- `Supervisor.prompt` re-authorizes `actor` itself,
   * so this method performs no scope check of its own.
   */
  async create(input: CreateTaskInput, actor: Actor): Promise<Task> {
    const agent = this.#store.getAgent(input.agentId);
    if (!agent) throw new Error(`agent ${input.agentId} does not exist`);
    if (TERMINAL_AGENT_STATES.includes(agent.state)) {
      throw new Error(`agent ${input.agentId} is ${agent.state}`);
    }

    const id: string = `tsk_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title: input.title,
      prompt: input.prompt,
      agentId: input.agentId,
      state: "running",
      createdAt: now,
      updatedAt: now,
      labels: input.labels ?? {},
      ...(input.skillName === undefined ? {} : { skillName: input.skillName }),
    };
    this.#store.createTask(task);

    // Fire-and-forget by design: the caller gets the row now, not when the
    // turn ends. `stopReason === "cancelled"` is how a `cancel()` call below
    // is actually observed settling -- there is exactly one write to this
    // row's terminal state, here, regardless of which of the two outcomes
    // produced it.
    void this.#sup
      .prompt(input.agentId, input.prompt, actor)
      .then((result) => {
        const state: TaskState = result.stopReason === CANCELLED_STOP_REASON ? "canceled" : "done";
        this.#store.updateTaskState(id, state, result.stopReason);
      })
      .catch((err: unknown) => {
        this.#store.updateTaskState(id, "failed", err instanceof Error ? err.message : String(err));
      });

    return task;
  }

  /**
   * Ask the owning session to stop the turn. This does not itself write a
   * terminal state -- see `create`'s settle handler -- because the turn has
   * not actually stopped until the host says so.
   */
  async cancel(id: string, actor: Actor): Promise<Task> {
    const task = this.#store.getTask(id);
    if (!task) throw new TaskNotFoundError(id);
    if (task.state !== "running") return task;
    await this.#sup.cancel(task.agentId, actor);
    return this.#store.getTask(id) ?? task;
  }
}
