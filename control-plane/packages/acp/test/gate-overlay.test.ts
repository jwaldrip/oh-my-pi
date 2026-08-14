/**
 * The gate overlay's lifetime, which is a security property rather than hygiene.
 *
 * `spawnLocalHost` writes a private 0600 `--config` overlay before it can know
 * whether the child will start at all. Both directions of getting its lifetime
 * wrong are real, and only one of them is litter:
 *
 *  - Left behind on a spawn that never started, it accumulates one private
 *    directory per attempt in the temp dir for as long as the machine lives.
 *  - Removed while the child is alive, it drops that child back onto the user's
 *    global config, which may be `approvalMode: yolo`. A host that never asks
 *    permission looks exactly like a safe one, so that failure is silent.
 *
 * So both directions are asserted here: nothing survives a spawn that threw,
 * and the overlay stays intact and readable for a live child's whole lifetime.
 *
 * Every leak assertion is a delta between two snapshots of the temp dir, never
 * an absolute "no ompd-gate-* exists". Sibling suites and the live-check scripts
 * spawn real hosts in the same temp dir concurrently, so an absolute assertion
 * would report their in-flight overlays as this code's leak.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_CONFIG_YAML, spawnLocalHost, type SpawnLocalHostOptions } from "../src/index.ts";

/** Overlay directories present in the temp dir at this instant. */
const gateDirs = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith("ompd-gate-"))
    .toSorted();

/** Overlays that appeared between two snapshots, so only ours can be blamed. */
const appeared = (before: string[], after: string[]): string[] =>
  after.filter((dir) => !before.includes(dir));

/**
 * The two callbacks `AcpClientOptions` requires. Never invoked here: a child
 * that never starts sends no requests, and the live stand-in speaks no ACP.
 * They exist so these calls use the real signature instead of a cast.
 */
const callbacks: SpawnLocalHostOptions = {
  onPermission: async () => "reject_once",
  onElicitation: async () => ({ action: "decline" }),
};

const scratch: string[] = [];

/** A scratch directory outside the overlay namespace, cleaned up at the end. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ompd-acp-test-"));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("spawnLocalHost overlay lifetime", () => {
  test("a missing binary leaves no overlay behind", () => {
    const before = gateDirs();

    expect(() =>
      spawnLocalHost({ ...callbacks, ompPath: join(scratchDir(), "not-a-binary") }),
    ).toThrow(/ENOENT/);

    expect(appeared(before, gateDirs())).toEqual([]);
  });

  test("a non-executable binary leaves no overlay behind", () => {
    // A different errno from the missing-binary case, and a different failure
    // point inside posix_spawn, so it is worth exercising separately.
    const bin = join(scratchDir(), "not-executable");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o600 });

    const before = gateDirs();

    expect(() => spawnLocalHost({ ...callbacks, ompPath: bin })).toThrow(/EACCES/);

    expect(appeared(before, gateDirs())).toEqual([]);
  });

  test("a cwd that does not exist leaves no overlay behind", () => {
    // The shape the live check hit: a routine pointed at a working directory
    // that is not there. The binary resolves, so this fails later inside
    // posix_spawn than the cases above, and still before any child exists.
    const missingCwd = join(scratchDir(), "gone");

    const before = gateDirs();

    expect(() => spawnLocalHost({ ...callbacks, ompPath: "/bin/echo", cwd: missingCwd })).toThrow(
      /ENOENT/,
    );

    expect(appeared(before, gateDirs())).toEqual([]);
  });

  test("a live child keeps a readable 0600 overlay, removed only once it exits", async () => {
    // A stand-in host that reports the child's own view of the overlay: it
    // copies whatever `--config` points at to a witness file, announces itself
    // on stderr, then stays alive. Asserting on the witness rather than on the
    // overlay is the point, because the guarantee is about what the child could
    // read, not about what the parent wrote.
    const dir = scratchDir();
    const witness = join(dir, "witness.yml");
    const bin = join(dir, "fake-omp");
    // `$3` is the overlay path: argv is `acp --config <path>`. The marker is
    // written after the copy, so seeing it means the copy is complete. `exec`
    // hands the pid to sleep, so `kill` reaches the process being waited on.
    writeFileSync(bin, `#!/bin/sh\ncat "$3" > '${witness}'\necho host-ready >&2\nexec sleep 300\n`);
    chmodSync(bin, 0o755);

    const ready = Promise.withResolvers<void>();
    const before = gateDirs();
    const host = spawnLocalHost({
      ...callbacks,
      ompPath: bin,
      onLog: (line) => {
        if (line.includes("host-ready")) ready.resolve();
      },
    });

    const overlays = appeared(before, gateDirs());
    expect(overlays).toHaveLength(1);
    const overlay = join(tmpdir(), overlays[0] as string);

    // The child's own signal, not a guessed delay.
    await ready.promise;

    // What the child actually got: the whole overlay, not a truncated prefix.
    expect(readFileSync(witness, "utf8")).toBe(GATE_CONFIG_YAML);
    // Still private, and still on disk, while the child runs.
    expect(statSync(join(overlay, "gate.yml")).mode & 0o777).toBe(0o600);
    expect(existsSync(overlay)).toBe(true);

    host.kill();
    // Removal is registered on the child's exit ahead of the bookkeeping that
    // resolves `exited`, and reactions on one promise run in registration
    // order, so awaiting this is enough: no polling for the directory to go.
    await host.exited;

    expect(existsSync(overlay)).toBe(false);
    expect(appeared(before, gateDirs())).toEqual([]);
  });
});
