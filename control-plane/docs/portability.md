# Portability: teleporting a session, and syncing settings

**Status: designed for, not built.** Nothing here is implemented. It exists so the
things being built now do not quietly assume a session belongs to the machine
that created it, because unpicking that assumption later is the expensive kind of
rewrite.

## The topology today

Every client talks to one daemon on the laptop. Loopback when the client is on
the same machine, through the hub tunnel when it is not. There is no cloud-hosted
agent, and nothing below should be read as implying one.

## What already makes a session portable

None of this was built for teleport, but three properties fall out of decisions
already made and verified.

**A session is a file, and its identity is not a machine.** Sessions live at
`~/.omp/agent/sessions/<flattened-cwd>/<ISO-timestamp>_<uuid>.jsonl`, one JSONL
per session, 305 of them across 93 directories on this machine. The id is a uuid.
Nothing in it names a host.

**An agent's host is already a separate axis.** The provisioner has `local` and
`container` backends, and the container path is proven end to end against a real
container: non-root, `--cap-drop ALL`, read-only rootfs, its own network. An agent
records which host serves it; the session does not care.

**Loading an existing session is an advertised capability.** ACP announces
`loadSession`, and `session/list|fork|resume|close` alongside it. A session that
arrives from elsewhere is, to the receiving side, just a session it did not
create.

So the mechanism for teleport is not exotic: move the JSONL, resume it on the
target host. What makes it hard is everything around the file.

## What teleport would actually have to answer

**The cwd problem, which is the real one.** A session is filed under its working
directory, and that directory is the one thing guaranteed not to exist on the
other side. `/Users/jwaldrip/dev/src/github.com/jwaldrip/ompd` means nothing in a
container, and a repo checked out at a different path is a different path even
when it is the same repo. Teleport is therefore not a file copy, it is a
rebinding: the session's history refers to paths that must be re-rooted or
declared missing. Silently resuming a session whose paths do not resolve is worse
than refusing, because the agent will act on a filesystem it believes it knows.

**In-flight state is not in the file.** A session mid-turn has a model call
outstanding, possibly a pending approval, and tool calls the transcript has not
recorded yet. Teleporting a live session means either draining it to a quiescent
point first, or accepting that the turn dies and the transcript resumes from the
last durable entry. The honest version is to drain: this project already learned
that a run interrupted at shutdown leaves a record nothing settles, and fixed it
with a bounded drain that cancels and persists before teardown. Teleport is the
same problem with a network hop in the middle.

**Credentials do not travel.** A device token is scoped to one daemon, and
`daemonId` is the SHA-256 of that daemon's public key, which a client pins. That
is deliberate: it is why a token for daemon A means nothing at daemon B. A
teleported session therefore arrives somewhere the operator's device has not
paired, and pairing is an explicit act. Teleport cannot imply trust that pairing
has not granted.

**Approvals are per-daemon by design.** The policy engine and its audit log live
in the receiving daemon's store. A session that carries an approval history has
carried evidence about decisions a different policy engine made. That history is
worth showing and must not be replayed as though the new daemon had granted it.

## What settings sync would have to answer

Settings are currently three separate things in two places, and only one of them
is ours.

| Thing | Where | Owner |
| --- | --- | --- |
| daemon config | `~/.ompd/config.json` | ours |
| daemon state | `~/.ompd/ompd.db` | ours |
| agent settings | `~/.omp/agent/config.yml` plus project `.omp/config.yml` | upstream |

The uncomfortable part is that sync implies an authority, and today there is
none: a project-local `.omp/config.yml` deliberately overrides the user's global
one, because a repo is allowed to say how it wants to be worked on. A sync that
flattens that hierarchy would break the reason the hierarchy exists.

Two things must not be synced at all, and stating that now is cheaper than
discovering it later. Credentials, because a device token is scoped to one
daemon and copying one is indistinguishable from stealing it. And anything
naming a path, because that is the same cwd problem as above wearing a different
hat.

## The constraint this document exists to impose

While the session index, the takeover paths, and the Cowork surface are being
built:

1. A session id identifies a session, never a machine. Nothing may key off "the
   host that created it".
2. A cwd is data about a session, not its address. Grouping by directory is a
   view; it must not become the identity.
3. A task's session may not be assumed local. If a task can only be resumed by
   the daemon that started it, say so in the type rather than in a comment.
4. Credentials stay put. Any design that would make a token portable is wrong
   for a reason that has nothing to do with teleport.
