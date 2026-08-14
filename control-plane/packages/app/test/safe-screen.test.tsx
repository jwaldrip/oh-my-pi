/**
 * SafeScreen must keep design padding and add system insets, never trade one
 * for the other. A phone with a notch that lost its design padding is how a
 * form ends up jammed against the status bar on one edge and the home
 * indicator on the other.
 */

import "./rnw.ts";

import { describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// Known insets, set before SafeScreen is imported so the module sees them.
const INSETS = { top: 47, right: 0, bottom: 34, left: 0 };
mock.module("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => children ?? null,
  useSafeAreaInsets: () => INSETS,
}));

const { Text } = await import("react-native");
const { SafeScreen } = await import("../src/design/SafeScreen.tsx");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");
const { EMPTY_SESSION } = await import("../src/session/model.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function cssPadding(el: Element | null): { top: string; bottom: string; left: string; right: string } {
  if (!(el instanceof HTMLElement)) throw new Error("expected an HTMLElement");
  // RNW writes padding as inline style on the native host node.
  const style = el.style;
  return {
    top: style.paddingTop || style.getPropertyValue("padding-top"),
    bottom: style.paddingBottom || style.getPropertyValue("padding-bottom"),
    left: style.paddingLeft || style.getPropertyValue("padding-left"),
    right: style.paddingRight || style.getPropertyValue("padding-right"),
  };
}

describe("SafeScreen", () => {
  test("outer shell takes the system insets; inner content keeps design padding", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <SafeScreen testID="shell" style={{ padding: 16 }}>
          <Text testID="inner">content</Text>
        </SafeScreen>,
      );
    });

    const shell = host.querySelector('[data-testid="shell"]');
    expect(shell).not.toBeNull();
    const shellPad = cssPadding(shell);
    // System insets alone on the outer shell.
    expect(shellPad.top).toBe("47px");
    expect(shellPad.bottom).toBe("34px");
    expect(shellPad.left).toBe("0px");
    expect(shellPad.right).toBe("0px");

    // Design padding lives on the inner content node, the shell's first child.
    const content = shell?.firstElementChild ?? null;
    expect(content).not.toBeNull();
    const contentPad = cssPadding(content);
    expect(contentPad.top).toBe("16px");
    expect(contentPad.bottom).toBe("16px");
    expect(contentPad.left).toBe("16px");
    expect(contentPad.right).toBe("16px");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("session back control is labeled Sessions and returns to the bay", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let backed = 0;

    act(() => {
      root.render(
        <SessionScreen
          agent={{
            id: "agt_test",
            name: "probe",
            state: "idle",
            host: { kind: "local", id: "1", spec: { kind: "local" } },
            cwd: "/tmp",
            createdAt: new Date(0).toISOString(),
            lastActiveAt: new Date(0).toISOString(),
            labels: {},
          }}
          session={EMPTY_SESSION}
          connection="connected"
          attempt={0}
          spoken={null}
          fleetClearances={0}
          canApprove
          onBack={() => {
            backed += 1;
          }}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
        />,
      );
    });

    const label = host.querySelector('[data-testid="session-back-label"]');
    expect(label?.textContent).toBe("Sessions");
    const back = host.querySelector('[data-testid="session-back"]') as HTMLElement | null;
    expect(back).not.toBeNull();
    // Assistive tech must hear the destination, not just "back".
    const accessible =
      back?.getAttribute("aria-label") ??
      back?.getAttribute("accessibilityLabel") ??
      "";
    expect(accessible.toLowerCase()).toContain("sessions");
    act(() => {
      back?.click();
    });
    expect(backed).toBe(1);

    // Bottom safe inset is on the composer chrome, not lost to KeyboardAvoidingView.
    const composerSafe = host.querySelector('[data-testid="session-composer-safe"]');
    expect(composerSafe).not.toBeNull();
    const composerPad = cssPadding(composerSafe);
    expect(composerPad.bottom).toBe("34px");

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
