# Fix Issues Command

Diagnose, reproduce, then fix reproducible open GitHub issues in parallel using OMP-managed isolated tasks.

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

## 2. Parallel subagents

Use parallel `task` subagents with `isolated: true`, one per issue. Assignment: number, title, body summary, workflow below. Integrate returned patches after tasks finish; coordinate if issues clearly touch the same file.

Each subagent MUST:

### a. Read

1. Read `issue://<N>`; cross-repo: `issue://<owner>/<repo>/<N>`. Includes body/comments; comments often contain repro/fix hints. Append `?comments=0` only to explicitly skip comments.
2. Run `gh search prs` for issue number. Reasonable existing PR → review per `.omp/commands/review-prs.md`, report `existing-pr`; do NOT create competing fix.

### b. Diagnose/reproduce

Reproduce in the OMP-assigned isolated workspace, starting from the supplied base revision. Do not write a repro in the parent checkout.

1. Read relevant checkout source; state concrete 1–2-sentence failure hypothesis.
2. Under affected package, create focused `repro-issue-<N>-<slug>.test.ts` (or `.rs`, etc.): unique, greppable, deletable.
3. Run only that file, never suite; confirm expected failure.

- Reproduced → fix.
- Not reproduced → stop; remove the temporary test; report `unreproduced`: hypothesis, non-failure evidence, unblockers (versions, OS, config, author repro snippet).
- Out-of-scope/not bug (user-config error, intended behavior, dup) → stop; report `not-a-bug` with issue-postable explanation.

### c. Fix

1. Keep the failing test in the assigned workspace and confirm the failure there.
2. Fix source, following `AGENTS.md` patterns: root cause, not symptom; no product-code stubs/mocks.
3. Re-run repro until passing.
4. If the real contract changed, add or adjust adjacent unit or contract tests; run only affected files, never the full suite.
5. `bun fmt` the union of edited files.


### d. Report

```
Issue #<N>  <title>
Status:    fixed | unreproduced | not-a-bug | existing-pr (#<M>)
Repro:     <test path>                            (if applicable)
Base:      <revision used for the isolated task>
Patch:     <returned patch or none>
Notes:     <root cause in one sentence; or what info is missing>
```

## 3. Aggregate

After all subagents, print:

```
| # | Title | Status | Branch / Notes |
|---|-------|--------|----------------|
```

Group results by status, `fixed` first. Integrate non-conflicting returned patches in the parent workspace.

## Rules

MUST: reproduce in the assigned isolated workspace; parallel one-issue subagents with `isolated: true`; check existing PR first and divert reasonable ones to `review-prs`.

MUST NOT: push, open PRs, or comment on issues; ship stubs, product-code mocks, or `TODO: implement` placeholders; expand beyond reported bug into adjacent code smells. Do not symlink the whole `packages/natives/native/`, which shadows tracked source.

Failed repro → remove the temporary test before yielding; leave the parent workspace untouched.
