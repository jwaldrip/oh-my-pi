# Fix Issues Command

Diagnose, reproduce, then fix reproducible open GitHub issues in parallel, one isolated task per issue. The harness hands each task's change back through its configured native isolation. This command delivers each fix on its own `fix/issue-<N>` branch from that handoff, and never applies a change a second time.

## Arguments

`$ARGUMENTS` optional: space/comma-separated issue numbers/URLs, or GitHub-search qualifiers (`is:open`, `label:bug`, `author:foo`, ...) and/or time window (`3d`, `2w`, `12h`).

No issues/flags → all issues open and created within last 3 days.

## 1. Resolve issues

Parse `$ARGUMENTS`.

- Explicit numbers/URLs: use verbatim.
- Otherwise `github` `op: search_issues`. No args:

  ```
  github { op: "search_issues", query: "is:open", since: "3d", limit: 50 }
  ```

  User qualifiers verbatim in `query`; add `is:open` unless present. Time window (`3d`, `2w`, `12h`, ISO date; see `github` docs) → `since`. `dateField` defaults `created`; set `"updated"` only for explicitly requested recently-touched issues.

Print resolved set before fan-out for scope confirmation.

## 2. Preconditions, then dispatch

Every check must pass. If one fails, stop and report the check. Do not change config, and do not fall back to editing any checkout.

- `omp config get task.isolation.enabled --json` reports `true`. Without it, `isolated` is refused.
- `omp config get task.isolation.apply --json` reports `true`. This command relies on the native handoff, so it does not run when that handoff is off.
- `omp config get task.isolation.merge --json` reports `branch`. Under `patch`, the handoff applies every child's change uncommitted into the dispatching workspace, all mixed together. A per-issue commit cannot then be separated safely, so this command stops rather than guess.
- The dispatching session runs in a clean batch worktree that this run owns, whose HEAD is `origin/main`. Create it once with `git worktree add -b fix/batch-<timestamp> <path> origin/main` and start the session there. Confirm with `git rev-parse HEAD` and `git rev-parse origin/main`, which must match after `git fetch origin main`. Do not dispatch from the primary checkout: the handoff writes into the dispatching workspace.

Record `MAIN`, the primary checkout from `git rev-parse --show-toplevel` in the original checkout, for symlink sources.

Then dispatch one `task` per issue with `isolated: true`, in parallel. Assignment: number, title, body summary, workflow below, and `MAIN`. Coordinate only if two issues clearly touch the same file.

Each subagent MUST:

### a. Read

1. Read `issue://<N>`; cross-repo: `issue://<owner>/<repo>/<N>`. Includes body/comments; comments often contain repro/fix hints. Append `?comments=0` only to explicitly skip comments.
2. Run `gh search prs` for the issue number. Reasonable existing PR → report `existing-pr` with its number. Do NOT create a competing fix.

### b. Prepare your workspace

Your workspace is the one the harness gave you. Record its base with `git rev-parse HEAD`. Before any build or test, symlink outputs from `MAIN` using absolute paths, then exclude those symlinks from git so they are never captured as part of your change:

```bash
ln -snf "$MAIN/target"       "$PWD/target"
ln -snf "$MAIN/node_modules" "$PWD/node_modules"
for f in "$MAIN"/packages/natives/native/*.node; do
  [ -e "$f" ] && ln -snf "$f" "$PWD/packages/natives/native/"
done
printf '%s\n' target node_modules 'packages/natives/native/*.node' >> "$(git rev-parse --git-path info/exclude)"
```

Never symlink the whole `packages/natives/native/` directory: it shadows tracked source.

### c. Diagnose and reproduce

Reproduce in your own workspace, after step b.

1. Read the relevant source; state a concrete 1–2-sentence failure hypothesis.
2. Under the affected package, create a focused `repro-issue-<N>-<slug>.test.ts` (or `.rs`, etc.): unique, greppable, and kept with the fix as its regression test.
3. Run only that file, never the suite. Confirm the expected failure.

- Reproduced → fix.
- Not reproduced → delete the test; report `unreproduced` with the hypothesis, non-failure evidence, and unblockers (versions, OS, config, author repro snippet). Change nothing else.
- Out of scope or not a bug (user-config error, intended behavior, duplicate) → report `not-a-bug` with an issue-postable explanation. Change nothing.

### d. Fix

1. Confirm the failure in your workspace.
2. Fix the source, following `AGENTS.md` patterns: root cause, not symptom; no product-code stubs or mocks.
3. Re-run the repro until it passes.
4. If the real contract changed, add or adjust adjacent unit or contract tests; run only the affected files, never the full suite.
5. `bun fmt` the union of edited files.

### e. Leave the change for the handoff

Do NOT commit, push, or open a PR. Leave the change as uncommitted working-tree edits. The configured native handoff carries it back, committed to `omp/task/<id>` in branch mode, so a commit made here would be applied twice.

### f. Report

```
Issue #<N>  <title>
Status:    fixed | unreproduced | not-a-bug | existing-pr (#<M>)
Base:      <SHA your workspace started from>
Files:     <every path you changed, one per line>   (if fixed)
Repro:     <test path>                              (if fixed)
Notes:     <root cause in one sentence; or what info is missing>
```

## 3. Deliver, in the dispatching session

Run after every subagent has finished. The handoff has already put each fixed change into the batch worktree and committed it to `omp/task/<id>`. Deliver by naming those commits. Never re-apply a change.

For each `fixed` result, with `<id>` from its task record:

1. `git rev-parse --verify omp/task/<id>` must succeed. If it does not, the change was not committed by the handoff. Report `not integrated: no handoff branch`, and leave the batch worktree's uncommitted changes as they are. Do not commit them by hand: that would mix issues together.
2. `git log --oneline origin/main..omp/task/<id>` must show exactly one commit.
3. `git diff --name-only origin/main omp/task/<id>` must match the subagent's `Files:` list. A mismatch means the handoff and the report disagree, so report `not integrated: file mismatch` and create nothing.
4. Create the per-issue ref without a checkout: `git branch fix/issue-<N> omp/task/<id>`.
5. Check the commit message contains `Fixes #<N>`. If it does not, report that, and leave the wording for whoever opens the PR.

Do not check out, reset, or clean the batch worktree. Its handoff state is the native outcome and stays as it is.

A worktree is needed for a PR target only when a branch ref cannot be used, for example to push or to run tests on a branch. Create one for that issue alone, when needed. Do not create per-issue worktrees by default.

## 4. Aggregate

Print:

```
| # | Title | Status | Branch / Notes |
|---|-------|--------|----------------|
```

Group by status, `fixed` (with its `fix/issue-<N>` ref) first. Nothing is pushed, and no PR is opened, by this command.

## Rules

MUST: check every precondition before dispatch and stop if one fails; use `isolated: true` on every subagent; leave changes uncommitted for the handoff; deliver by naming `omp/task/<id>` and never by re-applying; keep the symlinks out of git; check for an existing PR first and divert reasonable ones to `review-prs`.

MUST NOT: change `task.isolation` config or any other config; dispatch from the primary checkout; push, open PRs, or comment on issues; apply any subagent output a second time or by hand; symlink the whole `packages/natives/native/` directory; ship stubs, product-code mocks, or `TODO: implement` placeholders; expand beyond the reported bug into adjacent code smells.

Failed repro → delete the temporary test in the subagent's workspace before yielding.
