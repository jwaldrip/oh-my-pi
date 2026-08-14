/**
 * Wiring the tunnel to this daemon's gateway.
 *
 * The protocol lives in `@ompd/tunnel`, which knows how to dial, register,
 * answer a handshake, and carry sealed frames. What it deliberately does not
 * know is who anyone is. That is this file: it hands the token the tunnel
 * recovered to `Gateway.acceptTunnelSession`, which runs the same
 * `authenticate` a local websocket runs, and records what was decided.
 *
 * Everything security-relevant is therefore in one place already covered by
 * the gateway's own tests. This adds an audit line and nothing else.
 */

import type { Store } from "@ompd/core";
import { type DaemonKeyPair, type DialTransport, type RefusalCode, TunnelDaemon } from "@ompd/tunnel";
import type { Gateway } from "../gateway/gateway.ts";

export interface TunnelDialerOptions {
  hubUrl: string;
  identity: DaemonKeyPair;
  gateway: Gateway;
  store: Store;
  transport?: DialTransport;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onLog?: (message: string) => void;
}

/**
 * Build the daemon's outbound leg.
 *
 * Returned rather than started, so the composition root decides when a daemon
 * starts advertising itself as reachable.
 */
export function createTunnelDialer(opts: TunnelDialerOptions): TunnelDaemon {
  const audit = (
    action: "tunnel.register" | "tunnel.attach",
    outcome: "ok" | "denied",
    actorDeviceId: string | null,
    detail: Record<string, unknown>,
  ): void => {
    opts.store.audit({ action, actorDeviceId, outcome, detail });
  };

  return new TunnelDaemon({
    hubUrl: opts.hubUrl,
    identity: opts.identity,
    transport: opts.transport,
    minBackoffMs: opts.minBackoffMs,
    maxBackoffMs: opts.maxBackoffMs,
    onLog: opts.onLog,
    // The gateway is the only thing that decides. This closure adds no check of
    // its own, and could not usefully add one: it has no credential store.
    acceptor: {
      accept: (token, send) => opts.gateway.acceptTunnelSession(token, send),
    },
    onWebhook: async (request) => {
      const response = await opts.gateway.fireWebhook(
        request.routineId,
        request.secret,
        Buffer.from(request.body, "base64url"),
        request.contentType,
      );
      return {
        status: response.status,
        body: Buffer.from(await response.arrayBuffer()).toString("base64url"),
        contentType: response.headers.get("content-type") ?? undefined,
      };
    },
    onRegistered: (instanceId) => {
      audit("tunnel.register", "ok", null, { daemonId: opts.identity.daemonId, instanceId });
      opts.onLog?.(`tunnel registered with hub instance ${instanceId}`);
    },
    onRefused: (code: RefusalCode, message: string) => {
      audit("tunnel.register", "denied", null, { daemonId: opts.identity.daemonId, code, message });
    },
    onSession: (event) => {
      audit("tunnel.attach", event.outcome, event.deviceId ?? null, {
        sessionId: event.sessionId,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
    },
  });
}
