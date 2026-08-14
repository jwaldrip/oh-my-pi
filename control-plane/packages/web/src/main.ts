/**
 * The position: everything an operator sees, and the wiring between the socket
 * and the surfaces that show it.
 *
 * Layout is a controller's position rather than a chat app. The bay holds one
 * strip per agent. The centre column is the running log for whichever strip is
 * selected, with its instruments pinned under it. The rack expands those
 * instruments when the screen is wide enough to earn them.
 *
 * State per agent is a `SessionState` from the reducer, kept for every agent
 * whether or not it is on screen, so switching strips is instant and a strip
 * that is not being watched still reports its load and its spend.
 */

import "./styles.css";

import type { Agent, AgentId } from "@ompd/core/contracts";
import { SCOPE_APPROVE } from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import type { ClientErrorEvent } from "@ompd/core/ompd-client";
import { clearConnection, defaultSocketUrl, loadConnection, saveConnection } from "./config.ts";
import type { Connection } from "./config.ts";
import { EMPTY_SESSION, appendApproval, appendPrompt, endTurn, reduce, resolveApproval } from "./session/model.ts";
import type { SessionState } from "./session/model.ts";
import { createTimeline } from "./session/render.ts";
import type { TimelineView } from "./session/render.ts";
import { createBay } from "./ui/bay.ts";
import { createAgentHub } from "./ui/agent-hub.ts";
import { createComposer } from "./ui/composer.ts";
import { el, elapsed, formatMoney, setText, shortenPath } from "./ui/dom.ts";
import { icon } from "./ui/icons.ts";
import { createPlan } from "./ui/plan.ts";
import { createDataBlock, createRack } from "./ui/readouts.ts";
import type { Readings } from "./ui/readouts.ts";
import { createStatus } from "./ui/status.ts";
import { browserSink, SpeechPlayer } from "./voice/playback.ts";

/** Cadence of the running clocks. A controller's board ticks. */
const TICK_MS = 1_000;
const TOAST_MS = 6_000;
/** Width at which the rack earns its place. */
const RACK_QUERY = "(min-width: 1180px)";
/** Width at which the bay and a log are on screen together. */
const SPLIT_QUERY = "(min-width: 860px)";

/** Error codes that mean the daemon overruled us, not that the link broke. */
const SCOPE_CODES: Record<string, true> = { forbidden: true, scope: true, unauthorized: true };

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("missing #app");

const connection = loadConnection();
if (connection === null) {
  renderPairing(root);
} else {
  renderConsole(root, connection);
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * `notice` explains why the operator is looking at this screen again rather
 * than at their agents. A pairing form with no explanation, after a console
 * that was working a second ago, reads as the app having lost its mind.
 */
function renderPairing(host: HTMLElement, notice?: string): void {
  const url = el("input", {
    class: "field-input",
    attrs: { id: "pair-url", type: "url", required: "", placeholder: "ws://127.0.0.1:7717/v1/socket" },
  });
  url.value = defaultSocketUrl();

  const token = el("input", {
    class: "field-input",
    attrs: { id: "pair-token", type: "password", required: "", placeholder: "device token", autocomplete: "off" },
  });

  // An assertive live region, not the polite one the toast uses: this is the
  // reason the screen changed under the operator, so a screen reader has to
  // interrupt with it rather than queue it behind whatever it was reading.
  const notified =
    notice === undefined
      ? []
      : [
          el("p", {
            class: "pairing-notice",
            attrs: { role: "alert" },
            text: notice,
          }),
        ];

  const form = el("form", {
    class: "pairing",
    children: [
      el("p", { class: "pairing-kicker", text: "ompd" }),
      el("h1", { class: "pairing-title", text: "Take the position" }),
      ...notified,
      el("p", {
        class: "pairing-lead",
        text: "Run ompd device pair on the machine running the daemon, then paste the token it prints.",
      }),
      el("label", {
        class: "field",
        attrs: { for: "pair-url" },
        children: [el("span", { class: "field-label", text: "Daemon socket" }), url],
      }),
      el("label", {
        class: "field",
        attrs: { for: "pair-token" },
        children: [el("span", { class: "field-label", text: "Device token" }), token],
      }),
      el("button", { class: "btn btn-primary", attrs: { type: "submit" }, text: "Connect" }),
    ],
  });

  form.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    const next: Connection = { url: url.value.trim(), token: token.value.trim(), scopes: [] };
    if (next.url.length === 0 || next.token.length === 0) return;
    saveConnection(next);
    host.replaceChildren();
    renderConsole(host, next);
  });

  host.replaceChildren(el("div", { class: "pairing-host", children: [form] }));
  url.focus();
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

function renderConsole(host: HTMLElement, connection: Connection): void {
  const client = new OmpdClient({ url: connection.url, token: connection.token });

  const sessions = new Map<AgentId, SessionState>();
  const timelines = new Map<AgentId, TimelineView>();
  const agentsById = new Map<AgentId, Agent>();
  const watermarks = new Map<AgentId, number>();
  /** Agents this page has already pulled a full transcript for. */
  const backfilled = new Set<AgentId>();
  const turnStarts = new Map<AgentId, number>();
  /** How long the previous turn took, so the readout is never blank after one. */
  const turnDurations = new Map<AgentId, number>();

  let selected: AgentId | null = null;
  // A pairing that did not declare its scopes stays optimistic; the daemon's
  // first refusal is what downgrades it.
  let canApprove = connection.scopes.length === 0 || connection.scopes.includes(SCOPE_APPROVE);

  // -- chrome ---------------------------------------------------------------

  const status = createStatus();
  const clock = el("span", { class: "position-clock" });

  const unpair = el("button", {
    class: "icon-btn",
    attrs: { type: "button", "aria-label": "Forget this pairing" },
    children: [icon("unpair")],
  });
  unpair.addEventListener("click", () => {
    client.close();
    clearConnection();
    host.replaceChildren();
    renderPairing(host);
  });

  const position = el("header", {
    class: "position",
    children: [
      el("div", {
        class: "position-brand",
        children: [
          icon("bay", "position-mark"),
          el("span", { class: "position-name", text: "ompd" }),
          el("span", { class: "position-sub", text: "strip bay" }),
        ],
      }),
      clock,
      status.element,
      unpair,
    ],
  });

  const bay = createBay({
    onSelect: (agentId) => {
      select(agentId);
    },
  });
  const agentHub = createAgentHub();
  const bayStack = el("aside", {
    class: "bay-stack",
    attrs: { "aria-label": "Agent position" },
    children: [agentHub.element, bay.element],
  });

  // -- the log column -------------------------------------------------------

  const back = el("button", {
    class: "icon-btn log-back",
    attrs: { type: "button", "aria-label": "Back to the bay" },
    children: [icon("back")],
  });
  back.addEventListener("click", () => {
    const previous = selected;
    host.setAttribute("data-view", "list");
    if (previous !== null) bay.focusAgent(previous);
  });

  const callsign = el("h1", { class: "log-callsign", attrs: { tabindex: "-1" }, text: "No strip selected" });
  const logState = el("span", { class: "log-state", text: "" });
  const logOrigin = el("span", { class: "log-origin", text: "" });
  const logClock = el("span", { class: "log-clock", text: "" });

  const logHead = el("header", {
    class: "log-head",
    children: [
      back,
      el("div", {
        class: "log-ident",
        children: [callsign, el("div", { class: "log-meta", children: [logOrigin, logClock] })],
      }),
      logState,
    ],
  });

  const timelineHost = el("div", { class: "log-timeline" });
  const vacant = el("div", {
    class: "vacant",
    children: [
      icon("bay", "vacant-mark"),
      el("p", { class: "vacant-title", text: "No strip selected" }),
      el("p", { class: "vacant-lead", text: "Pick an agent from the bay to take its log." }),
    ],
  });
  timelineHost.append(vacant);

  const plan = createPlan();
  const planDock = el("div", { class: "plan-dock" });
  const dataBlock = createDataBlock();
  const rack = createRack();

  const composer = createComposer({
    onSubmit: (text) => {
      if (selected === null) return;
      client.prompt(selected, text);
      mutate(selected, (state) => appendPrompt(state, text));
      // Optimistic: the daemon's next roster frame is the authority, but a
      // composer that stays live after a send reads as a dropped prompt.
      turnStarts.set(selected, Date.now());
      composer.setBusy(true);
      timelineFor(selected).setTurnActive(true);
      timelines.get(selected)?.scrollToEnd();
    },
    onCancel: () => {
      if (selected === null) return;
      client.cancel(selected);
    },
  });
  composer.setEnabled(false);

  const logColumn = el("main", {
    class: "log-column",
    children: [logHead, timelineHost, planDock, dataBlock.element, composer.element],
  });

  const toast = el("div", { class: "toast", attrs: { role: "status", "aria-live": "polite" } });
  toast.hidden = true;
  let toastTimer: number | undefined;

  host.replaceChildren(position, bayStack, logColumn, rack.element, toast);

  // The plan panel has two homes and one instance: moving the node keeps its
  // open state and its rows rather than duplicating them per breakpoint.
  const wide = window.matchMedia(RACK_QUERY);
  function placePlan(): void {
    (wide.matches ? rack.planHost : planDock).append(plan.element);
  }
  wide.addEventListener("change", placePlan);
  placePlan();

  // On a phone the bay is the whole screen and taking a strip is a deliberate
  // act. Wider than that, both are on screen at once and an empty log column is
  // just a hole, so the top strip is taken automatically.
  const sideBySide = window.matchMedia(SPLIT_QUERY);

  // -- state ----------------------------------------------------------------

  function sessionFor(agentId: AgentId): SessionState {
    return sessions.get(agentId) ?? EMPTY_SESSION;
  }

  function timelineFor(agentId: AgentId): TimelineView {
    const existing = timelines.get(agentId);
    if (existing !== undefined) return existing;
    const created = createTimeline({
      onDecide: (requestId, choice, scope) => {
        client.decide(agentId, requestId, choice, scope);
        mutate(agentId, (state) => resolveApproval(state, requestId, choice));
      },
    });
    created.setCanApprove(canApprove);
    timelines.set(agentId, created);
    return created;
  }

  function readingsFor(agentId: AgentId): Readings {
    const state = sessionFor(agentId);
    const agent = agentsById.get(agentId);
    const startedAt = turnStarts.get(agentId);
    return {
      cwd: agent?.cwd ?? "unknown",
      state: agent?.state ?? "stopped",
      usage: state.usage,
      turnMs: startedAt === undefined ? (turnDurations.get(agentId) ?? null) : Date.now() - startedAt,
      turnLive: startedAt !== undefined,
      seq: watermarks.get(agentId) ?? 0,
      tools: state.activity.tools,
      running: state.activity.running,
      failed: state.activity.failed,
      clearances: state.pendingApprovals.length,
      commands: state.commands.length,
      model: state.info.model,
    };
  }

  function paintStrip(agentId: AgentId): void {
    const state = sessionFor(agentId);
    const usage = state.usage;
    bay.setStats(agentId, {
      contextPct: usage === null || usage.size === 0 ? null : (usage.used / usage.size) * 100,
      cost: usage === null ? null : formatMoney(usage.costAmount, usage.costCurrency),
      tools: state.activity.tools,
      running: state.activity.running,
      clearances: state.pendingApprovals.length,
    });
  }

  /** The one path that changes a session. Everything downstream repaints here. */
  function mutate(agentId: AgentId, change: (state: SessionState) => SessionState): void {
    const before = sessionFor(agentId);
    const after = change(before);
    if (after === before) return;
    sessions.set(agentId, after);
    paintStrip(agentId);
    if (agentId !== selected) return;
    timelineFor(agentId).render(after);
    plan.render(after.plan);
    composer.setCommands(after.commands, after.commandDetails);
    paintInstruments();
  }

  function paintInstruments(): void {
    if (selected === null) return;
    const readings = readingsFor(selected);
    dataBlock.render(readings);
    rack.render(readings);
  }

  function paintHead(): void {
    if (selected === null) return;
    const agent = agentsById.get(selected);
    if (agent === undefined) return;
    setText(callsign, agent.name);
    setText(logOrigin, shortenPath(agent.cwd, 3));
    logOrigin.setAttribute("title", agent.cwd);
    setText(logClock, elapsed(agent.lastActiveAt));
    setText(logState, agent.state);
    logHead.setAttribute("data-state", agent.state);
  }

  function select(agentId: AgentId): void {
    const changed = selected !== agentId;
    selected = agentId;
    host.setAttribute("data-view", "agent");
    if (!changed) return;

    bay.setSelected(agentId);
    const timeline = timelineFor(agentId);
    timelineHost.replaceChildren(timeline.element);
    const state = sessionFor(agentId);
    timeline.render(state);
    plan.render(state.plan);
    composer.setCommands(state.commands, state.commandDetails);
    paintHead();
    paintInstruments();

    // The first time this page sees an agent it asks for the whole transcript,
    // because a console opened mid-session should show the session. After that
    // the client's own watermark resumes, so revisiting a strip never replays a
    // log that is still on screen and a reconnect picks up where it stopped.
    if (backfilled.has(agentId)) {
      client.attach(agentId);
    } else {
      backfilled.add(agentId);
      client.attach(agentId, { sinceSeq: 0 });
    }

    const agent = agentsById.get(agentId);
    composer.setEnabled(client.connectionState === "connected");
    composer.setBusy(agent?.state === "busy");
    timeline.setTurnActive(agent?.state === "busy");
    // Focus the heading, not the field: on a phone, focusing a textarea throws
    // the keyboard over the log the operator just asked to see.
    callsign.focus();
    timeline.scrollToEnd();
  }

  function showToast(message: string): void {
    setText(toast, message);
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, TOAST_MS);
  }

  // -- client wiring --------------------------------------------------------

  client.on("status", (event) => {
    status.render(event);
    composer.setEnabled(event.state === "connected" && selected !== null);
  });

  client.on("agents", (event) => {
    const previous = new Map(agentsById);
    agentsById.clear();
    for (const agent of event.agents) agentsById.set(agent.id, agent);
    agentHub.render(event.agents.filter((agent) => agent.parentAgentId !== undefined));
    bay.render(event.agents.filter((agent) => agent.parentAgentId === undefined));

    for (const agent of event.agents) {
      const before = previous.get(agent.id);
      if (agent.state === "busy" && before?.state !== "busy") turnStarts.set(agent.id, Date.now());
      if (agent.state !== "busy" && before?.state === "busy") {
        const startedAt = turnStarts.get(agent.id);
        if (startedAt !== undefined) turnDurations.set(agent.id, Date.now() - startedAt);
        turnStarts.delete(agent.id);
        mutate(agent.id, endTurn);
      }
      paintStrip(agent.id);
    }

    if (selected === null && sideBySide.matches) {
      const top = bay.topAgent();
      if (top !== null) select(top);
    }

    // An agent off the roster is never coming back on this id. Stop streaming
    // it and let its log go.
    for (const agentId of [...sessions.keys()]) {
      if (agentsById.has(agentId)) continue;
      client.detach(agentId);
      sessions.delete(agentId);
      timelines.delete(agentId);
      turnStarts.delete(agentId);
      turnDurations.delete(agentId);
    }

    if (selected === null) return;
    const agent = agentsById.get(selected);
    if (agent === undefined) {
      showToast("That agent is gone.");
      selected = null;
      bay.setSelected(null);
      timelineHost.replaceChildren(vacant);
      composer.setEnabled(false);
      host.setAttribute("data-view", "list");
      return;
    }
    paintHead();
    composer.setBusy(agent.state === "busy");
    timelineFor(selected).setTurnActive(agent.state === "busy");
    paintInstruments();
  });

  client.on("update", (event) => {
    watermarks.set(event.agentId, event.seq);
    mutate(event.agentId, (state) => reduce(state, event.update));
  });

  // The daemon speaks only to a device that spoke first, so anything arriving
  // here was asked for. The sink is built on the first frame rather than at
  // load, because a browser will not start an AudioContext before a gesture
  // and an eagerly built one stays suspended forever.
  const speech = new SpeechPlayer({
    createSink: browserSink,
    onLog: (line) => console.warn(line),
  });
  client.on("speech", (event) => {
    void speech.play(event.pcm);
  });

  client.on("approval", (event) => {
    mutate(event.agentId, (state) =>
      appendApproval(state, {
        requestId: event.requestId,
        tool: event.tool,
        title: event.title,
        input: event.input,
      }),
    );
    if (event.agentId !== selected) {
      showToast(`${agentsById.get(event.agentId)?.name ?? "An agent"} needs a clearance.`);
      return;
    }
    const active = document.activeElement;
    // Never steal focus mid-sentence: the live region has already announced it.
    if (active instanceof HTMLElement && composer.element.contains(active)) return;
    timelineFor(event.agentId).focusClearance();
  });

  client.on("error", (event: ClientErrorEvent) => {
    if (event.code !== undefined && SCOPE_CODES[event.code]) {
      canApprove = false;
      const reason = `${event.message}. Sign this from a device holding the approve scope.`;
      for (const timeline of timelines.values()) timeline.setCanApprove(false, reason);
    }
    showToast(event.message);
  });

  // The credential is dead, confirmed by the daemon rather than inferred from
  // a failed connection. Keeping it would leave the console retrying forever
  // against a token nothing will ever accept, which looks exactly like the
  // daemon being down and is the one thing it is not.
  client.on("unauthorized", (event) => {
    client.close();
    clearConnection();
    host.replaceChildren();
    host.removeAttribute("data-view");
    renderPairing(host, `${event.reason} Pair this device again to carry on.`);
  });

  client.start();

  // -- the tick -------------------------------------------------------------

  const timeFormat = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  function tick(): void {
    setText(clock, timeFormat.format(new Date()));
    bay.refreshClocks();
    agentHub.refreshClocks();
    if (selected === null) return;
    const agent = agentsById.get(selected);
    if (agent !== undefined) setText(logClock, elapsed(agent.lastActiveAt));
    if (turnStarts.has(selected)) paintInstruments();
  }

  tick();
  window.setInterval(tick, TICK_MS);

  window.addEventListener("online", () => {
    client.reconnectNow();
  });

  document.addEventListener("visibilitychange", () => {
    // Phones suspend timers in the background, so a pending backoff may be
    // hours stale by the time the app is looked at again.
    if (document.visibilityState !== "visible") return;
    client.reconnectNow();
  });

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (host.getAttribute("data-view") !== "agent") return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && composer.element.contains(active)) return;
    host.setAttribute("data-view", "list");
    if (selected !== null) bay.focusAgent(selected);
  });

  registerServiceWorker();
}

function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((cause: unknown) => {
      console.warn("ompd: service worker registration failed", cause);
    });
  });
}
