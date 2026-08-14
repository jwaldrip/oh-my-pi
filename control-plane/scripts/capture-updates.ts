/**
 * Capture every distinct `session/update` shape a real omp acp turn emits.
 *
 * The web client's transcript must render what OMP actually sends, not what we
 * imagine it sends. This drives one turn that thinks, calls a read tool, calls
 * bash, and answers, then reports every update kind with a representative
 * payload and the full ordered stream.
 *
 * Output: scripts/update-shapes.json
 */
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocalHost } from "@ompd/acp";

const workdir = mkdtempSync(join(tmpdir(), "ompd-capture-"));
writeFileSync(join(workdir, "notes.md"), "# Notes\n\nalpha\nbravo\ncharlie\n");

const stream: Array<{ at: number; kind: string; update: unknown }> = [];
const t0 = Date.now();

const host = spawnLocalHost({
  cwd: workdir,
  onPermission: async (req) => {
    console.log(`  [permission] ${req.toolCall.kind} :: ${req.toolCall.title.slice(0, 60)}`);
    return "allow_once";
  },
  onUpdate: (_sessionId, update) => {
    const kind =
      update && typeof update === "object" && "sessionUpdate" in update
        ? String((update as Record<string, unknown>).sessionUpdate)
        : "unknown";
    stream.push({ at: Date.now() - t0, kind, update });
  },
  onLog: (l) => {
    if (l.trim()) console.log(`  [stderr] ${l.slice(0, 160)}`);
  },
});

await host.client.initialize();
const sessionId = await host.client.newSession(workdir);
console.log(`session ${sessionId} in ${workdir}`);

const result = await host.client.prompt(
  sessionId,
  [
    "Do these three things in order, briefly:",
    "1. Read notes.md with your read tool.",
    "2. Run exactly this with your bash tool: echo hello-from-ompd",
    "3. Tell me in one sentence what the file contained.",
  ].join("\n"),
);
console.log(`stopReason=${result.stopReason}`);

const byKind = new Map<string, unknown>();
const counts = new Map<string, number>();
for (const entry of stream) {
  counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  if (!byKind.has(entry.kind)) byKind.set(entry.kind, entry.update);
}

console.log("\n=== update kinds ===");
for (const [kind, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${kind}`);
}

console.log("\n=== one representative payload per kind ===");
for (const [kind, sample] of byKind) {
  console.log(`\n--- ${kind} ---`);
  console.log(JSON.stringify(sample, null, 1).slice(0, 1400));
}

writeFileSync(
  join(import.meta.dir, "update-shapes.json"),
  JSON.stringify({ counts: Object.fromEntries(counts), samples: Object.fromEntries(byKind), stream }, null, 2),
);
console.log(`\nwrote ${stream.length} updates to scripts/update-shapes.json`);

host.kill();
rmSync(workdir, { recursive: true, force: true });
