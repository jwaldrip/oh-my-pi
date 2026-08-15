/**
 * `ScanScreen`'s decode-then-confirm gate: a decoded pairing bundle earns a
 * confirmation card, never an immediate callback, and anything the camera
 * decodes that isn't a bundle -- a stranger's QR code, a bundle with the
 * wrong `v` -- stays quiet and keeps scanning rather than crashing or
 * silently accepting foreign input.
 */

import "./rnw.ts";
import { resetCameraMock, scanCode, setCameraAvailability } from "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { encodePairingBundle } from "@ompd/core/pairing";
import type { PairingBundle } from "@ompd/core/pairing";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose, the same way `pair-screen.test.tsx` loads its screen:
// bun evaluates a file's whole static import graph before its body runs, so a
// static import of the screen would pull the real `react-native` and
// `react-native-vision-camera` in before `./rnw.ts` could substitute them.
const { ScanScreen } = await import("../src/screens/ScanScreen.tsx");

declare global {
  // `var` is what a global declaration takes; `let`/`const` do not reach globalThis.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(resetCameraMock);

const VALID_BUNDLE: PairingBundle = {
  v: 1,
  label: "Jason's Mac",
  connection: { transport: "direct", url: "ws://10.4.1.221:7777/v1/socket", token: "tok_abc", scopes: ["read", "prompt"] },
};

interface Harness {
  host: HTMLElement;
  scanned: Array<{ connection: Connection; label: string }>;
  cancelled: number;
  unmount: () => void;
}

function mountScanScreen(): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const scanned: Array<{ connection: Connection; label: string }> = [];
  let cancelled = 0;

  act(() => {
    root.render(
      <ScanScreen
        onCancel={() => {
          cancelled += 1;
        }}
        onScanned={(connection, label) => {
          scanned.push({ connection, label });
        }}
      />,
    );
  });

  return {
    host,
    scanned,
    get cancelled() {
      return cancelled;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  } as Harness;
}

function el(host: HTMLElement, testID: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testID}"]`);
}

describe("ScanScreen: a decode is not a pairing", () => {
  test("a valid bundle shows a confirmation card and only calls back once it's accepted", () => {
    const h = mountScanScreen();
    expect(el(h.host, "scan-camera")).not.toBeNull();
    expect(el(h.host, "scan-confirm")).toBeNull();

    act(() => {
      scanCode(encodePairingBundle(VALID_BUNDLE));
    });

    // Confirmed nothing yet: the decode alone never reaches `onScanned`.
    expect(h.scanned).toEqual([]);
    const confirm = el(h.host, "scan-confirm");
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain("Jason's Mac");

    act(() => {
      el(h.host, "scan-confirm-accept")?.click();
    });

    expect(h.scanned).toEqual([{ connection: VALID_BUNDLE.connection, label: "Jason's Mac" }]);
    h.unmount();
  });

  test("declining the confirmation resumes scanning without ever calling back", () => {
    const h = mountScanScreen();
    act(() => {
      scanCode(encodePairingBundle(VALID_BUNDLE));
    });
    expect(el(h.host, "scan-confirm")).not.toBeNull();

    act(() => {
      el(h.host, "scan-confirm-cancel")?.click();
    });

    expect(h.scanned).toEqual([]);
    expect(el(h.host, "scan-confirm")).toBeNull();

    // Scanning resumed: a second decode still reaches the confirmation card.
    act(() => {
      scanCode(encodePairingBundle(VALID_BUNDLE));
    });
    expect(el(h.host, "scan-confirm")).not.toBeNull();
    h.unmount();
  });

  test("a string that isn't a pairing bundle at all is refused quietly and keeps scanning", () => {
    const h = mountScanScreen();
    act(() => {
      scanCode("https://example.com/definitely-not-a-bundle");
    });

    expect(h.scanned).toEqual([]);
    expect(el(h.host, "scan-confirm")).toBeNull();
    expect(el(h.host, "scan-invalid")).not.toBeNull();
    // The camera is still mounted and scanning, not replaced by an error screen.
    expect(el(h.host, "scan-camera")).not.toBeNull();
    h.unmount();
  });

  test("a bundle with the wrong `v` is refused the same way a foreign code is", () => {
    const h = mountScanScreen();
    const wrongVersion = { ...VALID_BUNDLE, v: 2 } as unknown as PairingBundle;

    act(() => {
      scanCode(encodePairingBundle(wrongVersion));
    });

    expect(h.scanned).toEqual([]);
    expect(el(h.host, "scan-confirm")).toBeNull();
    expect(el(h.host, "scan-invalid")).not.toBeNull();
    h.unmount();
  });

  test("cancelling the screen reports back without ever having scanned anything", () => {
    const h = mountScanScreen();
    act(() => {
      el(h.host, "scan-cancel")?.click();
    });
    expect(h.cancelled).toBe(1);
    expect(h.scanned).toEqual([]);
    h.unmount();
  });

  test("no camera permission shows a request control instead of the camera", () => {
    setCameraAvailability({ permission: false });
    const h = mountScanScreen();
    expect(el(h.host, "scan-permission")).not.toBeNull();
    expect(el(h.host, "scan-camera")).toBeNull();
    h.unmount();
  });
});
