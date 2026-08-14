/**
 * The task sidebar's data model.
 *
 * A task is a named unit of work, not the session it runs in — that is
 * `agentId`, a reference the sidebar never resolves itself. Mirrors the split
 * `console/state.ts` already draws between wire events and the pure state
 * they fold into: this reducer never touches a socket or a fetch, so a canned
 * frame stream produces byte-identical state to a live daemon.
 *
 * Lifecycle is REST-polled today (`GET /v1/tasks`), not pushed — CoworkSurface
 * is not adding a task-scoped websocket channel in this pass — so `load` is
 * the steady-state action and `upsert`/`remove` exist for optimistic local
 * echoes of an action this device just took.
 */

import type { Task, TaskState } from "./types.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TaskListState {
  tasks: Map<string, Task>;
}

export const EMPTY_TASKS: TaskListState = { tasks: new Map() };

/** What starting a task from the composer or the `/` menu collects — `agentId` is added by whoever has one (`useCowork`), not by the sidebar itself. */
export interface NewTaskInput {
  title: string;
  prompt: string;
  skillName?: string;
}

export type TaskListAction =
  /** The steady-state action: a fresh `GET /v1/tasks` roster replaces what's held. */
  | { t: "load"; tasks: readonly Task[] }
  /** One task, created or advanced — an optimistic echo, or a single-task refetch. */
  | { t: "upsert"; task: Task }
  | { t: "remove"; id: string };

export function reduceTasks(state: TaskListState, action: TaskListAction): TaskListState {
  switch (action.t) {
    case "load": {
      const tasks = new Map<string, Task>();
      for (const task of action.tasks) tasks.set(task.id, task);
      return { tasks };
    }
    case "upsert": {
      const tasks = new Map(state.tasks);
      tasks.set(action.task.id, action.task);
      return { tasks };
    }
    case "remove": {
      if (!state.tasks.has(action.id)) return state;
      const tasks = new Map(state.tasks);
      tasks.delete(action.id);
      return { tasks };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** Whether a task still needs attention rather than being settled history. `TERMINAL_TASK_STATES`'s inverse — there is no "queued": `POST /v1/tasks` calls `Supervisor.prompt` synchronously and a task starts life at `running`, per CoworkSurface. */
const IN_FLIGHT: Record<TaskState, boolean> = {
  running: true,
  waiting: true,
  done: false,
  failed: false,
  canceled: false,
};

/**
 * Rank within the in-flight list, lowest first. `waiting` outranks `running`:
 * a task blocked on a person is more actionable than one that is merely
 * moving, the same reasoning `AgentStrip`'s clearance emphasis already uses.
 */
const IN_FLIGHT_RANK: Record<TaskState, number> = {
  waiting: 0,
  running: 1,
  done: 2,
  failed: 2,
  canceled: 2,
};

export interface TaskListView {
  /** running or waiting — most actionable first, then most recently updated. */
  inFlight: Task[];
  /** done, failed, or canceled — most recently updated first. */
  recent: Task[];
}

/** What the sidebar renders. Computed from state, never stored. */
export function taskListView(state: TaskListState): TaskListView {
  const inFlight: Task[] = [];
  const recent: Task[] = [];
  for (const task of state.tasks.values()) {
    (IN_FLIGHT[task.state] ? inFlight : recent).push(task);
  }
  inFlight.sort((a, b) => IN_FLIGHT_RANK[a.state] - IN_FLIGHT_RANK[b.state] || b.updatedAt.localeCompare(a.updatedAt));
  recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { inFlight, recent };
}

// ---------------------------------------------------------------------------
// State signal mapping
// ---------------------------------------------------------------------------

/** Decoupled from `design/tokens.ts` on purpose: this is a data-layer file and names its own signal vocabulary, resolved to a colour only where it renders. */
export type SignalName = "amber" | "sage" | "ochre" | "oxide" | "slate" | "violet";

export const TASK_STATE_SIGNALS: Record<TaskState, SignalName> = {
  running: "amber",
  waiting: "ochre",
  done: "sage",
  failed: "oxide",
  canceled: "slate",
};

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};
