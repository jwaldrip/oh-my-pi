/**
 * `platform/connection.ts`'s `coerce`: the door both a stored blob and a
 * pasted pairing carry through.
 *
 * The property worth defending is not "valid input parses" -- that is the
 * easy direction -- it is that a device paired before endpoints existed keeps
 * working, and that nothing claiming a transport this app cannot reach (an
 * `https://` page, a hub missing the daemon it is pinned to) is silently
 * accepted as one it can.
 */

// `connection.ts` now pulls in `./secrets`, which on this (native) build
// imports `react-native-keychain`, which imports the real `react-native`.
// `./rnw.ts` substitutes `react-native-web` for it, same as every other test
// here that touches a module with that dependency; see its own header for
// why. The import of `connection.ts` itself has to stay dynamic and come
// after it: bun parses a static import's whole dependency graph up front,
// before any top-level code (including `./rnw.ts`'s `mock.module` calls)
// gets to run, so a static import here would still choke on the real
// `react-native` package's Flow-typed entry point. `coerce` itself needs
// none of this -- it is still pure logic -- but reaching it means loading
// the rest of the module too. Same reasoning as `fleet-screen.test.tsx`'s
// dynamic import of `FleetScreen.tsx`.
import "./rnw.ts";

import { describe, expect, test } from "bun:test";
const { coerce } = await import("../src/platform/connection.ts");

describe("coerce: a device paired before endpoints existed", () => {
  test("migrates the untagged {url, token, scopes} shape to a direct connection", () => {
    const legacy = { url: "ws://127.0.0.1:7777/v1/socket", token: "tok_abc", scopes: ["read", "write"] };
    expect(coerce(legacy)).toEqual({
      transport: "direct",
      url: "ws://127.0.0.1:7777/v1/socket",
      token: "tok_abc",
      scopes: ["read", "write"],
    });
  });

  test("an untagged blob still migrates with no scopes recorded", () => {
    const legacy = { url: "wss://10.4.1.221:7777/v1/socket", token: "tok_xyz" };
    expect(coerce(legacy)).toEqual({
      transport: "direct",
      url: "wss://10.4.1.221:7777/v1/socket",
      token: "tok_xyz",
      scopes: [],
    });
  });
});

describe("coerce: refusing what this app cannot reach", () => {
  test("an https:// url is not a socket, tagged or not", () => {
    expect(coerce({ transport: "direct", url: "https://example.com", token: "tok", scopes: [] })).toBeNull();
    expect(coerce({ url: "https://example.com", token: "tok", scopes: [] })).toBeNull();
  });

  test("a hub entry missing its daemonId is refused rather than connecting to just anyone the hub links", () => {
    expect(coerce({ transport: "hub", hubUrl: "wss://hub.example.com", token: "tok", scopes: [] })).toBeNull();
  });

  test("a hub entry with an empty daemonId is refused the same way", () => {
    expect(
      coerce({ transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "", token: "tok", scopes: [] }),
    ).toBeNull();
  });

  test("a well-formed hub entry parses to a hub connection", () => {
    const stored = { transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "dmn_1", token: "tok", scopes: [] };
    expect(coerce(stored)).toEqual({
      transport: "hub",
      hubUrl: "wss://hub.example.com",
      daemonId: "dmn_1",
      token: "tok",
      scopes: [],
    });
  });

  test("a transport this app does not have is a refusal, not a guess", () => {
    expect(coerce({ transport: "carrier-pigeon", url: "ws://127.0.0.1:7777/v1/socket", token: "tok" })).toBeNull();
  });

  test("no token at all is a refusal: there is nothing to authenticate with", () => {
    expect(coerce({ url: "ws://127.0.0.1:7777/v1/socket", scopes: [] })).toBeNull();
  });

  test("anything that is not an object is a refusal", () => {
    expect(coerce(null)).toBeNull();
    expect(coerce("ws://127.0.0.1:7777/v1/socket")).toBeNull();
    expect(coerce(undefined)).toBeNull();
  });
});
