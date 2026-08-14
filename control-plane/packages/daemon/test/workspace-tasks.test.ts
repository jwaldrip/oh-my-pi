/**
 * `TaskManager` against a real `Store`.
 *
 * `TaskPrompter` is faked -- this is not the place that proves a task's
 * prompt reaches the policy engine, `workspace-tasks-policy.test.ts` is --
 * but the store itself is real SQLite on disk, because "survives a reopen"
 * is a claim about a file, and a fake store cannot falsify it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Store, type Actor, type Agent } from "@ompd/core";
import { TaskManager, TaskNotFoundError, type TaskPrompter } from "../src/workspace/tasks.ts";

const paths: string[] = [];
const stores: Store[] = [];

function freshStore(): Store {
  const path = `/tmp/ompd-tasks-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

function seedAgent(store: Store, overrides: Partial<Agent> = {}): Agent {
  const agent: Agent = {
    id: "agt_test0000000001",
    name: "test-agent",
    state: "idle",
    host: { kind: "local", id: "1234", spec: { kind: "local" } },
    cwd: "/tmp/work",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    labels: {},
    ...overrides,
  };
  store.upsertAgent(agent);
  return agent;
}

const actor: Actor = { deviceId: "daemon", scopes: ["prompt"] };

/**
 * Resolves once a prompt is issued and lets the test decide how it settles.
 *
 * `prompt` returns the exact same promise `settle` resolves or rejects,
 * rather than wrapping it, so `TaskManager.create`'s `.then()/.catch()` is
 * registered on that promise synchronously, before the test ever calls
 * `settle`. `settle` then awaits that same promise itself: since its handler
 * was registered first, it is queued as a microtask ahead of ours, which is
 * what makes awaiting `settle`'s return value -- not a guessed duration --
 * the correct way to know the store write already happened.
 */
function deferredPrompter(): {
  prompter: TaskPrompter;
  cancels: Array<{ agentId: string }>;
  called: Promise<{ agentId: string; text: string; actor: Actor }>;
  settle: (result: { stopReason: string } | Error) => Promise<void>;
} {
  const calledSignal = Promise.withResolvers<{ agentId: string; text: string; actor: Actor }>();
  const promptSignal = Promise.withResolvers<{ stopReason: string }>();
  const cancels: Array<{ agentId: string }> = [];
  const prompter: TaskPrompter = {
    prompt: (agentId, text, callerActor) => {
      calledSignal.resolve({ agentId, text, actor: callerActor });
      return promptSignal.promise;
    },
    cancel: async (agentId) => {
      cancels.push({ agentId });
    },
  };
  const settle = async (result: { stopReason: string } | Error): Promise<void> => {
    if (result instanceof Error) promptSignal.reject(result);
    else promptSignal.resolve(result);
    await promptSignal.promise.then(
      () => {},
      () => {},
    );
  };
  return { prompter, cancels, settle, called: calledSignal.promise };
}

describe("TaskManager.create", () => {
  test("appears immediately at 'running', before the prompt settles", async () => {
    const store = freshStore();
    const agent = seedAgent(store);
    const { prompter, called } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });

    const task = await manager.create({ title: "Do a thing", prompt: "please do it", agentId: agent.id }, actor);
    expect(task.state).toBe("running");
    expect(task.title).toBe("Do a thing");

    const forwarded = await called;
    expect(forwarded.agentId).toBe(agent.id);
    expect(forwarded.text).toBe("please do it");
  });

  test("settles to 'done' with the stop reason once the prompt resolves", async () => {
    const store = freshStore();
    const agent = seedAgent(store);
    const { prompter, settle } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });

    const task = await manager.create({ title: "t", prompt: "p", agentId: agent.id }, actor);
    await settle({ stopReason: "end_turn" });
    const reread = manager.get(task.id);
    expect(reread?.state).toBe("done");
    expect(reread?.result).toBe("end_turn");
  });

  test("settles to 'failed' with the error message when the prompt rejects", async () => {
    const store = freshStore();
    const agent = seedAgent(store);
    const { prompter, settle } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });

    const task = await manager.create({ title: "t", prompt: "p", agentId: agent.id }, actor);
    await settle(new Error("host crashed"));
    const reread = manager.get(task.id);
    expect(reread?.state).toBe("failed");
    expect(reread?.result).toBe("host crashed");
  });

  test("a stopReason of 'cancelled' settles to 'canceled', the same single write path as any other outcome", async () => {
    const store = freshStore();
    const agent = seedAgent(store);
    const { prompter, settle } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });

    const task = await manager.create({ title: "t", prompt: "p", agentId: agent.id }, actor);
    await settle({ stopReason: "cancelled" });
    expect(manager.get(task.id)?.state).toBe("canceled");
  });

  test("refuses an agent id that does not exist", async () => {
    const store = freshStore();
    const { prompter } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });
    await expect(
      manager.create({ title: "t", prompt: "p", agentId: "agt_does_not_exist" }, actor),
    ).rejects.toThrow();
  });

  test("'waiting' is derived from the owning agent's live state, not stored", async () => {
    const store = freshStore();
    const agent = seedAgent(store);
    const { prompter } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });

    const task = await manager.create({ title: "t", prompt: "p", agentId: agent.id }, actor);
    expect(manager.get(task.id)?.state).toBe("running");

    store.setAgentState(agent.id, "waiting");
    expect(manager.get(task.id)?.state).toBe("waiting");

    // The raw row itself was never rewritten to "waiting" -- it is still
    // "running" underneath the overlay.
    expect(store.getTask(task.id)?.state).toBe("running");
  });
});

describe("TaskManager.cancel", () => {
  test("asks the owning session to stop, without itself writing a terminal state", async () => {
    const store = freshStore();
    const agent = seedAgent(store);
    const { prompter, cancels } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });

    const task = await manager.create({ title: "t", prompt: "p", agentId: agent.id }, actor);
    const afterCancel = await manager.cancel(task.id, actor);

    expect(cancels).toEqual([{ agentId: agent.id }]);
    // Still running: the turn has not actually stopped until the prompt
    // promise itself settles, which this test never triggers.
    expect(afterCancel.state).toBe("running");
  });

  test("an unknown task id throws TaskNotFoundError", async () => {
    const store = freshStore();
    const { prompter } = deferredPrompter();
    const manager = new TaskManager({ store, supervisor: prompter });
    await expect(manager.cancel("tsk_nope", actor)).rejects.toThrow(TaskNotFoundError);
  });
});

describe("task persistence", () => {
  test("a task survives a store reopen", async () => {
    const path = `/tmp/ompd-tasks-reopen-${crypto.randomUUID()}.db`;
    paths.push(path);
    let store = new Store(path);
    const agent = seedAgent(store);
    const { prompter, settle } = deferredPrompter();
    let manager = new TaskManager({ store, supervisor: prompter });

    const created = await manager.create(
      { title: "Reopen me", prompt: "please survive", agentId: agent.id, skillName: "some-skill" },
      actor,
    );
    await settle({ stopReason: "end_turn" });
    const beforeClose = manager.get(created.id);
    expect(beforeClose?.state).toBe("done");

    store.close();
    // A fresh Store instance against the same file, not the same object: this
    // is the only thing that actually proves persistence rather than an
    // in-memory cache.
    store = new Store(path);
    stores.push(store);
    manager = new TaskManager({ store, supervisor: prompter });

    const reopened = manager.get(created.id);
    expect(reopened).toEqual(beforeClose);
    expect(reopened?.title).toBe("Reopen me");
    expect(reopened?.prompt).toBe("please survive");
    expect(reopened?.skillName).toBe("some-skill");
    expect(reopened?.result).toBe("end_turn");

    const listed = manager.list(agent.id);
    expect(listed.map((t) => t.id)).toContain(created.id);
  });
});
