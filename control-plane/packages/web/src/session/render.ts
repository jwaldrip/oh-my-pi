/**
 * The running log for one strip.
 *
 * Rendering is incremental by construction. The reducer shares every entry that
 * did not change, so a pass over the timeline is a walk of pointer comparisons,
 * and a streamed token costs one `appendData` on a text node that is already on
 * screen. Nothing is rebuilt, which is what keeps a selection intact, a scroll
 * position honest, and a tool card's expanded state from collapsing under the
 * next chunk.
 *
 * The vocabulary is a controller's log: an entry is a line in the record, a tool
 * call is an annotation against it, and a clearance request is a card that holds
 * the whole strip until somebody signs it.
 */

import type { ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import { el, formatPayload, setText, toggleClass } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import type { ApprovalEntry, AssistantEntry, Entry, SessionState, ToolEntry, UnknownEntry, UserEntry } from "./model.ts";

export interface TimelineOptions {
  onDecide(requestId: string, choice: ApprovalChoice, scope: ApprovalScope): void;
  /** Milliseconds a fresh clearance card keeps its buttons disabled. */
  armMs?: number;
}

export interface TimelineView {
  readonly element: HTMLElement;
  render(state: SessionState): void;
  /** Grants or withdraws this device's authority to sign clearances. */
  setCanApprove(canApprove: boolean, reason?: string): void;
  /**
   * Whether the agent is producing right now. The model's `streaming` flag says
   * a message was left open; only the roster knows whether anyone is still
   * typing into it, and a replayed transcript is full of the former without any
   * of the latter.
   */
  setTurnActive(active: boolean): void;
  scrollToEnd(): void;
  focusClearance(): boolean;
}

interface EntryNode {
  entry: Entry;
  root: HTMLElement;
  /** The text node streamed content is appended to. */
  text: Text | null;
  status: HTMLElement | null;
  title: HTMLElement | null;
  body: HTMLElement | null;
  output: HTMLElement | null;
  outputWrap: HTMLElement | null;
  decision: HTMLElement | null;
  actions: HTMLElement | null;
  expanded: boolean;
}

/** How far off the bottom the operator may be and still be considered pinned. */
const PIN_SLACK_PX = 64;

/**
 * Output beyond this is trimmed from the front. A single `execute` can emit
 * megabytes, and the tail is the part that says what happened.
 */
const MAX_OUTPUT_CHARS = 8_000;

const DEFAULT_ARM_MS = 450;

const STATUS_LABELS: Record<string, string> = {
  pending: "queued",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

const ROLE_LABELS: Record<string, string> = {
  user: "operator",
  assistant: "agent",
  thought: "reasoning",
};

const NO_SCOPE_REASON =
  "This device cannot sign clearances. Decide from a paired device holding the approve scope, or at the daemon.";

export function createTimeline(options: TimelineOptions): TimelineView {
  const armMs = options.armMs ?? DEFAULT_ARM_MS;

  const log = el("div", {
    class: "log-scroll",
    attrs: { id: "log", role: "log", "aria-label": "Running log", tabindex: "0" },
  });

  const announcer = el("div", { class: "sr-only", attrs: { role: "status", "aria-live": "assertive" } });

  const element = el("div", { class: "log-body", children: [log, announcer] });

  const nodes = new Map<string, EntryNode>();
  let rendered: readonly Entry[] = [];
  let canApprove = true;
  let scopeReason = NO_SCOPE_REASON;

  function pinned(): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= PIN_SLACK_PX;
  }

  function scrollToEnd(): void {
    log.scrollTop = log.scrollHeight;
  }

  // -- entry construction ---------------------------------------------------

  function buildProse(entry: UserEntry | AssistantEntry): EntryNode {
    const thought = entry.kind === "assistant" && entry.thought;
    const role = entry.kind === "user" ? "user" : thought ? "thought" : "assistant";
    const text = document.createTextNode(entry.text);
    const prose = el("div", { class: "prose-text" });
    prose.append(text);
    const root = el("article", {
      class: "entry prose",
      attrs: { "data-role": role },
      children: [el("p", { class: "entry-label", text: ROLE_LABELS[role] ?? role }), prose],
    });
    toggleClass(root, "is-streaming", entry.kind === "assistant" && entry.streaming);
    return blank(entry, root, { text: text as Text });
  }

  function buildTool(entry: ToolEntry): EntryNode {
    const title = el("span", { class: "annot-title", text: entry.title });
    const status = el("span", { class: "pill", text: STATUS_LABELS[entry.status] ?? entry.status });
    const head = el("button", {
      class: "annot-head",
      attrs: { type: "button", "aria-expanded": "false" },
      children: [
        el("span", { class: "annot-glyph", attrs: { "data-kind": entry.toolKind }, children: [icon(entry.toolKind)] }),
        title,
        status,
        el("span", { class: "annot-chevron", children: [icon("chevron")] }),
      ],
    });

    const input = el("pre", { class: "block block-input", text: formatPayload(entry.input) });
    const output = el("pre", { class: "block block-output", text: trimOutput(entry.output) });
    const outputWrap = el("div", {
      class: "block-group",
      children: [el("p", { class: "block-label", text: "output" }), output],
    });
    outputWrap.hidden = entry.output === null;

    const locations =
      entry.locations.length > 0
        ? el("p", { class: "annot-locations", text: entry.locations.join("  ") })
        : null;

    const body = el("div", {
      class: "annot-body",
      children: [
        locations,
        el("div", { class: "block-group", children: [el("p", { class: "block-label", text: "input" }), input] }),
        outputWrap,
      ],
    });
    body.hidden = true;

    const root = el("article", {
      class: "entry annot",
      attrs: { "data-kind": entry.toolKind, "data-status": entry.status },
      children: [head, body],
    });

    const node = blank(entry, root, { status, title, body, output, outputWrap });
    head.addEventListener("click", () => {
      node.expanded = !node.expanded;
      body.hidden = !node.expanded;
      head.setAttribute("aria-expanded", node.expanded ? "true" : "false");
      toggleClass(root, "is-open", node.expanded);
    });
    // A failure is the one case where the detail is the point, so it opens
    // itself rather than waiting to be asked.
    if (entry.status === "failed") head.click();
    return node;
  }

  function buildApproval(entry: ApprovalEntry): EntryNode {
    const decision = el("p", { class: "clearance-decision" });
    decision.hidden = entry.decision === null;

    const actions = el("div", { class: "clearance-actions" });

    const root = el("article", {
      class: "entry clearance",
      attrs: { "data-decision": entry.decision ?? "open", tabindex: "-1" },
      children: [
        el("header", {
          class: "clearance-head",
          children: [
            el("span", { class: "clearance-glyph", children: [icon("clearance")] }),
            el("div", {
              class: "clearance-heading",
              children: [
                el("p", { class: "clearance-kicker", text: "clearance required" }),
                el("h3", { class: "clearance-title", text: entry.title }),
              ],
            }),
            el("code", { class: "clearance-tool", text: entry.tool }),
          ],
        }),
        el("pre", { class: "block block-input", text: formatPayload(entry.input) }),
        decision,
        actions,
      ],
    });

    const node = blank(entry, root, { decision, actions });
    paintClearance(node, entry);
    return node;
  }

  function buildUnknown(entry: UnknownEntry): EntryNode {
    const body = el("pre", { class: "block block-input", text: formatPayload(entry.payload) });
    body.hidden = true;
    const head = el("button", {
      class: "inert-head",
      attrs: { type: "button", "aria-expanded": "false" },
      children: [
        icon("unknown"),
        el("span", { class: "inert-label", text: entry.label }),
        el("span", { class: "inert-note", text: "not rendered by this build" }),
      ],
    });
    const root = el("article", { class: "entry inert", children: [head, body] });
    const node = blank(entry, root, { body });
    head.addEventListener("click", () => {
      node.expanded = !node.expanded;
      body.hidden = !node.expanded;
      head.setAttribute("aria-expanded", node.expanded ? "true" : "false");
    });
    return node;
  }

  function build(entry: Entry): EntryNode {
    if (entry.kind === "tool") return buildTool(entry);
    if (entry.kind === "approval") return buildApproval(entry);
    if (entry.kind === "unknown") return buildUnknown(entry);
    return buildProse(entry);
  }

  // -- clearance controls ---------------------------------------------------

  function paintClearance(node: EntryNode, entry: ApprovalEntry): void {
    const actions = node.actions;
    const decision = node.decision;
    if (actions === null || decision === null) return;
    node.root.setAttribute("data-decision", entry.decision ?? "open");

    if (entry.decision !== null) {
      actions.replaceChildren();
      decision.hidden = false;
      setText(decision, entry.decision === "allow" ? "Allowed by an operator." : "Denied by an operator.");
      return;
    }

    decision.hidden = true;

    if (!canApprove) {
      actions.replaceChildren(el("p", { class: "clearance-blocked", text: scopeReason }));
      return;
    }

    const deny = el("button", {
      class: "btn btn-deny",
      attrs: { type: "button" },
      children: [icon("deny"), el("span", { text: "Deny" })],
    });
    const allow = el("button", {
      class: "btn btn-allow",
      attrs: { type: "button" },
      children: [icon("allow"), el("span", { text: "Allow" })],
    });
    const always = el("label", {
      class: "clearance-scope",
      children: [el("input", { attrs: { type: "checkbox" } }), el("span", { text: "remember for this tool" })],
    });
    const remember = always.querySelector("input");

    // Armed late on purpose: a tap already travelling toward whatever used to be
    // at these coordinates must not land on Allow. `disabled`, not `aria-disabled`,
    // because only the real thing stops a keyboard activation too.
    deny.disabled = true;
    allow.disabled = true;
    window.setTimeout(() => {
      deny.disabled = false;
      allow.disabled = false;
    }, armMs);

    const decide = (choice: ApprovalChoice): void => {
      const scope: ApprovalScope = remember instanceof HTMLInputElement && remember.checked ? "always" : "once";
      deny.disabled = true;
      allow.disabled = true;
      options.onDecide(entry.requestId, choice, scope);
    };
    deny.addEventListener("click", () => {
      decide("deny");
    });
    allow.addEventListener("click", () => {
      decide("allow");
    });

    actions.replaceChildren(deny, always, allow);
  }

  // -- patching -------------------------------------------------------------

  function patch(node: EntryNode, entry: Entry): void {
    const before = node.entry;
    node.entry = entry;

    if ((entry.kind === "assistant" || entry.kind === "user") && node.text !== null) {
      const previous = before.kind === "assistant" || before.kind === "user" ? before.text : "";
      if (entry.text.startsWith(previous)) {
        const delta = entry.text.slice(previous.length);
        // One character-data mutation, no new nodes, no reflow of siblings.
        if (delta.length > 0) node.text.appendData(delta);
      } else {
        node.text.data = entry.text;
      }
      if (entry.kind === "assistant") toggleClass(node.root, "is-streaming", entry.streaming);
      return;
    }

    if (entry.kind === "tool") {
      if (node.title !== null) setText(node.title, entry.title);
      if (node.status !== null) setText(node.status, STATUS_LABELS[entry.status] ?? entry.status);
      node.root.setAttribute("data-status", entry.status);
      node.root.setAttribute("data-kind", entry.toolKind);
      if (node.output !== null && node.outputWrap !== null) {
        setText(node.output, trimOutput(entry.output));
        node.outputWrap.hidden = entry.output === null;
      }
      if (entry.status === "failed" && !node.expanded) {
        const head = node.root.querySelector<HTMLButtonElement>(".annot-head");
        head?.click();
      }
      return;
    }

    if (entry.kind === "approval") paintClearance(node, entry);
  }

  // -- the pass -------------------------------------------------------------

  function render(state: SessionState): void {
    const wasPinned = pinned();
    const next = state.entries;

    for (let index = 0; index < next.length; index += 1) {
      const entry = next[index];
      if (entry === undefined) continue;
      // Reference equality is the whole optimisation: unchanged entries are the
      // same object the reducer was handed, so they cost one comparison.
      if (rendered[index] === entry) continue;

      const existing = nodes.get(entry.id);
      if (existing !== undefined) {
        patch(existing, entry);
        continue;
      }

      const node = build(entry);
      nodes.set(entry.id, node);
      log.append(node.root);
      if (entry.kind === "approval" && entry.decision === null) {
        setText(announcer, `Clearance required: ${entry.title}`);
      }
    }

    // Entries only ever append or amend, but a transcript replaced wholesale on
    // reattach must not leave the previous session's nodes behind.
    if (next.length < rendered.length) {
      for (let index = next.length; index < rendered.length; index += 1) {
        const stale = rendered[index];
        if (stale === undefined) continue;
        nodes.get(stale.id)?.root.remove();
        nodes.delete(stale.id);
      }
    }

    rendered = next;
    if (wasPinned) scrollToEnd();
  }

  function setCanApprove(next: boolean, reason?: string): void {
    if (canApprove === next && reason === undefined) return;
    canApprove = next;
    if (reason !== undefined) scopeReason = reason;
    for (const node of nodes.values()) {
      if (node.entry.kind !== "approval") continue;
      paintClearance(node, node.entry);
    }
  }

  function focusClearance(): boolean {
    for (const node of nodes.values()) {
      if (node.entry.kind !== "approval" || node.entry.decision !== null) continue;
      node.root.focus();
      node.root.scrollIntoView({ block: "center" });
      return true;
    }
    return false;
  }

  function setTurnActive(active: boolean): void {
    toggleClass(element, "is-live", active);
  }

  return { element, render, setCanApprove, setTurnActive, scrollToEnd, focusClearance };
}

function blank(entry: Entry, root: HTMLElement, parts: Partial<Omit<EntryNode, "entry" | "root">>): EntryNode {
  return {
    entry,
    root,
    text: parts.text ?? null,
    status: parts.status ?? null,
    title: parts.title ?? null,
    body: parts.body ?? null,
    output: parts.output ?? null,
    outputWrap: parts.outputWrap ?? null,
    decision: parts.decision ?? null,
    actions: parts.actions ?? null,
    expanded: false,
  };
}

function trimOutput(output: string | null): string {
  if (output === null) return "";
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const dropped = output.length - MAX_OUTPUT_CHARS;
  return `[${dropped} earlier characters trimmed]\n${output.slice(-MAX_OUTPUT_CHARS)}`;
}
