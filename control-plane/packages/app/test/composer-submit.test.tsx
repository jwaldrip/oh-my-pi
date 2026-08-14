/**
 * Sending from the composer must leave a user entry on screen immediately.
 *
 * The daemon does not echo prompts. If the optimistic entry is missing, a
 * successful tap still looks like a dropped message — which is exactly what
 * the device UI test was failing on.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { Composer } = await import("../src/components/Composer.tsx");
const { Transcript } = await import("../src/components/Transcript.tsx");
const { EMPTY_SESSION, appendPrompt } = await import("../src/session/model.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function typeInto(input: HTMLElement, value: string): void {
  const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input");
  const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
  if (typeof props.onChange !== "function") throw new Error("the rendered input has no onChange handler");
  (input as HTMLInputElement).value = value;
  props.onChange({
    target: input,
    currentTarget: input,
    nativeEvent: { text: value },
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

describe("composer submit", () => {
  test("appendPrompt puts a user entry the transcript can render with an a11y label", () => {
    const session = appendPrompt(EMPTY_SESSION, "  pineapple-nonce-xyz  ");
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0]).toMatchObject({
      kind: "user",
      text: "pineapple-nonce-xyz",
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <Transcript entries={session.entries} canApprove onDecide={() => {}} spoken={null} />,
      );
    });

    const row = host.querySelector('[data-testid="entry-user-prompt-0"]');
    expect(row).not.toBeNull();
    const label =
      row?.getAttribute("aria-label") ??
      row?.getAttribute("accessibilityLabel") ??
      row?.textContent ??
      "";
    expect(label).toContain("pineapple-nonce-xyz");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("pressing Send calls onSubmit with the trimmed text and clears the field", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const submitted: string[] = [];

    act(() => {
      root.render(
        <Composer
          enabled
          busy={false}
          onSubmit={(text) => {
            submitted.push(text);
          }}
          onCancel={() => {}}
        />,
      );
    });

    const input = host.querySelector('[data-testid="composer-input"]') as HTMLElement | null;
    expect(input).not.toBeNull();
    act(() => {
      typeInto(input!, "  pineapple-send-me  ");
    });

    const send = host.querySelector('[data-testid="composer-send"]') as HTMLElement | null;
    expect(send).not.toBeNull();
    act(() => {
      send?.click();
    });

    expect(submitted).toEqual(["pineapple-send-me"]);
    expect((input as HTMLInputElement).value ?? "").toBe("");

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
