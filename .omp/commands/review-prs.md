# Review PRs

Parallel PR triage: decide merge-worthiness with read-only reviewers, then fix merge blockers one PR at a time in a dedicated worktree for the human to push and merge.

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

## 2. Read-only review, one `task` per PR

Dispatch one `task` per PR, in parallel, **without** the `isolated` option. A review task only reads. It takes the PR diff from `pr://<N>/diff/all` (or `pr://<N>/diff/<i>` per file), reads files at the PR head with `git show <head-sha>:<path>` or the `github` file read, and runs `git log origin/main` and `gh search prs`. It never checks out, switches, resets, or writes to any checkout, so nothing it does can reach another workspace.

Each review task:

1. Reads `pr://<N>` (comments default; `?comments=0` skips) and the changed-file listing.
2. Checks `git log origin/main` and `gh search prs` for an already-landed equivalent.
3. Records the head SHA from the PR metadata. This is the SHA every later step refers to.
4. Decides:
   - `slop`: AI-generated noise, broken, off-spec, or net-negative. Drop; 1–2-line justification.
   - `superseded`: fixed or merged in main or a newer PR. Drop with pointer.
   - `worthy`: review for correctness, security, regressions, breaking-change impact, and new-path test coverage. Record each merge blocker with `file:line` evidence.

   Ambiguous: `worthy`; human decides on a real branch.
5. Compares the head with `origin/main` and reports `current`, `stale`, or `conflicts` with evidence.

Report:

```
PR #<N>  <title>
Decision: worthy | slop | superseded
PR head:  <full SHA>
Base:     current | stale | conflicts | unknown (evidence)
Blockers: <merge blockers with file:line evidence, or none>
```

## 3. Fix merge blockers, one PR at a time

Only for `worthy` PRs with blockers. The dispatching session does this itself. It is not a child task, because an isolated child starts from the parent's HEAD and not from a PR head, and it would have nothing to fix. Work through PRs sequentially.

**Preconditions.** Every one must hold. If any fails, record `fix: not attempted` with the failed check and move on.

- `github pr_checkout` created the worktree at `~/.omp/wt/<encoded-repo>/pr-<N>/`. Use this, never `gh pr checkout`, and never switch the primary checkout.
- `git -C <worktree> rev-parse HEAD` equals the recorded PR head SHA.
- `git -C <worktree> status --short` is empty.

**Artifacts.** Before any build or test in the worktree, symlink outputs from the primary checkout using absolute paths:

```bash
MAIN="$(git rev-parse --show-toplevel)"   # run from the primary checkout, before pr_checkout
WT="<worktree path>"
ln -snf "$MAIN/target"       "$WT/target"
ln -snf "$MAIN/node_modules" "$WT/node_modules"
for f in "$MAIN"/packages/natives/native/*.node; do
  [ -e "$f" ] && ln -snf "$f" "$WT/packages/natives/native/"
done
```

Never symlink the whole `packages/natives/native/` directory: it shadows tracked files the PR may change.

**Rebase, only if the base is stale.** `git fetch origin main && git rebase origin/main` inside the worktree. Mechanical conflicts (formatting, import order, adjacent edits): resolve and continue. Semantic conflicts: `git rebase --abort`, report, and do not commit. The rebase is local. Never push it.

**Fix.** Fix only merge blockers in the PR's own diff: build or test failure, an obvious PR-introduced bug, or an edge case the PR's goal requires. Do not taste-rewrite, refactor unrelated code, or expand scope. Each fix reads existing patterns, follows `AGENTS.md`, adds or updates behavior-change tests, and runs only the targeted test files, never the full suite. Run `bun fmt` over the union of edited files.

**Commit.** One conventional commit on the PR branch in the worktree:

```bash
git add -A
git commit -m "fix(<scope>): <what & why>

Addresses review feedback on #<PR>."
```

Do not amend author commits. Do not push, merge, or force-push. A human reviews the commit and pushes it with `github pr_push` if accepted.

Report:

```
PR #<N>  <title>
Worktree: ~/.omp/wt/.../pr-<N>
Fix:      <commit sha + one-liner>, or none needed, or not attempted (<check>)
Tests:    <targeted files run and their exit codes>
```

## 4. Aggregate

After every review task and every fix finishes, print:

```
| PR | Title | Decision | Base | Fixes | Blockers |
|----|-------|----------|------|-------|----------|
```

Then list the worktree paths and fix commit SHAs for the human to review, grouped by decision. Nothing is pushed or merged by this command.

## Rules

- Review tasks run in parallel and are read-only. They never use `isolated`, because nothing they do needs isolation.
- Fixes run one PR at a time in the `pr_checkout` worktree, under the preconditions above. This command never applies a task's output into any checkout.
- `slop` and `superseded` PRs: record the decision only, with no checkout.
- Fixes are limited to merge blockers in that PR's diff.
- MUST NOT push, merge, or force-push. A human reviews and merges.
