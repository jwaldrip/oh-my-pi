/**
 * Connection indicator. Three states an operator must be able to tell apart at
 * a glance, because they demand different reactions: connected (trust the
 * screen), reconnecting (the screen is stale, it is coming back), offline (the
 * screen is stale and nothing is coming back until something changes).
 */

import type { StatusEvent } from "@ompd/core/ompd-client";
import { el, setText } from "./dom.ts";
import { icon } from "./icons.ts";

export interface StatusView {
  readonly element: HTMLElement;
  render(event: StatusEvent): void;
}

const LABEL: Record<StatusEvent["state"], string> = {
  connecting: "connecting",
  connected: "live",
  reconnecting: "reconnecting",
  offline: "offline",
};

export function createStatus(): StatusView {
  const lamp = el("span", { class: "lamp", attrs: { "aria-hidden": "true" } });
  const label = el("span", { class: "status-label" });
  const element = el("div", {
    class: "status status-offline",
    attrs: { role: "status", "aria-live": "polite" },
    children: [icon("link", "status-glyph"), lamp, label],
  });

  // `window.setInterval` is the DOM overload, which hands back a numeric
  // handle rather than a host timer object.
  let countdown: number | undefined;
  let remainingSeconds = 0;

  function stopCountdown(): void {
    window.clearInterval(countdown);
    countdown = undefined;
  }

  function paintCountdown(state: StatusEvent["state"]): void {
    if (remainingSeconds <= 0) {
      setText(label, LABEL[state]);
      stopCountdown();
      return;
    }
    setText(label, `${LABEL[state]}, retry in ${remainingSeconds}s`);
  }

  function render(event: StatusEvent): void {
    element.className = `status status-${event.state}`;
    element.setAttribute(
      "title",
      event.reason ? `${LABEL[event.state]}: ${event.reason}` : LABEL[event.state],
    );

    stopCountdown();
    const waiting = event.state === "reconnecting" || event.state === "offline";
    if (!waiting || event.delayMs === undefined || event.delayMs < 1000) {
      setText(label, LABEL[event.state]);
      return;
    }

    // A visible countdown is the difference between "it is working on it" and
    // "it has given up". Both look identical without one.
    remainingSeconds = Math.round(event.delayMs / 1000);
    paintCountdown(event.state);
    countdown = window.setInterval(() => {
      remainingSeconds -= 1;
      paintCountdown(event.state);
    }, 1000);
  }

  return { element, render };
}
