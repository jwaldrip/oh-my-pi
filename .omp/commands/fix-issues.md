# Fix Issues Command

Diagnose, reproduce, then fix reproducible open GitHub issues one at a time. Each issue runs in one isolated child task, and the child's change returns through the operator's configured handoff. The dispatching session verifies that already-integrated change, delivers it to its own `fix/issue-<N>` branch, cleans its workspace, and only then starts the next issue.

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

Print the resolved set before starting, for scope confirmation.

## 2. Preconditions

Check these once before the first issue. If any fails, stop and report the check. Change no configuration, and do not switch branches, reset, or clean any checkout.

- `omp config get task.isolation.enabled --json` reports `true`. Otherwise `isolated` is refused and nothing runs.
- `omp config get task.isolation.merge --json` reports `patch`. Under `branch`, the handoff commits each child's change onto the dispatching session's own branch. That moves the branch every issue is based on, so a later issue's branch would contain an earlier fix. Stop and report that blocker. Do not rewind the branch to work around it.
- `omp config get task.isolation.apply --json` reports `true`. If it reports `false`, nothing is integrated into the workspace, so there is no result to verify. Stop and report.
- `git fetch origin main`, then `git rev-parse HEAD` equals `git rev-parse origin/main`. Each issue branch must start from `origin/main`.
- `git status --porcelain` prints nothing, and no merge, rebase, or cherry-pick is in progress (`git rev-parse -q --verify MERGE_HEAD` and the `.git/rebase-*` and `.git/CHERRY_PICK_HEAD` paths are absent).
- Record `MAIN` as `git rev-parse --show-toplevel`. Children use it for build artifacts.

The dispatching session works in its harness-assigned workspace. If that workspace is a shared checkout, run this command only while no other live session is writing to it. The handoff writes into this workspace while a child runs, and another writer would see or mix with those changes.

## 3. One issue at a time

Repeat this loop for each issue in the resolved set, one at a time. Do not dispatch the next child until the previous issue is delivered and the workspace is clean again.

### 3a. Gate

Before dispatch, every check must pass:

- `git status --porcelain` prints nothing, and `git rev-parse HEAD` still equals `origin/main`.
- `git show-ref --verify --quiet refs/heads/fix/issue-<N>` fails. An existing branch is never overwritten.
- `gh search prs` for the issue number finds no reasonable open PR. If one exists, record `existing-pr (#<M>)`, divert it to `review-prs`, and move on. Do not create a competing fix.

If a check fails, stop the whole run and report the state. Do not skip to the next issue on a dirty or conflicting workspace.

### 3b. Dispatch one child

Dispatch one `task` with `isolated: true`. Assignment: number, title, body summary, the workflow in 3c, and `MAIN`. The child reads `issue://<N>` (cross-repo: `issue://<owner>/<repo>/<N>`); comments often hold repro hints, and `?comments=0` skips them only when explicitly asked.

The child MUST:

1. Record its base with `git rev-parse HEAD`.
2. Symlink build outputs from `MAIN` by absolute path, and exclude them from git so they are never part of the change:

   ```bash
   ln -snf "$MAIN/target"       "$PWD/target"
   ln -snf "$MAIN/node_modules" "$PWD/node_modules"
   for f in "$MAIN"/packages/natives/native/*.node; do
     [ -e "$f" ] && ln -snf "$f" "$PWD/packages/natives/native/"
   done
   printf '%s\n' target node_modules 'packages/natives/native/*.node' >> "$(git rev-parse --git-path info/exclude)"
   ```

   Never symlink the whole `packages/natives/native/` directory: it shadows tracked source.
3. Reproduce. Read the relevant source and state a concrete 1–2-sentence failure hypothesis. Create a focused `repro-issue-<N>-<slug>.test.ts` (or `.rs`, etc.). Run only that file, never the suite, and confirm the failure.
   - Not reproduced → delete the test. Report `unreproduced` with the hypothesis, the non-failure evidence, and what is needed to reproduce. Change nothing else.
   - Out of scope or not a bug → report `not-a-bug` with an issue-postable explanation. Change nothing.
4. Fix the root cause, following `AGENTS.md`. No product-code stubs or mocks. Re-run the repro until it passes. If the real contract changed, add or adjust adjacent unit or contract tests, running only the affected files. Run `bun fmt` over the edited files.
5. Leave the change uncommitted. Do NOT commit, push, or open a PR: the handoff carries the working-tree change.
6. Report:

   ```
   Issue #<N>  <title>
   Status:    fixed | unreproduced | not-a-bug | existing-pr (#<M>)
   Base:      <SHA>
   Subject:   fix(<scope>): <one-line summary>
   Files:     <every changed path, one per line>   (fixed only)
   Repro:     <test path>                          (fixed only)
   Notes:     <root cause in one sentence, or what information is missing>
   ```

### 3c. Verify the integrated result

After the child finishes, the handoff has already applied its change to this workspace, uncommitted. Verify before delivering anything. For a non-`fixed` status, verify that the workspace is still clean, then continue to the next issue.

- `git rev-parse HEAD` still equals `origin/main`.
- `git diff --name-only --diff-filter=U` prints nothing. Any conflicted path is a stop.
- `git status --porcelain` lists only paths from the child's `Files:` list, and every listed path appears. Any extra or missing path is a stop: report it and leave the workspace exactly as found.
- Untracked files appear only where the child listed them as new.

Any stop here leaves the workspace as it is and ends the run. Do not repair it by hand.

### 3d. Deliver this issue

The change exists only in this workspace, so it is preserved as a commit on its own branch before anything else runs. Build the commit in a temporary index, which leaves HEAD and the working tree untouched until the branch exists:

```bash
FILES=(<the Files: paths>)
IDX="$(mktemp)"
GIT_INDEX_FILE="$IDX" git read-tree HEAD
GIT_INDEX_FILE="$IDX" git add -A -- "${FILES[@]}"
TREE="$(GIT_INDEX_FILE="$IDX" git write-tree)"
C="$(git commit-tree "$TREE" -p HEAD -m "<Subject>

Fixes #<N>.")"
git update-ref refs/heads/fix/issue-<N> "$C" 0000000000000000000000000000000000000000
rm -f "$IDX"
```

The zero old value makes `update-ref` fail if the branch appeared meanwhile. Then verify the branch before the workspace is touched:

- `git rev-list --count origin/main..fix/issue-<N>` is `1`.
- `git diff --name-only origin/main fix/issue-<N>` matches the `Files:` list exactly.
- `git diff --quiet "$C" -- "${FILES[@]}"` succeeds, so the working tree equals the commit.

Only after all three pass, return the workspace to `origin/main`. Restore tracked paths from HEAD. Remove untracked paths that the child listed as new, after confirming they are untracked:

```bash
git restore --source=HEAD --staged --worktree -- <tracked paths>
git clean -f -- <untracked paths>
```

Confirm `git status --porcelain` prints nothing and HEAD still equals `origin/main`. Report `delivered` with `fix/issue-<N>` and `$C`. Then go back to 3a for the next issue.

If the commit or any verification fails, stop before restoring. The integrated change stays in the workspace for a human to inspect, and the run reports it as the stop.

Nothing is pushed and no PR is opened. A worktree is needed only when a branch must be pushed or tested; create one for that single issue at that moment. Never by default.

## 4. Aggregate

After the last issue, print:

```
| # | Title | Status | Branch / Notes |
|---|-------|--------|----------------|
```

List each `delivered` issue with its `fix/issue-<N>` ref and commit, then every other status. Name any stop that ended the run and the state it left behind.

## Rules

MUST: check the preconditions before the first issue and stop on any failure; run one child at a time with `isolated: true`; verify the integrated result against the child's file list before delivering it; deliver each issue to its own branch before the next child starts; leave the workspace clean at `origin/main` between issues; stop on dirty, conflicting, or mismatched state.

MUST NOT: change any configuration; switch branches, reset HEAD, or overwrite an existing `fix/issue-<N>`; apply a child's change a second time or by hand; commit inside a child; symlink the whole `packages/natives/native/` directory; push, open PRs, or comment on issues; ship stubs, product-code mocks, or `TODO: implement` placeholders; expand beyond the reported bug.
