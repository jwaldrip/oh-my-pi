/**
 * The correlation a live probe uses to decide whether a mutation was gated.
 *
 * These are regression tests for a checker that lied. `check-routine-live.ts`
 * joined gate-2 approval ids against ACP `toolCallId`s, matched nothing ever,
 * and reported a fully closed write gate as a hole. Two properties have to hold
 * forever: an `elc_*` row must account for the call it belongs to, and a real
 * hole must still be reported.
 */

import { describe, expect, test } from "bun:test";
import {
  coverFor,
  subjectsOf,
  uncoveredMutations,
  type ApprovalSubject,
  type CallSubject,
} from "../../../scripts/gate-correlation.ts";

const MARKER = "/tmp/ompd-routine-live-work-vCgsP3/routine-marker.txt";

/** The exact shapes observed in a kept `--phase write` run. */
const editCall: CallSubject = {
  id: "toolu_017zXDPwPfdtUaryJ4mN5jgn",
  kind: "edit",
  title: "Creating marker file",
  paths: [MARKER],
  command: null,
};

const writeApproval: ApprovalSubject = {
  requestId: "elc_c834098614ec4c5a",
  tool: "write",
  input: { paths: [MARKER] },
  decision: "allow",
  rule: "write:workspace",
};

describe("gate correlation", () => {
  test("an elc_ row accounts for the toolu_ call it belongs to", () => {
    // The regression. These two ids share no namespace and never will, because
    // elicitation/create carries no toolCallId. Joining on the subject is the
    // only join available.
    expect(editCall.id.startsWith("toolu_")).toBe(true);
    expect(writeApproval.requestId.startsWith("elc_")).toBe(true);

    const cover = coverFor(editCall, [writeApproval]);
    expect(cover).toHaveLength(1);
    expect(cover[0]?.rule).toBe("write:workspace");
    expect(uncoveredMutations([editCall], [writeApproval])).toEqual([]);
  });

  test("the ACP kind and the policy tool disagree by name, and it does not matter", () => {
    // `edit` against `write` is why a name join is not the fix either.
    expect(editCall.kind).toBe("edit");
    expect(writeApproval.tool).toBe("write");
    expect(coverFor(editCall, [writeApproval])).toHaveLength(1);
  });

  test("a mutation with no approval row at all is still reported", () => {
    // The property the broken join was meant to defend. It has to survive the
    // fix, or the check would have been made quiet rather than correct.
    const uncovered = uncoveredMutations([editCall], []);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.title).toBe("Creating marker file");
  });

  test("an approval for a different path does not account for this one", () => {
    const elsewhere: ApprovalSubject = {
      requestId: "elc_0000000000000001",
      tool: "write",
      input: { paths: ["/tmp/some-other-file.txt"] },
      decision: "allow",
      rule: "write:workspace",
    };
    expect(coverFor(editCall, [elsewhere])).toEqual([]);
    expect(uncoveredMutations([editCall], [elsewhere])).toHaveLength(1);
  });

  test("non-mutating kinds are never reported, however they are decided", () => {
    // Before the fix these printed NEVER ASKED too. They were only spared a
    // failure by the mutating-kind filter, which hid how broken the join was.
    const think: CallSubject = { id: "toolu_a", kind: "think", title: "Plan", paths: [], command: null };
    const read: CallSubject = { id: "toolu_b", kind: "read", title: "Verify", paths: [MARKER], command: null };
    expect(uncoveredMutations([think, read], [])).toEqual([]);
  });

  test("a shell call is accounted for by a row naming the same command", () => {
    const exec: CallSubject = {
      id: "toolu_c",
      kind: "execute",
      title: "echo hello",
      paths: [],
      command: "echo hello-from-ompd",
    };
    const bashApproval: ApprovalSubject = {
      requestId: "toolu_c",
      tool: "bash",
      input: { command: "echo hello-from-ompd" },
      decision: "allow",
      rule: "operator",
    };
    expect(coverFor(exec, [bashApproval])).toHaveLength(1);
    expect(uncoveredMutations([exec], [bashApproval])).toEqual([]);

    const other = { ...bashApproval, input: { command: "echo something-else" } };
    expect(uncoveredMutations([exec], [other])).toHaveLength(1);
  });

  test("a mutation naming neither a path nor a command is reported, not waved through", () => {
    // An unidentifiable mutation cannot be shown to have been gated. In a probe
    // that has to read as a failure.
    const opaque: CallSubject = { id: "toolu_d", kind: "delete", title: "?", paths: [], command: null };
    expect(uncoveredMutations([opaque], [writeApproval])).toHaveLength(1);
  });

  test("subject extraction tolerates the spellings both sides actually use", () => {
    // The tool call says `path`, the approval says `paths`. A probe that missed
    // one of those would invent a gate hole.
    expect(subjectsOf({ path: MARKER }).paths).toEqual([MARKER]);
    expect(subjectsOf({ paths: [MARKER] }).paths).toEqual([MARKER]);
    expect(subjectsOf({ command: "ls" }).command).toBe("ls");
    expect(subjectsOf(null).paths).toEqual([]);
    expect(subjectsOf("nonsense").paths).toEqual([]);
    // Duplicates across spellings collapse, so a count is never inflated.
    expect(subjectsOf({ path: MARKER, paths: [MARKER] }).paths).toEqual([MARKER]);
  });
});
