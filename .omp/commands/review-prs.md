# Review PRs

Parallel PR triage: review PRs read-only in OMP-managed isolated tasks and return findings. Prepare blocker fixes only when the assigned workspace already matches the PR head.

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

#### Inspect the PR without changing the workspace

Read the PR diff and relevant files at its recorded head SHA using GitHub or
read-only Git commands. Compare that head with the current base and report a
stale base or conflicts when established. Do not apply the PR snapshot, switch
branches, rebase, or modify another checkout. An isolated task's changes are
applied to its parent, so importing the PR snapshot would import it there too.

#### Review and fix

Review for correctness, security, regressions, breaking-change impact, and
new-path test coverage. Fix only merge blockers in the PR's diff; do not expand
scope. A task may edit and test a fix only if its assigned workspace starts
clean at the exact recorded PR head SHA. In that case, read existing patterns,
follow `AGENTS.md`, add or update behavior-change tests, run targeted files, and
format the edited files. Return only the fix as the task patch.

Otherwise, keep the task read-only and report the evidence, proposed fix, and
that the fix and tests were not exercised. A separate session whose OMP-assigned
workspace starts at that PR head can implement and verify it. Never import a PR
snapshot into a child patch to make a fix appear applicable.

Do not amend author commits, push, merge, or force-push author history; a human
reviews and merges. Never symlink all of `packages/natives/native/`, which would
shadow tracked files.

#### Report

Return:

```
PR #<N>  <title>
Decision: worthy | slop | superseded
PR head:  <recorded SHA>
Base:     current | stale | conflicts | unknown (evidence)
Fixes:    <fix-only task patch if workspace matched PR head; otherwise proposed fix or none>
Blockers: <anything the human must decide>
```

## 3. Aggregate

After all agents finish, print:

```
| PR | Title | Decision | Base | Fixes | Blockers |
|----|-------|----------|--------|-------|----------|
```

Group findings by decision. Identify fix-only patches and the PR head SHA each was based on.

## Rules

- MUST use parallel subagents, one/PR; NEVER serial loop.
- `slop`/`superseded`: record decision only.
- Fixes are limited to merge blockers in that PR's diff, and are returned only from a clean task workspace already at that PR head.
- MUST NOT push or merge; human reviews and merges.
