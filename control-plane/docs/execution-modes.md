# Execution Modes

OMP-as-driver has four modes. All four run through one local daemon
(`ompd`); none of them is a second execution engine.

## The four modes

| Mode | What it is | Where the agent runs | Already built |
|---|---|---|---|
| **Code** | The existing agent coding session (`omp acp` spawned by the supervisor). Every other mode ultimately produces one of these. | Local `omp acp` host (or container/cloud host) | Yes — this is the supervisor/host machinery every mode below reuses. |
| **Chat** | An interactive session driven from a client (app/web/CLI), same as today's console. | Local host, via ompd | Yes — `Console`/`SessionScreen`, `useConsole`, gateway websocket. |
| **Routine** | A prompt fired on a trigger: `cron` (time) or `webhook` (external event), tracked as a `Run`. | Local host, via `Scheduler` | Cron: yes (`routines/cron.ts`, `routines/scheduler.ts`). Webhook: trigger kind already modeled (`scheduler.ts` treats `manual`/`webhook` as "driven from outside the clock"), but no public HTTP surface exists to fire one. **Gap.** |
| **Cowork** | Work scoped to one or more bound directories, executed on a container/VM host so the blast radius is the bound set, not the whole machine. | `container`/`cloud` host via `HostProvisioner` | Backend: yes (`workspace/{tasks,skills,connectors}.ts`, `provisioner/{container,cloud,local}.ts`). Directory-binding UX (choosing which folders a task's container sees) and web/desktop UI parity: **gap.** |

## The constraint that shapes all of it

**Every mode always executes through the operator's own local `ompd`.**
A webhook does not spin up cloud compute to run your agent; it reaches a
public relay (the **hub**), which forwards the trigger over the daemon's
already-open outbound tunnel to the pinned local daemon, which runs the
routine through the same `Scheduler`/`Supervisor` a cron trigger does.
There is no code path where a routine executes anywhere your `ompd` is not
running. If your Mac is asleep, the routine does not run — this is already
true today for cron (`docs/running.md`, "The Mac has to be awake") and the
webhook path inherits it by construction rather than working around it.

This is why the hub is a sealed, content-blind relay (see `docs/hub.md`)
and not a second control plane: it does not gain the ability to execute
anything by carrying a webhook trigger.

## Webhook routing (new)

```
external caller
     │  POST https://hub.example/v1/webhooks/<daemonId>/<routineId>?token=<secret>
     ▼
   hub (public, deployed via packages/hub/deploy)
     │  forwards over the daemon's existing tunnel leg
     ▼
 local ompd  ──▶  Scheduler.fireWebhook(routineId, token)  ──▶  Supervisor (same as cron)
```

- The secret is per-routine, minted by the daemon, never known to the hub in
  plaintext beyond what it needs to route (the hub already cannot decrypt
  payloads; the webhook token is verified daemon-side, same trust boundary
  as everything else in `docs/hub.md`).
- No device pairing is required for a webhook caller — pairing is for
  people, a webhook token is for a service. That is a deliberately
  different, narrower credential: it can only ever fire one named routine.

## Voice across modes

Voice does not branch per mode. The daemon's voice bridge is already
keyed on `agentId` + `deviceId`, and every mode above eventually produces
(or attaches to) an agent. Memo, Live, and Live+Narration therefore attach
to whichever mode's agent is active — a live voice call over a Cowork task's
agent works the same as over a Chat session's agent.

**Collab Voice (Multi-Party):**
- **Live Conference Call:** `/collab` live voice runs as a WebRTC conference
  room where human guests AND agent(s) sit in the same audio room. Human speech
  is mixed; agent TTS is spoken to the room.
- **PTT / Voice Notes:** In PTT mode during a collab session, the voice-notes
  feed carries audio notes from BOTH human participants and the agent(s),
  queued in chronological order on the transcript timeline.

## Universal Links & App Handoff (`.ompsession`)

- **Universal Links for Collab:** Hub `/collab` join URLs use a universal-link
  domain (`app.ompctl.ai` / `app.ompctl.ai`) registered with `apple-app-site-association`
  (iOS/macOS) and `assetlinks.json` (Android). Clicking a join link opens our
  native app directly if installed, falling back to the web app in browser.
- **Handoff File Format (`.ompsession`):** Handoff exports are saved as a
  structured JSON container (`.ompsession`) containing session ID, handoff
  markdown, active model/role config, and daemon routing hint. Registered as
  a document type on iOS (`CFBundleDocumentTypes`), Android (`<intent-filter>`),
  macOS, and Windows. Opening an `.ompsession` file boots the app, connects to
  the daemon, and resumes the session at the handoff boundary.

## Cloud vs. local daemon

There is no special "cloud daemon" binary — a cloud daemon is the same
`ompd`, run somewhere reachable (a container/VM the operator provisions),
enrolled with the same hub. The operator pairs with it exactly like any
other daemon (its own device pairing, its own token) — there is no new
trust primitive here, just a second daemon the app also knows about. The
app does not need a cloud/local flag: it needs to hold **more than one
saved connection** and let the operator pick which one is active. That is
the actual client-side gap (`platform/connection.ts` today stores exactly
one pairing).

**Sync replicates full state, not just config.** A cloud daemon mirrors:

- Config: policy mode, keepAwake, routine definitions (webhook secrets
  exported by reference only, never the resolved secret value), skill and
  connector registrations.
- Sessions: the full agent list and session transcripts/update logs, not
  merely index metadata. A cloud replica exists so the fleet is readable
  and reviewable even when the local Mac is off; a metadata-only mirror
  cannot do that.

**Never replicated, no exceptions:** device bearer tokens/credential
material, and live host process handles. A running `omp acp` process or
container cannot be "synced" — it exists on exactly one machine. Copying a
bearer token would be copying a credential that authorizes arbitrary code
execution as the operator; copying a transcript is not that.

**Execution authority never moves, and the reason it can't be bypassed is
existing plumbing, not a promise.** A write action (prompt, decide,
new-agent, cancel) sent to a cloud daemon for a session that daemon does
not itself own is authorized the same way every action already is: the
caller must hold a valid pairing *on that daemon*, checked against the
same `Actor`/scope model every route already uses (`SCOPE_PROMPT`,
`SCOPE_MANAGE`, ...) — nothing new is trusted. What's new is only what the
cloud daemon does once the call is authorized: instead of executing it
(it has no local host for that session), it records a queued intent
tagged with the authorized actor. The *owning* local delegate pulls and
drains that queue using the same sync credential the config/session
export already requires, and only the local delegate ever calls the
supervisor. A cloud daemon that is fully compromised can therefore see
synced state and can enqueue bogus intents from a caller it wrongly
authorized — it can never make a supervisor run anything by itself.

This ships as a manual, operator-initiated `ompd sync <target-url> --token
<token>` (push/pull, not silent background replication — two daemons
quietly overwriting each other is a worse failure mode than an operator
running one command when they mean to), plus a queued-intent surface the
owning delegate drains on its own schedule.

## Desktop and web parity

`react-native-macos`/`react-native-windows` are declared dependencies with
no generated native project. Web (`packages/web`) already has session
rendering and voice playback, but no Cowork surface (task sidebar,
skills/connectors catalogue). Both are additive UI work over contracts
that already exist server-side; neither needs a new daemon route.

## Explicitly out of reach of engineering alone

- **CarPlay**: requires Apple's CarPlay entitlement, granted only after
  Apple reviews the specific app and use case. Code can be written and
  wired; it cannot run on a real head unit, and cannot ship to the App
  Store, without that grant.
- **watchOS / Wear OS distribution**: buildable as an in-repo target and
  testable in a simulator; shipping to a physical Watch/App Store needs
  device pairing and store review this pass does not perform.
- **Windows desktop**: `react-native-windows` needs a Windows toolchain to
  actually compile; this session can scaffold the project files but cannot
  build-verify them from this Mac.
