/**
 * Prove the browser half of "once paired, both sides are long lived".
 *
 * Uses a persistent Chrome profile so localStorage survives between runs, the
 * same way a real browser does. The token is read from disk and only ever
 * appears in the first navigation; it is never printed.
 *
 * Usage: bun run scripts/check-browser-pairing.ts <baseUrl> <ompdHome>
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:7799";
const home = process.argv[3] ?? join(process.env.HOME ?? "", ".ompd-verify");
const token = readFileSync(join(home, "token"), "utf8").trim();

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) throw new Error(`no chrome at ${CHROME}`);

const profile = mkdtempSync(join(tmpdir(), "ompd-profile-"));

/** Load a URL in the persistent profile and report what the page settled on. */
async function visit(url: string, label: string): Promise<string> {
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      `--user-data-dir=${profile}`,
      "--virtual-time-budget=6000",
      "--dump-dom",
      url,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  // Chrome with a persistent profile does not close stdout or exit on its own,
  // so waiting for EOF deadlocks. One pump owns the reader for its lifetime and
  // the deadline races the PUMP, never an individual read: racing read() itself
  // orphans the losing call and the next iteration then reads concurrently,
  // which silently drops chunks.
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let dom = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      dom += decoder.decode(value, { stream: true });
      if (dom.includes("</html>")) return;
    }
  })();
  await Promise.race([pump, Bun.sleep(25_000)]);
  proc.kill();
  await proc.exited.catch(() => 0);

  // The pairing screen is the tell: if it rendered, the stored credential did
  // not carry. The strip bay means it connected.
  const sawPairing = /Pair this device|pairing-form/i.test(dom);
  const sawBay = /STRIP BAY/i.test(dom);
  const verdict = dom.length === 0 ? "NO DOM" : sawBay && !sawPairing ? "CONNECTED" : "PAIRING SCREEN";
  console.log(`${label.padEnd(38)} ${verdict}`);
  return verdict;
}
console.log(`profile ${profile}`);
const first = await visit(
  `${base}/?token=${encodeURIComponent(token)}&scopes=read,prompt,manage,approve`,
  "1. first visit, token in query",
);
const second = await visit(`${base}/`, "2. reload, bare url, no token");

console.log("\nnow restart the daemon, then run:");
console.log(`  bun run scripts/check-browser-pairing.ts ${base} ${home} --resume ${profile}`);

if (process.argv.includes("--resume")) {
  const resumeProfile = process.argv[process.argv.indexOf("--resume") + 1];
  console.log(`resuming in ${resumeProfile}`);
}

const ok = first === "CONNECTED" && second === "CONNECTED";
console.log(`\n${ok ? "PASS" : "FAIL"}: browser ${ok ? "remembers" : "forgets"} the pairing across a reload.`);
console.log(`profile kept at ${profile} for the post-restart check`);
if (!ok) rmSync(profile, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
