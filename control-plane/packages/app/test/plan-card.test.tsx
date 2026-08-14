import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { PlanCard } = await import("../src/components/PlanCard.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function typeInto(input: HTMLElement, value: string): void {
  const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input");
  const props = Reflect.get(input, key) as {
    onChange?: (event: unknown) => void;
    onChangeText?: (text: string) => void;
  };
  (input as HTMLInputElement).value = value;
  if (typeof props.onChangeText === "function") {
    props.onChangeText(value);
  }
  if (typeof props.onChange === "function") {
    props.onChange({
      target: input,
      currentTarget: input,
      nativeEvent: { text: value },
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  }
}

function renderCard(onRespond: (requestId: string, choice: "Approve and execute" | "Refine plan", feedback?: string) => void) {
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
    const responses: Array<[string, string, string | undefined]> = [];
    const { host, root } = renderCard((requestId, choice, feedback) => responses.push([requestId, choice, feedback]));

    expect(host.textContent).toContain("Approve and execute");
    expect(host.textContent).toContain("Refine plan");
    act(() => {
      (host.querySelector('[data-testid="plan-approve"]') as HTMLElement).click();
    });
    expect(responses).toEqual([["pln_review", "Approve and execute", undefined]]);

    act(() => root.unmount());
    host.remove();
  });

  test("refining opens feedback entry before returning OMP's exact refine choice", () => {
    const responses: Array<[string, string, string | undefined]> = [];
    const { host, root } = renderCard((requestId, choice, feedback) => responses.push([requestId, choice, feedback]));

    act(() => {
      (host.querySelector('[data-testid="plan-refine"]') as HTMLElement).click();
    });
    const input = host.querySelector('[data-testid="plan-feedback"]') as HTMLElement | null;
    expect(input).not.toBeNull();
    act(() => {
      typeInto(input!, "Prefer the live route.");
    });
    act(() => {
      (host.querySelector('[data-testid="plan-send-feedback"]') as HTMLElement).click();
    });
    expect(responses).toEqual([["pln_review", "Refine plan", "Prefer the live route."]]);

    act(() => root.unmount());
    host.remove();
  });
});
