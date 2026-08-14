/**
 * Live check for pending-approval replay on attach.
 *
 * Drives a real agent into a blocked state with NO client connected, then
 * connects one for the first time and asserts the approval arrives anyway.
 * That is the case the daemon could not serve before: an approval was only ever
 * pushed at the instant it was raised, so a client that connected later saw an
 * agent sitting still with nothing to act on.
 *
 * Usage: bun run scripts/check-approval-replay.ts <baseUrl> <agentId>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:7788";
const agentId = process.argv[3];
if (agentId === undefined) throw new Error("usage: check-approval-replay.ts <baseUrl> <agentId>");

const home = process.env.OMPD_HOME ?? join(homedir(), ".ompd-gw");
const token = readFileSync(join(home, "token"), "utf8").trim();

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  return await fetch(`${base}${path}`, { ...init, headers });
};

// Deliberately not awaited. The turn blocks on the permission gate and stays
// blocked until something answers it, which is the state under test.
console.log("1. prompting the agent to run a bash command, with no client connected");
const turn = api(`/v1/agents/${agentId}/prompt`, {
  method: "POST",
  body: JSON.stringify({ text: "Run exactly this with your bash tool: echo hello-from-ompd" }),
});

interface PendingApprovalRow {
  requestId: string;
  agentId: string;
  tool: string;
  title: string;
}

const deadline = Date.now() + 120_000;
let pending: PendingApprovalRow | undefined;
while (Date.now() < deadline) {
  const res = await api("/v1/approvals");
  const body = (await res.json()) as { pending?: PendingApprovalRow[] };
  pending = body.pending?.find((row) => row.agentId === agentId);
  if (pending) break;
  await Bun.sleep(250);
}
if (!pending) throw new Error("the agent never blocked on an approval");
console.log(`2. agent is blocked: tool=${pending.tool} title=${JSON.stringify(pending.title)}`);

console.log("3. only now connecting a client, attaching with sinceSeq 0");
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/v1/socket?token=${encodeURIComponent(token)}`);
const gotApproval = Promise.withResolvers<Record<string, unknown>>();
const timer = setTimeout(() => gotApproval.reject(new Error("no approval frame after attach")), 15_000);

let updates = 0;
ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "attach", agentId, sinceSeq: 0 })));
ws.addEventListener("message", (event) => {
  const frame: unknown = JSON.parse(String(event.data));
  if (frame === null || typeof frame !== "object" || !("t" in frame)) return;
  if (frame.t === "update") updates += 1;
  if (frame.t === "approval") {
    clearTimeout(timer);
    gotApproval.resolve({ ...frame });
  }
});

const approval = await gotApproval.promise;
console.log(`4. replayed ${updates} transcript update(s), then the approval frame:`);
console.log(`   ${JSON.stringify(approval)}`);

const requestId = approval.requestId;
if (typeof requestId !== "string") throw new Error("approval frame carried no requestId");
if (requestId !== pending.requestId) throw new Error("replayed a different approval than the pending one");

// A replayed approval is worth nothing if the request it names is already dead.
console.log("5. answering the replayed approval to prove the request is still live");
ws.send(JSON.stringify({ t: "decide", agentId, requestId, choice: "allow", scope: "once" }));

const settled = await turn;
const body = (await settled.json()) as { stopReason?: string };
console.log(`6. the turn settled: stopReason=${body.stopReason}`);
ws.close();

if (body.stopReason !== "end_turn") throw new Error(`unexpected stop reason ${body.stopReason}`);
console.log("\nPASS: a client that connected after the block saw the approval and could answer it.");
