/**
 * Prove the daemon holds a macOS idle-sleep assertion for exactly as long as
 * an agent is working, by asking the operating system rather than the daemon.
 *
 * The unit tests assert the control logic against an injected spawn. This asks
 * `pmset -g assertions`, which is the only witness that can tell the
 * difference between "we ran caffeinate" and "the system is actually being
 * held awake". It runs a real daemon with a scripted ACP peer, so no `omp`
 * binary and no model are involved, and every state transition is driven on
 * purpose.
 *
 * Usage: bun run scripts/check-sleep-assertion.ts
 * Exits non-zero if the assertion is not taken, or not released.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ompd } from "../packages/daemon/src/daemon.ts";
import { createFakeHost } from "../packages/daemon/test/fake-host.ts";

/**
 * The assertion this daemon is responsible for, and only that one.
 *
 * Other things on a Mac hold caffeinate assertions, and one of them was
 * running while this was written. `caffeinate -w <pid>` reports "on behalf of
 * Process ID <pid>", which is what makes ours identifiable rather than merely
 * plausible: a filter on the word caffeinate would have called someone else's
 * 300-second timer a pass.
 */
async function assertions(): Promise<string[]> {
  const proc = Bun.spawn(["pmset", "-g", "assertions"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;

  const records: string[][] = [];
  let open: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^\s*pid \d+\(/.test(line)) {
      open = [line.trim()];
      records.push(open);
    } else if (line.trim().length === 0) {
      // A blank line ends the record. Without this the unrelated trailer
      // `pmset` prints after the list gets glued onto the last one.
      open = null;
    } else open?.push(line.trim());
  }

  return records
    .filter((record) => record.some((line) => line.includes(`on behalf of Process ID ${process.pid}`)))
    .map((record) => record.join("\n  "));
}

async function report(label: string): Promise<string[]> {
  // The child needs a moment to register with powerd; without it the first
  // read races the spawn and reports an absence that is not real.
  await Bun.sleep(300);
  const lines = await assertions();
  console.log(`\n### ${label}`);
  console.log(`$ pmset -g assertions   # assertions held on behalf of pid ${process.pid}`);
  console.log(
    lines.length === 0 ? "  (none held by this daemon)" : lines.map((l) => `  ${l}`).join("\n"),
  );
  return lines;
}

const home = mkdtempSync(join(tmpdir(), "ompd-awake-check-"));
const host = createFakeHost();
const daemon = new Ompd({
  home,
  overrides: { port: 0 },
  spawnHost: host.factory,
  voice: false,
  onLog: (line) => console.log(`  daemon: ${line}`),
});

const info = await daemon.start();
console.log(`daemon pid ${process.pid}, listening at ${info.url}, keepAwake=${daemon.config.keepAwake}`);

const actor = {
  deviceId: info.bootstrap?.deviceId ?? "",
  scopes: ["read", "prompt", "manage", "approve"],
};

const idle = await report("idle: a daemon with no agents");

const agent = await daemon.supervisor.createAgent({ cwd: home, name: "probe" }, actor);
const settled = await report(`one agent, state ${daemon.supervisor.listAgents()[0]?.state}`);

// Hold the turn open so the agent stays busy while pmset is read.
const turn = Promise.withResolvers<unknown>();
host.onPrompt(() => turn.promise);
const prompted = daemon.supervisor.prompt(agent.id, "do some work", actor);
const busy = await report(`mid-turn, state ${daemon.supervisor.listAgents()[0]?.state}`);

// `--hold` exists for the one property no in-process check can prove: that a
// daemon which never gets to run its teardown still cannot strand an
// assertion. The caller SIGKILLs this pid and reads `pmset` afterwards.
if (process.argv.includes("--hold")) {
  console.log(`HOLDING pid=${process.pid}`);
  const forever = Promise.withResolvers<void>();
  await forever.promise;
}

turn.resolve({ stopReason: "end_turn" });
await prompted;
const after = await report(`turn settled, state ${daemon.supervisor.listAgents()[0]?.state}`);

await daemon.stop();
const stopped = await report("daemon stopped");
rmSync(home, { recursive: true, force: true });

const failures: string[] = [];
if (idle.length !== 0) failures.push("an idle daemon held an assertion");
if (settled.length !== 0) failures.push("an idle agent held an assertion");
if (busy.length === 0) failures.push("no assertion was held during a turn");
if (after.length !== 0) failures.push("the assertion outlived the turn");
if (stopped.length !== 0) failures.push("the assertion outlived the daemon");

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.log(`VERDICT fail: ${failure}`);
  process.exit(1);
}
console.log("VERDICT ok: held only for the turn, released at the end of it, gone after stop");
