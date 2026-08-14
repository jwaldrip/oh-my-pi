/**
 * The evolution loop is the one subsystem that edits the daemon that runs it, so
 * these tests are written against the ways it could be talked into doing that.
 *
 * Every test here is built to fail if the corresponding defence is removed:
 *
 * - Protected-path tests use spellings a prefix check alone would miss.
 * - The under-reporting test hands the engine a truthful-looking `touchedPaths`
 *   that omits the file the diff actually edits. It passes only because paths
 *   are parsed out of the diff.
 * - The isolation test hashes the whole working tree before and after an
 *   evaluation, so a patch that escapes into the running tree is caught by
 *   content rather than by inspection.
 * - The authorization tests include the internal `daemon` actor, which is
 *   trusted everywhere else in the daemon and must not be trusted here.
 *
 * A real git repository is created per test group. Nothing touches the
 * repository these tests live in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, Store, type Actor, type Proposal } from "@ompd/core";
import { EvolutionEngine, ProposalStore, evaluateProposal } from "../src/evolution/index.ts";
import { UnauthorizedError } from "../src/supervisor.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_APP = [
  'export const NAME = "fixture";',
  "export function main(): string {",
  "  return NAME;",
  "}",
  "",
].join("\n");

/** Edits `src/app.ts` only. Applies cleanly against ORIGINAL_APP with -p1. */
const CLEAN_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@",
  '-export const NAME = "fixture";',
  '+export const NAME = "PATCHED";',
  " export function main(): string {",
  "   return NAME;",
  " }",
  "",
].join("\n");

/** Only a proposal object is needed to exercise the gate; nothing is persisted. */
function proposalOf(diff: string, touchedPaths: string[] = []): Proposal {
  const p: Proposal = {
    id: "prop_test",
    title: "t",
    rationale: "r",
    diff,
    touchedPaths,
    state: "submitted",
    createdAt: new Date().toISOString(),
  };
  return p;
}

const tempDirs: string[] = [];
const stores: Store[] = [];
const proposalStores: ProposalStore[] = [];

interface RepoHarness {
  root: string;
  store: Store;
  proposals: ProposalStore;
  engine: EvolutionEngine;
  pair: (id: string, scopes: string[]) => Actor;
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  await proc.exited;
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: proc.exitCode ?? -1, out: `${out}${err}` };
}

async function repoHarness(verifyCommand?: string[]): Promise<RepoHarness> {
  const root = await mkdtemp(join(tmpdir(), "ompd-evo-repo-"));
  tempDirs.push(root);

  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@ompd.local"]);
  await git(root, ["config", "user.name", "ompd test"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), ORIGINAL_APP, "utf8");
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
  await git(root, ["add", "-A"]);
  const commit = await git(root, ["commit", "-m", "initial"]);
  if (commit.code !== 0) throw new Error(`fixture commit failed: ${commit.out}`);

  // The daemon's SQLite file lives outside the repository, as it does in
  // production. Inside it, an untracked db file would make `git status` dirty
  // and quietly weaken every clean-tree assertion below.
  const dbDir = await mkdtemp(join(tmpdir(), "ompd-evo-db-"));
  tempDirs.push(dbDir);
  const dbPath = join(dbDir, "ompd.db");
  const store = new Store(dbPath);
  stores.push(store);
  const proposals = new ProposalStore(dbPath);
  proposalStores.push(proposals);

  const engine = new EvolutionEngine({
    store,
    proposals,
    repoRoot: root,
    verifyCommand: verifyCommand ?? ["sh", "-c", "pwd && grep -q PATCHED src/app.ts"],
    timeoutMs: 60_000,
  });

  return {
    root,
    store,
    proposals,
    engine,
    pair: (id, scopes) => {
      store.addDevice({
        id,
        name: id,
        publicKey: `pk_${id}`,
        scopes,
        createdAt: new Date().toISOString(),
      });
      return { deviceId: id, scopes };
    },
  };
}

/**
 * Hash every tracked and untracked file in the working tree except `.git`.
 *
 * Content-addressed rather than a status check: `git status` would stay clean if
 * a patch were applied and committed, and would say nothing about file bytes.
 */
async function treeDigest(root: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of sorted) {
      if (entry.name === ".git") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      hasher.update(rel);
      hasher.update(await readFile(join(dir, entry.name)));
    }
  };
  await walk(root, "");
  return hasher.digest("hex");
}

afterEach(async () => {
  while (proposalStores.length) proposalStores.pop()?.close();
  while (stores.length) stores.pop()?.close();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The gate: protected paths
// ---------------------------------------------------------------------------

describe("gate: protected paths are archived, never queued", () => {
  test("a plain edit to the policy engine is archived", () => {
    const diff = [
      "diff --git a/packages/core/src/policy.ts b/packages/core/src/policy.ts",
      "--- a/packages/core/src/policy.ts",
      "+++ b/packages/core/src/policy.ts",
      "@@ -1,1 +1,1 @@",
      "-const STRICT = true;",
      "+const STRICT = false;",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.nextState).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/core/src/policy.ts");
  });

  test("the './packages/...' spelling is archived", () => {
    // `isProtectedPath` normalises a leading './', so this must not survive by
    // being spelled relatively.
    const diff = [
      "diff --git a/./packages/core/src/policy.ts b/./packages/core/src/policy.ts",
      "--- a/./packages/core/src/policy.ts",
      "+++ b/./packages/core/src/policy.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/core/src/policy.ts");
  });

  test("the bare 'a/packages/...' spelling is archived", () => {
    // A diff written with no `diff --git` header, where the a/ and b/ prefixes
    // are the only thing between the raw string and the protected path.
    const diff = [
      "--- a/packages/core/src/policy.ts",
      "+++ b/packages/core/src/policy.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.touchedPaths).toEqual(["packages/core/src/policy.ts"]);
  });

  test("a rename INTO a protected path is archived", () => {
    // No hunks at all: the entire payload is rename metadata, which a parser
    // that only reads '---'/'+++' would see as an empty diff.
    const diff = [
      "diff --git a/docs/notes.md b/packages/core/src/policy.ts",
      "similarity index 100%",
      "rename from docs/notes.md",
      "rename to packages/core/src/policy.ts",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/core/src/policy.ts");
  });

  test("a rename OUT OF a protected path is archived", () => {
    // Deleting the gate by moving it away is the same attack in reverse.
    const diff = [
      "diff --git a/packages/daemon/src/evolution/gate.ts b/docs/old-gate.ts",
      "similarity index 100%",
      "rename from packages/daemon/src/evolution/gate.ts",
      "rename to docs/old-gate.ts",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/daemon/src/evolution/gate.ts");
  });

  test("deleting a protected file is archived", () => {
    const diff = [
      "diff --git a/packages/core/src/contracts.ts b/packages/core/src/contracts.ts",
      "deleted file mode 100644",
      "--- a/packages/core/src/contracts.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-export const x = 1;",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/core/src/contracts.ts");
  });

  test("'..' traversal onto a protected path is archived", () => {
    // Prefix matching alone would read this as an unprotected 'foo' directory.
    const diff = [
      "diff --git a/packages/core/src/foo/../policy.ts b/packages/core/src/foo/../policy.ts",
      "--- a/packages/core/src/foo/../policy.ts",
      "+++ b/packages/core/src/foo/../policy.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/core/src/policy.ts");
  });

  test("a custom source prefix cannot smuggle a protected path past -p1", () => {
    // `git apply` strips one leading component whatever it is named, so
    // 'vendored/packages/core/src/policy.ts' lands on the protected file.
    const diff = [
      "--- vendored/packages/core/src/policy.ts",
      "+++ vendored/packages/core/src/policy.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/core/src/policy.ts");
  });

  test("a protected directory prefix is archived", () => {
    const diff = [
      "diff --git a/packages/daemon/src/auth/tokens.ts b/packages/daemon/src/auth/tokens.ts",
      "--- a/packages/daemon/src/auth/tokens.ts",
      "+++ b/packages/daemon/src/auth/tokens.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/daemon/src/auth/tokens.ts");
  });
});

// ---------------------------------------------------------------------------
// The gate: paths come from the diff, not the proposal
// ---------------------------------------------------------------------------

describe("gate: touchedPaths is a claim, not evidence", () => {
  test("a diff under-reporting its own paths is still caught", () => {
    // The proposal swears it only edits the README. The second file section
    // rewrites the policy engine. This test passes only if the gate ignores the
    // claim and reads the diff.
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,1 @@",
      "-# fixture",
      "+# fixture, now with docs",
      "diff --git a/packages/core/src/policy.ts b/packages/core/src/policy.ts",
      "--- a/packages/core/src/policy.ts",
      "+++ b/packages/core/src/policy.ts",
      "@@ -1,1 +1,1 @@",
      '-  return { action: "deny", reason: "default" };',
      '+  return { action: "allow", reason: "default" };',
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff, ["README.md"]));

    expect(verdict.outcome).toBe("archived");
    expect(verdict.protectedPaths).toContain("packages/core/src/policy.ts");
    // And the derived list is complete, not just the claimed entry.
    expect(verdict.touchedPaths).toContain("README.md");
    expect(verdict.touchedPaths).toContain("packages/core/src/policy.ts");
  });

  test("an over-reported claim does not archive an innocuous diff", () => {
    // The inverse: claiming to touch a protected path must not archive a diff
    // that does not. Otherwise the claim is still steering the decision.
    const verdict = evaluateProposal(proposalOf(CLEAN_DIFF, ["packages/core/src/policy.ts"]));

    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["src/app.ts"]);
  });

  test("a removed line that looks like a file header is read as content", () => {
    // Removing the source line '-- a/packages/core/src/policy.ts' renders as
    // '--- a/packages/core/src/policy.ts'. Only counting hunk lines tells the
    // two apart. A parser that sniffs prefixes archives this by mistake, and a
    // parser that can be steered into misreading hunk bodies can be steered
    // into skipping a real file section.
    const diff = [
      "diff --git a/docs/diff-notes.md b/docs/diff-notes.md",
      "--- a/docs/diff-notes.md",
      "+++ b/docs/diff-notes.md",
      "@@ -1,3 +1,1 @@",
      " Example header lines:",
      "--- a/packages/core/src/policy.ts",
      "-+++ b/packages/core/src/policy.ts",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));

    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["docs/diff-notes.md"]);
    expect(verdict.protectedPaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate: diff shapes
// ---------------------------------------------------------------------------

describe("gate: diff edge cases", () => {
  test("a new file via /dev/null is accepted with the new path", () => {
    const diff = [
      "diff --git a/src/added.ts b/src/added.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/added.ts",
      "@@ -0,0 +1,2 @@",
      "+export const added = true;",
      "+",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["src/added.ts"]);
  });

  test("a deletion is accepted with the old path", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-export const gone = true;",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["src/gone.ts"]);
  });

  test("a path containing spaces is parsed whole", () => {
    const diff = [
      "diff --git a/docs/release notes.md b/docs/release notes.md",
      "--- a/docs/release notes.md",
      "+++ b/docs/release notes.md",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["docs/release notes.md"]);
  });

  test("a '\\ No newline at end of file' marker does not derail hunk counting", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["src/app.ts"]);
  });

  test("multiple hunks in one file section are all consumed", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+A",
      " b",
      "@@ -10,2 +10,2 @@",
      "-c",
      "+C",
      " d",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["src/app.ts"]);
  });
});

// ---------------------------------------------------------------------------
// The gate: malformed input is rejected, never partially parsed
// ---------------------------------------------------------------------------

describe("gate: malformed diffs are rejected", () => {
  const cases: Array<{ name: string; diff: string }> = [
    { name: "an empty diff", diff: "" },
    { name: "whitespace only", diff: "   \n\n" },
    {
      name: "a truncated hunk",
      diff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,5 +1,5 @@",
        "-a",
        "+A",
        "",
      ].join("\n"),
    },
    {
      name: "a hunk before any file header",
      diff: ["@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n"),
    },
    {
      name: "'+++' without a preceding '---'",
      diff: ["+++ b/src/app.ts", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n"),
    },
    {
      name: "'---' with no '+++'",
      diff: ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", ""].join("\n"),
    },
    {
      name: "/dev/null on both sides",
      diff: [
        "diff --git a/x b/x",
        "--- /dev/null",
        "+++ /dev/null",
        "@@ -0,0 +0,0 @@",
        "",
      ].join("\n"),
    },
    {
      name: "an unparseable hunk header",
      diff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ garbage @@",
        "-a",
        "",
      ].join("\n"),
    },
    {
      name: "a binary patch",
      diff: [
        "diff --git a/logo.png b/logo.png",
        "GIT binary patch",
        "literal 24",
        "zcmZQzU|",
        "",
      ].join("\n"),
    },
    {
      name: "a rename missing its target",
      diff: [
        "diff --git a/docs/a.md b/docs/b.md",
        "similarity index 100%",
        "rename from docs/a.md",
        "",
      ].join("\n"),
    },
    {
      name: "an absolute path",
      diff: [
        "--- /etc/passwd",
        "+++ /etc/passwd",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    },
    {
      name: "a path escaping the repository root",
      diff: [
        "--- a/../../outside.ts",
        "+++ b/../../outside.ts",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    },
    {
      name: "junk inside a file section",
      diff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "this line belongs to no hunk",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    },
  ];

  for (const c of cases) {
    test(`${c.name} is rejected`, () => {
      const verdict = evaluateProposal(proposalOf(c.diff));
      expect(verdict.outcome).toBe("malformed");
      expect(verdict.nextState).toBe("rejected");
      // Nothing is reported as touched, because nothing was reliably parsed.
      expect(verdict.touchedPaths).toEqual([]);
    });
  }

  test("a malformed diff never reports 'accepted' even when it names safe paths", () => {
    // The point of rejecting rather than best-effort parsing: the readable half
    // of this diff is innocuous, and the unreadable half is where a protected
    // path would hide.
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,9 +1,9 @@",
      "-# fixture",
      "+# fixture",
      "",
    ].join("\n");

    const verdict = evaluateProposal(proposalOf(diff));
    expect(verdict.outcome).toBe("malformed");
    expect(verdict.touchedPaths).not.toContain("README.md");
  });
});

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

describe("submit", () => {
  test("a protected proposal is persisted as archived and cannot be evaluated", async () => {
    const h = await repoHarness();
    const diff = [
      "diff --git a/packages/core/src/policy.ts b/packages/core/src/policy.ts",
      "--- a/packages/core/src/policy.ts",
      "+++ b/packages/core/src/policy.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");

    const submitted = h.engine.submit({ title: "loosen policy", rationale: "faster", diff });

    expect(submitted.state).toBe("archived");
    expect(submitted.verdict?.passed).toBe(false);
    expect(submitted.verdict?.log).toContain("packages/core/src/policy.ts");
    expect(h.proposals.get(submitted.id)?.state).toBe("archived");
    // Archived is terminal: there is no route onward.
    await expect(h.engine.evaluate(submitted.id)).rejects.toThrow(/not submitted/);
  });

  test("submission records the claim and the derived paths separately", async () => {
    const h = await repoHarness();
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,1 @@",
      "-# fixture",
      "+# fixture!",
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    const submitted = h.engine.submit({
      title: "docs",
      rationale: "typo",
      diff,
      touchedPaths: ["README.md"],
    });

    // The stored proposal carries the truth, not the claim.
    expect(submitted.touchedPaths).toEqual(["README.md", "src/app.ts"]);

    const entry = h.store.listAudit(10).find((e) => e.action === "proposal.submit");
    expect(entry?.detail.claimedPaths).toEqual(["README.md"]);
    expect(entry?.detail.underReportedPaths).toEqual(["src/app.ts"]);
  });

  test("an archived submission is audited as denied", async () => {
    const h = await repoHarness();
    h.engine.submit({
      title: "x",
      rationale: "y",
      diff: [
        "diff --git a/mise.toml b/mise.toml",
        "--- a/mise.toml",
        "+++ b/mise.toml",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    });

    const entry = h.store.listAudit(10).find((e) => e.action === "proposal.submit");
    expect(entry?.outcome).toBe("denied");
    expect(entry?.detail.protectedPaths).toEqual(["mise.toml"]);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("evaluate: isolation", () => {
  test("evaluation runs in a worktree and leaves the running tree byte-identical", async () => {
    const h = await repoHarness();
    const before = await treeDigest(h.root);
    const headBefore = (await git(h.root, ["rev-parse", "HEAD"])).out.trim();

    const submitted = h.engine.submit({ title: "patch", rationale: "why", diff: CLEAN_DIFF });
    expect(submitted.state).toBe("submitted");

    const evaluated = await h.engine.evaluate(submitted.id);

    // The verification command only exits 0 if the patch really applied, so a
    // pass proves the work happened somewhere.
    expect(evaluated.state).toBe("awaiting_review");
    expect(evaluated.verdict?.passed).toBe(true);

    // And that somewhere was not here.
    expect(await treeDigest(h.root)).toBe(before);
    expect((await git(h.root, ["rev-parse", "HEAD"])).out.trim()).toBe(headBefore);
    expect(await readFile(join(h.root, "src", "app.ts"), "utf8")).toBe(ORIGINAL_APP);
    expect((await git(h.root, ["status", "--porcelain"])).out.trim()).toBe("");
  });

  test("the verification command runs inside the temporary worktree", async () => {
    const h = await repoHarness();
    const submitted = h.engine.submit({ title: "patch", rationale: "why", diff: CLEAN_DIFF });
    const evaluated = await h.engine.evaluate(submitted.id);

    // `pwd` is the first thing the verification command prints.
    expect(evaluated.verdict?.log).toContain("ompd-eval-");
    expect(evaluated.verdict?.log).not.toContain(`${h.root}\n`);
  });

  test("the worktree is removed even after a failing evaluation", async () => {
    const h = await repoHarness(["false"]);
    const before = await treeDigest(h.root);
    const submitted = h.engine.submit({ title: "patch", rationale: "why", diff: CLEAN_DIFF });

    const evaluated = await h.engine.evaluate(submitted.id);
    expect(evaluated.state).toBe("rejected");
    expect(evaluated.verdict?.passed).toBe(false);

    // A leaked worktree is a stale registration in the real repository, so
    // cleanup has to survive the failure path too.
    const worktrees = (await git(h.root, ["worktree", "list"])).out.trim().split("\n");
    expect(worktrees).toHaveLength(1);
    expect(await treeDigest(h.root)).toBe(before);
  });

  test("a patch that does not apply is rejected without touching the tree", async () => {
    const h = await repoHarness();
    const stale = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      '-export const NAME = "something else entirely";',
      '+export const NAME = "PATCHED";',
      "",
    ].join("\n");

    const before = await treeDigest(h.root);
    const submitted = h.engine.submit({ title: "stale", rationale: "why", diff: stale });
    const evaluated = await h.engine.evaluate(submitted.id);

    expect(evaluated.state).toBe("rejected");
    expect(evaluated.verdict?.log).toContain("does not apply cleanly");
    expect(await treeDigest(h.root)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

describe("promote: requires an operator", () => {
  async function readyProposal(h: RepoHarness): Promise<Proposal> {
    const submitted = h.engine.submit({ title: "patch app", rationale: "why", diff: CLEAN_DIFF });
    const evaluated = await h.engine.evaluate(submitted.id);
    expect(evaluated.state).toBe("awaiting_review");
    return evaluated;
  }

  test("a device without manage scope is refused", async () => {
    const h = await repoHarness();
    const ready = await readyProposal(h);
    const actor = h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);

    await expect(h.engine.promote(ready.id, actor)).rejects.toThrow(UnauthorizedError);
    expect(h.proposals.get(ready.id)?.state).toBe("awaiting_review");
    expect((await git(h.root, ["status", "--porcelain"])).out.trim()).toBe("");
  });

  test("a forged actor claiming manage scope is refused", async () => {
    const h = await repoHarness();
    const ready = await readyProposal(h);
    const forged: Actor = { deviceId: "not-paired", scopes: [SCOPE_MANAGE] };

    await expect(h.engine.promote(ready.id, forged)).rejects.toThrow(UnauthorizedError);
    expect(h.proposals.get(ready.id)?.state).toBe("awaiting_review");
  });

  test("a revoked device is refused", async () => {
    const h = await repoHarness();
    const ready = await readyProposal(h);
    const actor = h.pair("laptop", [SCOPE_MANAGE]);
    h.store.revokeDevice("laptop");

    await expect(h.engine.promote(ready.id, actor)).rejects.toThrow(UnauthorizedError);
  });

  test("the internal daemon actor cannot promote even holding manage scope", async () => {
    // Everywhere else in the daemon this actor is trusted for automatic
    // decisions. Promotion is the one place it must not be, because an
    // automated identity that can promote is an auto-promote switch.
    const h = await repoHarness();
    const ready = await readyProposal(h);
    const internal: Actor = { deviceId: "daemon", scopes: [SCOPE_MANAGE] };

    await expect(h.engine.promote(ready.id, internal)).rejects.toThrow(UnauthorizedError);
    expect(h.proposals.get(ready.id)?.state).toBe("awaiting_review");
  });

  test("a proposal that has not been evaluated cannot be promoted", async () => {
    const h = await repoHarness();
    const actor = h.pair("laptop", [SCOPE_MANAGE]);
    const submitted = h.engine.submit({ title: "patch", rationale: "why", diff: CLEAN_DIFF });

    await expect(h.engine.promote(submitted.id, actor)).rejects.toThrow(/not awaiting_review/);
  });

  test("an operator with manage scope promotes, and the commit lands", async () => {
    const h = await repoHarness();
    const ready = await readyProposal(h);
    const actor = h.pair("laptop", [SCOPE_MANAGE]);

    const promoted = await h.engine.promote(ready.id, actor);

    expect(promoted.state).toBe("promoted");
    expect(promoted.promotedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(h.root, "src", "app.ts"), "utf8")).toContain("PATCHED");

    const head = (await git(h.root, ["rev-parse", "HEAD"])).out.trim();
    expect(head).toBe(promoted.promotedCommit ?? "");
    expect((await git(h.root, ["log", "-1", "--format=%s"])).out.trim()).toBe("patch app");

    const entry = h.store.listAudit(20).find((e) => e.action === "proposal.promote");
    expect(entry?.outcome).toBe("ok");
    expect(entry?.detail.commit).toBe(promoted.promotedCommit);
    expect(entry?.actorDeviceId).toBe("laptop");
  });

  test("a row edited to hide a protected path is caught at promotion", async () => {
    // The gate runs again immediately before committing, because the proposal
    // row is mutable and a verdict recorded earlier proves nothing about the
    // diff that is about to be applied.
    const h = await repoHarness();
    const ready = await readyProposal(h);
    const actor = h.pair("laptop", [SCOPE_MANAGE]);

    h.proposals.upsert({
      ...ready,
      diff: [
        "diff --git a/packages/core/src/policy.ts b/packages/core/src/policy.ts",
        "--- a/packages/core/src/policy.ts",
        "+++ b/packages/core/src/policy.ts",
        "@@ -1,1 +1,1 @@",
        "-x",
        "+y",
        "",
      ].join("\n"),
    });

    await expect(h.engine.promote(ready.id, actor)).rejects.toThrow(/failed the gate/);
    expect(h.proposals.get(ready.id)?.state).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe("rollback", () => {
  test("rollback produces a revert commit and restores the file", async () => {
    const h = await repoHarness();
    const actor = h.pair("laptop", [SCOPE_MANAGE]);

    const submitted = h.engine.submit({ title: "patch app", rationale: "why", diff: CLEAN_DIFF });
    const evaluated = await h.engine.evaluate(submitted.id);
    const promoted = await h.engine.promote(evaluated.id, actor);

    const rolledBack = await h.engine.rollback(promoted.id, actor);

    expect(rolledBack.state).toBe("rolled_back");

    // A new commit, not a rewritten history: the promotion is still there.
    const subjects = (await git(h.root, ["log", "--format=%s"])).out.trim().split("\n");
    expect(subjects[0]).toMatch(/^Revert "patch app"/);
    expect(subjects).toContain("patch app");

    const head = (await git(h.root, ["rev-parse", "HEAD"])).out.trim();
    expect(head).not.toBe(promoted.promotedCommit);
    expect(await readFile(join(h.root, "src", "app.ts"), "utf8")).toBe(ORIGINAL_APP);

    // The promoted commit is still reachable, which is what makes the history
    // an audit trail rather than a rewrite.
    expect((await git(h.root, ["cat-file", "-t", promoted.promotedCommit ?? ""])).out.trim()).toBe(
      "commit",
    );
  });

  test("rollback is refused without manage scope", async () => {
    const h = await repoHarness();
    const operator = h.pair("laptop", [SCOPE_MANAGE]);
    const reader = h.pair("phone", [SCOPE_READ]);

    const submitted = h.engine.submit({ title: "patch app", rationale: "why", diff: CLEAN_DIFF });
    const evaluated = await h.engine.evaluate(submitted.id);
    const promoted = await h.engine.promote(evaluated.id, operator);

    await expect(h.engine.rollback(promoted.id, reader)).rejects.toThrow(UnauthorizedError);
    expect(h.proposals.get(promoted.id)?.state).toBe("promoted");
  });

  test("a proposal that was never promoted cannot be rolled back", async () => {
    const h = await repoHarness();
    const actor = h.pair("laptop", [SCOPE_MANAGE]);
    const submitted = h.engine.submit({ title: "patch", rationale: "why", diff: CLEAN_DIFF });

    await expect(h.engine.rollback(submitted.id, actor)).rejects.toThrow(/no promoted commit/);
  });
});

// ---------------------------------------------------------------------------
// Observation stays a draft
// ---------------------------------------------------------------------------

describe("observe: drafting only", () => {
  test("repeated failures produce drafts, and drafts are not proposals", async () => {
    const h = await repoHarness();
    for (let i = 0; i < 4; i++) {
      h.store.audit({
        action: "agent.create",
        outcome: "error",
        detail: { reason: "host spawn failed" },
      });
    }

    const drafts = h.engine.observe(h.store);

    expect(drafts.length).toBeGreaterThan(0);
    const draft = drafts.find((d) => d.evidence.action === "agent.create");
    expect(draft).toBeDefined();
    expect(draft?.evidence.failures).toBe(4);
    expect(draft?.evidence.reasons).toContain("host spawn failed");

    // Structurally not a Proposal: no id to pass to evaluate or promote, and no
    // state to be mistaken for an approved one.
    expect(draft).not.toHaveProperty("id");
    expect(draft).not.toHaveProperty("state");
    expect(draft).not.toHaveProperty("verdict");
  });

  test("observing persists nothing", async () => {
    const h = await repoHarness();
    for (let i = 0; i < 5; i++) {
      h.store.audit({ action: "agent.prompt", outcome: "error", detail: { reason: "timeout" } });
    }

    const drafts = h.engine.observe(h.store);
    expect(drafts.length).toBeGreaterThan(0);

    // Nothing entered the pipeline. Entering it requires a caller to read the
    // draft and call submit.
    expect(h.proposals.list()).toEqual([]);
  });

  test("failures below the threshold produce nothing", async () => {
    const h = await repoHarness();
    h.store.audit({ action: "agent.create", outcome: "error", detail: { reason: "one off" } });

    expect(h.engine.observe(h.store)).toEqual([]);
  });

  test("successful audit entries are not mined as failures", async () => {
    const h = await repoHarness();
    for (let i = 0; i < 10; i++) {
      h.store.audit({ action: "agent.create", outcome: "ok", detail: { reason: "fine" } });
    }

    expect(h.engine.observe(h.store)).toEqual([]);
  });

  test("there is no code path from observe to promote", async () => {
    // Two independent checks, because either alone is weak.
    //
    // 1. Structural: the body of `observe` neither calls `promote` nor writes to
    //    the proposal store. Comments are stripped first so prose about
    //    promotion cannot fail or pass the check by accident.
    const body = EvolutionEngine.prototype.observe
      .toString()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(body).not.toContain("promote");
    expect(body).not.toContain("upsert");
    expect(body).not.toContain("submit");

    // 2. Behavioural: a draft carries nothing `promote` can accept. `promote`
    //    takes an id minted by `submit`, and a draft has none, so the only way
    //    across the gap is an operator calling `submit` by hand.
    const h = await repoHarness();
    for (let i = 0; i < 4; i++) {
      h.store.audit({ action: "agent.create", outcome: "error", detail: { reason: "boom" } });
    }
    const drafts = h.engine.observe(h.store);
    const keys = Object.keys(drafts[0] ?? {}).sort();
    expect(keys).toEqual(["diff", "evidence", "rationale", "title"]);

    // And no proposal exists for an operator to promote by mistake.
    expect(h.proposals.list()).toEqual([]);
  });

  test("a drafted diff is well formed and survives the gate", async () => {
    // If drafts were malformed the whole observe step would be decorative: no
    // operator could act on one.
    const h = await repoHarness();
    for (let i = 0; i < 3; i++) {
      h.store.audit({ action: "routine.run", outcome: "error", detail: { reason: "exit 1" } });
    }

    const draft = h.engine.observe(h.store)[0];
    expect(draft).toBeDefined();

    const verdict = evaluateProposal(proposalOf(draft?.diff ?? ""));
    expect(verdict.outcome).toBe("accepted");
    expect(verdict.touchedPaths).toEqual(["docs/evolution/routine-run.md"]);
  });
});

// ---------------------------------------------------------------------------
// The absence of a switch
// ---------------------------------------------------------------------------

describe("no auto-promote surface exists", () => {
  test("the gate takes exactly one argument and no options", () => {
    // A second parameter is where an options bag lands, and an options bag is
    // where an auto-promote flag lands.
    expect(evaluateProposal.length).toBe(1);
  });

  test("no source file in the evolution slice mentions an auto-promote setting", async () => {
    const dir = join(import.meta.dir, "..", "src", "evolution");
    const files = await readdir(dir);
    const banned = /auto[_-]?promote|autoPromote|skipGate|bypassGate|forcePromote/i;

    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8");
      // The word may appear in prose explaining why it is absent, so only
      // executable text is checked.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code).not.toMatch(banned);
    }
  });
});
