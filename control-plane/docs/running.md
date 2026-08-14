# Running ompd

The daemon supervises OMP agents, serves the web client, and executes arbitrary
code as you. Read "Reach it from outside" before you expose it to anything.

## Install it

```bash
bun packages/cli/src/main.ts self-install
```

That is the only command in this document that names a file path, and it is
the last time you need one. It compiles a standalone binary and puts it at
`~/.local/bin/ompd`, then tells you whether that directory is already on your
`PATH`:

```
installed ompd 0.1.0
  path         /Users/you/.local/bin/ompd
  source       compiled from /Users/you/dev/ompd/packages/cli/src/main.ts
  PATH         /Users/you/.local/bin is already on your PATH; nothing to edit
```

If it is not on your `PATH`, that last line names the rc file for your shell
and the exact line to add to it, rather than guessing on your behalf.

The artifact is one self-contained executable. It embeds the runtime and the
whole bundle, so it keeps working after the checkout it was built from is
deleted. That matters more than it sounds: the login agent below records an
absolute path and re-execs it at every login for as long as the file is there,
and a path into a git worktree stops existing the moment that branch is done.

`self-install` is idempotent, takes `--prefix` for somewhere other than
`~/.local/bin`, and refuses to overwrite a file at the target that it did not
build. `bun run build:cli` produces the same binary at `dist/ompd` without
installing anything.

## Start it

```bash
ompd start
```

It prints where it is listening and where its token went:

```
ompd is listening at http://127.0.0.1:7777
  web UI       http://127.0.0.1:7777/
  token        /Users/you/.ompd/token (local operator, mode 0600)
```

`start` backgrounds itself and returns once the daemon answers `/v1/health`, so
`ompd start && ompd agents` is not a race. Logs go to `~/.ompd/ompd.log`. Use
`--foreground` to keep it attached to the terminal, and `--port` / `--host` to
override the config for one run. `--port 0` lets the OS choose; the other
commands still find it, because the daemon publishes the address it actually
bound.

## Open the console

```bash
ompd open
```

Puts the token on your clipboard and opens the bare origin, so you paste it
once on the pairing screen and the console remembers it.

The console also accepts `?token=...` and strips it from the address on read,
which is what makes a QR handoff to a phone work. Do not use that form from a
shell. The app can strip its own history; it cannot strip your shell history,
your terminal scrollback, or whatever those sync to, and this token does not
expire. `ompd open` exists so the credential never becomes part of an address.

## Check it

```bash
ompd doctor
```

One command for "is this set up correctly", and the command to run first when
something is wrong:

```
ok   binary       /Users/you/.local/bin/ompd (0.1.0)
ok   daemon       running at http://127.0.0.1:7777 (0.1.0)
ok   versions     cli, binary, daemon all on 0.1.0
ok   token        authenticates against the daemon (/Users/you/.ompd/token)
warn login agent  not installed; the daemon will not start at login
                  run: ompd install
ok   state dir    /Users/you/.ompd 700, token 600
ok   containers   docker, podman, container
ok   stay awake   the daemon holds an idle-sleep assertion while an agent is working

7 ok, 1 to look at, 0 broken
```

Every line that is not `ok` says what to run. `warn` is a capability that is
absent rather than broken, like having no container runtime, and does not
affect the exit code. `FAIL` is something that is broken now: no daemon, a
token the daemon rejects, a state directory anyone can read, or a login agent
whose program has been deleted. Any `FAIL` exits non-zero, so this is usable in
a script.

That last check is the one worth knowing about. A launch agent pointing at a
path that no longer exists loads without complaint and then fails at every
login with nothing on screen.

Everything lives under `~/.ompd`, created `0700` on first start:

| Path | What |
| ---- | ---- |
| `ompd.db` | agents, updates, devices, tokens, routines, approvals, audit |
| `proposals.db` | evolution proposals |
| `config.json` | optional; see below |
| `token` | the local operator's token, mode `0600` |
| `endpoint` | the URL the running daemon is serving; written at start, removed at stop |
| `ompd.log` | daemon output when backgrounded or run by launchd |

`endpoint` is runtime state, not configuration, the way a pid file is. A stale
one left by a daemon that was killed points at a dead port, so the next command
reports "not running" rather than quietly talking to whatever took that port.

### config.json

Every field is optional, and every default is the conservative one.

```json
{
  "host": "127.0.0.1",
  "port": 7777,
  "policyMode": "standard",
  "ompPath": "omp",
  "keepAwake": true
}
```

`policyMode` is `strict`, `standard`, or `trusted`. A value outside that set is
an error at startup rather than a fallback, because a daemon that quietly ran
under `standard` because someone typoed `strict` is enforcing a policy nobody
chose. There is deliberately no mode that auto-allows critical commands or
reads of secret paths.

`keepAwake` holds a macOS idle-sleep assertion while any agent is working, so
the machine does not sleep through a turn. See "The Mac has to be awake".

Speech needs no configuration. The daemon calls OMP's own speech libraries in
process: Parakeet TDT v3 through sherpa-onnx for recognition, Kokoro-82M for
synthesis, both on device and both the same models the TUI uses. There is no
separate binary to install and no weights to fetch by hand.

What it does need is for those models to have been downloaded once:

```sh
omp setup speech
```

Until then the daemon reports that it has no ears rather than pretending, and
the reason names the engine and the model: `omp speech-to-text model parakeet
is not downloaded`. Synthesis reports the runtime and the weights separately,
because they fail independently and the same command fixes both.

`bun scripts/check-voice-loop.ts` proves the whole path with real audio: it
synthesises a sentence, streams it back as PCM16 frames, and reports the
transcript from both the bridge and a live websocket.

### The local operator token

Every API call needs a paired device, and the operator of this machine cannot
pair with a daemon they cannot yet call. So the first start mints a device
called `local operator`, holding all four scopes, and writes its token to
`~/.ompd/token` with mode `0600`.

This grants nothing new: writing that file requires local filesystem access,
which already implies the ability to run arbitrary code as you.

**A pairing is durable.** The daemon stores the SHA-256 hash of every token it
issues, bound to a device id, so a restart changes nothing: the same
`~/.ompd/token` keeps working, and so does every phone you have paired. If the
file already holds a live credential, a start leaves it byte-identical and
says nothing about it. Only a missing or no-longer-valid file mints a new one,
and then it says so.

A token has no expiry. It ends when you end it, in one of two ways:

```bash
ompd revoke dev_1a2b3c4d   # the device and every token it holds
ompd rotate --device dev_1a2b3c4d   # replace its token, print the new one
```

`ompd revoke dev_local_operator` is honoured across restarts. The daemon will
not resurrect it, will say so at startup, and the token file left on disk
stops being a credential even though its bytes are unchanged.

Only the hash is ever written. A stolen `ompd.db` yields a list of hashes and
no way to present one.

## Run it at login

```bash
ompd install     # writes ~/Library/LaunchAgents/sh.ompd.plist and loads it
ompd uninstall   # unloads and removes it
```

Both are idempotent. Both refuse to touch a plist at that path that ompd did
not write: the file it writes carries an `OMPD_MANAGED_PLIST` marker, and
without that marker the command stops rather than clobber someone else's launch
agent. `uninstall` leaves `~/.ompd` alone.

**`install` will not point launchd at a source tree.** It runs the binary at
`~/.local/bin/ompd`, or the running binary if that is itself a compiled ompd.
If the only candidate left is a path inside a git checkout it refuses and tells
you to run `self-install` first:

```
refusing to install a launch agent that runs /Users/you/dev/ompd/packages/cli/src/main.ts
  That path is inside the checkout at /Users/you/dev/ompd, and launchd will
  hold it across every login. A linked worktree is removed as soon as its branch is
  done, and the agent then fails silently at each login for good.
```

`--allow-source-path` overrides it if the checkout really is permanent and you
maintain it yourself. It is a flag rather than a prompt, because agreeing to
that by pressing return is how you end up with a login agent nobody can
explain.

It prints the program it settled on, and records it in the plist as
`OMPD_PROGRAM`, so what launchd will run is never something you have to open a
plist to discover. `WorkingDirectory` is your home directory rather than
whatever directory you happened to type the command in: launchd chdirs before
it execs, so a deleted cwd fails the job just as silently as a deleted program.

The plist also pins the `PATH` and `OMPD_HOME` of the shell that installed it,
because launchd gives an agent almost no environment and `omp` has to be
findable.

A login agent starts the daemon when you log in. It does nothing about the
machine sleeping; see "The Mac has to be awake".

## Pair a phone

Two steps, and the split is the point: the first records an intent and grants
nothing, the second is the operator act that mints a credential.

```bash
$ ompd pair phone --scopes read,prompt
pairing phone started
  code    580734

  approve it, from this machine or a device holding the approve scope:
    ompd approve 580734 --scopes read,prompt

$ ompd approve 580734 --scopes read,prompt
approved. scopes: read, prompt

  3njHB7YmEEaSKpS63rxf0ajA83gKnIzyFdY7-yfxCnQ

  This token is shown once and is not recoverable.
```

Then open the web UI on the phone and paste the daemon URL and that token. It
pairs once. Restarting the daemon, upgrading it, or rebooting the machine does
not sign that phone out.

The scopes are:

| Scope | Grants |
| ----- | ------ |
| `read` | see agents and transcripts |
| `prompt` | send prompts, cancel turns, speak |
| `manage` | create and stop agents, run routines, revoke devices |
| `approve` | answer a tool approval, and approve a pairing |

Approving is clamped: a device cannot grant a scope it does not itself hold. A
device with `read,approve` that tries to mint one with `manage` gets a 403 and
the pairing code stays claimable. Give a phone the smallest set that makes it
useful; `read,prompt` is a good default, and `approve` means that phone can
allow a tool call.

Codes expire after ten minutes and are spent once. The tokens they mint do not
expire at all.

`ompd devices` lists every device, revoked ones included, so revocation stays
auditable. `ompd revoke <deviceId>` takes effect on that device's next request
or frame, and withdraws every token that device holds in the same transaction.

### Rotate a token

A credential that lasts until you say otherwise is only reasonable if saying
otherwise is one command. That command is `rotate`.

```bash
$ ompd rotate
rotated the token for dev_local_operator

  hxnrxOLl8dfgOA3HZDlwr7ATmxKMYVFB6ISFtd1jYPU

  This token is shown once and is not recoverable. The previous one stopped
  working the moment this command returned.
  The daemon rewrote /Users/you/.ompd/token, so the CLI there needs nothing further.
```

Bare `rotate` replaces the credential you are presenting, which is what to
reach for the moment you suspect a token has leaked. It needs no scope: it
withdraws authority you already hold and hands the same authority back under a
new secret.

`ompd rotate --device <id>` replaces someone else's, withdrawing every live
token that device holds. That needs `manage`, and it is clamped the same way
approving is: you cannot rotate a device holding a scope you do not, because
the replacement token comes back to you and that would be a way to mint
yourself `approve`.

Rotating the local operator rewrites `~/.ompd/token`, wherever the rotation was
driven from. Rotate it from your phone and the CLI on the machine keeps working.

## Three ways to reach it

A daemon can offer a client three kinds of endpoint. `GET /v1/endpoints` is
how it says which are actually available right now, and only one of the three
is proven end to end in this repo.

**Loopback, same machine.** The daemon's default bind, and the only path this
repo's tests exercise with real client traffic: the CLI and the local web UI,
run on the same Mac the daemon runs on. A phone is a separate device and
cannot reach another machine's loopback interface at all, which is exactly why
the other two options exist. Proven.

**A LAN address, same network.** `ompd config set host <lan-ip>`, then restart
the daemon, binds an interface other machines on the network can reach instead
of `127.0.0.1`, and that is exactly the risk: it publishes a daemon that runs
arbitrary code as this user to anything on that network segment that can reach
the interface, paired or not, the instant the port is listening. Not proven
against a second machine anywhere in this repo. If you want the same reach
without opening an interface to the whole network, use Tailscale below instead.

**A hub, anywhere.** A base URL plus the daemon's pinned `daemonId`, relayed by
`@ompd/hub` (`docs/hub.md`). Requires a *deployed* hub, and none is deployed:
`docs/hub.md` names exactly what is missing. Until one exists, this path
reaches nothing. It does not change "The Mac has to be awake" below: a hub
gets past NAT and past not knowing an address, not past macOS actually being
asleep.

## Reach it from outside

**The daemon binds `127.0.0.1` and nothing about running it changes that.**
Exposing it is a separate, deliberate act that you perform, not a setting the
daemon flips for you. It is not a web app: it runs arbitrary code as your user,
on your machine, with your credentials in the environment. Anyone who reaches
the port and holds a token has your laptop.

That is why this section is ordered the way it is. A private network you are
already a member of, then a public hostname with an identity check in front of
it, and last, a public URL with nothing in front of it but a bearer token.

### Tailscale, which is the one to use

A tailnet is a private overlay network. Every device authenticates to your
account before it can address anything on it, and the daemon goes on binding
loopback: you reach it at the Mac's tailnet address, and nothing on the public
internet can route to that port at all. "Unreachable" is a stronger property
than "reachable but behind a token", and it is the whole difference.

It is **not installed on this machine**. To install it:

```bash
brew install --cask tailscale
```

Sign in on the Mac and on the phone, then:

```bash
tailscale ip -4              # the Mac's tailnet address
tailscale serve --bg 7777    # optional: HTTPS on the tailnet, still not public
```

`tailscale serve` terminates TLS with a certificate for your tailnet name and
forwards to loopback, so the phone gets `https://your-mac.your-tailnet.ts.net/`
while the daemon is still bound to `127.0.0.1`. Pair the phone the ordinary
way; the token crosses your own overlay and nothing else.

Do not reach for `tailscale funnel`. It is the same machinery aimed at the
public internet, which throws away the reason to have used Tailscale.

### A named cloudflared tunnel, when you want a real hostname

`cloudflared` is installed on this machine. A named tunnel is the option when
you want `ompd.example.com` rather than a tailnet name, or when a device that
cannot join the tailnet has to reach the daemon:

```bash
cloudflared tunnel login
cloudflared tunnel create ompd
cloudflared tunnel route dns ompd ompd.example.com
cloudflared tunnel run --url http://127.0.0.1:7777 ompd
```

**The Access policy is the point, not the tunnel.** Put one on
`ompd.example.com` so Cloudflare authenticates the human before the request
ever reaches your machine. Without it you have built a public URL with a single
bearer token in front of a process that runs arbitrary code as you. The
daemon's token should be the second lock, never the only one.

### A quick tunnel, for a scratch test

```bash
cloudflared tunnel --url http://127.0.0.1:7777
```

This prints a `https://<random>.trycloudflare.com` URL. Be clear about what
that is: a public address for a daemon that runs arbitrary code as you, with
one bearer token between the internet and your laptop, and no identity check in
front of it. The URL is unguessable, which is not the same as private.

It is fine for a five minute test you are watching. It is not a way to run
anything. Close it when you are done, and `ompd rotate --device <id>` any phone
you paired through it: the token crossed a third party and it does not expire
on its own.

### Three things worth doing before any of that

1. Pair the phone over loopback first, on the same machine or over a trusted
   network. Pairing through a tunnel works, but the code and token cross a
   third party.
2. Give the phone the narrowest scopes that let it do the job.
3. Watch `ompd audit`. Every privileged action lands there with its actor.

Do not change `host` in `config.json` to `0.0.0.0` as a shortcut. That
publishes the daemon to every machine that can route to yours, with no
authentication in front of the pairing endpoint, which is exactly what every
option above avoids.

## The Mac has to be awake

This is the part a login agent does not solve, and it is worth being blunt
about: **a sleeping Mac cannot be reached.** Not over Tailscale, not through a
tunnel, not at all. Wake on LAN is enabled here (`womp 1` in `pmset -g`) but it
only helps something on the same physical network sending a magic packet. A
phone on cellular cannot wake your laptop.

There are two separate problems in here and they have different answers.

### Work already in flight

The daemon holds a macOS idle-sleep assertion for as long as any agent is
provisioning, starting, busy, or waiting on an approval, and releases it when
the last one settles. That is what stops a turn you kicked off from your phone
from being killed halfway through because the machine went idle. Waiting on an
approval counts, deliberately: that is the case where you are away from the
machine deciding on a phone.

You can watch it happen:

```bash
pmset -g assertions | grep -A2 caffeinate
```

Nothing while the daemon is idle. Mid-turn:

```
pid 77723(caffeinate): PreventUserIdleSystemSleep named: "caffeinate command-line tool"
  Details: caffeinate asserting on behalf of Process ID 77694
```

Then nothing again once the turn settles. It is `PreventUserIdleSystemSleep`
and not display sleep, so background work does not hold your screen on, and an
idle daemon asserts nothing at all. The assertion is tied to the daemon's pid,
so killing the daemon, however rudely, takes it with it.

Turn it off with `"keepAwake": false` in `config.json` if you would rather the
machine sleep through a running turn.

It keeps a waking Mac awake. It cannot wake a sleeping one.

### Being reachable later at all

That is a machine setting, not an ompd one.

- On power, stop the Mac sleeping: System Settings > Displays > Advanced >
  "Prevent automatic sleeping on power adapter when the display is off", or
  `sudo pmset -c sleep 0`. This machine already reads `sleep 0`, but only
  because running processes are asserting it; that goes away when they do.
- `caffeinate -i -t 28800` in a terminal you leave open holds idle sleep off
  for eight hours and ends when you close it or the time runs out. Good for
  "I am going out for the afternoon", bad as a permanent arrangement.
- On battery, macOS will sleep, and a closed lid on battery sleeps whatever you
  set. Let it.
- `pmset -g` prints what is actually in effect, including who is currently
  preventing sleep, which is usually more honest than the settings pane.

A login agent and an awake machine are two different guarantees. `ompd install`
gives you the first one only.

## Run an agent in a container

An agent is created on a container host by naming one in the spec:

```bash
curl -sS -X POST http://127.0.0.1:7777/v1/agents \
  -H "authorization: Bearer $(cat ~/.ompd/token)" \
  -H 'content-type: application/json' \
  -d '{"name":"sandboxed","cwd":"'"$PWD"'","host":{"kind":"container","image":"your/omp:tag"}}'
```

or from the CLI, which can also name further directories the container gets
to see:

```bash
ompd new ~/dev/some-repo --container --image your/omp:tag \
  --mounts ~/dev/shared-lib:ro,~/dev/scratch:rw
```

The daemon probes `docker`, `podman`, and `container` (Apple's) in that order
unless a runtime is pinned, starts a detached container from the named image,
mounts the workspace at the same absolute path it has here so a cwd means the
same thing on both sides, and speaks ACP over `<runtime> exec -i <id> omp acp`.
Stopping the last agent on a host removes the container and the network it was
given.

A runtime outside that list is refused rather than assumed to behave like
docker, because a runtime nobody has held a `run --help` against cannot be
trusted to have accepted the confinement it was asked for. `orbctl` was on this
list and should not have been: OrbStack's container surface is `docker`, while
`orbctl` manages OrbStack Linux machines and its `run` means "run a command on
Linux", taking none of `--volume`, `--cap-drop`, or `--network`.

ompd does not build or publish the image; `scripts/container-host.Dockerfile`
is the minimal one the end-to-end check builds, and it is a reference rather
than a product. Whatever image you point at needs `omp` on its `PATH` and a
root certificate store.

`bun run scripts/check-container-host.ts` proves the whole path against a real
container, including that a denied bash call does not run, that an allowed one
does, and that each of the escapes below fails. It cleans up everything it
makes. It runs against `docker`; the run command itself is exercised per
runtime by the unit tests in `packages/daemon/test/provisioner.test.ts`.

### Extra mounts

`mounts` in the host spec (`--mounts` on the CLI) names further host
directories, beyond the workspace, that the container gets to see. Each lands
at the identical absolute path inside, the same property that makes the
workspace mount work: a path a transcript names means the same thing on both
sides. Read-only is the default -- a folder the agent should merely reference
does not need write access, and a writable mount (`:rw`) is a decision an
operator opts into per path, not something that falls out of naming a folder.

A mount naming `/`, a home directory root, `~/.ssh`, `~/.omp`, `~/.ompd`, or
the daemon's own configured state directory (wherever `OMPD_HOME` actually
points) is refused before the container is even created, because any of those
would hand the sandbox the credentials that make it a sandbox. The refusal is
audited like any other failed provision (`ompd audit`); nothing about it is a
silent no-op.

### How it is confined

None of the flags below are configurable, because a sandbox with a switch on
it is a sandbox someone turns off. Which flags exist to turn on, though,
genuinely differs by runtime -- Apple's `container` CLI (verified against
0.4.1) has no `--cap-drop`, `--security-opt`, `--read-only`, or `--pids-limit`,
and exits on an unknown flag rather than ignoring it, so provisioning against
it never sends a flag it does not accept:

| Guarantee | docker / podman | Apple `container` |
| --- | --- | --- |
| Runs as your uid/gid, never root | yes -- `--user` | yes -- `--user` |
| No Linux capability is granted | yes -- `--cap-drop ALL` | not expressible, and arguably not needed: each container gets its own lightweight VM, so there is no shared kernel for a capability to escape into |
| A setuid binary cannot regain privilege | yes -- `--security-opt no-new-privileges` | same as above -- the VM boundary, not this flag, is what would stop it |
| **Image is read-only** | yes -- `--read-only` | **no.** This flag does not exist on this CLI. The image is writable from inside the container, which is a real loss of confinement, not a reframed one |
| A fork bomb stays inside the sandbox | yes -- `--pids-limit 1024` | not expressible; the VM's own resource limits are the boundary instead of a pid cap enforced by a shared kernel |
| Scratch is tmpfs and dies with the container | yes -- `--tmpfs` | yes -- `--tmpfs` |
| A bridge network per host | yes | yes |

The three flags Apple's CLI lacks that are folded into "a different trade, not
a hole" -- `--cap-drop`, `--security-opt no-new-privileges`, `--pids-limit` --
all mitigate a shared-kernel escape. A VM-per-container runtime has no shared
kernel for any of them to escape into, so their absence there is not the same
claim as their absence on docker. `--read-only` is not that: it is whether the
image can be rewritten from inside, and that is lost outright on Apple
`container` today, which is why it gets its own row instead of being grouped
with the rest.

### The threat model, which is the part worth reading

Assume the agent inside has gone wrong: a prompt injection out of a file it
read, a model doing something stupid, a hostile dependency it just installed.

**What it cannot reach.** The rest of your filesystem, unless you name it as
an extra mount, and even then not the paths listed under "Extra mounts" above:
`~/.ssh`, `~/.omp`, `~/.ompd`, a home directory root, and `/` are refused
outright, not merely left off by default. Nothing outside the workspace and
whatever you explicitly named is mounted, so `~/.aws` and your other
repositories are not merely unreadable, they are not there. It cannot write
the image, gain a capability, become root, or reach your other containers.

**What it can reach, which is the honest part.**

- **The whole workspace, read-write.** There is no read-only option and no
  subpath option for the workspace itself. Anything under the `cwd` you name,
  `.git` and any `.env` included, can be read, rewritten, or destroyed. Point
  a container host at a directory you would be willing to hand over whole. An
  extra mount is different: it defaults to read-only, and a subpath is exactly
  what naming one directory instead of another already is.
- **One live model credential.** omp inside the container needs one, and the
  backend injects only the image, the workspace, any mounts an operator
  explicitly named, and `OMPD_REPO` / `OMPD_REF`. The check script narrows
  that to a single provider's OAuth row copied out of
  `~/.omp/agent/agent.db` into a snapshot it deletes afterwards, with every
  other credential and the usage and cache tables emptied out of the copy, and
  the image's shim copies that seed to a container-local path so a refresh is
  discarded with the container rather than written back over yours. It is still
  a credential that can spend your money and read your model history for as
  long as the container runs.
- **The internet.** Egress is not filtered. The agent has to reach a model
  endpoint, and Docker cannot express "that host and nothing else" without a
  proxy in the path, so anything it can reach, it can reach. That includes
  posting your workspace somewhere.
- **The daemon's port.** "The daemon binds `127.0.0.1` so only this machine can
  reach it" is not true from inside a container. On Docker for Mac
  `host.docker.internal` resolves to an address that reaches services bound to
  the host's loopback, which was measured rather than assumed. It cannot be
  closed without also closing the model endpoint. What stops it being useful is
  authentication: every route except `/v1/health` answers `401` without a
  token, and the token lives in `~/.ompd`, which is not mounted. **A container
  escape into the daemon is bounded by authentication, not by the network.**

So a container host is a filesystem boundary and a privilege boundary. It is
not a network boundary and not an account boundary. It bounds the blast radius
rather than eliminating it, and on a `local` host there is no boundary at all.

## Day to day

```bash
ompd doctor                    # is any of this set up correctly
ompd status                    # running? for how long? how many agents?
ompd agents                    # id, state, name, cwd, last activity
ompd new ~/dev/some-repo       # create an agent there
ompd stop-agent agt_1234       # stop one
ompd routines                  # what is scheduled
ompd run rt_1234               # fire one now, without touching its schedule
ompd audit --limit 50          # who did what
ompd rotate                    # replace the token this shell is using
```

`OMPD_TOKEN` overrides `~/.ompd/token`, and `OMPD_URL` points the CLI at a
daemon somewhere else entirely, outranking both the published endpoint and the
config:

```bash
OMPD_URL=http://127.0.0.1:54321 OMPD_TOKEN=$(cat ~/.ompd/token) ompd agents
```

`OMPD_HOME` moves the whole state directory, which is how a second daemon runs
on the same machine without colliding with the first.

## Stopping it

`SIGINT` or `SIGTERM`. The daemon stops the scheduler, closes the gateway so no
new work arrives, and only then tears down running agents. It exits non-zero
only if that fails.

If launchd is managing it, `ompd uninstall` is what stops it for good;
`launchctl unload ~/Library/LaunchAgents/sh.ompd.plist` stops it until the next
login.
