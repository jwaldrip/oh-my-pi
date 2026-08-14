/**
 * Dispatch, tracking, and TTL.
 *
 * The one rule this file exists to enforce: a host kind is served by its own
 * backend or not at all. There is no default and no fallback. An operator who
 * asks for a container and gets a process on the daemon's machine has lost the
 * isolation they asked for and has no way to tell, so an unknown or
 * unconfigured kind fails loudly and is written to the audit log.
 *
 * Connections are tracked alongside handles because destroying a host has to
 * mean the ACP stream dies too. Killing the local end of `docker exec` or
 * `ssh` is what actually stops the remote `omp acp`.
 */

import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import type { Actor, HostKind, HostSpec, Store } from "@ompd/core";
import { CloudBackend, type CloudDriver } from "./cloud.ts";
import { ContainerBackend } from "./container.ts";
import { LocalBackend } from "./local.ts";
import { ProvisionError, type HostHandle, type Provisioner, type ProvisionerBackend } from "./types.ts";

export interface ProvisionerOptions {
  store: Store;
  /**
   * Backends by kind. Any kind left out is unavailable, which is the point:
   * `cloud` has no default because a cloud backend without a driver would have
   * to either fail or run somewhere else, and one of those is a security bug.
   */
  backends?: Partial<Record<HostKind, ProvisionerBackend>>;
  /** Convenience: builds the default `cloud` backend around this driver. */
  cloudDriver?: CloudDriver;
  /** Host directory mounted into container hosts. */
  workspace?: string;
  /** The daemon's own state directory. Passed through so a container host refuses to mount it. */
  home?: string;
  /** How often TTLs are checked. */
  sweepIntervalMs?: number;
  /** Clock seam, so TTL is testable without waiting. */
  now?: () => number;
  onLog?: (line: string) => void;
}

interface TrackedHost {
  /** The backend's handle. Never handed out directly. */
  inner: HostHandle;
  /** What callers get: same ref, plus the destroyed check and TTL touch. */
  wrapped: HostHandle;
  backend: ProvisionerBackend;
  kind: HostKind;
  ttlMs: number | null;
  lastUsedAt: number;
  connections: Set<LocalHost>;
  destroyed: boolean;
}

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

export class HostProvisioner implements Provisioner {
  #store: Store;
  #backends: Map<HostKind, ProvisionerBackend>;
  #hosts = new Map<string, TrackedHost>();
  #sweepIntervalMs: number;
  #now: () => number;
  #onLog: ((line: string) => void) | undefined;
  #timer: Timer | null = null;
  /** Sweep-initiated teardowns, which no caller is awaiting. */
  #inFlight = new Set<Promise<void>>();

  constructor(opts: ProvisionerOptions) {
    this.#store = opts.store;
    this.#sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#now = opts.now ?? Date.now;
    this.#onLog = opts.onLog;

    this.#backends = new Map<HostKind, ProvisionerBackend>();
    const supplied = opts.backends;
    if (supplied === undefined) {
      this.#backends.set("local", new LocalBackend());
      this.#backends.set("container", new ContainerBackend({ workspace: opts.workspace, home: opts.home }));
      if (opts.cloudDriver !== undefined) {
        this.#backends.set("cloud", new CloudBackend({ driver: opts.cloudDriver }));
      }
    } else {
      for (const [kind, backend] of Object.entries(supplied)) {
        if (backend !== undefined) this.#backends.set(kind as HostKind, backend);
      }
      if (opts.cloudDriver !== undefined && !this.#backends.has("cloud")) {
        this.#backends.set("cloud", new CloudBackend({ driver: opts.cloudDriver }));
      }
    }
  }

  async provision(spec: HostSpec, actor?: Actor): Promise<HostHandle> {
    const backend = this.#backends.get(spec.kind);
    if (backend === undefined) {
      this.#store.audit({
        action: "host.provision",
        actorDeviceId: actor?.deviceId ?? null,
        outcome: "error",
        detail: { kind: String(spec.kind), reason: "no backend for this host kind" },
      });
      throw new ProvisionError(
        `no backend for host kind ${JSON.stringify(spec.kind)}`,
        String(spec.kind),
      );
    }

    let inner: HostHandle;
    try {
      inner = await backend.provision(spec);
    } catch (err) {
      this.#store.audit({
        action: "host.provision",
        actorDeviceId: actor?.deviceId ?? null,
        outcome: "error",
        detail: { kind: spec.kind, reason: err instanceof Error ? err.message : String(err) },
      });
      // Nothing was tracked, so there is no half-live handle to reclaim: the
      // backend is responsible for releasing whatever it created before it threw.
      throw err instanceof ProvisionError
        ? err
        : new ProvisionError(`provisioning a ${spec.kind} host failed: ${String(err)}`, spec.kind, {
            cause: err,
          });
    }

    const ttlMs = spec.ttlSeconds === undefined ? null : spec.ttlSeconds * 1000;
    const tracked: TrackedHost = {
      inner,
      wrapped: inner,
      backend,
      kind: spec.kind,
      ttlMs,
      lastUsedAt: this.#now(),
      connections: new Set<LocalHost>(),
      destroyed: false,
    };
    tracked.wrapped = {
      ref: inner.ref,
      spawn: (opts: SpawnLocalHostOptions): LocalHost => {
        if (tracked.destroyed) {
          throw new ProvisionError(
            `host ${inner.ref.id} has been destroyed and cannot be reconnected`,
            spec.kind,
          );
        }
        const connection = inner.spawn(opts);
        tracked.lastUsedAt = this.#now();
        tracked.connections.add(connection);
        void connection.exited.then(() => tracked.connections.delete(connection));
        return connection;
      },
    };

    this.#hosts.set(inner.ref.id, tracked);
    this.#store.audit({
      action: "host.provision",
      actorDeviceId: actor?.deviceId ?? null,
      outcome: "ok",
      detail: {
        kind: spec.kind,
        hostId: inner.ref.id,
        image: spec.image,
        ttlSeconds: spec.ttlSeconds,
      },
    });
    this.#startTimerIfNeeded();
    return tracked.wrapped;
  }

  /**
   * Release a host. Unknown ids are a no-op, so a caller racing the TTL sweep
   * or retrying after a timeout does not get an error for work already done.
   */
  async destroy(id: string, actor?: Actor): Promise<void> {
    await this.#destroy(id, "requested", actor);
  }

  async list(): Promise<HostHandle[]> {
    return [...this.#hosts.values()].map((tracked) => tracked.wrapped);
  }

  /**
   * Extend a host's lease. TTL is measured from the last connection opened, so
   * a long-lived agent on a JIT host needs whoever drives it to say so; the
   * provisioner cannot see prompts.
   */
  touch(id: string): void {
    const tracked = this.#hosts.get(id);
    if (tracked !== undefined) tracked.lastUsedAt = this.#now();
  }

  /**
   * Stop the sweep and release every tracked host.
   *
   * Also waits on any teardown a sweep already started. Those are not tracked
   * hosts any more, so without this the daemon could exit while a container or
   * machine is still being released, and leak it.
   */
  async close(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const ids = [...this.#hosts.keys()];
    await Promise.all(ids.map((id) => this.#destroy(id, "shutdown").catch(() => undefined)));
    await Promise.allSettled([...this.#inFlight]);
  }

  async #destroy(id: string, reason: string, actor?: Actor): Promise<void> {
    const tracked = this.#hosts.get(id);
    if (tracked === undefined) return;

    // Untrack first. Destroying is async, and a second caller (or the sweep)
    // must not start a parallel teardown of the same host.
    this.#hosts.delete(id);
    tracked.destroyed = true;
    for (const connection of tracked.connections) {
      try {
        connection.kill();
      } catch (err) {
        this.#onLog?.(`host ${id}: killing a connection failed: ${String(err)}`);
      }
    }
    tracked.connections.clear();

    try {
      await tracked.backend.destroy(tracked.inner);
      this.#store.audit({
        action: "host.destroy",
        actorDeviceId: actor?.deviceId ?? null,
        outcome: "ok",
        detail: { kind: tracked.kind, hostId: id, reason },
      });
    } catch (err) {
      // Still untracked: a host that cannot be released must not stay in the
      // pool to be handed out again. The audit entry is how the operator finds
      // the leak.
      this.#store.audit({
        action: "host.destroy",
        actorDeviceId: actor?.deviceId ?? null,
        outcome: "error",
        detail: {
          kind: tracked.kind,
          hostId: id,
          reason,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err instanceof ProvisionError
        ? err
        : new ProvisionError(`destroying host ${id} failed: ${String(err)}`, tracked.kind, { cause: err });
    } finally {
      this.#stopTimerIfIdle();
    }
  }

  #startTimerIfNeeded(): void {
    if (this.#timer !== null) return;
    if (![...this.#hosts.values()].some((tracked) => tracked.ttlMs !== null)) return;
    this.#timer = setInterval(() => this.#sweep(), this.#sweepIntervalMs);
    // A pending sweep must never be the reason the daemon cannot exit.
    this.#timer.unref();
  }

  #stopTimerIfIdle(): void {
    if (this.#timer === null) return;
    if ([...this.#hosts.values()].some((tracked) => tracked.ttlMs !== null)) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, tracked] of this.#hosts) {
      if (tracked.ttlMs === null) continue;
      if (now - tracked.lastUsedAt < tracked.ttlMs) continue;
      const teardown = this.#destroy(id, "ttl").catch((err: unknown) => {
        this.#onLog?.(`host ${id}: ttl teardown failed: ${String(err)}`);
      });
      this.#inFlight.add(teardown);
      void teardown.finally(() => this.#inFlight.delete(teardown));
    }
  }
}
