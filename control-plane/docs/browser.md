# The agent-driveable WebView

On the laptop the agent drives the user's own Chrome through the OMP browser
relay: `app.relay: true`, a real tab, a real profile, a real extension.
There is no laptop-shaped browser on a phone, and no relay extension to
install into it. `@ompd/app` embeds `react-native-webview` 14.0.1 (observe/
click/type/navigate) and `react-native-view-shot` 4.0.3 (screenshot) instead,
and the daemon mounts a small MCP server into the agent's session so a tool call can
drive it. This document is the vocabulary that capability speaks, written
before the implementation so the implementation has something to be honest
against.

## Why this is not the `browser`/`computer` tool

OMP already ships `browser` (CDP, relay-capable) and `computer` (host desktop
control) as native tools -- `docs/acp-approval-gate.md` gates both through
elicitation already. Neither can reach an in-app WebView running on a
different device across a websocket, and neither is ours to extend:
`packages/coding-agent` is upstream. So this is a new capability, mounted the
way every third-party tool reaches an OMP session -- as an MCP server, passed
through `session/new.mcpServers` -- and it is deliberately named apart from
`browser`/`computer` (`webview_*`) so it is never confused with a tool that
drives a different surface under a similar name.

## Vocabulary

Five actions, chosen to be the smallest set the relay's own vocabulary
already uses -- navigate, observe, click, type, screenshot -- so a model that
has driven the relay is not learning a second language for the phone.

| Action | Input | Output | Native mechanism |
| --- | --- | --- | --- |
| `navigate` | `url` | `ack` (url, title) or `error` | `WebView.injectJavaScript` sets `location.href`; completion via `onNavigationStateChange`, not the message bridge -- a page unloading is not a page that can reliably `postMessage` first. |
| `observe` | -- | `WebViewObservation`: url, title, a structural tree, `settled` | Injected script (`bridge.ts#buildInjectedScript`), reply via the nonce-correlated message bridge. |
| `click` | `ref` (from a prior observation) | `ack` or `error` | Same injected-script channel as `observe`. |
| `type` | `ref`, `text`, `replace?` | `ack` or `error` | Same injected-script channel as `observe`. |
| `screenshot` | -- | base64 PNG | `react-native-view-shot`'s `captureRef` on the WebView's container `<View>` -- a capture of the native view, which page JS cannot produce, so this one never touches the message bridge either. |

**Observation matters more than action.** An agent that cannot see a page
guesses at it, and a screenshot cannot be queried for "the submit button" --
it forces the model to estimate coordinates the way `computer`'s pixel mode
does, which is exactly the fallback this capability exists to avoid on a
touch-sized viewport. `observe` returns `WebViewNode`, an accessibility-style
tree (tag, role, text, a small attribute allowlist, children), not a DOM
dump: enough structure to name a target by `ref`, never enough to hand the
model raw HTML to parse. `screenshot` exists for appearance judgments --
layout, color, whether something visibly rendered -- and is not how an agent
finds a click target. It is also the one action with a real capability gap
of its own: `react-native-view-shot`'s podspec is `ios`-only (no `:osx`,
no `macos/` folder in the package at all), so `webview_screenshot` has no
macOS implementation to even be unverified about, unlike the other four
actions, which macOS genuinely could run once this app scaffolds a `macos/`
project. Windows is covered (`react-native-view-shot` ships a `windows/`
project alongside `react-native-webview`'s).

**A ref is a handle, not an address.** It is valid until the next `observe`
or a navigation invalidates it; the native side mints it, the page never
sees it, and a click or type against a stale ref fails rather than hitting
whatever now occupies that position.

## Page content can only ever become data

`WebViewNode.text` and `.attributes` are exactly what the page said. Nothing
in the bridge (`app/src/browser/bridge.ts`) has a code path that turns them
into an action: the type returned to a caller when a page's own script tries
to talk back is `{ kind: "resolved" }` or `{ kind: "dropped" }`, and there is
no `{ kind: "action" }` case for either to become. The one channel that can
cause a real side effect -- navigate, click, type -- is `webview_action`,
sent by the daemon over the authenticated websocket after the policy engine
has already decided. A page cannot originate that frame; at most it can make
its *content* alarming, which is a fact about the page an operator reads in
the transcript, not an instruction anything downstream executes.

Concretely: every inbound message from the WebView is matched against a
nonce the native side minted for the one outstanding request it is waiting
on. A message that does not match -- unsolicited, replayed, or forged by the
page's own script calling `window.ReactNativeWebView.postMessage` on its own
initiative -- is dropped before it reaches anything that could act on it.
`app/test/browser-bridge.test.ts` proves this for both a mismatched nonce and a message
shaped like a spoofed action.

## Every mutating action reaches the policy engine

`webview_observe` and `webview_screenshot` are read-only and carry no
filesystem or network write, so they join `read`/`grep`/`glob` in
`core/policy.ts`'s fast-path tables -- a phone should not be nagged for
looking. `webview_navigate`, `webview_click`, and `webview_type` name no
filesystem path and no shell command, so `DefaultPolicy.evaluate()` falls
through every specific rule to the same place `bash` and an out-of-workspace
write land: `{ action: "prompt", reason: "no rule matched; defaulting to
human" }`.

**Stated gap, not a silent one.** `WebViewBridge` (`daemon/src/browser/`)
evaluates that decision directly rather than through `Supervisor`'s `#gate`
-- reusing `#gate` would open a real
`ApprovalRequest` row that nothing today can answer, since no client screen
renders a webview-action approval yet, and the call would sit until
`approvalTimeoutMs` expired instead of failing fast. So today, `prompt`
fails closed immediately with a distinct reason
(`"requires operator approval, not yet wired"`) rather than either
auto-allowing or silently hanging. The fix, when a client screen exists to
render it, is to route that one branch through the same approval queue
everything else already uses -- the type (`ApprovalRequest`) and the wire
frames (`t: "approval"` / `t: "decide"`) are already shared, so nothing about
the contract changes when that lands.

`daemon/test/browser-bridge.test.ts` proves both halves: an actor-independent `deny`-shaped
policy stops `webview_navigate` before any frame reaches a device (the
device-send spy is asserted never called), and a policy that returns `allow`
lets the identical call through to dispatch. `webview_observe` is proven
allowed on the fast path with the *same* policy that denies `navigate`,
which is the part that would be trivial to fake by hard-coding an allow.

## Composition: the whole round trip

A tool call reaches a device and its answer reaches the model back through
six seams, all of which are now wired. Named in order, because "the daemon
plumbing" understates how many distinct pieces that phrase covers.

1. **Mount.** `daemon.ts` constructs one `WebViewBridge` and one
   `WebViewMcpServer` per daemon, and passes `mcpServersFor` to `Supervisor`,
   so `session/new` and `session/load` both carry an `ompd-webview` descriptor
   naming a loopback URL with a per-agent token. Resumed sessions get the same
   mount as fresh ones, which is what stops a restart from silently taking the
   capability away from an agent that had it.
2. **Register.** A client that mounts a WebView sends
   `{ t: "webview_register", agentId }` on its socket. The gateway holds one
   target per agent, refuses a registration for an agent this socket has not
   attached to, and requires `read` scope. Registering displaces the previous
   holder, and `detach`, `webview_unregister`, or losing the socket all drop it.
3. **Gate.** `tools/call` reaches `WebViewBridge.performAction`, which
   evaluates `DefaultPolicy` before anything is dispatched. See "Every
   mutating action reaches the policy engine" above.
4. **Dispatch.** `Gateway.sendWebViewAction` pushes `webview_action` to the
   registered socket, and answers `false` synchronously when there is no
   target, so the tool call fails immediately rather than waiting out the
   bridge's device timeout for a frame that could never arrive.
5. **Answer.** The client performs the action against its own
   `WebViewDriver` and replies `webview_result` with the request id it was
   given. The gateway refuses a result from a socket that is not the agent's
   registered target, and refuses an unknown or already-settled request id,
   so one device cannot settle another's action by replaying what it observed.
6. **Unavailable.** A registered socket that closes mid-action fails every
   in-flight action for that agent at once (`onWebViewUnavailable` ->
   `WebViewBridge.cancelAgent`), rather than leaving the model waiting.

`daemon/test/daemon.test.ts`'s "WebView composition" cases drive 1 through 5
end to end against a real `Bun.serve` gateway, a real socket, and the real
MCP server, and cover 6 by closing the socket mid-action. `gateway.test.ts`
covers the refusal paths, `browser-bridge.test.ts` the gating, and
`browser-mcp.test.ts` the MCP surface.

On the client side, `core/src/ompd-client.ts` owns the transport for every
ompd client (app, web, and the TUI-as-client), including replaying
registrations after a reconnect's `hello`, in that order: an attach first,
then the registration the daemon would otherwise refuse. `app`'s session
screen mounts the driver behind a browser toggle and registers it on mount,
which is the only place a `WebViewDriverHandle` and an `AgentId` meet.

## Per-platform status

| Platform | Support | Note |
| --- | --- | --- |
| iOS | unverified | `react-native-webview`'s primary target: podspec declares `ios => 11.0`, `WebView.ios.tsx` implements `injectJavaScript`/`onMessage` (read at `node_modules/react-native-webview/src/WebView.ios.tsx`), and `@ompd/app/ios` already has a scaffolded Xcode workspace. No simulator run was exercised in this pass -- Xcode 26.6 and simulators are present on this machine, so that is the concrete next step, not a structural blocker. |
| Android | unverified | Same shape as iOS: `WebView.android.tsx` implements the identical `injectJavaScript`/`onMessage` surface, `@ompd/app/android` has a Gradle project already. No emulator run was exercised. |
| macOS | unverified | `react-native-webview` genuinely supports it at the source level -- the podspec declares `osx => 10.13`, and `WebView.macos.tsx` / `WebViewNativeComponent.macos.ts` / a dedicated `macos/RNCWebView.xcodeproj` all ship in the 14.0.1 package. The gap is this app, not the library: `@ompd/app` has no `macos/` native project (`react-native-macos-init` has never been run here), so there is nothing to build yet. `react-native-macos` is a listed dependency (`0.81.9`) with no declared peer range against `react-native-webview`, which is why this could not simply be assumed to work. |
| Windows | unverified | Two independent gaps. `@ompd/app` has no `windows/` native project either, and even if it did, this machine has no Windows build environment to exercise it from. `react-native-webview` does ship Windows support (`windows/ReactNativeWebView.sln`, autolinking declared in its own `react-native.config.js`, `WebView.windows.tsx` implementing the same bridge surface) and `react-native-windows` (`0.81.32`) is a listed dependency, again with no declared peer range. |
| Web (`react-native-web`) | unavailable | Not a gap -- a deliberate absence. A browser tab cannot honestly host a driveable browser inside itself: there is no second content process to sandbox, no separate storage partition, and "the agent's own browser" would just be the visitor's own tab. `app/src/browser/index.web.ts` exports `webViewCapability: null`, typed as literal `null` rather than `WebViewCapability \| null`, so a caller cannot compile code that assumes the capability might be present on web and only discovers otherwise at runtime. The relay -- the laptop's real mechanism -- is what the web/desktop story actually is, and it is out of this slice's scope, not replaced by this one. |

Nothing above is claimed "verified" in this pass. `WebViewSupport` has three
states -- `verified`, `unverified`, `unavailable` -- specifically so a
platform can be honestly *un*ticked rather than defaulted to looking
supported because nobody found a reason to say otherwise.

## What the agent can and cannot see from inside the WebView

**It can see exactly what the app's own WebView loads, in the app's own
sandbox.** `react-native-webview` gives each `<WebView>` its own cookie jar,
`localStorage`, and process-level isolation from the rest of the app and
from any other app on the device; it is not a bridge to Safari, Chrome, or
whatever browser the phone's owner actually uses day to day. There is no
shared session, no shared saved password, and no shared history. Whatever
the agent navigates to starts from that sandbox's own blank state, the same
way a fresh browser profile does, and whatever it observes is scoped to that
one WebView instance -- not to other tabs, because there are no other tabs,
and not to the OS keychain, because `injectJavaScript` runs inside the
page's own JS context with the page's own privileges, not the app's.

**It cannot see the operator's real browsing.** No access to the device's
system browser's cookies, saved credentials, extensions, or open tabs; no
access to the app's own AsyncStorage-backed connection/pairing state
(`platform/connection.ts`), which lives outside the WebView entirely; and no
access to other apps' sandboxes, which iOS/Android enforce regardless of
what this code does. If a page the agent navigates to requires a login the
operator already has in their real browser, that login does not carry over
-- which is the correct failure mode for a sandbox, not a bug to route
around.
