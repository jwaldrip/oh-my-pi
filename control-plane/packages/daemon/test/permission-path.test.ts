/**
 * The permission path, end to end, against a scripted ACP peer.
 *
 * This is the test the security model stands on: a client reachable from the
 * internet must not be able to cause a built-in tool to run that policy did not
 * approve. Real supervisor, real policy, real store, real ACP client -- only
 * the subprocess is scripted, so the assertions are about ompd's behaviour and
 * not a model's mood.
 *
 * Each test asserts on the *option id sent back to the agent*, because that is
 * the only thing that actually gates execution. Asserting on internal state
 * would pass even if the wrong answer went out on the wire.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DefaultPolicy,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  Store,
  type Actor,
} from "@ompd/core";
import { AcpClient } from "@ompd/acp";
import { Supervisor, type PendingApproval, type PendingPlanReview } from "../src/supervisor.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

/** A gate-2 approval prompt for `write`, shaped exactly as omp renders one. */
const writePrompt = (path: string, content = "x"): string =>
  `Allow tool: write\nPath: ${path}\nContent:\n${content}`;

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];

interface Harness {
  sup: Supervisor;
  store: Store;
  fake: FakeHostController;
  approvals: Array<Omit<PendingApproval, "resolve">>;
  planReviews: Array<Omit<PendingPlanReview, "resolve">>;
  pair: (id: string, scopes: string[]) => Actor;
}

interface HarnessOptions {
  approvalTimeoutMs?: number;
  /** Asked for, not necessarily honoured: the supervisor floors it. */
  promptTimeoutMs?: number;
  mode?: "strict" | "standard" | "trusted";
}

function harness(opts: HarnessOptions = {}): Harness {
  const path = `/tmp/ompd-perm-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const approvals: Array<Omit<PendingApproval, "resolve">> = [];
  const planReviews: Array<Omit<PendingPlanReview, "resolve">> = [];
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: opts.mode ?? "standard" }),
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 500,
    promptTimeoutMs: opts.promptTimeoutMs,
    spawnHost: fake.factory,
    events: {
      onApprovalNeeded: (p) => approvals.push(p),
      onPlanReviewNeeded: (p) => planReviews.push(p),
    },
  });
  sups.push(sup);
  return {
    sup,
    store,
    fake,
    approvals,
    planReviews,
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

afterEach(async () => {
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

const bashCall = (command: string) => ({
  toolCallId: `tc_${crypto.randomUUID().slice(0, 8)}`,
  title: command,
  kind: "execute",
  rawInput: { command },
});

describe("automatic decisions", () => {
  test("a shell command with nobody listening is rejected on the wire", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const option = await h.fake.requestPermission(agent.acpSessionId!, bashCall("touch /tmp/x"));

    expect(option).toBe("reject_once");
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("deny");
    expect(rec?.rule).toBe("timeout");
  });

  test("a critical command is rejected even after the timeout window", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const option = await h.fake.requestPermission(agent.acpSessionId!, bashCall("rm -rf /"));
    expect(option).toBe("reject_once");
  });

  test("a workspace read is allowed without troubling a human", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const option = await h.fake.requestPermission(agent.acpSessionId!, {
      toolCallId: "tc_read",
      title: "read main.ts",
      kind: "read",
      rawInput: { path: "/work/main.ts" },
    });

    expect(option).toBe("allow_once");
    expect(h.approvals).toHaveLength(0); // nobody was asked
  });

  test("reading a secret path is rejected without asking a human at all", async () => {
    // Asking would be a bug: a human tapping 'allow' on a phone must not be
    // able to exfiltrate a private key.
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const option = await h.fake.requestPermission(agent.acpSessionId!, {
      toolCallId: "tc_secret",
      title: "read key",
      kind: "read",
      rawInput: { path: "/Users/j/.ssh/id_ed25519" },
    });

    expect(option).toBe("reject_once");
    expect(h.approvals).toHaveLength(0);
  });
});

describe("human decisions", () => {
  test("an operator with approve scope can allow, and the allow reaches the agent", async () => {
    // Without this the suite would pass if the gate rejected everything.
    const h = harness({ approvalTimeoutMs: 5_000 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const pending = h.fake.requestPermission(agent.acpSessionId!, bashCall("echo hi"));
    const req = await waitFor(() => h.approvals[0] ?? null, 2_000);
    expect(h.sup.decide(req.requestId, "allow", "once", admin)).toBe(true);

    expect(await pending).toBe("allow_once");
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("allow");
    expect(rec?.actorDeviceId).toBe("admin");
  });

  test("scope always maps through to the agent", async () => {
    const h = harness({ approvalTimeoutMs: 5_000 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const pending = h.fake.requestPermission(agent.acpSessionId!, bashCall("echo hi"));
    const req = await waitFor(() => h.approvals[0] ?? null, 2_000);
    h.sup.decide(req.requestId, "allow", "always", admin);
    expect(await pending).toBe("allow_always");
  });

  test("a phone without approve scope cannot turn a prompt into an allow", async () => {
    // The headline case: a device paired to drive agents, never to approve.
    const h = harness({ approvalTimeoutMs: 800 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const phone = h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const pending = h.fake.requestPermission(agent.acpSessionId!, bashCall("touch /tmp/x"));
    const req = await waitFor(() => h.approvals[0] ?? null, 2_000);

    expect(h.sup.decide(req.requestId, "allow", "always", phone)).toBe(false);
    expect(await pending).toBe("reject_once");
  });

  test("a forged actor cannot approve", async () => {
    const h = harness({ approvalTimeoutMs: 800 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const pending = h.fake.requestPermission(agent.acpSessionId!, bashCall("touch /tmp/x"));
    const req = await waitFor(() => h.approvals[0] ?? null, 2_000);

    const forged: Actor = { deviceId: "ghost", scopes: [SCOPE_APPROVE] };
    expect(h.sup.decide(req.requestId, "allow", "once", forged)).toBe(false);
    expect(await pending).toBe("reject_once");
  });

  test("a revoked device cannot approve even mid-flight", async () => {
    const h = harness({ approvalTimeoutMs: 1_500 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const pending = h.fake.requestPermission(agent.acpSessionId!, bashCall("touch /tmp/x"));
    const req = await waitFor(() => h.approvals[0] ?? null, 2_000);

    h.store.revokeDevice("admin");
    expect(h.sup.decide(req.requestId, "allow", "once", admin)).toBe(false);
    expect(await pending).toBe("reject_once");
  });
});

/**
 * The write gate.
 *
 * These calls never reach `session/request_permission`. omp 17.2.12 stopped
 * requesting ACP permission for ordinary `edit`, `write` and `ast_edit` calls,
 * so the only channel they are visible on is `elicitation/create`, carrying
 * the string OMP's internal gate would have shown a human. Every assertion
 * below is on the value sent back over that channel, because that is what
 * decides whether the file is written.
 */
describe("the write gate", () => {
  const writePrompt = (path: string, content = "x"): string =>
    `Allow tool: write\nPath: ${path}\nContent:\n${content}`;

  test("a write inside the workspace is allowed without troubling a human", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(agent.acpSessionId!, writePrompt("/work/out.txt"), [
      "Approve",
      "Deny",
    ]);

    expect(chosen).toBe("Approve");
    expect(h.approvals).toHaveLength(0);
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("allow");
    expect(rec?.rule).toBe("write:workspace");
  });

  test("a write outside the workspace with nobody listening is denied", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(agent.acpSessionId!, writePrompt("/etc/hosts"), [
      "Approve",
      "Deny",
    ]);

    expect(chosen).toBe("Deny");
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("deny");
    // A recorded decision, not a row left pending by a transport error.
    expect(rec?.rule).toBe("timeout");
  });

  test("a write to a secret path is denied without asking a human at all", async () => {
    // The case the whole ticket exists for: before this, a client with only
    // prompt scope could write ~/.ssh/authorized_keys and policy never ran.
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(
      agent.acpSessionId!,
      writePrompt("/Users/j/.ssh/authorized_keys", "ssh-ed25519 AAAA"),
      ["Approve", "Deny"],
    );

    expect(chosen).toBe("Deny");
    expect(h.approvals).toHaveLength(0);
    expect(h.store.listApprovals(agent.id)[0]?.rule).toStartWith("secret:");
  });

  test("an operator can allow a write outside the workspace, and the allow lands", async () => {
    // A gate that only ever denies is indistinguishable from a broken tool.
    const h = harness({ approvalTimeoutMs: 5_000 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const pending = h.fake.elicit(agent.acpSessionId!, writePrompt("/tmp/scratch.txt"), [
      "Approve",
      "Deny",
    ]);
    const req = await waitFor(() => h.approvals[0] ?? null, 2_000);
    expect(req.tool).toBe("write");
    expect(h.sup.decide(req.requestId, "allow", "once", admin)).toBe(true);

    expect(await pending).toBe("Approve");
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("allow");
    expect(rec?.actorDeviceId).toBe("admin");
  });

  test("a content-only edit is gated, which gate 1 never sees", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    // omp's edit tool reports a bare `File:` line and no content.
    const chosen = await h.fake.elicit(agent.acpSessionId!, "Allow tool: edit\nFile: /etc/passwd", [
      "Approve",
      "Deny",
    ]);

    expect(chosen).toBe("Deny");
    expect(h.store.listApprovals(agent.id)[0]?.tool).toBe("edit");
  });

  test("a relative edit target is resolved against the agent's cwd", async () => {
    // omp reports whatever path the tool was called with, which for `edit` is
    // routinely relative. Treating that as unknowable would nag on every edit.
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(agent.acpSessionId!, "Allow tool: edit\nFile: src/main.ts", [
      "Approve",
      "Deny",
    ]);

    expect(chosen).toBe("Approve");
    expect(h.approvals).toHaveLength(0);
  });

  test("one escaping path in a multi-target call denies the whole call", async () => {
    // ast_edit names a list. A call is only as safe as its worst target, so a
    // workspace file sitting next to /etc must not carry the decision.
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(
      agent.acpSessionId!,
      "Allow tool: ast_edit\nPattern: a\nReplacement: b\nPaths: /work/one.ts, /Users/j/.ssh/config",
      ["Approve", "Deny"],
    );

    expect(chosen).toBe("Deny");
    expect(h.approvals).toHaveLength(0);
    expect(h.store.listApprovals(agent.id)[0]?.rule).toStartWith("secret:");
  });

  test("an opaque target alongside a workspace file still reaches a human", async () => {
    // `local://` and `xd://` are OMP namespaces, not paths. Deciding the call
    // on the workspace file beside them would leave the opaque half unexamined.
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(
      agent.acpSessionId!,
      "Allow tool: ast_edit\nPattern: a\nReplacement: b\nPaths: /work/one.ts, local://PLAN.md",
      ["Approve", "Deny"],
    );

    expect(chosen).toBe("Deny");
    // Nobody answered, but somebody was asked: this is a prompt, not a
    // silent allow on the strength of /work/one.ts.
    expect(h.approvals).toHaveLength(1);
  });

  test("a target omp elided is denied rather than guessed at", async () => {
    const h = harness({ approvalTimeoutMs: 5_000 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(
      agent.acpSessionId!,
      `Allow tool: write\nPath: /work/${"a".repeat(40)}[\u202631ch elided\u2026]\nContent:\nx`,
      ["Approve", "Deny"],
    );

    expect(chosen).toBe("<declined>");
    // Denied outright, not queued for a human who would see the same stump.
    expect(h.approvals).toHaveLength(0);
    expect(h.store.listApprovals(agent.id)[0]?.rule).toBe("opaque:truncated");
  });

  test("an Approve/Deny question that is not a tool approval is declined", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(agent.acpSessionId!, "Something else entirely?", [
      "Approve",
      "Deny",
    ]);

    expect(chosen).toBe("<declined>");
    expect(h.store.listApprovals(agent.id)).toHaveLength(0);
  });

  test("an unrecognised elicitation is declined, never accepted", async () => {
    // Declining reproduces exactly what a client with no elicitation
    // capability produces, so advertising the capability cannot turn a
    // question ompd does not understand into consent.
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(agent.acpSessionId!, "Pick a colour", ["Red", "Blue"]);
    expect(chosen).toBe("<declined>");
  });

  test("a plan approval is delivered to a connected client and returns its selected option", async () => {
    const h = harness({ approvalTimeoutMs: 5_000 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const pending = h.fake.elicit(
      agent.acpSessionId!,
      'Approve plan "Ship it" and start implementation?\n- step one',
      ["Approve and execute", "Refine plan"],
    );
    const review = await waitFor(() => h.planReviews[0] ?? null, 2_000);

    expect(review.agentId).toBe(agent.id);
    expect(review.message).toContain('Approve plan "Ship it"');
    expect(review.choices).toEqual(["Approve and execute", "Refine plan"]);
    expect(h.sup.decidePlan(review.requestId, "Approve and execute", admin)).toBe(true);
    expect(await pending).toBe("Approve and execute");
  });

  test("plan choices attached to a different question are declined", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit(agent.acpSessionId!, "Delete production?", [
      "Approve and execute",
      "Refine plan",
    ]);

    expect(chosen).toBe("<declined>");
  });

  test("an elicitation on an unmapped session is declined", async () => {
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    const chosen = await h.fake.elicit("sess_nope", writePrompt("/work/out.txt"), [
      "Approve",
      "Deny",
    ]);
    expect(chosen).toBe("<declined>");
  });
});

describe("approval and turn deadlines", () => {
  /**
   * A peer that behaves the way `omp acp` does around gate 2: it leaves
   * `session/prompt` unanswered for as long as the tool call is waiting on an
   * approval, and only then reports the turn. If the client's turn deadline
   * were the approval deadline, this shape would produce a transport error
   * every time an operator failed to answer.
   */
  const promptThatWaitsOnAnApproval = (h: Harness): void => {
    h.fake.onPrompt(async (sessionId) => {
      const chosen = await h.fake.elicit(sessionId, writePrompt("/etc/hosts"), ["Approve", "Deny"]);
      return { stopReason: chosen === "Approve" ? "end_turn" : "refusal" };
    });
  };

  test("an unanswered approval records a denial instead of timing out the turn", async () => {
    // These two deadlines were the same number, so `session/prompt` gave up at
    // the instant the approval would have failed closed. The caller got a
    // transport error and the approval row stayed `pending` forever.
    const h = harness({ approvalTimeoutMs: 300 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);
    promptThatWaitsOnAnApproval(h);

    const started = Date.now();
    const result = await h.sup.prompt(agent.id, "write to /etc/hosts", admin);
    const elapsed = Date.now() - started;

    // The turn outlived the approval window rather than racing it.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(result.stopReason).toBe("refusal");
    const rec = h.store.listApprovals(agent.id)[0];
    expect(rec?.decision).toBe("deny");
    expect(rec?.rule).toBe("timeout");
    expect(h.sup.pendingApprovals()).toHaveLength(0);
  });

  test("a turn deadline shorter than the approval window is raised, not honoured", async () => {
    // The invariant, not the happy path: a caller cannot configure the turn
    // deadline back underneath the approval deadline and reintroduce the bug.
    const h = harness({ approvalTimeoutMs: 300, promptTimeoutMs: 1 });
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);
    promptThatWaitsOnAnApproval(h);

    const result = await h.sup.prompt(agent.id, "write to /etc/hosts", admin);

    expect(result.stopReason).toBe("refusal");
    expect(h.store.listApprovals(agent.id)[0]?.rule).toBe("timeout");
  });

  test("the client's turn deadline is its own, and it does fire", async () => {
    // Directly against `AcpClient`, because the two numbers being distinct is
    // only worth anything if the turn timer exists at all. A peer that answers
    // nothing proves both halves: `session/prompt` waits for its own deadline,
    // and a control-plane request gives up on the shorter one.
    const silent = new AcpClient(() => {}, {
      onPermission: async () => "reject_once",
      onElicitation: async () => ({ action: "decline" }),
      requestTimeoutMs: 40,
      promptTimeoutMs: 400,
    });

    const started = Date.now();
    await expect(silent.newSession("/work")).rejects.toThrow(/timeout after 40ms: session\/new/);
    expect(Date.now() - started).toBeLessThan(300);

    await expect(silent.prompt("sess_1", "hi")).rejects.toThrow(
      /timeout after 400ms: session\/prompt/,
    );
    silent.close();
  });
});

describe("update persistence", () => {
  test("session updates are sequenced and replayable", async () => {
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    for (let i = 1; i <= 4; i++) h.fake.emitUpdate(agent.acpSessionId!, { i });
    await waitFor(() => (h.store.updatesSince(agent.id, 0).length === 4 ? true : null), 2_000);

    // A client that dropped after seq 2 gets exactly the gap.
    expect(h.store.updatesSince(agent.id, 2).map((u) => u.seq)).toEqual([3, 4]);
  });
});

describe("agent durability", () => {
  test("an agent survives the client that created it going away", async () => {
    // The inversion the control plane rests on: lifetime belongs to the daemon.
    const h = harness();
    const admin = h.pair("admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agent = await h.sup.createAgent({ name: "a", cwd: "/work" }, admin);

    h.fake.onPrompt(async () => {
      await Bun.sleep(300);
      return { stopReason: "end_turn" };
    });

    // Fire a turn and abandon the caller, as a phone losing signal would.
    const turn = h.sup.prompt(agent.id, "long task", admin);
    await Bun.sleep(50);

    // The agent is still registered and still busy.
    expect(h.sup.listAgents().find((a) => a.id === agent.id)?.state).toBe("busy");
    await turn;
    expect(h.sup.listAgents().find((a) => a.id === agent.id)?.state).toBe("idle");
    expect(h.fake.prompts).toHaveLength(1);
  });
});

async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}
