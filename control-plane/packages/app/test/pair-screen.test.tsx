/**
 * `PairScreen`'s Connect control: gated on a parseable endpoint and a token,
 * not on either alone.
 *
 * Rendered for real through happy-dom, the way `session-webview.test.tsx`
 * does: the property under test is what happens as text is typed into a
 * controlled input, and a static markup snapshot cannot show that. Two
 * things are checked for "disabled" rather than one, because this file does
 * not own `Pressable`'s DOM mapping and should not assume which of
 * `aria-disabled` or the native property it renders as; a control that reads
 * as enabled by both but still refuses to invoke `onPair` on click would be a
 * defect this test exists to catch.
 */

import { resetWindowSize, setWindowWidth } from "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose, the same way `smoke.test.tsx` and `session-webview.test.tsx`
// load their screens: bun evaluates a file's whole static import graph before
// its body runs, so static imports of either the screen or `StyleSheet` would
// pull the real `react-native` in before `./rnw.ts` could substitute it, and
// the real DOM globals before happy-dom is registered.
const { PairScreen } = await import("../src/screens/PairScreen.tsx");
const { StyleSheet } = await import("react-native");

/** RNW exposes this stylesheet API at runtime but not in its TypeScript surface. */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

// React 19 reads this to decide whether act() is legal outside a test
// renderer. It is React's own contract with a test host and no shipped type
// declares it, so the declaration belongs here rather than at a call site.
declare global {
  // `var` is what a global declaration takes; `let`/`const` do not reach globalThis.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(resetWindowSize);


/**
 * Type into a rendered `TextInput` by invoking the change handler React
 * actually attached to it.
 *
 * Not the obvious way, and the obvious way is a trap. Setting `.value` through
 * the native prototype setter and dispatching an `input` event, which is what
 * every DOM testing helper does, never reaches React under happy-dom here:
 * measured, the component's state stayed empty while the DOM node held the
 * text. Every assertion written that way passes because nothing changed, which
 * makes a gating test that can only ever see "disabled" and therefore cannot
 * fail. A click does arrive, so this is specific to the change path.
 *
 * Going through the rendered `onChange` prop keeps the real wiring under test:
 * react-native-web's own `TextInput` handler runs, maps the event to
 * `onChangeText`, and the screen's state, its transport label, and the Connect
 * control all follow. The lookup throws rather than returning undefined so a
 * React internals rename fails this file loudly instead of quietly restoring
 * the vacuous version.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input: the change path cannot be driven");
  const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
  if (typeof props.onChange !== "function") throw new Error("the rendered input has no onChange handler");
  input.value = value;
  props.onChange({
    target: input,
    currentTarget: input,
    nativeEvent: { text: value },
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

/**
 * `aria-disabled` and a native `disabled` property are both legitimate ways an
 * interactive control can say it is off; this file has no stake in which one
 * `Pressable` chooses, only in whether the operator reads the control as
 * inert.
 */
function readsDisabled(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true") return true;
  return Reflect.get(el, "disabled") === true;
}

interface Harness {
  endpointInput: HTMLInputElement;
  tokenInput: HTMLInputElement;
  submit: HTMLElement;
  form: HTMLElement;
  paired: Connection[];
  unmount: () => void;
}

function mountPairScreen(): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const paired: Connection[] = [];

  act(() => {
    root.render(<PairScreen onPair={(connection) => paired.push(connection)} />);
  });

  const endpointInput = host.querySelector('[data-testid="pair-endpoint"]');
  const tokenInput = host.querySelector('[data-testid="pair-token"]');
  const submit = host.querySelector('[data-testid="pair-submit"]');
  const form = host.querySelector('[data-testid="pair-form"]');
  if (!(endpointInput instanceof HTMLInputElement)) throw new Error("no endpoint field rendered");
  if (!(tokenInput instanceof HTMLInputElement)) throw new Error("no token field rendered");
  if (!(submit instanceof HTMLElement)) throw new Error("no submit control rendered");
  if (!(form instanceof HTMLElement)) throw new Error("no pair form rendered");

  return {
    endpointInput,
    tokenInput,
    submit,
    form,
    paired,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("PairScreen: Connect is gated on a parseable endpoint and a token", () => {
  test("form width honors the 390px phone viewport", () => {
    setWindowWidth(390);
    const h = mountPairScreen();
    const maxWidths = [...rnwStyleSheet.getSheet().textContent.matchAll(/max-width:\s*(\d+(?:\.\d+)?)px/gi)].map((m) =>
      Number(m[1]),
    );

    expect(maxWidths.every((maxWidth) => maxWidth <= 390)).toBe(true);
    expect(h.form.style.maxWidth).toBe("");

    h.unmount();
  });
  test("keeps the 480px cap for layouts wider than the pairing form", () => {
    setWindowWidth(768);
    const h = mountPairScreen();
    expect(h.form.style.maxWidth).toBe("480px");

    h.unmount();
  });


  test("no input at all leaves Connect disabled and inert", () => {
    const h = mountPairScreen();
    expect(readsDisabled(h.submit)).toBe(true);
    act(() => {
      h.submit.click();
    });
    expect(h.paired).toEqual([]);
    h.unmount();
  });

  test("text that ompd approve would never print leaves Connect disabled even with a token typed", () => {
    const h = mountPairScreen();
    act(() => {
      typeInto(h.endpointInput, "not an endpoint");
      typeInto(h.tokenInput, "some-token");
    });
    expect(readsDisabled(h.submit)).toBe(true);
    act(() => {
      h.submit.click();
    });
    expect(h.paired).toEqual([]);
    h.unmount();
  });

  test("a parseable endpoint with no token yet still leaves Connect disabled", () => {
    const h = mountPairScreen();
    act(() => {
      typeInto(h.endpointInput, "ws://10.4.1.221:7777/v1/socket");
    });
    expect(readsDisabled(h.submit)).toBe(true);
    h.unmount();
  });

  test("a pasted ompd://hub endpoint plus a token enables Connect and yields a hub connection", () => {
    const h = mountPairScreen();
    act(() => {
      typeInto(h.endpointInput, "ompd://hub?url=wss%3A%2F%2Fhub.example.com&daemon=dmn_1");
      typeInto(h.tokenInput, "tok_abc");
    });
    expect(readsDisabled(h.submit)).toBe(false);
    act(() => {
      h.submit.click();
    });
    expect(h.paired).toEqual([
      { transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "dmn_1", token: "tok_abc", scopes: [] },
    ]);
    h.unmount();
  });

  test("a direct socket url plus a token also enables Connect, and yields a direct connection", () => {
    const h = mountPairScreen();
    act(() => {
      typeInto(h.endpointInput, "ws://10.4.1.221:7777/v1/socket");
      typeInto(h.tokenInput, "tok_xyz");
    });
    expect(readsDisabled(h.submit)).toBe(false);
    act(() => {
      h.submit.click();
    });
    expect(h.paired).toEqual([
      { transport: "direct", url: "ws://10.4.1.221:7777/v1/socket", token: "tok_xyz", scopes: [] },
    ]);
    h.unmount();
  });
});
