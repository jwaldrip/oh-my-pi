import { describe, expect, test } from "bun:test";
import {
  handleCollabDeepLink,
  listenForCollabLinks,
  parseCollabDeepLink,
  type DeepLinkSource,
} from "../src/platform/deeplink.ts";

describe("parseCollabDeepLink", () => {
  test("accepts the custom-scheme and verified universal-link forms", () => {
    expect(parseCollabDeepLink("ompd://collab/room_0123456789")).toEqual({ roomId: "room_0123456789" });
    expect(parseCollabDeepLink("https://my.ompd.sh/collab/room_0123456789")).toEqual({ roomId: "room_0123456789" });
  });

  test("refuses lookalike origins, query capabilities, and malformed room paths", () => {
    expect(parseCollabDeepLink("https://my.ompd.sh.evil.example/collab/room_0123456789")).toBeNull();
    expect(parseCollabDeepLink("https://my.ompd.sh/collab/room_0123456789?token=leak")).toBeNull();
    expect(parseCollabDeepLink("ompd://collab/short")).toBeNull();
    expect(parseCollabDeepLink("ompd://other/room_0123456789")).toBeNull();
    expect(parseCollabDeepLink("https://my.ompd.sh/collab/room_0123456789/extra")).toBeNull();
  });
});

describe("incoming collaboration deep links", () => {
  test("routes cold-start and warm links directly to the collaboration session view", async () => {
    const received: string[] = [];
    const source = new FakeDeepLinks("https://my.ompd.sh/collab/room_0123456789");
    const stop = listenForCollabLinks(source, (roomId) => received.push(roomId));

    await Promise.resolve();
    source.emit("ompd://collab/room_abcdefghij");
    source.emit("https://unrelated.example/collab/room_abcdefghij");

    expect(received).toEqual(["room_0123456789", "room_abcdefghij"]);
    stop();
    source.emit("ompd://collab/room_after_stop");
    expect(received).toEqual(["room_0123456789", "room_abcdefghij"]);
  });

  test("reports whether an incoming URL was a collaboration route", () => {
    const received: string[] = [];
    expect(handleCollabDeepLink("ompd://collab/room_0123456789", (roomId) => received.push(roomId))).toBe(true);
    expect(handleCollabDeepLink("ompd://pair/example", (roomId) => received.push(roomId))).toBe(false);
    expect(received).toEqual(["room_0123456789"]);
  });
});

class FakeDeepLinks implements DeepLinkSource {
  #listener: ((event: { url: string }) => void) | null = null;

  constructor(private readonly initialUrl: string | null) {}

  async getInitialURL(): Promise<string | null> {
    return this.initialUrl;
  }

  addEventListener(_type: "url", listener: (event: { url: string }) => void): { remove(): void } {
    this.#listener = listener;
    return { remove: () => (this.#listener = null) };
  }

  emit(url: string): void {
    this.#listener?.({ url });
  }
}
