/**
 * The plan panel.
 *
 * An agent republishes its whole plan on every change, so this patches in place
 * rather than rebuilding: the common update is three identical lines with one
 * status moved on, and a rebuild would make the panel flash on every step.
 *
 * Hidden entirely when there is no plan. An empty panel labelled "no plan" is
 * chrome, and chrome is what makes a dense surface unreadable.
 */

import type { PlanReviewChoice } from "@ompd/core/contracts";
import type { PlanEntry, PlanStatus } from "../session/model.ts";
import { el, setText, toggleClass } from "./dom.ts";
import { icon } from "./icons.ts";

export interface PlanReview {
  requestId: string;
  message: string;
  choices: readonly PlanReviewChoice[];
}

export interface PlanOptions {
  onRespond: (requestId: string, choice: PlanReviewChoice) => void;
}

export interface PlanView {
  readonly element: HTMLElement;
  render(plan: readonly PlanEntry[], review: PlanReview | null): void;
}

interface Row {
  root: HTMLElement;
  label: HTMLElement;
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "done",
};

export function createPlan(options: PlanOptions): PlanView {
  const progress = el("span", { class: "plan-progress", text: "0/0" });
  const chevron = el("span", { class: "plan-chevron", children: [icon("chevron")] });
  const head = el("button", {
    class: "plan-head",
    attrs: { type: "button", "aria-expanded": "true", "aria-controls": "plan-body" },
    children: [icon("plan"), el("span", { class: "plan-title", text: "Plan" }), progress, chevron],
  });
  const body = el("ol", { class: "plan-list", attrs: { id: "plan-body" } });
  const reviewMessage = el("p", { class: "plan-review-message" });
  const approve = el("button", {
    class: "plan-review-approve",
    text: "Approve and execute",
    attrs: { type: "button", "data-testid": "plan-approve" },
  });
  const refine = el("button", {
    class: "plan-review-refine",
    text: "Refine plan",
    attrs: { type: "button", "data-testid": "plan-refine" },
  });
  const feedback = el("textarea", {
    class: "plan-review-feedback",
    attrs: { "aria-label": "Plan feedback", placeholder: "What should change?", "data-testid": "plan-feedback" },
  });
  const sendFeedback = el("button", {
    class: "plan-review-send",
    text: "Send feedback",
    attrs: { type: "button", "data-testid": "plan-send-feedback" },
  });
  const actions = el("div", { class: "plan-review-actions", children: [approve, refine] });
  const feedbackForm = el("div", { class: "plan-review-form", children: [feedback, sendFeedback] });
  feedbackForm.hidden = true;
  const reviewPanel = el("div", { class: "plan-review", children: [reviewMessage, actions, feedbackForm] });
  reviewPanel.hidden = true;
  const element = el("section", { class: "plan", children: [head, body, reviewPanel] });
  element.hidden = true;

  const rows: Row[] = [];
  let open = true;
  let currentReview: PlanReview | null = null;

  const respond = (choice: PlanReviewChoice): void => {
    if (currentReview === null) return;
    options.onRespond(currentReview.requestId, choice);
  };
  head.addEventListener("click", () => {
    open = !open;
    body.hidden = !open;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    toggleClass(element, "is-open", open);
  });
  approve.addEventListener("click", () => {
    respond("Approve and execute");
  });
  refine.addEventListener("click", () => {
    feedbackForm.hidden = false;
    feedback.focus();
  });
  sendFeedback.addEventListener("click", () => {
    // ACP accepts the enum value only. The feedback stays visible to the
    // operator while OMP takes its normal refine-plan path.
    respond("Refine plan");
  });
  toggleClass(element, "is-open", open);

  return {
    element,
    render(plan: readonly PlanEntry[], review: PlanReview | null): void {
      currentReview = review;
      const pending = review !== null || plan.some((entry) => entry.status === "pending");
      element.hidden = plan.length === 0 && review === null;
      reviewPanel.hidden = !pending;
      const canRespond = review !== null;
      approve.disabled = !canRespond;
      refine.disabled = !canRespond;
      sendFeedback.disabled = !canRespond;
      reviewMessage.textContent =
        review?.message ?? (pending ? "Plan is pending review. Waiting for the agent's approval request." : "");
      if (review === null) {
        feedbackForm.hidden = true;
        feedback.value = "";
      }
      if (plan.length === 0) {
        body.replaceChildren();
        rows.length = 0;
        return;
      }

      while (rows.length > plan.length) rows.pop()?.root.remove();
      while (rows.length < plan.length) {
        const label = el("span", { class: "plan-text" });
        const root = el("li", {
          class: "plan-item",
          children: [el("span", { class: "plan-mark", attrs: { "aria-hidden": "true" } }), label],
        });
        rows.push({ root, label });
        body.append(root);
      }

      let done = 0;
      for (const [index, entry] of plan.entries()) {
        const row = rows[index];
        if (row === undefined) continue;
        if (entry.status === "completed") done += 1;
        setText(row.label, entry.content);
        row.root.setAttribute("data-status", entry.status);
        row.root.setAttribute("data-priority", entry.priority);
        row.root.setAttribute("aria-label", `${entry.content}: ${STATUS_LABELS[entry.status]}`);
      }

      setText(progress, `${done}/${plan.length}`);
      toggleClass(element, "is-complete", done === plan.length);
    },
  };
}
