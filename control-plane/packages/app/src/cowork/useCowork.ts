/**
 * The one impure edge between the client and the Cowork screen.
 *
 * Everything that decides what is on screen lives in `tasks.ts` and
 * `catalog.ts` and is pure. This file owns the fetches and the poll interval,
 * mirroring the split `console/useConsole.ts` already draws between a socket
 * and the reducer it feeds. Lifecycle is REST-polled rather than pushed —
 * CoworkSurface is not adding a task-scoped websocket channel in this pass —
 * so this hook refetches on an interval instead of subscribing to anything.
 *
 * `POST /v1/tasks` requires an existing `agentId`: creating a task never
 * provisions a host (that is a separate manage-scope act, `POST /v1/agents`).
 * `defaultAgentId` is the caller's answer to "which session does a new task
 * with no session of its own target" — this hook does not pick one itself,
 * because picking a session is app-shell integration (which agent is "the
 * current one" is Console's fleet state, not Cowork's). `startTask` rejects
 * up front when it is `null` rather than silently guessing.
 */

import { useCallback, useEffect, useState } from "react";
import type { Connection } from "../platform/connection.ts";
import { EMPTY_TASKS, reduceTasks } from "./tasks.ts";
import type { NewTaskInput, TaskListState } from "./tasks.ts";
import type { ConnectorSummary, SkillSummary, Task } from "./types.ts";

const POLL_INTERVAL_MS = 4000;

/** `ws://host/v1/socket?x=1#y` becomes `http://host` — the root every Cowork route hangs off. Mirrors `client.ts`'s `agentsEndpoint`. */
export function restRoot(socketUrl: string): string | null {
  const match = /^(wss?|https?):\/\/([^/?#]+)/.exec(socketUrl);
  if (match === null) return null;
  const [, scheme, authority] = match;
  if (scheme === undefined || authority === undefined || authority.length === 0) return null;
  const secure = scheme === "wss" || scheme === "https";
  return `${secure ? "https" : "http"}://${authority}`;
}

export interface CoworkState {
  tasks: TaskListState;
  skills: SkillSummary[];
  connectors: ConnectorSummary[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: CoworkState = { tasks: EMPTY_TASKS, skills: [], connectors: [], loading: true, error: null };

export interface CoworkActions {
  startTask: (input: NewTaskInput) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  refresh: () => void;
}

interface SkillsResponse {
  skills: SkillSummary[];
}

interface ConnectorsResponse {
  connectors: ConnectorSummary[];
}

interface TasksResponse {
  tasks: Task[];
}

export function useCowork(connection: Connection, cwd: string, defaultAgentId: string | null): [CoworkState, CoworkActions] {
  const [state, setState] = useState<CoworkState>(EMPTY_STATE);
  // Cowork's routes are plain REST, and a hub is a relay for the socket
  // protocol only: there is no HTTP surface behind it to hang these on, so a
  // hub connection has no root and every fetch below fails closed instead of
  // guessing at one.
  const root = connection.transport === "direct" ? restRoot(connection.url) : null;

  const authFetch = useCallback(
    (path: string, init?: RequestInit): Promise<Response> => {
      if (root === null) return Promise.reject(new Error("connection is not a websocket URL"));
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${connection.token}`);
      return fetch(`${root}${path}`, { ...init, headers });
    },
    [root, connection.token],
  );

  const load = useCallback(async () => {
    try {
      const [skillsRes, connectorsRes, tasksRes] = await Promise.all([
        authFetch(`/v1/skills?cwd=${encodeURIComponent(cwd)}`),
        authFetch(`/v1/connectors?cwd=${encodeURIComponent(cwd)}`),
        authFetch("/v1/tasks"),
      ]);
      if (!skillsRes.ok || !connectorsRes.ok || !tasksRes.ok) {
        throw new Error(`daemon returned ${skillsRes.status}/${connectorsRes.status}/${tasksRes.status}`);
      }
      const [skillsBody, connectorsBody, tasksBody] = (await Promise.all([
        skillsRes.json(),
        connectorsRes.json(),
        tasksRes.json(),
      ])) as [SkillsResponse, ConnectorsResponse, TasksResponse];
      setState({
        tasks: reduceTasks(EMPTY_TASKS, { t: "load", tasks: tasksBody.tasks }),
        skills: skillsBody.skills,
        connectors: connectorsBody.connectors,
        loading: false,
        error: null,
      });
    } catch (cause) {
      setState((previous) => ({ ...previous, loading: false, error: describe(cause) }));
    }
  }, [authFetch, cwd]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const startTask = useCallback(
    async (input: NewTaskInput) => {
      if (defaultAgentId === null) {
        throw new Error("no session to target — pick or create an agent before starting a task");
      }
      const response = await authFetch("/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, agentId: defaultAgentId }),
      });
      if (!response.ok) throw new Error(`failed to start task: ${response.status}`);
      const created = (await response.json()) as Task;
      setState((previous) => ({ ...previous, tasks: reduceTasks(previous.tasks, { t: "upsert", task: created }) }));
    },
    [authFetch, defaultAgentId],
  );

  const cancelTask = useCallback(
    async (id: string) => {
      const response = await authFetch(`/v1/tasks/${id}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error(`failed to cancel task: ${response.status}`);
      await load();
    },
    [authFetch, load],
  );

  return [state, { startTask, cancelTask, refresh: () => void load() }];
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
