/**
 * Provisioner contracts.
 *
 * Every backend hands the supervisor the same thing: a duplex stream carrying
 * ACP JSON-RPC. Local is a pipe, container is `exec -i`, cloud is ssh. That is
 * why `HostHandle.spawn` returns a `LocalHost` whatever the transport -- the
 * supervisor stays transport-agnostic, and `spawnLocalHost` keeps ownership of
 * the approval-gate overlay in all three cases.
 */

import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import type { Actor, HostKind, HostRef, HostSpec } from "@ompd/core";

/**
 * Provisioning failed, or a host was asked to do something it cannot.
 *
 * Distinct from a generic Error so callers can tell "this host kind is not
 * available here" from a bug. The provisioner never degrades a failed
 * container or cloud provision into a local host: an agent the operator
 * believes is sandboxed, silently running on the laptop instead, is the exact
 * failure this type exists to make loud.
 */
export class ProvisionError extends Error {
  /** Host kind the caller asked for. A string, because it may be unknown. */
  readonly kind: string;

  constructor(message: string, kind = "unknown", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProvisionError";
    this.kind = kind;
  }
}

export interface HostHandle {
  ref: HostRef;
  /**
   * Open an ACP connection to this host.
   *
   * Always routed through `spawnLocalHost`, including for remote backends, so
   * the gate overlay is written and passed by the same code every time.
   */
  spawn(opts: SpawnLocalHostOptions): LocalHost;
}

export interface Provisioner {
  /** `actor` is optional: routines and the TTL sweep provision unattended. */
  provision(spec: HostSpec, actor?: Actor): Promise<HostHandle>;
  destroy(id: string, actor?: Actor): Promise<void>;
  list(): Promise<HostHandle[]>;
}

/** One host kind. The provisioner dispatches to exactly one of these, or fails. */
export interface ProvisionerBackend {
  readonly kind: HostKind;
  provision(spec: HostSpec): Promise<HostHandle>;
  destroy(handle: HostHandle): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
}

/**
 * Every subprocess the provisioner runs goes through this seam, so tests never
 * touch a container runtime or the network.
 */
export type CommandRunner = (argv: string[], opts?: CommandOptions) => Promise<CommandResult>;

/** The host-factory seam, matching `SupervisorOptions.spawnHost`. */
export type SpawnHost = (opts: SpawnLocalHostOptions) => LocalHost;
