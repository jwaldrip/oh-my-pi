/**
 * Determine the OMP configuration under which the ACP permission hook is both
 * LIVE and DECISIVE.
 *
 * Two gates exist in omp 17.2.12:
 *   1. the ACP permission wrapper, which calls `session/request_permission`
 *   2. an internal approval gate, which has no UI in a headless ACP host
 *
 * `--approval-mode always-ask` arms gate 2, which then denies everything with
 * "Tool call denied by user" no matter what the ACP client answered. Plain
 * `yolo` disarms gate 2 but also skips gate 1 entirely, which would remove the
 * control plane's only enforcement point. The hypothesis under test is that
 * `yolo` plus a per-tool `approval: prompt` entry keeps gate 1 while disarming
 * gate 2.
 *
 * Usage: bun run scripts/probe-gate-config.ts <deny|allow> [configPath]
 * Prints a verdict line that says whether the marker file exists.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Frame {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const decision = process.argv[2] === "allow" ? "allow_once" : "reject_once";
const configPath = process.argv[3];
const workdir = mkdtempSync(join(tmpdir(), "ompd-gate-"));
const marker = join(workdir, "gate.txt");

const args = ["acp", ...(configPath ? ["--config", configPath] : ["--approval-mode", "always-ask"])];
const proc = Bun.spawn(["omp", ...args], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  cwd: workdir,
});

const enc = new TextEncoder();
const send = (o: unknown): void => {
  proc.stdin.write(enc.encode(JSON.stringify(o) + "\n"));
  void proc.stdin.flush();
};

const waiters = new Map<number | string, (f: Frame) => void>();
const expect = (id: number | string, ms: number): Promise<Frame | null> => {
  const { promise, resolve } = Promise.withResolvers<Frame | null>();
  const t = setTimeout(() => {
    waiters.delete(id);
    resolve(null);
  }, ms);
  waiters.set(id, (f) => {
    clearTimeout(t);
    waiters.delete(id);
    resolve(f);
  });
  return promise;
};

const str = (v: unknown, k: string): string | undefined => {
  if (v && typeof v === "object" && k in v) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === "string") return x;
  }
  return undefined;
};

const asked: string[] = [];
const toolResults: string[] = [];

void (async () => {
  const dec = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const f = JSON.parse(line) as Frame;

      if (f.method === "session/request_permission") {
        const params = f.params as { toolCall?: unknown } | undefined;
        const title = str(params?.toolCall, "title") ?? "?";
        asked.push(title);
        console.log(`  ASK  ${title.slice(0, 70)}  -> ${decision}`);
        send({
          jsonrpc: "2.0",
          id: f.id,
          result: { outcome: { outcome: "selected", optionId: decision } },
        });
        continue;
      }

      if (f.method === "session/update") {
        const params = f.params as { update?: unknown } | undefined;
        if (str(params?.update, "sessionUpdate") === "tool_call_update") {
          const u = params?.update as { status?: string; rawOutput?: unknown } | undefined;
          const out = JSON.stringify(u?.rawOutput ?? {});
          if (u?.status === "failed") toolResults.push(out.slice(0, 160));
        }
        continue;
      }

      if (f.method) {
        console.log(
          `  OTHER REQUEST method=${f.method} id=${String(f.id)} params=${JSON.stringify(f.params).slice(0, 500)}`,
        );
        if (f.id !== undefined) {
          send({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "unsupported" } });
        }
        continue;
      }
      if (f.id !== undefined) waiters.get(f.id)?.(f);
    }
  }
})();

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  },
});
await expect(1, 30_000);

send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workdir, mcpServers: [] } });
const sess = await expect(2, 30_000);
const sessionId = str(sess?.result, "sessionId") ?? "";

console.log(`config=${configPath ?? "always-ask"} decision=${decision}`);
send({
  jsonrpc: "2.0",
  id: 3,
  method: "session/prompt",
  params: {
    sessionId,
    prompt: [
      {
        type: "text",
        text: `Use your bash tool to run exactly: touch ${marker}\nThat is the entire task. Do not use any other tool.`,
      },
    ],
  },
});
await expect(3, 150_000);

const exists = existsSync(marker);
console.log(`  permissionsAsked=${asked.length}`);
if (toolResults.length) console.log(`  failures=${toolResults.join(" | ")}`);
console.log(`VERDICT config=${configPath ? "yolo+prompt" : "always-ask"} decision=${decision} markerExists=${exists}`);

proc.kill();
rmSync(workdir, { recursive: true, force: true });
