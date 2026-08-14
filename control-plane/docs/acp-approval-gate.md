# The approval gates in omp 17.2.12

The single most important thing to know about this repo. Everything else is
plumbing; this is the part that must not be wrong.

An earlier version of this page said `omp acp` has two approval gates and that
ompd's configuration leaves "exactly one gate, ours". That was measured with
`bash`, and it was true of `bash`. It was false of every file write. A remote
client holding only `prompt` scope could write any file anywhere on the machine
and `DefaultPolicy` was never consulted. This is the corrected page.

## Summary

There are two gates, they cover different tools, and neither covers everything.
ompd uses both.

| Tool                                | Gated by                    | Channel ompd sees            |
| ----------------------------------- | --------------------------- | ---------------------------- |
| `bash`                              | gate 1, ACP permission hook | `session/request_permission` |
| `delete`                            | gate 1                      | `session/request_permission` |
| `move`                              | gate 1                      | `session/request_permission` |
| `edit` that deletes or renames      | gate 1 **and** gate 2       | both, asked twice            |
| `edit`, content only                | gate 2, OMP internal        | `elicitation/create`         |
| `write`                             | gate 2                      | `elicitation/create`         |
| `ast_edit`                          | gate 2                      | `elicitation/create`         |
| `eval`, `browser`, `ssh`, `computer`, `task`, every mounted MCP tool | gate 2 | `elicitation/create` |
| `multi_edit`                        | no such tool in 17.2.12     | none                         |

**ACP's permission hook can never see `write` or `ast_edit`, no matter how it is
configured.** That is not a setting we got wrong; it is a fixed table of four
tool names inside the binary. Any document, comment, or mental model that says
otherwise is wrong, and this one used to.

Read the middle column before trusting anything else here. Gate 1 is structured
JSON-RPC carrying the tool's real input. Gate 2 is a string omp renders for a
human, which ompd parses. Those are not equally strong, and the difference is
the subject of "What this is, and what it is not".

## The two gates

**Gate 1, the ACP permission wrapper.** Emits `session/request_permission` and
honours the returned option id. Armed whenever `tools.approvalMode` is not
`yolo`. From the shipped bundle:

```js
#N(A) {
  const j = this.#A.clientBridge();
  if (!j?.capabilities.requestPermission || !j.requestPermission) return A;
  if (P53[A.name] !== true) return A;      // <-- the whole story
  if (this.#B()) {                          // #B() is true when approvalMode === "yolo"
    const k = (settings.get("tools.approval") ?? {})[A.name];
    if (!k || k === "allow") return A;
  }
  return new Proxy(A, { /* asks the ACP client */ });
}
```

`P53` is the entire set of tool names this gate will ever fire for:

```js
P53 = { bash: true, edit: true, delete: true, move: true };
```

`write` is not in it. Neither is `ast_edit`. And `edit` only produces a
descriptor when the call deletes or renames something:

```js
if (A === "edit") {
  const k = gTj(j);        // a descriptor ONLY for a delete or a rename
  if (!k) return;          // <-- content-only edit: no descriptor, no request
  ...
}
```

This is deliberate upstream behaviour. From omp 17.2.12's own changelog:

> Fixed ACP ordinary file-editing calls (`edit`, `write`, `ast_edit`)
> incorrectly requesting `session/request_permission` before every call, while
> keeping permission prompts for edit operations that delete or move files

**Gate 2, the internal approval gate.** Wraps every tool and asks through the
runner's UI context:

```js
const m = this.runner.getUIContext();
const E = HaA(this.tool, h, W.reason);            // the rendered prompt
Z = await m.select(a, ["Approve", "Deny"]);
if (Z !== "Approve") throw new Error(`Tool call denied by user: ${this.tool.name}`);
```

In a headless ACP host that UI context is the elicitation bridge, and the bridge
answers nothing unless the client advertised the capability:

```js
function ek3(A, j, _) {
  const k = _?.elicitation?.form != null;
  return {
    select: async (u, n, i) => {
      if (!k) return;                     // undefined, so !== "Approve", so deny
      ...
```

That silent `return` is why the old configuration existed. Gate 2 was armed and
unanswerable, so it denied everything it covered without sending the client a
single frame.

## What was wrong, measured

The old overlay set `bash`, `edit`, `write` and `multi_edit` to `allow`, which
disarms gate 2 for those tools. Correct and necessary for `bash`. Applied to
`write` it converted "denied headlessly" into "allowed silently", because gate 1
does not cover `write` and gate 2 was now switched off for it.

Measured against a real agent, asking whether ompd was consulted at all:

```
write tool, new file in workspace
  permission requested: NO
  file on disk:         true
  verdict:              UNGATED

write tool, file OUTSIDE the workspace
  permission requested: NO
  file on disk:         true
  verdict:              UNGATED

bash tool, control case
  permission requested: yes (bash)
  verdict:              GATED
```

`DefaultPolicy`'s entire write branch was dead code: `write:workspace`,
`write:escape`, and the `SECRET_PATH_PATTERNS` deny that is supposed to stop a
write to `~/.ssh` were all unreachable.

A second defect fell out of the same overlay. Every tool it did not name sat at
gate 2's mode default, which above read tier is `prompt`, so those tools were
denied with nothing sent to the client:

```
mode=legacy (old overlay, no elicitation)
tool=eval answer=Approve
  session/request_permission: 0
  elicitation/create:         0
  failed tool calls: ... "Tool call denied by user: eval"
  marker exists: false
```

Not a refusal an operator could see, not an approval anyone could grant, just a
silent no. `eval`, `browser`, `computer`, `ssh`, `debug` and every mounted MCP
tool were dead in ompd and nobody had noticed, which is its own small lesson
about trusting a configuration you have only tested along one path.

## The configuration that works

```yaml
tools:
  approvalMode: always-ask # arms gate 1
  approval:
    bash: allow # gate 1 owns it; disarm gate 2 so one call is not asked twice
    delete: allow
    move: allow
    write: prompt # gate 1 never sees these, so arm gate 2
    edit: prompt
    multi_edit: prompt
    ast_edit: prompt
```

`ompd` writes exactly this as a `--config` overlay for every host it spawns
(`GATE_CONFIG_YAML` in `packages/acp/src/client.ts`), and `AcpClient.initialize`
advertises `clientCapabilities.elicitation.form`, without which gate 2 stays
mute.

Three notes on the split:

- `bash`, `delete` and `move` go to gate 1 because it covers them completely and
  hands over structured `rawInput` plus resolved `locations`. That is a better
  input to a policy engine than a rendered string, so it is preferred wherever
  it is available.
- `edit` is armed on gate 2 because that is the only way to see a content-only
  edit. A delete-or-rename edit therefore passes both gates and is asked twice.
  Both answers come from the same policy, so the cost is a duplicate question,
  never a divergent decision, and in the common case (a workspace path, which
  policy allows on its own) no human sees either.
- `multi_edit` does not exist in omp 17.2.12; the string does not appear in the
  binary. The entry is kept so that if the tool returns it arrives armed rather
  than silent.

## How ompd answers gate 2

Gate 2 does not hand over a tool call. It hands over the string it would have
shown a human, built by `formatApprovalPrompt`:

```
Allow tool: <name>
[Origin: MCP server tool]
[Reason: <why>]
<the tool's own detail lines>
```

Detail lines, measured rather than read off an interface. Print them yourself
with `scripts/probe-elicitation-gate.ts`:

| Tool       | Lines                                                             |
| ---------- | ----------------------------------------------------------------- |
| `write`    | `Path: <path>`, then `Content:` and the body                       |
| `edit`     | `File: <path>`, which may be relative to the agent's cwd           |
| `ast_edit` | `Pattern:`, `Replacement:`, optional `+N more ops`, `Paths: a, b`  |
| `bash`     | `Command: <command>`                                               |

`parseApprovalPrompt` in `packages/acp/src/approval-prompt.ts` reads the target
back out. `Supervisor` then evaluates `DefaultPolicy` once per recovered target
and takes the most restrictive verdict, because a call is only as safe as its
worst target. Four rules keep the failure modes safe rather than clever:

1. **A question is identified by the choices offered, never by its prose.** A
   tool approval is exactly `["Approve", "Deny"]`. The message beside it is a
   rendering any release may reword; the choice list is a literal constant.
2. **A target omp elided is denied, not guessed at.** omp truncates long values
   at 2000 characters with a `[…Nch elided…]` marker. A path carrying it cannot
   be workspace-checked and cannot be shown to an operator honestly either, so
   the call is refused and recorded with rule `opaque:truncated`.
3. **A scheme is not a path.** `xd://ast_edit` and `local://PLAN.md` are
   dispatches into OMP namespaces. Where they land on disk is not derivable
   here, so they are never handed to a lexical workspace check that would
   cheerfully call `xd://ast_edit` a file inside the workspace. Policy gets an
   empty input and falls through to its own default, which is to ask a human.
   Aggregation is most-restrictive, so a call naming both a workspace file and
   an opaque target is decided on the opaque one. This is the main ergonomic
   cost of the design: every `xd://` dispatch, which includes every mounted MCP
   tool and `ast_edit`, needs an operator.
4. **Anything unrecognised is declined, never accepted.** Declining reproduces
   exactly what a client that never advertised the capability produces, so
   advertising it cannot turn a question ompd does not understand into consent.
   The single exception is plan approval, whose choices are
   `["Approve and execute", "Refine plan"]` and whose message starts
   `Approve plan `. The host used to take the plan as approved because it could
   not ask, the plan mutates nothing itself, and every tool call it leads to is
   gated on its own, so ompd answers it the way the host answered it before.

On the obvious attack: every line of the prompt is scanned, including the body
of a `Content:` block. A tool call cannot forge its way past the gate by
planting a `Path:` line in the bytes it writes, because a planted line can only
add a target, every target is decided, and the most restrictive decision wins.
Injection here tightens; it never loosens.

## What this is, and what it is not

**ompd's policy now decides ordinary writes.** Measured in both directions, and
it closes the reported defect.

**It is a tool approval hook, not a filesystem boundary.** Five clauses, and
anyone deciding whether to expose this daemon needs all five:

1. Policy decides ordinary writes.
2. That decision rests on parsing a string omp renders for a human. It is not a
   contract. `formatApprovalDetails` can change shape in any release, and the
   `["Approve", "Deny"]` pair can be renamed.
3. A future release can reword it.
4. When it does, ompd fails closed and denies, loudly: an unparseable prompt is
   declined, a truncated target is denied with rule `opaque:truncated`, an
   unrecognised question is declined. Loud denial is safe. It is not the same
   thing as still working.
5. `scripts/probe-elicitation-gate.ts` and `scripts/check-write-gate.ts` are
   committed so that this is detectable. Run them before trusting an omp
   upgrade.

None of that constrains a process that ignores the tool layer. Policy runs
inside the approval path; it is not a filesystem permission.

**The filesystem boundary for writes is the container, and on a local host there
is none.** An agent reachable from a remote client should not be an unsandboxed
process on the operator's machine with unrestricted write. Use a container host;
`docs/running.md` covers the setup and `scripts/check-container-host.ts` proves
it end to end against a real container. An ungated write inside a sandbox cannot
reach `~/.ssh` because that path is not in the filesystem it can see, which is a
property of the mount namespace rather than of a decision anyone made at
runtime. That is what makes it a boundary and this a gate.

**The container bounds the blast radius; it does not eliminate it.** A container
host today mounts the whole workspace read-write and carries one live model
credential. Everything in the workspace is reachable, and so is the credential.
Sandboxing narrows what an escaped write can touch. It does not make the agent
harmless.

## Two traps worth naming

**A denial proves nothing on its own.** Every broken configuration on this page
also blocks execution. "The tool did not run" is satisfied by a correct gate, a
misparsed response, and a crashed host alike. Any test of this behaviour must
assert the allow path too, or it passes while enforcing nothing.
`scripts/check-write-gate.ts` asserts both, on every probe.

**`yolo` is not merely permissive, it is invisible.** With
`tools.approvalMode: yolo` and no per-tool entries, gate 1 is skipped entirely
and the ACP client is never asked. A daemon that assumed "no permission request
means nothing needed approval" would execute everything silently. This is why
the overlay is owned by ompd and passed as `--config`, which outranks global
config, rather than read from the user's environment.

## Response shapes

Gate 1 reads `result.outcome.optionId`:

```json
{ "outcome": { "outcome": "selected", "optionId": "allow_once" } }
```

A flat `{ "outcome": "selected", "optionId": "..." }` produces
`Tool permission response used unknown option ID: undefined` and denies. Valid
ids are `allow_once`, `allow_always`, `reject_once`, `reject_always`;
`allow_always` and `reject_always` are cached by omp against the tool's cache
key, so a daemon keeping every decision under its own policy should prefer the
`_once` forms.

Gate 2 reads `result.action` and `result.content.value`:

```json
{ "action": "accept", "content": { "value": "Approve" } }
```

Any `action` other than `accept` resolves the host's `select` to `undefined`,
which it reads as a denial. There is no separate reject shape; a decline is the
denial.

## Two deadlines, not one

`AcpClient`'s request timeout and `Supervisor`'s approval timeout used to be the
same number, 120 seconds, so `session/prompt` gave up at the instant the first
unanswered approval would have failed closed. The caller got a transport error
where it should have got a policy denial, and the approval row was left pending
with no decision ever written to it.

They are now separate. `requestTimeoutMs` bounds control-plane calls.
`promptTimeoutMs` bounds a turn, defaults to an hour, and the supervisor raises
it further if `approvalTimeoutMs * 10` would not fit inside it. The floor is
applied to the long default rather than replacing it, because deriving a turn
deadline from the approval window alone lets a short approval timeout shrink the
time a model is allowed to think, and a healthy turn then dies of a transport
error. `packages/daemon/test/permission-path.test.ts` covers the invariant, the
unanswered-approval path, and that both timers actually fire.

## The measured evidence

Gate 2 in isolation, under the corrected overlay with `elicitation.form`
advertised. `scripts/probe-elicitation-gate.ts`:

```
tool=write answer=Approve
  session/request_permission: 0
  elicitation/create:         2
    [0] enum=["Approve","Deny"]
    [0] message:
         | Allow tool: write
         | Path: /var/folders/.../ompd-elicit-f0dPp0/elicit.txt
         | Content:
         | gated
  marker exists: true

tool=write answer=Deny
  session/request_permission: 0
  elicitation/create:         1
    [0] enum=["Approve","Deny"]
    [0] message:
         | Allow tool: write
         | Path: /var/folders/.../ompd-elicit-PwcKIJ/elicit.txt
         | Content:
         | gated
  failed tool calls: "Tool call denied by user: write"
  marker exists: false

tool=edit answer=Deny            (content only: no create, delete, move, rename)
  session/request_permission: 0
  elicitation/create:         1
    [0] message:
         | Allow tool: edit
         | File: seed.txt
  failed tool calls: "Tool call denied by user: edit"
  seed contents: "alpha\n"       (unchanged)

tool=ast_edit answer=Approve
  session/request_permission: 0
  elicitation/create:         2
    [0] message:
         | Allow tool: write
         | Path: xd://ast_edit
         | Content:
         | {"ops":[{"pat":"alpha","out":"beta"}],"paths":["/var/folders/.../seed.txt"]}
    [1] message:
         | Allow tool: ast_edit
         | Pattern: alpha
         | Replacement: beta
         | Paths: /var/folders/.../seed.txt

tool=bash answer=Approve         (control case, unchanged)
  session/request_permission: 1 -> touch /var/folders/.../elicit
  elicitation/create:         0
  marker exists: true
```

Four things to take from that. The path is present in the payload, which is what
makes a policy decision possible at all. Both directions work, so this is a gate
and not a broken tool. `bash` still arrives on gate 1, so the channel that
already worked is untouched. And `ast_edit`, dispatched as a `write` to
`xd://ast_edit`, raises a second elicitation carrying the real target paths, so
the mounted-tool case is decided on its arguments rather than on a device URI.

And the whole thing end to end, `scripts/check-write-gate.ts`, which is what a
future omp upgrade should be measured against. Phase 1 drives the gate with no
model in the way; phase 2 drives a real agent. `policy rows` is the recorded
approval per call, and it is the discriminator: a filesystem change with no
allow from a mutating tool is the defect this page is about.

```
deterministic: write to a secret path, operator standing by to approve
  answered:      Deny
  policy rows:   write=deny(secret:(^|\/)\.ssh(\/|$))
  humans asked:  0
  verdict:       PASS

write, new file in workspace, nobody listening
  policy rows:   write=allow(write:workspace), write=allow(write:workspace)
  humans asked:  0
  fs effect:     true
  verdict:       PASS

write, file OUTSIDE the workspace, nobody listening
  policy rows:   write=deny(timeout)
  humans asked:  1 (write)
  fs effect:     false
  verdict:       PASS

write, file OUTSIDE the workspace, operator approves
  policy rows:   write=allow(operator), write=allow(operator)
  humans asked:  2 (write, write)
  fs effect:     true
  verdict:       PASS

write, secret path under ~/.ssh
  policy rows:   write=deny(secret:(^|\/)\.ssh(\/|$))
  humans asked:  0
  fs effect:     false
  verdict:       PASS

edit, content only, inside workspace
  policy rows:   edit=allow(write:workspace)
  humans asked:  0
  fs effect:     true
  verdict:       PASS

multi_edit, inside workspace
  policy rows:   edit=allow(write:workspace)
  verdict:       SKIP, no multi_edit tool in omp 17.2.12; substitute was gated

ast_edit via xd:// dispatch, nobody listening
  policy rows:   write=deny(timeout)
  humans asked:  1 (write)
  fs effect:     false
  verdict:       PASS

ast_edit via xd:// dispatch, operator approves
  policy rows:   write=allow(operator), ast_edit=allow(write:workspace), write=allow(operator)
  humans asked:  2 (write, write)
  fs effect:     true
  verdict:       PASS

bash, control case
  policy rows:   bash=allow(operator), bash=allow(operator)
  humans asked:  2 (bash, bash)
  fs effect:     true
  verdict:       PASS

PASS: every filesystem mutation reached the policy engine, and the allow path works.
```

Read the `ast_edit via xd:// dispatch, operator approves` row closely, because
it is the two-layer case in one line. The dispatch (`write` to `xd://ast_edit`)
is opaque, so it reaches a human and the operator allows it. The inner
`ast_edit` then arrives separately with its real `Paths:`, and policy allows
that one on its own as `write:workspace` without asking again. Neither half was
decided on the other's evidence.

Two caveats about the live half, both about the model rather than the gate.

A live agent cannot be made to attempt an attack on demand: asked to write to
`~/.ssh` it complies on some runs and quietly writes somewhere harmless on
others. That is why the secret-path rule is asserted in phase 1 against a
scripted peer with the exact payload omp renders, and the live probe is
supplementary. When the model does not attempt it, the run says so rather than
claiming a pass.

`multi_edit` is skipped rather than passed, and the skip is honest only because
the absence is established from the binary (the string does not occur in it),
not inferred from the agent's behaviour on one run. The agent substitutes
`edit`, and the substitute is still required to have been gated.

## Reproducing

`scripts/gate-config-reference.yml` is the same overlay `GATE_CONFIG_YAML`
produces, kept in the repo so a probe does not depend on a temp file.

```bash
# The whole question, end to end, against a real agent. Exits non-zero on any
# probe that misbehaves. Covers a workspace write, an escaping write with and
# without an operator, a write to the real ~/.ssh, a content-only edit,
# multi_edit, ast_edit through its xd:// dispatch, and the bash control.
bun run scripts/check-write-gate.ts

# Gate 2 alone, printing every elicitation payload verbatim. The trailing
# `legacy` argument reproduces the old overlay for comparison.
bun run scripts/probe-elicitation-gate.ts allow write
bun run scripts/probe-elicitation-gate.ts deny  write
bun run scripts/probe-elicitation-gate.ts allow eval legacy

# Gate 1 alone.
bun run scripts/probe-gate-config.ts allow scripts/gate-config-reference.yml
bun run scripts/probe-gate-config.ts deny  scripts/gate-config-reference.yml

# The deterministic version, against a scripted ACP peer.
bun test packages/daemon/test/permission-path.test.ts
OMPD_LIVE=1 bun test packages/daemon/test/smoke-live.test.ts
```

If a future omp release changes any of this, `check-write-gate.ts` is what will
catch it. Run it before trusting an upgrade, and read the failure carefully: a
gate that has started denying everything looks a great deal like a gate that is
working.
