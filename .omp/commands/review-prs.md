# Review PRs

Parallel PR triage: decide merge-worthiness, examine each PR in an OMP-managed isolated task, and return findings and blocker fixes for human review.

## Arguments

`$ARGUMENTS` optional:
- space/comma-separated PR numbers/URLs; or
- GitHub-search qualifiers (`is:open`, `author:foo`, `label:bug`, `draft:false`, ...) and/or time window (`3d`, `2w`, `12h`).

No PRs or flags: all open PRs opened in last 3 days.

## 1. Resolve PRs

Parse `$ARGUMENTS`. Explicit numbers/URLs: use verbatim. Otherwise `github` `op: search_prs`; no-args default:

```
github { op: "search_prs", query: "is:open", since: "3d", limit: 50 }
```

Pass supplied qualifiers verbatim in `query`; add `is:open` unless present. Time window (`3d`, `2w`, `12h`, ISO date; see `github` docs): `since`. `dateField` defaults `created`; set `"updated"` only on explicit request for recently-touched PRs. Print resolved set before fan-out for scope confirmation.

## 2. One parallel `task` subagent/PR

Assign each PR's number, head ref, author, and workflow to a `task` with `isolated: true`. Coordinate only if fixes on separate PRs obviously conflict.

### Required subagent workflow

#### Read and decide

1. Read `pr://<N>` (comments default; `?comments=0` skips) and `pr://<N>/diff` (changed-file listing). Full unified diff: `pr://<N>/diff/all`; file slice: `pr://<N>/diff/<i>`.
2. Check `git log origin/main` and `gh search prs` for an already-landed equivalent.
3. Decision:
   - `slop`: AI-generated noise, broken, off-spec, or net-negative. Drop; 1–2-line justification; no checkout.
   - `superseded`: fixed/merged in main or newer PR. Drop with pointer.
   - `worthy`: proceed.

Ambiguous: `worthy`; human decides on a real branch.

#### Prepare the PR in the assigned workspace

Fetch the PR head and record its SHA. In the isolated workspace only, apply the
diff from the task's initial HEAD to the fetched PR head so the working files
match the PR snapshot; do not change the managed checkout's branch. If this
cannot be applied cleanly, report the blocker rather than modifying another
workspace. Do not link shared build outputs into this workspace. In particular,
never symlink all of `packages/natives/native/`, which would shadow tracked files.

Compare the PR head with the current base and report conflicts or a stale base.
Do not rebase or rewrite the author's branch.

#### Review and fix

Review for correctness, security, regressions, breaking-change impact, and new-path test coverage. Fix merge blockers only: build/test failure, obvious PR-introduced bugs, or edge cases required by the PR's goal. Do NOT taste-rewrite, unrelated-refactor, or expand scope.

Each fix: read existing patterns; follow `AGENTS.md` conventions; add/update behavior-change tests; run targeted area test files only—no project-wide subagent tests. End with `bun fmt` over union of edited files.

#### Return fixes

Keep fixes in the assigned workspace. Return the fix-only diff relative to the
recorded PR head, separately from the PR's own changes, and identify the head
SHA. The parent must not integrate the task's entire patch as a new change:
it contains the PR snapshot as well as any fixes. Do not amend author commits,
push, merge, or force-push author history; a human reviews and merges.

#### Report

Return:

```
PR #<N>  <title>
Decision: worthy | slop | superseded
PR head:  <recorded SHA, or not prepared>
Base:     current | stale | conflicts (details)
Fixes:    <fix-only diff relative to PR head, or none needed>
Blockers: <anything the human must decide>
```

## 3. Aggregate

After all agents finish, print:

```
| PR | Title | Decision | Base | Fixes | Blockers |
|----|-------|----------|--------|-------|----------|
```

Group findings by decision. Return fix-only diffs with their PR head SHAs.

## Rules

- MUST use parallel subagents, one/PR; NEVER serial loop.
- `slop`/`superseded`: skip checkout; record decision only.
- Fixes limited to merge blockers in that PR's diff.
- MUST NOT push or merge; human reviews and merges.
