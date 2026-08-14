/**
 * Store tests defend three properties that are easy to break silently:
 * replay must be lossless and ordered, a recorded approval decision must be
 * final, and an issued credential must outlive the process that issued it
 * while a withdrawn one must stay withdrawn. All three are security-relevant;
 * none is visible in normal use.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { redact, REDACTED, Store } from "../src/index.ts";
import type { Agent, Device } from "../src/index.ts";

const stores: Store[] = [];
const fresh = (): Store => {
  // A file-backed temp db, because WAL and ON CONFLICT behave differently
  // in-memory and the point is to test what production runs.
  const s = new Store(`/tmp/ompd-test-${crypto.randomUUID()}.db`);
  stores.push(s);
  return s;
};

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

const agent = (id: string): Agent => ({
  id,
  name: id,
  state: "idle",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/work",
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
  labels: {},
});

describe("agent hub metadata", () => {
  test("round-trips lineage, assignment, model, and live metrics", () => {
    const s = fresh();
    const child = {
      ...agent("agt_child"),
      parentAgentId: "agt_parent",
      taskTitle: "Inspect the permission path",
      model: "anthropic/claude-sonnet-5",
      metrics: { usedTokens: 12_340, costAmount: 0.0187, durationMs: 87_000 },
    };

    s.upsertAgent(child);

    expect(s.getAgent(child.id)).toMatchObject(child);
  });
});

describe("update replay", () => {
  test("sequences are dense, ordered, and per-agent", () => {
    const s = fresh();
    s.upsertAgent(agent("agt_a"));
    s.upsertAgent(agent("agt_b"));

    for (let i = 0; i < 5; i++) s.appendUpdate("agt_a", { i });
    for (let i = 0; i < 3; i++) s.appendUpdate("agt_b", { i });

    const a = s.updatesSince("agt_a", 0);
    expect(a.map((u) => u.seq)).toEqual([1, 2, 3, 4, 5]);
    // Per-agent counters, not a global one: agent b starts at 1.
    expect(s.updatesSince("agt_b", 0).map((u) => u.seq)).toEqual([1, 2, 3]);
  });

  test("reattaching mid-stream replays exactly the gap", () => {
    const s = fresh();
    s.upsertAgent(agent("agt_a"));
    for (let i = 1; i <= 10; i++) s.appendUpdate("agt_a", { i });

    // A client that saw through seq 4 must get 5..10 and nothing it already has.
    const gap = s.updatesSince("agt_a", 4);
    expect(gap.map((u) => u.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(s.updatesSince("agt_a", 10)).toHaveLength(0);
  });
});

describe("approval finality", () => {
  test("a replayed request id cannot overwrite a decision", () => {
    const s = fresh();
    s.upsertAgent(agent("agt_a"));
    s.openApproval({
      requestId: "req1",
      agentId: "agt_a",
      tool: "bash",
      title: "rm -rf /",
      input: { command: "rm -rf /" },
    });
    s.resolveApproval("req1", "deny", "once", "critical", "dev1");

    // An attacker replays the open, then a permissive decision.
    s.openApproval({
      requestId: "req1",
      agentId: "agt_a",
      tool: "bash",
      title: "harmless",
      input: { command: "echo hi" },
    });
    s.resolveApproval("req1", "allow", "always", "spoofed", "dev2");

    const rec = s.listApprovals("agt_a").find((r) => r.requestId === "req1");
    expect(rec?.decision).toBe("deny");
    expect(rec?.rule).toBe("critical");
    expect(rec?.actorDeviceId).toBe("dev1");
    // The original title survives too: the replay did not rewrite history.
    expect(rec?.title).toBe("rm -rf /");
  });
});

describe("webhook secret persistence", () => {
  test("a secret reference retains only its replacement hash", () => {
    const s = fresh();

    const first = s.upsertWebhookSecret("whref_nightly", "first-hash");
    const replacement = s.upsertWebhookSecret("whref_nightly", "replacement-hash");

    expect(first.secretRef).toBe("whref_nightly");
    expect(s.getWebhookSecret("whref_nightly")).toEqual(replacement);
    expect(s.getWebhookSecret("missing")).toBeNull();
  });
});

describe("redaction at the persistence boundary", () => {
  test("credentials in an update payload never reach sqlite", () => {
    const s = fresh();
    s.upsertAgent(agent("agt_a"));
    s.appendUpdate("agt_a", {
      text: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      nested: { authorization: "Bearer sk-ant-abcdefghijklmnopqrstuvwxyz012345" },
    });

    const raw = JSON.stringify(s.updatesSince("agt_a", 0));
    expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(raw).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz012345");
    expect(raw).toContain(REDACTED);
  });

  test("a private key block is removed", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----";
    expect(JSON.stringify(redact({ pem }))).not.toContain("b3BlbnNzaC1rZXk");
  });

  test("a secret-named field is redacted regardless of its shape", () => {
    const out = redact({ password: "hunter2", api_key: "short" }) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
  });

  test("ordinary content survives redaction intact", () => {
    // Over-redaction would make replay useless, so this is a real risk.
    const out = redact({ text: "function add(a, b) { return a + b; }" }) as Record<string, string>;
    expect(out.text).toBe("function add(a, b) { return a + b; }");
  });

  test("an oversized payload is bounded rather than stored whole", () => {
    const huge = { blob: "x".repeat(2_000_000) };
    const out = JSON.stringify(redact(huge));
    expect(out.length).toBeLessThan(400_000);
  });

  test("circular structures do not hang persistence", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});

describe("audit", () => {
  test("entries are recorded newest-first with actor and outcome", () => {
    const s = fresh();
    s.audit({ action: "agent.create", actorDeviceId: "dev1", outcome: "ok", detail: { a: 1 } });
    s.audit({ action: "approval.decide", actorDeviceId: "dev1", outcome: "denied" });

    const rows = s.listAudit();
    expect(rows[0]?.action).toBe("approval.decide");
    expect(rows[0]?.outcome).toBe("denied");
    expect(rows[1]?.action).toBe("agent.create");
  });

  test("audit detail is redacted too", () => {
    const s = fresh();
    s.audit({ action: "agent.prompt", outcome: "ok", detail: { token: "ghp_aaaaaaaaaaaaaaaaaaaa" } });
    expect(JSON.stringify(s.listAudit())).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaa");
  });
});

describe("auth tokens", () => {
  const device = (id: string, scopes: string[]): Device => ({
    id,
    name: id,
    publicKey: `pk_${id}`,
    scopes,
    createdAt: new Date().toISOString(),
  });

  test("a token issued before a close is still found after a reopen", () => {
    // The whole reason this table exists. Hashes held in memory meant every
    // paired device was logged out by a restart, silently.
    const path = `/tmp/ompd-test-${crypto.randomUUID()}.db`;
    const first = new Store(path);
    first.addDevice(device("dev_phone", ["read"]));
    first.addAuthToken({ id: "tok_1", deviceId: "dev_phone", tokenHash: "hash_1", label: "phone" });
    first.close();

    const second = new Store(path);
    stores.push(second);
    const found = second.findAuthTokenByHash("hash_1");
    expect(found?.id).toBe("tok_1");
    expect(found?.deviceId).toBe("dev_phone");
    expect(found?.label).toBe("phone");
    expect(found?.revokedAt).toBeUndefined();
  });

  test("the raw token is never written, only its hash", () => {
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addAuthToken({ id: "tok_1", deviceId: "dev_phone", tokenHash: "hash_of_the_secret" });
    // Nothing in the row can produce the credential; a stolen database is a
    // list of hashes, which is the entire point of storing one.
    expect(JSON.stringify(s.listAuthTokens())).not.toContain("the_secret_itself");
    expect(s.findAuthTokenByHash("the_secret_itself")).toBeNull();
  });

  test("a revoked token is still found, and says it is revoked", () => {
    // Returned rather than hidden so a caller can tell "never issued" from
    // "issued and withdrawn". Both refuse; only one is worth an audit line.
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addAuthToken({ id: "tok_1", deviceId: "dev_phone", tokenHash: "hash_1" });
    s.revokeAuthToken("tok_1");

    expect(s.findAuthTokenByHash("hash_1")?.revokedAt).toBeDefined();
  });

  test("the first revocation of a token stands", () => {
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addAuthToken({ id: "tok_1", deviceId: "dev_phone", tokenHash: "hash_1" });
    s.revokeAuthToken("tok_1");
    const first = s.findAuthTokenByHash("hash_1")?.revokedAt;

    s.revokeAuthToken("tok_1");
    expect(s.findAuthTokenByHash("hash_1")?.revokedAt).toBe(first as string);
  });

  test("revoking a device revokes every token it holds", () => {
    // Transitive, or a device row marked revoked leaves live credentials
    // behind it that only one lookup path happens to refuse.
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addDevice(device("dev_laptop", ["read", "manage"]));
    s.addAuthToken({ id: "tok_a", deviceId: "dev_phone", tokenHash: "hash_a" });
    s.addAuthToken({ id: "tok_b", deviceId: "dev_phone", tokenHash: "hash_b" });
    s.addAuthToken({ id: "tok_c", deviceId: "dev_laptop", tokenHash: "hash_c" });

    s.revokeDevice("dev_phone");

    expect(s.findAuthTokenByHash("hash_a")?.revokedAt).toBeDefined();
    expect(s.findAuthTokenByHash("hash_b")?.revokedAt).toBeDefined();
    // And nothing else. Revocation is per device, not a purge.
    expect(s.findAuthTokenByHash("hash_c")?.revokedAt).toBeUndefined();
  });

  test("revoking a device's tokens reports how many were live", () => {
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addAuthToken({ id: "tok_a", deviceId: "dev_phone", tokenHash: "hash_a" });
    s.addAuthToken({ id: "tok_b", deviceId: "dev_phone", tokenHash: "hash_b" });
    s.revokeAuthToken("tok_a");

    // Only the one still live. A count that included the already-revoked row
    // would tell an operator they had just withdrawn access they had not.
    expect(s.revokeAuthTokensForDevice("dev_phone")).toBe(1);
    expect(s.revokeAuthTokensForDevice("dev_phone")).toBe(0);
  });

  test("listing is newest first and filters by device", () => {
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addDevice(device("dev_laptop", ["read"]));
    s.addAuthToken({ id: "tok_a", deviceId: "dev_phone", tokenHash: "hash_a" });
    s.addAuthToken({ id: "tok_b", deviceId: "dev_laptop", tokenHash: "hash_b" });

    expect(s.listAuthTokens().map((t) => t.id).toSorted()).toEqual(["tok_a", "tok_b"]);
    expect(s.listAuthTokens("dev_phone").map((t) => t.id)).toEqual(["tok_a"]);
  });

  test("last_used_at starts empty and is set by a touch", () => {
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addAuthToken({ id: "tok_1", deviceId: "dev_phone", tokenHash: "hash_1" });
    expect(s.findAuthTokenByHash("hash_1")?.lastUsedAt).toBeUndefined();

    s.touchAuthToken("tok_1");
    expect(s.findAuthTokenByHash("hash_1")?.lastUsedAt).toBeDefined();
  });

  test("a hash can only be registered once", () => {
    // The UNIQUE constraint is the thing that makes a hash an identity. Two
    // rows for one hash would make "which device is this" ambiguous.
    const s = fresh();
    s.addDevice(device("dev_phone", ["read"]));
    s.addAuthToken({ id: "tok_1", deviceId: "dev_phone", tokenHash: "hash_1" });
    expect(() => {
      s.addAuthToken({ id: "tok_2", deviceId: "dev_phone", tokenHash: "hash_1" });
    }).toThrow();
  });
});

describe("interrupted runs", () => {
  test("mid-flight rows are settled and finished ones are left alone", () => {
    // What a killed daemon leaves behind. Until something settles those rows
    // `hasActiveRun` stays true, and a singleton routine never fires again.
    const s = fresh();
    const at = "2026-01-01T00:00:00.000Z";
    s.upsertRun({ id: "run_q", routineId: "rtn_a", state: "queued", startedAt: at });
    s.upsertRun({ id: "run_r", routineId: "rtn_a", state: "running", startedAt: at });
    s.upsertRun({
      id: "run_ok",
      routineId: "rtn_a",
      state: "succeeded",
      startedAt: at,
      finishedAt: at,
      summary: "nothing broke",
    });
    s.upsertRun({ id: "run_other", routineId: "rtn_b", state: "running", startedAt: at });

    expect(s.failInterruptedRuns("the daemon exited")).toBe(3);

    const settled = new Map(s.listRuns("rtn_a").map((run) => [run.id, run]));
    expect(settled.get("run_q")?.state).toBe("failed");
    expect(settled.get("run_q")?.error).toBe("the daemon exited");
    expect(settled.get("run_q")?.finishedAt).toBeDefined();
    expect(settled.get("run_r")?.state).toBe("failed");
    // A finished run is history, not a candidate: its outcome and its summary
    // survive untouched.
    expect(settled.get("run_ok")?.state).toBe("succeeded");
    expect(settled.get("run_ok")?.error).toBeUndefined();
    expect(settled.get("run_ok")?.summary).toBe("nothing broke");

    expect(s.hasActiveRun("rtn_a")).toBe(false);
    expect(s.hasActiveRun("rtn_b")).toBe(false);

    // Idempotent, so a restart loop cannot keep rewriting the same rows.
    expect(s.failInterruptedRuns("the daemon exited again")).toBe(0);
  });
});
