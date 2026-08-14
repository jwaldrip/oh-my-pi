/**
 * These tests defend the door untrusted input comes through, not the encoding.
 *
 * An endpoint arrives by paste, by deep link, or by QR, and every one of those
 * is a place an attacker can put a string. So each test below fails on a
 * plausible bug: a scheme check that admits a web page, a hub entry with no
 * daemon to pin, a token smuggled in beside the address, a base URL whose
 * trailing slash produces a path no proxy routes.
 */

import { describe, expect, test } from "bun:test";
import {
  describeEndpoint,
  encodeEndpoint,
  isHubUrl,
  isSocketUrl,
  normalizeHubUrl,
  parseEndpoint,
  type Endpoint,
} from "../src/index.ts";

describe("parseEndpoint: what may become a connection", () => {
  test("a bare websocket URL is a direct endpoint", () => {
    expect(parseEndpoint("ws://10.4.1.221:7777/v1/socket")).toEqual({
      transport: "direct",
      url: "ws://10.4.1.221:7777/v1/socket",
    });
    expect(parseEndpoint("  wss://box.example.com/v1/socket  ")).toEqual({
      transport: "direct",
      url: "wss://box.example.com/v1/socket",
    });
  });

  test("an http(s) page is refused rather than coerced into an endpoint", () => {
    // The bug this catches: accepting any URL and letting the client post a
    // bearer token to a website the operator merely had in their clipboard.
    expect(parseEndpoint("https://example.com/v1/socket")).toBeNull();
    expect(parseEndpoint("http://127.0.0.1:7777")).toBeNull();
  });

  test("schemes that are not a socket at all are refused", () => {
    expect(parseEndpoint("file:///etc/passwd")).toBeNull();
    expect(parseEndpoint("javascript:alert(1)")).toBeNull();
    expect(parseEndpoint("not a url")).toBeNull();
    expect(parseEndpoint("")).toBeNull();
  });

  test("a socket URL naming no host is refused", () => {
    expect(parseEndpoint("ws:///v1/socket")).toBeNull();
  });

  test("a hub endpoint carries a base and the daemon it is pinned to", () => {
    const parsed = parseEndpoint("ompd://hub?url=wss%3A%2F%2Fhub.example.com&daemon=abc123");
    expect(parsed).toEqual({
      transport: "hub",
      hubUrl: "wss://hub.example.com",
      daemonId: "abc123",
    });
  });

  test("a hub endpoint with no daemon to pin is refused", () => {
    // Without the fingerprint there is nothing to verify the far end against,
    // which is the whole reason a relay can be untrusted.
    expect(parseEndpoint("ompd://hub?url=wss%3A%2F%2Fhub.example.com")).toBeNull();
    expect(parseEndpoint("ompd://hub?url=wss%3A%2F%2Fhub.example.com&daemon=")).toBeNull();
  });

  test("a hub endpoint whose base is not a socket URL is refused", () => {
    expect(parseEndpoint("ompd://hub?url=https%3A%2F%2Fhub.example.com&daemon=abc")).toBeNull();
  });

  test("a token smuggled beside the address is a refusal, not a silent drop", () => {
    // Dropping it would leave the operator holding a connection they believe
    // is credentialed, failing later at authentication instead of here.
    expect(parseEndpoint("ompd://hub?url=wss%3A%2F%2Fhub.example.com&daemon=abc&token=secret")).toBeNull();
  });

  test("another ompd host is not read as a hub endpoint", () => {
    expect(parseEndpoint("ompd://pair?url=wss%3A%2F%2Fhub.example.com&daemon=abc")).toBeNull();
  });

  test("a hub base is normalized, so appending the link path cannot double a slash", () => {
    const parsed = parseEndpoint("ompd://hub?url=wss%3A%2F%2Fhub.example.com%2F&daemon=abc");
    expect(parsed).toEqual({ transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "abc" });
  });
});

describe("encodeEndpoint", () => {
  test("a direct endpoint encodes to the URL itself, because that is what an operator pastes", () => {
    expect(encodeEndpoint({ transport: "direct", url: "ws://10.4.1.221:7777/v1/socket" })).toBe(
      "ws://10.4.1.221:7777/v1/socket",
    );
  });

  test("every encoded endpoint parses back to itself", () => {
    const endpoints: Endpoint[] = [
      { transport: "direct", url: "ws://10.4.1.221:7777/v1/socket" },
      { transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "abc123" },
    ];
    for (const endpoint of endpoints) {
      expect(parseEndpoint(encodeEndpoint(endpoint))).toEqual(endpoint);
    }
  });

  test("an encoded hub endpoint contains no credential parameter", () => {
    const encoded = encodeEndpoint({ transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "abc" });
    expect(encoded).not.toContain("token");
  });
});

describe("the predicates the app validates stored state with", () => {
  test("isSocketUrl accepts only ws and wss with a host", () => {
    expect(isSocketUrl("ws://127.0.0.1:7777/v1/socket")).toBe(true);
    expect(isSocketUrl("wss://box/v1/socket")).toBe(true);
    expect(isSocketUrl("https://box/v1/socket")).toBe(false);
    expect(isSocketUrl("ws:///v1/socket")).toBe(false);
    expect(isSocketUrl("nonsense")).toBe(false);
  });

  test("isHubUrl accepts a local ws hub, because a hub under test is not served over TLS", () => {
    expect(isHubUrl("ws://127.0.0.1:8080")).toBe(true);
    expect(isHubUrl("wss://hub.example.com")).toBe(true);
    expect(isHubUrl("http://hub.example.com")).toBe(false);
  });

  test("normalizeHubUrl removes every trailing slash and surrounding space", () => {
    expect(normalizeHubUrl("  wss://hub.example.com///  ")).toBe("wss://hub.example.com");
    expect(normalizeHubUrl("wss://hub.example.com")).toBe("wss://hub.example.com");
  });
});

describe("describeEndpoint", () => {
  test("a hub line names the daemon, because the base alone does not say which machine", () => {
    expect(describeEndpoint({ transport: "hub", hubUrl: "wss://hub.example.com", daemonId: "abc" })).toBe(
      "wss://hub.example.com (daemon abc)",
    );
  });
});
