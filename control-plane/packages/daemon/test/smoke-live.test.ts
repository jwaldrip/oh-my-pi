/**
 * Live smoke test against a real `omp acp` child process.
 *
 * The scripted-peer tests in `permission-path.test.ts` prove ompd's logic. This
 * proves the assumption underneath all of it: that OMP genuinely asks before
 * running a built-in tool, and genuinely does not run it when told no. A fake
 * cannot establish that, because a fake is written by the same person who wrote
 * the assumption.
 *
 * Gated behind OMPD_LIVE=1: it spends real model tokens. Run it before trusting
 * a release, not on every save.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, Store, type Actor } from "@ompd/core";
import { Supervisor, type PendingApproval } from "../src/supervisor.ts";

const d = process.env.OMPD_LIVE === "1" ? describe : describe.skip;

d("live omp acp", () => {
  const workdir = mkdtempSync(join(tmpdir(), "ompd-live-"));
  const store = new Store(join(workdir, "ompd.db"));
  let approvals: Array<Omit<PendingApproval, "resolve">> = [];
  const sup = new Supervisor({
    store,
    approvalTimeoutMs: 10_000,
    events: { onApprovalNeeded: (p) => approvals.push(p) },
  });

  store.addDevice({
    id: "operator",
    name: "operator",
    publicKey: "pk",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
    createdAt: new Date().toISOString(),
  });
  const operator: Actor = {
    deviceId: "operator",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };

  afterAll(async () => {
    await sup.shutdown();
    store.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  test(
    "a real agent cannot touch the filesystem when the gate is not answered",
    async () => {
      approvals = [];
      const marker = join(workdir, "denied.txt");
      const agent = await sup.createAgent({ name: "live-deny", cwd: workdir }, operator);

      await sup.prompt(
        agent.id,
        `Use your bash tool to run exactly: touch ${marker}\nThat is the entire task.`,
        operator,
      );

      expect(approvals.length).toBeGreaterThan(0);
      expect(existsSync(marker)).toBe(false);
    },
    180_000,
  );

  test(
    "the same agent does touch the filesystem once an operator approves",
    async () => {
      approvals = [];
      const marker = join(workdir, "allowed.txt");
      const agent = await sup.createAgent({ name: "live-allow", cwd: workdir }, operator);

      const turn = sup.prompt(
        agent.id,
        `Use your bash tool to run exactly: touch ${marker}\nThat is the entire task.`,
        operator,
      );

      const deadline = Date.now() + 60_000;
      let approved = false;
      while (Date.now() < deadline && !approved) {
        const p = approvals[0];
        if (p) approved = sup.decide(p.requestId, "allow", "once", operator);
        if (!approved) await Bun.sleep(150);
      }

      expect(approved).toBe(true);
      await turn;
      expect(existsSync(marker)).toBe(true);
    },
    180_000,
  );
});
