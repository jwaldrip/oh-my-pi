/**
 * The evolution loop: observe, propose, isolate, evaluate, operator, promote.
 *
 * The loop is deliberately not closed. `observe` drafts, and drafting is where
 * automation stops. Nothing in this file lets a draft reach `promote` without an
 * operator, and the type system is the first line of that: `observe` returns
 * `ProposalDraft`, which has no id and is never persisted, while `promote` takes
 * an id that only `submit` can mint. There is no overload, no flag, and no
 * option that joins the two.
 *
 * Three gates run before anything is committed:
 *
 * 1. `submit` gates the diff. Protected paths archive it immediately.
 * 2. `evaluate` gates it again before spending a worktree on it.
 * 3. `promote` gates it a third time, immediately before committing.
 *
 * The repetition is not redundancy. The proposal row is a mutable surface: a
 * row edited in SQLite between submission and promotion would otherwise carry a
 * clean verdict for a diff nobody gated. Paths are always re-derived from the
 * diff that is about to be applied.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCOPE_MANAGE,
  type Actor,
  type AuditEntry,
  type Proposal,
  type Store,
} from "@ompd/core";
import { UnauthorizedError } from "../supervisor.ts";
import { evaluateProposal } from "./gate.ts";
import { ProposalStore } from "./proposal-store.ts";
import { evaluateInWorktree } from "./worktree.ts";

export interface EvolutionEngineOptions {
  store: Store;
  proposals: ProposalStore;
  /** The repository the daemon runs from. Promotion commits here. */
  repoRoot: string;
  /** Verification command run inside the isolated worktree. */
  verifyCommand?: string[];
  timeoutMs?: number;
  /** Failures of one action needed before `observe` drafts anything. */
  observeThreshold?: number;
}

export interface SubmitProposalInput {
  title: string;
  rationale: string;
  diff: string;
  /**
   * The author's claim about what the diff touches. Recorded in the audit trail
   * so an under-report is visible after the fact, and otherwise ignored: the
   * gate derives paths from the diff.
   */
  touchedPaths?: string[];
}

/**
 * The output of `observe`.
 *
 * Structurally distinct from `Proposal`: no id, no state, no verdict. A draft
 * cannot be evaluated or promoted because neither method can accept one, and it
 * is not written to the proposal store. Entering the pipeline requires a caller
 * to read the draft and call `submit`, which is the intended human step.
 */
export interface ProposalDraft {
  title: string;
  rationale: string;
  diff: string;
  evidence: ObservationEvidence;
}

export interface ObservationEvidence {
  action: string;
  failures: number;
  /** Distinct failure reasons seen, newest first, capped for readability. */
  reasons: string[];
}

interface GitResult {
  code: number;
  output: string;
}

const DEFAULT_VERIFY_COMMAND: readonly string[] = ["bun", "test"];
const DEFAULT_OBSERVE_THRESHOLD = 3;
const AUDIT_SCAN_LIMIT = 500;

export class EvolutionEngine {
  #store: Store;
  #proposals: ProposalStore;
  #repoRoot: string;
  #verifyCommand: string[];
  #timeoutMs: number | undefined;
  #observeThreshold: number;

  constructor(opts: EvolutionEngineOptions) {
    this.#store = opts.store;
    this.#proposals = opts.proposals;
    this.#repoRoot = opts.repoRoot;
    this.#verifyCommand = [...(opts.verifyCommand ?? DEFAULT_VERIFY_COMMAND)];
    this.#timeoutMs = opts.timeoutMs;
    this.#observeThreshold = opts.observeThreshold ?? DEFAULT_OBSERVE_THRESHOLD;
  }

  /**
   * Gate a diff and persist the result.
   *
   * A proposal touching a protected path lands in `archived` and never in
   * `submitted`, so it is not merely deprioritised: no later call can move it
   * forward, because `evaluate` only accepts `submitted`.
   */
  submit(input: SubmitProposalInput): Proposal {
    const claimed = input.touchedPaths ?? [];
    const candidate: Proposal = {
      id: `prop_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      title: input.title,
      rationale: input.rationale,
      diff: input.diff,
      touchedPaths: claimed,
      state: "submitted",
      createdAt: new Date().toISOString(),
    };

    const verdict = evaluateProposal(candidate);
    const stored: Proposal = {
      ...candidate,
      // The gate's paths replace the claim. This is the whole defence against a
      // diff that under-reports itself.
      touchedPaths: verdict.touchedPaths,
      state: verdict.nextState,
      verdict:
        verdict.outcome === "accepted" ? undefined : { passed: false, log: verdict.reason },
    };
    this.#proposals.upsert(stored);

    const underReported = verdict.touchedPaths.filter((p) => !claimed.includes(p));
    this.#store.audit({
      action: "proposal.submit",
      outcome: verdict.outcome === "accepted" ? "ok" : "denied",
      detail: {
        proposalId: stored.id,
        title: stored.title,
        state: stored.state,
        outcome: verdict.outcome,
        reason: verdict.reason,
        derivedPaths: verdict.touchedPaths,
        claimedPaths: claimed,
        underReportedPaths: underReported,
        protectedPaths: verdict.protectedPaths,
      },
    });

    return stored;
  }

  /**
   * Apply the diff in a throwaway worktree and run the verification command.
   *
   * Only a `submitted` proposal is eligible, which is what keeps an archived
   * proposal archived.
   */
  async evaluate(id: string): Promise<Proposal> {
    const proposal = this.#proposals.get(id);
    if (proposal === null) throw new Error(`unknown proposal ${id}`);
    if (proposal.state !== "submitted") {
      throw new Error(`proposal ${id} is ${proposal.state}, not submitted`);
    }

    // Re-gate. The row could have been edited since submission.
    const gate = evaluateProposal(proposal);
    if (gate.outcome !== "accepted") {
      const blocked: Proposal = {
        ...proposal,
        touchedPaths: gate.touchedPaths,
        state: gate.nextState,
        verdict: { passed: false, log: gate.reason },
      };
      this.#proposals.upsert(blocked);
      this.#store.audit({
        action: "proposal.reject",
        outcome: "denied",
        detail: { proposalId: id, phase: "evaluate", reason: gate.reason },
      });
      return blocked;
    }

    this.#proposals.upsert({ ...proposal, state: "evaluating" });

    const result = await evaluateInWorktree({
      repoRoot: this.#repoRoot,
      diff: proposal.diff,
      command: this.#verifyCommand,
      timeoutMs: this.#timeoutMs,
    });

    const settled: Proposal = {
      ...proposal,
      touchedPaths: gate.touchedPaths,
      state: result.passed ? "awaiting_review" : "rejected",
      verdict: result,
    };
    this.#proposals.upsert(settled);

    if (!result.passed) {
      this.#store.audit({
        action: "proposal.reject",
        outcome: "denied",
        detail: { proposalId: id, phase: "evaluate", reason: "verification failed" },
      });
    }

    return settled;
  }

  /**
   * Commit an approved proposal to the running tree.
   *
   * Requires `manage` scope held by a real paired device. The internal `daemon`
   * actor is refused here specifically, unlike everywhere else in the daemon:
   * an automated identity that can promote is an auto-promote setting wearing a
   * different hat.
   */
  async promote(id: string, actor: Actor): Promise<Proposal> {
    this.#authorize(actor, "proposal.promote", false);

    const proposal = this.#proposals.get(id);
    if (proposal === null) throw new Error(`unknown proposal ${id}`);
    if (proposal.state !== "awaiting_review") {
      throw new Error(`proposal ${id} is ${proposal.state}, not awaiting_review`);
    }

    // Third and final gating, immediately before the diff touches the real tree.
    const gate = evaluateProposal(proposal);
    if (gate.outcome !== "accepted") {
      const blocked: Proposal = {
        ...proposal,
        touchedPaths: gate.touchedPaths,
        state: gate.nextState,
        verdict: { passed: false, log: gate.reason },
      };
      this.#proposals.upsert(blocked);
      this.#store.audit({
        action: "proposal.reject",
        actorDeviceId: actor.deviceId,
        outcome: "denied",
        detail: { proposalId: id, phase: "promote", reason: gate.reason },
      });
      throw new Error(`proposal ${id} failed the gate at promotion: ${gate.reason}`);
    }

    const scratch = await mkdtemp(join(tmpdir(), "ompd-promote-"));
    const patchPath = join(scratch, "proposal.patch");
    try {
      await writeFile(
        patchPath,
        proposal.diff.endsWith("\n") ? proposal.diff : `${proposal.diff}\n`,
        "utf8",
      );

      const check = await this.#git(["apply", "--check", "--whitespace=nowarn", patchPath]);
      if (check.code !== 0) {
        throw new Error(`patch no longer applies to the running tree:\n${check.output}`);
      }

      // `--index` stages exactly what the patch changes, and the pathspec on
      // commit keeps unrelated dirty files in the operator's tree out of the
      // promotion commit.
      const apply = await this.#git(["apply", "--index", "--whitespace=nowarn", patchPath]);
      if (apply.code !== 0) throw new Error(`git apply failed:\n${apply.output}`);

      const message = `${proposal.title}\n\n${proposal.rationale}\n\nProposal: ${proposal.id}`;
      const commit = await this.#git(["commit", "-m", message, "--", ...gate.touchedPaths]);
      if (commit.code !== 0) throw new Error(`git commit failed:\n${commit.output}`);

      const head = await this.#git(["rev-parse", "HEAD"]);
      if (head.code !== 0) throw new Error(`git rev-parse failed:\n${head.output}`);
      const sha = head.output.trim();

      const promoted: Proposal = { ...proposal, state: "promoted", promotedCommit: sha };
      this.#proposals.upsert(promoted);
      this.#store.audit({
        action: "proposal.promote",
        actorDeviceId: actor.deviceId,
        outcome: "ok",
        detail: { proposalId: id, commit: sha, paths: gate.touchedPaths },
      });
      return promoted;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Undo a promotion with `git revert`.
   *
   * A revert is a new commit, so the promotion stays in history with its reason
   * attached. Rewriting history or editing the row back to `submitted` would
   * lose exactly the evidence an operator needs after a bad change.
   */
  async rollback(id: string, actor: Actor): Promise<Proposal> {
    // The daemon may roll back unattended. Undoing a change is the safe
    // direction, and the architecture's canary step depends on it.
    this.#authorize(actor, "proposal.rollback", true);

    const proposal = this.#proposals.get(id);
    if (proposal === null) throw new Error(`unknown proposal ${id}`);
    if (proposal.state !== "promoted" || proposal.promotedCommit === undefined) {
      throw new Error(`proposal ${id} is ${proposal.state} and has no promoted commit`);
    }

    const revert = await this.#git(["revert", "--no-edit", proposal.promotedCommit]);
    if (revert.code !== 0) {
      await this.#git(["revert", "--abort"]);
      throw new Error(`git revert failed:\n${revert.output}`);
    }

    const head = await this.#git(["rev-parse", "HEAD"]);
    const rolledBack: Proposal = { ...proposal, state: "rolled_back" };
    this.#proposals.upsert(rolledBack);
    this.#store.audit({
      // `proposal.rollback` is not in the frozen AuditAction union, and
      // contracts.ts may not be edited. A rollback is the withdrawal of a
      // promotion, so it is recorded as a rejection carrying both commits.
      action: "proposal.reject",
      actorDeviceId: actor.deviceId,
      outcome: "ok",
      detail: {
        proposalId: id,
        phase: "rollback",
        revertedCommit: proposal.promotedCommit,
        revertCommit: head.output.trim(),
      },
    });
    return rolledBack;
  }

  /**
   * Mine the audit log for repeated failures and draft candidate proposals.
   *
   * Drafting only, in both directions. Nothing is persisted, nothing is gated,
   * and the return type cannot be fed to `evaluate` or `promote`. Turning a
   * draft into a proposal is a deliberate call to `submit` by someone else.
   *
   * The drafted diff records the observation rather than attempting a fix.
   * Synthesising a corrective code change is a model's job, and a draft that
   * guessed at one would be a plausible-looking patch nobody wrote.
   */
  observe(store: Store): ProposalDraft[] {
    const entries: AuditEntry[] = store.listAudit(AUDIT_SCAN_LIMIT);
    const failuresByAction = new Map<string, AuditEntry[]>();

    for (const entry of entries) {
      if (entry.outcome !== "error" && entry.outcome !== "denied") continue;
      const bucket = failuresByAction.get(entry.action);
      if (bucket === undefined) {
        failuresByAction.set(entry.action, [entry]);
        continue;
      }
      bucket.push(entry);
    }

    const drafts: ProposalDraft[] = [];
    for (const [action, failures] of failuresByAction) {
      if (failures.length < this.#observeThreshold) continue;

      const reasons: string[] = [];
      for (const entry of failures) {
        const reason = typeof entry.detail.reason === "string" ? entry.detail.reason : entry.outcome;
        if (!reasons.includes(reason)) reasons.push(reason);
        if (reasons.length === 5) break;
      }

      const slug = action.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const path = `docs/evolution/${slug}.md`;
      const body = [
        `# Recurring failure: ${action}`,
        "",
        `Observed ${failures.length} failing \`${action}\` entries in the audit log.`,
        "",
        "Distinct reasons:",
        ...reasons.map((r) => `- ${r}`),
        "",
        "Drafted by the evolution engine from the audit log. No fix is proposed here;",
        "this records the pattern so an operator can decide what to change.",
      ];

      drafts.push({
        title: `Record recurring ${action} failures`,
        rationale: `${failures.length} failures of ${action} appear in the last ${AUDIT_SCAN_LIMIT} audit entries.`,
        diff: [
          `diff --git a/${path} b/${path}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${body.length} @@`,
          ...body.map((line) => `+${line}`),
          "",
        ].join("\n"),
        evidence: { action, failures: failures.length, reasons },
      });
    }

    return drafts;
  }

  /**
   * Authorization boundary, mirroring the supervisor: caller-supplied scopes are
   * a claim, and the paired device row is the truth.
   */
  #authorize(actor: Actor, action: string, allowDaemon: boolean): Actor {
    const deny = (reason: string): never => {
      this.#store.audit({
        action: "proposal.reject",
        actorDeviceId: actor.deviceId,
        outcome: "denied",
        detail: { action, reason },
      });
      throw new UnauthorizedError(`${action}: ${reason}`);
    };

    if (actor.deviceId === "daemon") {
      if (!allowDaemon) deny("promotion requires an operator, not the internal actor");
      if (!actor.scopes.includes(SCOPE_MANAGE)) deny(`missing ${SCOPE_MANAGE} scope`);
      return actor;
    }

    const device = this.#store.getDevice(actor.deviceId);
    if (!device) deny("unknown device");
    if (device?.revokedAt) deny("device revoked");

    const granted = device?.scopes ?? [];
    if (!granted.includes(SCOPE_MANAGE)) deny(`missing ${SCOPE_MANAGE} scope`);
    return { deviceId: device?.id ?? actor.deviceId, scopes: granted };
  }

  async #git(args: string[]): Promise<GitResult> {
    const proc = Bun.spawn(["git", "-C", this.#repoRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });
    await proc.exited;
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: proc.exitCode ?? -1, output: `${out}${err}` };
  }
}
