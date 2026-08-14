/**
 * The cloud backend: an `omp acp` process on a machine that is not this one.
 *
 * No cloud SDK. A `CloudDriver` is whatever knows how to get a machine and how
 * to reach it, and the only driver shipped here is ssh, which is enough for a
 * static build box and is the substrate the SDK drivers would use anyway. A
 * driver is injected, so tests never touch the network.
 *
 * Transport is `ssh -T <destination> omp acp`: stdin and stdout are the duplex
 * stream, the same shape as the local pipe. The approval gate is preserved the
 * same way the container backend preserves it, through the generated wrapper
 * in `gate-wrapper.ts`; ompd never passes `--config` itself.
 *
 * TTL is not enforced here. `spec.ttlSeconds` is swept by the provisioner,
 * which owns the one timer and can kill live connections before asking the
 * driver to destroy the machine.
 */

import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import { spawnLocalHost } from "@ompd/acp";
import type { HostKind, HostSpec } from "@ompd/core";
import { rmSync } from "node:fs";
import { execCommand } from "./exec.ts";
import { writeGateWrapper, type GateWrapper } from "./gate-wrapper.ts";
import {
  ProvisionError,
  type CommandRunner,
  type HostHandle,
  type ProvisionerBackend,
  type SpawnHost,
} from "./types.ts";

export interface CloudMachine {
  /** Stable id. Becomes `HostRef.id`. */
  id: string;
  /** Private directory on the machine that ompd owns and may delete. */
  scratchDir: string;
  /** Argv prefix running a plain command there with stdin attached. */
  shellArgv: string[];
  /** Argv prefix ending in the machine's omp binary. */
  attachArgv: string[];
}

/**
 * Acquiring and reaching a machine. Implementations range from "ssh to a box
 * that already exists" to "ask an API for one"; the backend cares only that
 * the result can run a command and be destroyed.
 */
export interface CloudDriver {
  readonly name: string;
  create(spec: HostSpec): Promise<CloudMachine>;
  destroy(id: string): Promise<void>;
  list(): Promise<CloudMachine[]>;
}

export interface SshCloudDriverOptions {
  /** ssh destination, e.g. `ops@build-01`. */
  destination: string;
  sshPath?: string;
  /** Extra ssh options, e.g. `["-i", "/path/to/key"]`. */
  sshArgs?: string[];
  /** Path to omp on the remote machine. */
  remoteOmpPath?: string;
  /** Parent directory for ompd's per-host scratch on the remote machine. */
  scratchRoot?: string;
  run?: CommandRunner;
}

/**
 * A driver for a machine that already exists.
 *
 * `create` does not conjure hardware; it claims a private scratch directory on
 * the configured host and proves the host answers, so an unreachable box fails
 * at provision time rather than halfway through an agent's first turn.
 * `destroy` removes that directory. The connections themselves are killed by
 * the provisioner, and killing the ssh client drops the remote `omp acp` with it.
 */
export class SshCloudDriver implements CloudDriver {
  readonly name = "ssh";

  #destination: string;
  #sshPath: string;
  #sshArgs: string[];
  #remoteOmpPath: string;
  #scratchRoot: string;
  #run: CommandRunner;
  #machines = new Map<string, CloudMachine>();

  constructor(opts: SshCloudDriverOptions) {
    this.#destination = opts.destination;
    this.#sshPath = opts.sshPath ?? "ssh";
    // BatchMode stops ssh from blocking the daemon on a password prompt that
    // nobody is there to answer.
    this.#sshArgs = ["-T", "-o", "BatchMode=yes", ...(opts.sshArgs ?? [])];
    this.#remoteOmpPath = opts.remoteOmpPath ?? "omp";
    this.#scratchRoot = opts.scratchRoot ?? "/tmp";
    this.#run = opts.run ?? execCommand;
  }

  async create(spec: HostSpec): Promise<CloudMachine> {
    // The machine already exists, so an image request cannot be honoured.
    // Refusing beats running the agent on whatever happens to be installed
    // and calling it the image the operator asked for.
    if (spec.image !== undefined) {
      throw new ProvisionError(
        `ssh driver cannot honour spec.image (${spec.image}); this machine's environment is fixed`,
        "cloud",
      );
    }
    const id = `ssh_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const scratchDir = `${this.#scratchRoot}/ompd-${id}`;
    const base = [this.#sshPath, ...this.#sshArgs, this.#destination];

    const made = await this.#run([...base, "mkdir", "-p", scratchDir]);
    if (made.code !== 0) {
      throw new ProvisionError(
        `ssh ${this.#destination} could not create ${scratchDir} (exit ${made.code}): ${made.stderr.trim()}`,
        "cloud",
      );
    }
    const locked = await this.#run([...base, "chmod", "700", scratchDir]);
    if (locked.code !== 0) {
      await this.#run([...base, "rm", "-rf", scratchDir]).catch(() => undefined);
      throw new ProvisionError(
        `ssh ${this.#destination} could not lock down ${scratchDir}: ${locked.stderr.trim()}`,
        "cloud",
      );
    }

    const machine: CloudMachine = {
      id,
      scratchDir,
      shellArgv: base,
      attachArgv: [...base, this.#remoteOmpPath],
    };
    // `spec` is otherwise carried on the HostRef by the backend; the driver
    // keeps only what it needs to release the machine again.
    this.#machines.set(id, machine);
    return machine;
  }

  async destroy(id: string): Promise<void> {
    const machine = this.#machines.get(id);
    if (machine === undefined) return;
    this.#machines.delete(id);
    const removed = await this.#run([...machine.shellArgv, "rm", "-rf", machine.scratchDir]);
    if (removed.code !== 0) {
      throw new ProvisionError(
        `ssh ${this.#destination} could not remove ${machine.scratchDir}: ${removed.stderr.trim()}`,
        "cloud",
      );
    }
  }

  async list(): Promise<CloudMachine[]> {
    return [...this.#machines.values()];
  }
}

export interface CloudBackendOptions {
  driver: CloudDriver;
  spawn?: SpawnHost;
}

interface CloudRecord {
  machine: CloudMachine;
  wrapper: GateWrapper;
}

export class CloudBackend implements ProvisionerBackend {
  readonly kind: HostKind = "cloud";

  #driver: CloudDriver;
  #spawn: SpawnHost;
  #live = new Map<string, CloudRecord>();

  constructor(opts: CloudBackendOptions) {
    this.#driver = opts.driver;
    this.#spawn = opts.spawn ?? spawnLocalHost;
  }

  async provision(spec: HostSpec): Promise<HostHandle> {
    if (spec.kind !== "cloud") {
      throw new ProvisionError(`cloud backend cannot serve a ${spec.kind} host`, spec.kind);
    }

    let machine: CloudMachine;
    try {
      machine = await this.#driver.create(spec);
    } catch (err) {
      throw err instanceof ProvisionError
        ? err
        : new ProvisionError(
            `cloud driver ${this.#driver.name} could not provision a machine: ${String(err)}`,
            "cloud",
            { cause: err },
          );
    }

    let wrapper: GateWrapper;
    try {
      wrapper = writeGateWrapper({
        shell: machine.shellArgv,
        attach: machine.attachArgv,
        remoteConfigPath: `${machine.scratchDir}/gate.yml`,
        label: `cloud ${machine.id}`,
        kind: "cloud",
      });
    } catch (err) {
      // The machine is claimed but unusable. Hand it back before failing, or
      // nothing holds a handle able to release it.
      await this.#driver.destroy(machine.id).catch(() => undefined);
      throw err instanceof ProvisionError
        ? err
        : new ProvisionError(`cloud host ${machine.id} could not be prepared: ${String(err)}`, "cloud", {
            cause: err,
          });
    }

    this.#live.set(machine.id, { machine, wrapper });
    const spawn = this.#spawn;
    return {
      ref: { kind: "cloud", id: machine.id, spec },
      // The caller's omp path is a path on the daemon's machine, so it is
      // replaced rather than merged.
      spawn: (opts: SpawnLocalHostOptions): LocalHost => spawn({ ...opts, ompPath: wrapper.path }),
    };
  }

  async destroy(handle: HostHandle): Promise<void> {
    const record = this.#live.get(handle.ref.id);
    if (record === undefined) {
      throw new ProvisionError(`unknown cloud handle ${handle.ref.id}`, "cloud");
    }
    this.#live.delete(handle.ref.id);
    try {
      rmSync(record.wrapper.dir, { recursive: true, force: true });
    } catch {
      // Best effort. A leftover script in the temp dir is litter, not a risk.
    }
    await this.#driver.destroy(record.machine.id);
  }
}
