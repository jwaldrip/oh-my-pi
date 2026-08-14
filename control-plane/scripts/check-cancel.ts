/**
 * Live check that a `cancel` frame stops a streaming turn.
 *
 * The scripted-peer test proves the gateway reaches ACP `session/cancel`. This
 * proves the other half, which a fake cannot: that the real agent honours it
 * and the turn settles early rather than running to completion.
 *
 * Usage: bun run scripts/check-cancel.ts <baseUrl> <agentId>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:7788";
const agentId = process.argv[3];
if (agentId === undefined) throw new Error("usage: check-cancel.ts <baseUrl> <agentId>");

const home = process.env.OMPD_HOME ?? join(homedir(), ".ompd-gw");
const token = readFileSync(join(home, "token"), "utf8").trim();

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/v1/socket?token=${encodeURIComponent(token)}`);
const open = Promise.withResolvers<void>();
const streaming = Promise.withResolvers<void>();

let chunks = 0;
ws.addEventListener("open", () => open.resolve());
ws.addEventListener("message", (event) => {
  const frame: unknown = JSON.parse(String(event.data));
  if (frame === null || typeof frame !== "object" || !("t" in frame)) return;
  if (frame.t !== "update" || !("update" in frame)) return;
  const update = frame.update;
  if (update === null || typeof update !== "object" || !("sessionUpdate" in update)) return;
  // Wait for real assistant text, not just a plan or a tool call, so the cancel
  // lands while the model is actually mid-stream.
  if (update.sessionUpdate === "agent_message_chunk") {
    chunks += 1;
    if (chunks === 3) streaming.resolve();
  }
});

await open.promise;
ws.send(JSON.stringify({ t: "attach", agentId }));

console.log("1. starting a long turn over the HTTP prompt route");
const startedAt = Date.now();
// The HTTP route is used rather than the socket's prompt frame because it
// answers with the stop reason, which is the only unambiguous way to tell a
// cancelled turn from one that finished on its own.
const turn = fetch(`${base}/v1/agents/${agentId}/prompt`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    text: "Count slowly from 1 to 500, writing out every single number in words, one per line. Do not stop early.",
  }),
});

await streaming.promise;
console.log(`2. turn is streaming (${chunks} chunks in ${Date.now() - startedAt}ms), sending cancel`);
ws.send(JSON.stringify({ t: "cancel", agentId }));

const settled = await turn;
const body = (await settled.json()) as { stopReason?: string };
const elapsed = Date.now() - startedAt;
console.log(`3. the turn settled: stopReason=${body.stopReason} after ${elapsed}ms, ${chunks} chunks`);
ws.close();

// The stop reason is the unambiguous observable. `end_turn` would mean the
// model finished on its own and the cancel changed nothing.
if (body.stopReason === "end_turn") {
  throw new Error("the turn ran to completion; the cancel did nothing");
}
console.log(`\nPASS: the cancel stopped a live streaming turn (stopReason=${body.stopReason}).`);
