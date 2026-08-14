/**
 * The socket factory that reaches a daemon through a hub instead of dialing it
 * directly.
 *
 * `OmpdClient` only knows how to build one kind of URL: whatever it was given,
 * plus `?token=` appended. That is right for a socket the device opens itself,
 * and wrong here, because a hub is a relay, never the party the token
 * authenticates. `hubSocketUrl` strips the parameter back off, and the token
 * that comes out travels inside `connectThroughHub`'s sealed channel instead,
 * readable only by the daemon pinned at pairing. See `@ompd/tunnel`'s
 * `socket.ts` for the other half of that contract.
 */

import type { SocketFactory, SocketLike } from "@ompd/core/ompd-client";
import { connectThroughHub, hubSocketUrl } from "@ompd/tunnel";
import type { DaemonId, TunnelSocketLike, TunnelTransportFactory } from "@ompd/tunnel";

export interface HubSocketFactoryOptions {
  /** The daemon this device paired with, pinned rather than taken from anything the hub claims. */
  daemonId: DaemonId;
  /** Overrides the wire transport. Tests substitute this so nothing here opens a real socket. */
  transport?: TunnelTransportFactory;
}

/**
 * Builds the `SocketFactory` `OmpdClient` needs to reach a daemon through a
 * hub, given the daemon id fixed at pairing.
 */
export function createHubSocketFactory(options: HubSocketFactoryOptions): SocketFactory {
  const transport = options.transport ?? defaultTransport;
  return (url) => {
    const { base, token } = hubSocketUrl(url);
    if (token === null || token.length === 0) {
      // `OmpdClient` always appends one. A caller reaching this without one
      // has dropped it somewhere upstream, and dialing the hub with an empty
      // credential would fail as an authentication error against the hub,
      // far from where the actual mistake was made.
      throw new Error(`hub socket factory: "${base}" carries no token`);
    }
    return adaptToSocketLike(connectThroughHub({ hubUrl: base, daemonId: options.daemonId, token, transport }));
  };
}

/**
 * `TunnelSocketLike.onmessage` hands over a bare string, the shape the wire
 * protocol actually carries. `SocketLike.onmessage` wants `{ data }`, because
 * that is what a real `WebSocket`'s event looks like and every other
 * `SocketFactory` in this app already speaks that shape.
 */
function adaptToSocketLike(wire: TunnelSocketLike): SocketLike {
  const adapter: SocketLike = {
    get readyState() {
      return wire.readyState;
    },
    send: (data) => wire.send(data),
    close: (code, reason) => wire.close(code, reason),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  wire.onopen = () => adapter.onopen?.();
  wire.onclose = (info) => adapter.onclose?.(info);
  wire.onerror = (info) => adapter.onerror?.(info);
  wire.onmessage = (data) => adapter.onmessage?.({ data });
  return adapter;
}

/**
 * The wire every target here ships a real `WebSocket` for: browsers, Bun, and
 * React Native's own. A class rather than a cast, because `TunnelSocketLike`
 * declares `readyState` as a plain mutable field (unlike core's `SocketLike`,
 * which is read-only), and a get-only accessor over `WebSocket.readyState`
 * does not satisfy that.
 */
class WebSocketWire implements TunnelSocketLike {
  readyState: number;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;

  readonly #ws: WebSocket;

  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.readyState = this.#ws.readyState;
    this.#ws.onopen = () => {
      this.readyState = this.#ws.readyState;
      this.onopen?.();
    };
    this.#ws.onclose = (event) => {
      this.readyState = this.#ws.readyState;
      this.onclose?.({ code: event.code, reason: event.reason });
    };
    this.#ws.onerror = (event) => {
      const message: unknown = Reflect.get(event, "message");
      this.onerror?.({ message: typeof message === "string" ? message : "hub socket error" });
    };
    this.#ws.onmessage = (event) => {
      this.onmessage?.(typeof event.data === "string" ? event.data : String(event.data));
    };
  }

  send(data: string): void {
    this.#ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#ws.close(code, reason);
  }
}

/**
 * Named rather than inlined at its one call site: `TunnelTransportFactory`
 * calls its argument as a plain function, and a class can only be invoked
 * with `new`. This is the adapter that lets `WebSocketWire` stand in as the
 * default value of that seam.
 */
function defaultTransport(url: string): TunnelSocketLike {
  return new WebSocketWire(url);
}
