import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { PlanCard } = await import("../src/components/PlanCard.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function renderCard(onRespond: (requestId: string, choice: "Approve and execute" | "Refine plan") => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <PlanCard
        canApprove
        onRespond={onRespond}
        plan={[{ content: "Inspect the live path", priority: "high", status: "pending" }]}
        review={{
          requestId: "pln_review",
          message: "Approve plan \"Inspect the live path\"?",
          choices: ["Approve and execute", "Refine plan"],
        }}
      />,
    );
  });
  return { host, root };
}

describe("PlanCard", () => {
  test("approving returns OMP's exact execution choice", () => {
    const responses: Array<[string, string]> = [];
    const { host, root } = renderCard((requestId, choice) => responses.push([requestId, choice]));

    expect(host.textContent).toContain("Approve and execute");
    expect(host.textContent).toContain("Refine plan");
    act(() => {
      (host.querySelector('[data-testid="plan-approve"]') as HTMLElement).click();
    });
    expect(responses).toEqual([["pln_review", "Approve and execute"]]);

    act(() => root.unmount());
    host.remove();
  });

  test("refining returns OMP's exact refine choice", () => {
    const responses: Array<[string, string]> = [];
    const { host, root } = renderCard((requestId, choice) => responses.push([requestId, choice]));

    act(() => {
      (host.querySelector('[data-testid="plan-refine"]') as HTMLElement).click();
    });
    expect(responses).toEqual([["pln_review", "Refine plan"]]);

    act(() => root.unmount());
    host.remove();
  });
});
