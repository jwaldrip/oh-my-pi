/**
 * Can OMP's internal approval gate (gate 2) be driven from an ACP client, and
 * does its payload identify the file being written?
 *
 * `docs/acp-approval-gate.md` established that gate 1, the ACP permission
 * wrapper, never fires for `write` or `ast_edit` and fires for `edit` only on a
 * delete or a rename. Gate 2 wraps every tool, but in a headless host it asks
 * through a UI context that answers nothing unless the client advertises
 * `elicitation.form`. This probe advertises it and measures three things:
 *
 *   1. does `elicitation/create` actually arrive for a write,
 *   2. does its `message` name the target path, which is what a policy engine
 *      needs to decide anything at all,
 *   3. does the answer change the outcome, allow AND deny.
 *
 * Usage:
 *   bun run scripts/probe-elicitation-gate.ts <allow|deny> [tool]
 *
 * `tool` is one of write, edit, ast_edit, bash. Default write.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Frame {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

const answer = process.argv[2] === "allow" ? "Approve" : "Deny";
const which = process.argv[3] ?? "write";
/**
 * `legacy` reproduces what ompd shipped before this change: the old overlay,
 * and no elicitation capability. It exists so the two configurations can be
 * compared under one harness rather than by memory.
 */
const legacy = process.argv[4] === "legacy";

const workdir = mkdtempSync(join(tmpdir(), "ompd-elicit-"));
const marker = join(workdir, "elicit.txt");
const seeded = join(workdir, "seed.txt");

// `edit` needs something to edit, and a content-only edit is the case that
// slips past gate 1 today.
writeFileSync(seeded, "alpha\n");

/**
 * Every filesystem tool set to `prompt` rather than `allow`. `prompt` is what
 * arms gate 2; `allow` is what the old overlay used and is precisely why
 * writes ran unobserved. `bash`, `delete` and `move` stay `allow` so gate 1
 * keeps owning them, because for those three it always produces a descriptor
 * carrying the real paths.
 */
const configYaml = legacy
  ? `tools:
  approvalMode: always-ask
  approval:
    bash: allow
    edit: allow
    write: allow
    multi_edit: allow
`
  : `tools:
  approvalMode: always-ask
  approval:
    bash: allow
    delete: allow
    move: allow
    edit: prompt
    write: prompt
    ast_edit: prompt
`;
const configPath = join(workdir, "gate.yml");
writeFileSync(configPath, configYaml);

const prompts: Record<string, string> = {
  write: `Use your write tool to create the file ${marker} containing exactly: gated\nThat is the entire task. Do not use bash.`,
  edit: `Use your edit tool to change the word alpha to beta in the file ${seeded}. Do not create, delete, move or rename any file. Do not use bash.`,
  ast_edit: `Use your ast_edit tool with pattern alpha and replacement beta over the path ${seeded}. That is the entire task. Do not use write, edit or bash.`,
  eval: `Use your eval tool to run this javascript and nothing else: await Bun.write(${JSON.stringify(marker)}, "gated")\nThat is the entire task. Do not use write or bash.`,
  bash: `Use your bash tool to run exactly: touch ${marker}\nThat is the entire task.`,
};

const proc = Bun.spawn(["omp", "acp", "--config", configPath], {
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
  const timer = setTimeout(() => {
    waiters.delete(id);
    resolve(null);
  }, ms);
  waiters.set(id, (f) => {
    clearTimeout(timer);
    waiters.delete(id);
    resolve(f);
  });
  return promise;
};

const permissions: string[] = [];
const elicitations: Array<{ message: string; enumValues: unknown }> = [];
const failures: string[] = [];

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
      let f: Frame;
      try {
        f = JSON.parse(line) as Frame;
      } catch {
        continue;
      }

      if (f.id !== undefined && f.method === undefined) {
        waiters.get(f.id)?.(f);
        continue;
      }

      if (f.method === "session/request_permission" && f.id !== undefined) {
        const p = f.params as { toolCall?: { title?: string; toolCallId?: string } };
        permissions.push(p.toolCall?.title ?? "(untitled)");
        send({
          jsonrpc: "2.0",
          id: f.id,
          result: {
            outcome: { outcome: "selected", optionId: answer === "Approve" ? "allow_once" : "reject_once" },
          },
        });
        continue;
      }

      if (f.method === "elicitation/create" && f.id !== undefined) {
        const p = f.params as {
          message?: string;
          requestedSchema?: { properties?: { value?: { enum?: unknown } } };
        };
        elicitations.push({
          message: p.message ?? "",
          enumValues: p.requestedSchema?.properties?.value?.enum ?? null,
        });
        send({
          jsonrpc: "2.0",
          id: f.id,
          result: { action: "accept", content: { value: answer } },
        });
        continue;
      }

      if (f.method === "session/update") {
        const u = f.params as { update?: { sessionUpdate?: string; content?: unknown; status?: string } };
        const up = u.update;
        if (up?.sessionUpdate === "tool_call_update" && up.status === "failed") {
          failures.push(JSON.stringify(up).slice(0, 400));
        }
        continue;
      }

      // Anything else the agent asks of us is declined rather than left hanging.
      if (f.id !== undefined && f.method) {
        send({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: `unsupported: ${f.method}` } });
      }
    }
  }
})();

let stderrText = "";
void (async () => {
  const dec = new TextDecoder();
  const reader = proc.stderr.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stderrText = (stderrText + dec.decode(value, { stream: true })).slice(-8192);
  }
})();

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      // The whole point of the probe. Without this, `select` short-circuits to
      // undefined and gate 2 denies without telling anyone.
      ...(legacy ? {} : { elicitation: { form: {} } }),
    },
  },
});
const init = await expect(1, 30_000);
if (!init) {
  console.log("FAIL: no initialize response");
  proc.kill();
  process.exit(1);
}

send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workdir, mcpServers: [] } });
const sess = await expect(2, 30_000);
const sessionId =
  sess?.result && typeof sess.result === "object"
    ? ((sess.result as Record<string, unknown>).sessionId as string)
    : "";

console.log(
  `mode=${legacy ? "legacy (old overlay, no elicitation)" : "gate2 (write/edit/ast_edit prompt, elicitation advertised)"}`,
);
console.log(`tool=${which} answer=${answer} session=${sessionId ? "ok" : "MISSING"}`);

send({
  jsonrpc: "2.0",
  id: 3,
  method: "session/prompt",
  params: { sessionId, prompt: [{ type: "text", text: prompts[which] ?? prompts.write }] },
});
const turn = await expect(3, 180_000);

const seededNow = existsSync(seeded) ? await Bun.file(seeded).text() : "(gone)";
console.log(`  stopReason=${JSON.stringify((turn?.result as Record<string, unknown>)?.stopReason ?? turn?.error?.message ?? null)}`);
console.log(`  session/request_permission: ${permissions.length}${permissions.length ? ` -> ${permissions.join(" | ")}` : ""}`);
console.log(`  elicitation/create:         ${elicitations.length}`);
for (const [i, e] of elicitations.entries()) {
  console.log(`    [${i}] enum=${JSON.stringify(e.enumValues)}`);
  console.log(`    [${i}] message:`);
  for (const line of e.message.split("\n").slice(0, 12)) console.log(`         | ${line}`);
}
if (failures.length) console.log(`  failed tool calls: ${failures.join(" ; ")}`);
console.log(`  marker exists: ${existsSync(marker)}`);
console.log(`  seed contents: ${JSON.stringify(seededNow)}`);
if (stderrText.trim()) console.log(`  stderr tail: ${stderrText.trim().split("\n").slice(-4).join(" / ")}`);

proc.kill();
rmSync(workdir, { recursive: true, force: true });
