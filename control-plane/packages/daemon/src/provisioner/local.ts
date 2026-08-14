/**
 * The local backend: an `omp acp` child of the daemon.
 *
 * Provisioning a local host acquires nothing, because there is nothing to
 * acquire. It exists as a backend anyway so dispatch has exactly one shape,
 * and so `local` is a deliberate choice in the table rather than the place
 * every unmatched kind quietly lands.
 */

import { spawnLocalHost, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";
import type { HostKind, HostSpec } from "@ompd/core";
import { ProvisionError, type HostHandle, type ProvisionerBackend, type SpawnHost } from "./types.ts";

export interface LocalBackendOptions {
  /** Path to the omp binary. Defaults to whatever `spawnLocalHost` resolves. */
  ompPath?: string;
  /** Host-factory seam. Defaults to the real `spawnLocalHost`. */
  spawn?: SpawnHost;
}

export class LocalBackend implements ProvisionerBackend {
  readonly kind: HostKind = "local";

  #ompPath: string | undefined;
  #spawn: SpawnHost;

  constructor(opts: LocalBackendOptions = {}) {
    this.#ompPath = opts.ompPath;
    this.#spawn = opts.spawn ?? spawnLocalHost;
  }

  /**
   * `ref.id` is a provisioner-side handle id, not a pid: no process exists
   * until `spawn`, and one handle may be spawned more than once. The supervisor
   * records the pid separately on the agent's `HostRef`.
   */
  async provision(spec: HostSpec): Promise<HostHandle> {
    if (spec.kind !== "local") {
      throw new ProvisionError(`local backend cannot serve a ${spec.kind} host`, spec.kind);
    }
    const id = `lcl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const ompPath = this.#ompPath;
    const spawn = this.#spawn;
    return {
      ref: { kind: "local", id, spec },
      spawn: (opts: SpawnLocalHostOptions): LocalHost =>
        spawn(ompPath === undefined ? opts : { ...opts, ompPath: opts.ompPath ?? ompPath }),
    };
  }

  /**
   * Nothing to reclaim. The connection itself is killed by the provisioner,
   * which owns every `LocalHost` it handed out.
   */
  async destroy(_handle: HostHandle): Promise<void> {
    return;
  }
}
