# Fix Issues Command

Diagnose, reproduce, then fix reproducible open GitHub issues in parallel, one isolated task per issue. Each fix comes back as a commit, and the dispatching session integrates it onto its own branch.

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

## 2. Preconditions, then parallel subagents

Check these before dispatching anything. If any fails, stop and report the failed check. Do not fall back to editing the primary checkout.

- `omp config get task.isolation.enabled --json` reports `true`. Without it, `isolated` is refused.
- `omp config get task.isolation.apply --json` reports `false`. This keeps each child's captured change out of the dispatching checkout. With apply on, every child's fix would land uncommitted in the checkout this command runs from, which breaks the rule that work must be recoverable. Setting `apply` is a project decision, so this command does not set it.
- `git rev-parse --show-toplevel` gives the primary checkout, recorded as `MAIN`.

Then dispatch one `task` per issue with `isolated: true`, in parallel. Assignment: number, title, body summary, workflow below, and `MAIN`. Coordinate only if two issues clearly touch the same file.

Each subagent MUST:

### a. Read

1. Read `issue://<N>`; cross-repo: `issue://<owner>/<repo>/<N>`. Includes body/comments; comments often contain repro/fix hints. Append `?comments=0` only to explicitly skip comments.
2. Run `gh search prs` for the issue number. Reasonable existing PR → report `existing-pr` with its number. Do NOT create a competing fix.

### b. Prepare your workspace

Your workspace is the one the harness gave you. Record its base with `git rev-parse HEAD`. Before any build or test, symlink outputs from `MAIN` using absolute paths:

```bash
ln -snf "$MAIN/target"       "$PWD/target"
ln -snf "$MAIN/node_modules" "$PWD/node_modules"
for f in "$MAIN"/packages/natives/native/*.node; do
  [ -e "$f" ] && ln -snf "$f" "$PWD/packages/natives/native/"
done
```

Never symlink the whole `packages/natives/native/` directory: it shadows tracked source.

### c. Diagnose and reproduce

Reproduce in your own workspace, after step b.

1. Read the relevant source; state a concrete 1–2-sentence failure hypothesis.
2. Under the affected package, create a focused `repro-issue-<N>-<slug>.test.ts` (or `.rs`, etc.): unique, greppable, deletable.
3. Run only that file, never the suite. Confirm the expected failure.

- Reproduced → fix.
- Not reproduced → delete the test; report `unreproduced` with the hypothesis, non-failure evidence, and unblockers (versions, OS, config, author repro snippet). No commit.
- Out of scope or not a bug (user-config error, intended behavior, duplicate) → report `not-a-bug` with an issue-postable explanation. No commit.

### d. Fix

1. Keep the failing test in your workspace and confirm the failure there.
2. Fix the source, following `AGENTS.md` patterns: root cause, not symptom; no product-code stubs or mocks.
3. Re-run the repro until it passes.
4. If the real contract changed, add or adjust adjacent unit or contract tests; run only the affected files, never the full suite.
5. `bun fmt` the union of edited files.

### e. Commit

One logical conventional commit in your workspace, with the body and `Fixes #<N>`. This commit is what gets captured and integrated. Do NOT push and do NOT open a PR.

```bash
git add -A
git commit -m "fix(<scope>): <one-line summary>

<short body explaining root cause and the fix>

Fixes #<N>."
```

### f. Report

```
Issue #<N>  <title>
Status:    fixed | unreproduced | not-a-bug | existing-pr (#<M>)
Base:      <SHA your workspace started from>
Commit:    <SHA + one-liner>                        (if fixed)
Repro:     <test path in your workspace>            (if fixed)
Notes:     <root cause in one sentence; or what info is missing>
```

## 3. Integrate, in the dispatching session

After every subagent finishes, integrate each `fixed` result onto its own branch. Do not apply anything to `MAIN` or to any checkout with uncommitted work.

For each fixed issue, in turn:

```bash
git -C "$MAIN" fetch origin main
WT="$HOME/.omp/wt/<encoded-main>/fix-issue-<N>"
git -C "$MAIN" worktree add -b "fix/issue-<N>" "$WT" origin/main
```

Bring the subagent's commit onto that branch: `git -C "$WT" cherry-pick <commit>` if its commit is available, otherwise apply the captured change with `git -C "$WT" apply` and commit it with the subagent's message. Then run the repro test in `$WT` and confirm it passes. Report `integrated` with the branch and SHA.

If the change does not apply cleanly, or the repro does not pass there, report `not integrated` with the reason. Keep the captured artifact. Do not resolve conflicts by hand in `MAIN`.

## 4. Aggregate

After integration, print:

```
| # | Title | Status | Branch / Notes |
|---|-------|--------|----------------|
```

Group by status, `fixed` and `integrated` first, with each worktree path for batch review. Nothing is pushed, and no PR is opened, by this command.

## Rules

MUST: check the preconditions before dispatch and stop if one fails; use `isolated: true` on every subagent; reproduce in the subagent's own workspace after the symlink step; check for an existing PR first and divert reasonable ones to `review-prs`; commit each fix; integrate only into new `fix/issue-<N>` worktrees.

MUST NOT: push, open PRs, or comment on issues; apply any subagent output to `MAIN` or any checkout with uncommitted work; symlink the whole `packages/natives/native/` directory; ship stubs, product-code mocks, or `TODO: implement` placeholders; expand beyond the reported bug into adjacent code smells.

Failed repro → delete the temporary test in the subagent's workspace before yielding.
