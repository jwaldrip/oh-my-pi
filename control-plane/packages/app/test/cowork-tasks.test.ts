/**
 * The task sidebar's reducer and view, driven directly — no socket, no React.
 */

import { describe, expect, test } from "bun:test";
import {
  EMPTY_TASKS,
  reduceTasks,
  taskListView,
  TASK_STATE_LABELS,
  TASK_STATE_SIGNALS,
} from "../src/cowork/tasks.ts";
import type { TaskListAction, TaskListState } from "../src/cowork/tasks.ts";
import type { Task, TaskState } from "../src/cowork/types.ts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    prompt: "do the thing",
    agentId: `agt_${id}`,
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    ...overrides,
  };
}

function drive(actions: readonly TaskListAction[], from: TaskListState = EMPTY_TASKS): TaskListState {
  let state = from;
  for (const action of actions) state = reduceTasks(state, action);
  return state;
}

describe("reduceTasks", () => {
  test("load replaces the whole roster", () => {
    const first = drive([{ t: "load", tasks: [task("a"), task("b")] }]);
    expect(first.tasks.size).toBe(2);
    const second = reduceTasks(first, { t: "load", tasks: [task("c")] });
    expect(second.tasks.size).toBe(1);
    expect(second.tasks.has("a")).toBe(false);
    expect(second.tasks.get("c")?.id).toBe("c");
  });

  test("upsert adds a new task and overwrites an existing one by id", () => {
    const created = drive([{ t: "upsert", task: task("a", { state: "running" }) }]);
    expect(created.tasks.get("a")?.state).toBe("running");

    const advanced = reduceTasks(created, { t: "upsert", task: task("a", { state: "done" }) });
    expect(advanced.tasks.size).toBe(1);
    expect(advanced.tasks.get("a")?.state).toBe("done");
  });

  test("remove drops a task and is a no-op for an id that was never there", () => {
    const state = drive([{ t: "upsert", task: task("a") }]);
    const removed = reduceTasks(state, { t: "remove", id: "a" });
    expect(removed.tasks.has("a")).toBe(false);

    const noop = reduceTasks(removed, { t: "remove", id: "a" });
    expect(noop).toBe(removed); // same reference: no render triggered for nothing
  });
});

describe("taskListView", () => {
  test("splits in-flight from settled tasks", () => {
    const state = drive([
      { t: "load", tasks: [task("running", { state: "running" }), task("done", { state: "done" })] },
    ]);
    const view = taskListView(state);
    expect(view.inFlight.map((t) => t.id)).toEqual(["running"]);
    expect(view.recent.map((t) => t.id)).toEqual(["done"]);
  });

  test("a task waiting on a person ranks ahead of one merely running", () => {
    const state = drive([
      {
        t: "load",
        tasks: [
          task("r", { state: "running", updatedAt: "2026-01-01T00:02:00.000Z" }),
          task("w", { state: "waiting", updatedAt: "2026-01-01T00:01:00.000Z" }),
        ],
      },
    ]);
    const view = taskListView(state);
    expect(view.inFlight.map((t) => t.id)).toEqual(["w", "r"]);
  });

  test("within the same urgency tier, the most recently updated task sorts first", () => {
    const state = drive([
      {
        t: "load",
        tasks: [
          task("older", { state: "running", updatedAt: "2026-01-01T00:01:00.000Z" }),
          task("newer", { state: "running", updatedAt: "2026-01-01T00:05:00.000Z" }),
        ],
      },
    ]);
    expect(taskListView(state).inFlight.map((t) => t.id)).toEqual(["newer", "older"]);
  });

  test("recent tasks are most-recently-updated first regardless of terminal state", () => {
    const state = drive([
      {
        t: "load",
        tasks: [
          task("failed-recent", { state: "failed", updatedAt: "2026-01-01T00:05:00.000Z" }),
          task("done-old", { state: "done", updatedAt: "2026-01-01T00:01:00.000Z" }),
          task("canceled-mid", { state: "canceled", updatedAt: "2026-01-01T00:03:00.000Z" }),
        ],
      },
    ]);
    expect(taskListView(state).recent.map((t) => t.id)).toEqual(["failed-recent", "canceled-mid", "done-old"]);
  });

  test("an empty board views as two empty lists, not undefined", () => {
    const view = taskListView(EMPTY_TASKS);
    expect(view.inFlight).toEqual([]);
    expect(view.recent).toEqual([]);
  });
});

describe("task state vocabulary", () => {
  test("every TaskState literal has a signal and a label — the mapping is total, not best-effort", () => {
    const states: TaskState[] = ["running", "waiting", "done", "failed", "canceled"];
    for (const state of states) {
      expect(TASK_STATE_SIGNALS[state]).toBeDefined();
      expect(TASK_STATE_LABELS[state]).toBeDefined();
    }
  });

  test("working, holding, and settled states carry their established meaning", () => {
    expect(TASK_STATE_SIGNALS.running).toBe("amber");
    expect(TASK_STATE_SIGNALS.waiting).toBe("ochre");
    expect(TASK_STATE_SIGNALS.done).toBe("sage");
    expect(TASK_STATE_SIGNALS.failed).toBe("oxide");
  });
});
