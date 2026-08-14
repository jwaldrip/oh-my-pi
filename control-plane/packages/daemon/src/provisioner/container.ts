/**
 * The container backend.
 *
 * A detached container is started from a published image with the workspace
 * mounted at the same absolute path it has on the host, so a cwd the daemon
 * hands to `session/new` means the same thing on both sides. An operator may
 * name further host directories in `spec.mounts`; each lands at that same
 * identical absolute path inside, for the same reason. The ACP transport is
 * `<runtime> exec -i <id> omp acp`: a duplex byte stream, exactly like the
 * local pipe, which is why the supervisor needs to know nothing about this.
 *
 * The approval gate is preserved, not reimplemented. `spawn` delegates to
 * `spawnLocalHost` with `ompPath` pointing at a generated wrapper, so
 * `spawnLocalHost` still writes the overlay and still passes its own
 * `--config`; the wrapper copies that file into the container, verifies it,
 * and rewrites the flag. See `gate-wrapper.ts`. ompd never passes `--config`
 * and never authors the overlay.
 *
 * The run command is built per runtime, not assumed docker-shaped. Apple's
 * `container` CLI (0.4.1) has no flag for `--cap-drop`, `--security-opt`,
 * `--read-only`, or `--pids-limit`, and exits on an unknown flag rather than
 * ignoring it, so a docker-shaped command never provisions on it at all. See
 * `RUNTIME_FLAG_SUPPORT` below and `docs/running.md`'s per-runtime table for
 * what that means for confinement, which is not the same on every runtime and
 * is never silently rounded up to "the same as docker".
 */

import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import { spawnLocalHost } from "@ompd/acp";
import { dangerousMountReason, isInside, type HostKind, type HostMount, type HostSpec } from "@ompd/core";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand } from "./exec.ts";
import { writeGateWrapper, type GateWrapper } from "./gate-wrapper.ts";
import {
  ProvisionError,
  type CommandRunner,
  type HostHandle,
  type ProvisionerBackend,
  type SpawnHost,
} from "./types.ts";

/**
 * Probe order. Docker first because OrbStack, Colima, and Rancher all present a
 * docker CLI, so it is the most likely to be both present and wired up.
 *
 * `orbctl` is deliberately absent. It was listed here and described as verified,
 * and it is neither: OrbStack's container surface IS `docker`, while `orbctl`
 * manages OrbStack Linux machines. Its `run` means "run a command on Linux", it
 * takes none of `--volume`, `--cap-drop`, or `--network`, and it rejects
 * `--version`. The probe only ever skipped it by that accident; pinning it
 * through `ContainerBackendOptions.runtime` would have produced a command that
 * looks like a container and is not one.
 */
export const CONTAINER_RUNTIMES: readonly string[] = ["docker", "podman", "container"];

/**
 * Used when `spec.image` is absent. ompd does not build an image: the operator
 * publishes one containing `omp` and points specs at it. A wrong or missing
 * image fails provisioning loudly rather than falling back to anything.
 */
export const DEFAULT_CONTAINER_IMAGE = "ghcr.io/jwaldrip/omp:latest";

/** Directory inside the container holding ompd's per-host scratch. */
const DEFAULT_SCRATCH_ROOT = "/tmp";

/** What a runtime may return as a container id. */
const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * First runtime that answers `--version`, or null.
 *
 * `--version` rather than `info` because it is the one subcommand all four
 * spell the same way. It proves the CLI is installed, not that its daemon is
 * up; a stopped daemon surfaces as a `ProvisionError` carrying the runtime's
 * own stderr on the first `run`, which is a better message than anything a
 * probe could synthesise.
 */
export async function detectContainerRuntime(
  run: CommandRunner = execCommand,
): Promise<string | null> {
  for (const runtime of CONTAINER_RUNTIMES) {
    try {
      const probe = await run([runtime, "--version"]);
      if (probe.code === 0) return runtime;
    } catch {
      // Not installed. `Bun.spawn` throws for a missing binary rather than
      // exiting non-zero, so this is the common case, not an error.
    }
  }
  return null;
}

export interface ContainerBackendOptions {
  /** Pin a runtime instead of probing. */
  runtime?: string;
  /** Image used when `spec.image` is absent. */
  image?: string;
  /** Host directory mounted into the container at the same absolute path. */
  workspace?: string;
  /** Directory inside the container for ompd's scratch. */
  scratchRoot?: string;
  /** Path to omp inside the image. */
  remoteOmpPath?: string;
  /**
   * The daemon's own state directory. Never mountable: it holds the pairing
   * token and the audit trail an operator relies on to catch a sandbox doing
   * something it should not, so handing it to the sandbox defeats the point
   * of having one. Defaults to `~/.ompd`, the same default the daemon itself
   * uses when nothing overrides it.
   */
  home?: string;
  run?: CommandRunner;
  spawn?: SpawnHost;
}

interface ContainerRecord {
  runtime: string;
  containerId: string;
  /** Removed after the container, which is the only order that works. */
  network: string;
  wrapper: GateWrapper;
}

/**
 * `--user <uid>:<gid>`, or nothing where the platform has no such notion.
 *
 * The daemon's own ids rather than a name baked into the image, because the
 * workspace arrives as a bind mount owned by whoever runs the daemon: a
 * container running as anyone else could not write to the directory it was
 * given, and one running as root would leave root-owned files in the
 * operator's repository.
 */
function userArgs(): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return [];
  return ["--user", `${uid}:${gid}`];
}

/**
 * Which of the four confinement flags a runtime's CLI actually accepts.
 *
 * What was actually verified on this machine, and what was not, because an
 * unearned "verified" is worse than an admitted assumption. Confirmed by
 * reading each CLI's own `run --help`: docker, podman 4.8.2 (a drop-in, all
 * nine flags present), and Apple's `container` 0.4.1. That last one is a
 * different CLI: it accepts `--user`, `--tmpfs`, `--volume`, `--network`,
 * `--workdir`, `--detach`, and `--rm`, but exits on `--cap-drop`,
 * `--security-opt`, `--read-only`, or `--pids-limit` as an unknown flag, so a
 * docker-shaped command never provisions on it.
 *
 * This table is what stands between "provision fails on the first unknown flag"
 * and "provision silently claims a confinement guarantee it never asked the
 * runtime for": every new runtime added to `CONTAINER_RUNTIMES` needs an entry
 * here, and a real `run --help` behind it, before it can be trusted.
 *
 * The four flags this table gates are not one thing. `--cap-drop`,
 * `--security-opt no-new-privileges`, and `--pids-limit` mitigate a
 * shared-kernel escape: a capability, a regained privilege, or a fork bomb
 * reaching past the container into the host's own kernel. Apple's `container`
 * gives each container its own lightweight VM, so there is no shared kernel
 * for any of those three to escape into in the first place -- their absence
 * there is a different boundary, not a hole in this one. `--read-only` is not
 * that: it is whether the image itself can be rewritten from inside, and
 * losing it is a real loss regardless of which kernel the container has.
 * `docs/running.md` reports it as one rather than folding it into the same
 * "different trade" story as the other three.
 */
interface RuntimeFlagSupport {
  capDrop: boolean;
  securityOpt: boolean;
  readOnly: boolean;
  pidsLimit: boolean;
}

const DOCKER_SHAPED_FLAGS: RuntimeFlagSupport = {
  capDrop: true,
  securityOpt: true,
  readOnly: true,
  pidsLimit: true,
};

const APPLE_CONTAINER_FLAGS: RuntimeFlagSupport = {
  capDrop: false,
  securityOpt: false,
  readOnly: false,
  pidsLimit: false,
};

/**
 * Runtime to verified capability. Keys match `CONTAINER_RUNTIMES` exactly.
 *
 * A lookup rather than a conditional, because the conditional it replaced read
 * `runtime === "container" ? APPLE : DOCKER_SHAPED`, which handed docker's shape
 * to every runtime that was not Apple's, including any added later and any
 * pinned by an operator. That is the behaviour this file's own header promises
 * never happens. An absent entry is now a refusal: a runtime nobody has held a
 * `run --help` against cannot be trusted to have accepted the confinement we
 * asked for, and failing to provision is the safe direction.
 */
const RUNTIME_FLAG_SUPPORT: Record<string, RuntimeFlagSupport> = {
  docker: DOCKER_SHAPED_FLAGS,
  podman: DOCKER_SHAPED_FLAGS,
  container: APPLE_CONTAINER_FLAGS,
};

/**
 * Refuse a mount that would hand the sandbox the credentials that make it a
 * sandbox, rather than trusting an operator never to name one by mistake.
 *
 * Reuses `dangerousMountReason`, the project's one list of paths a mount must
 * never name, and adds only what that list cannot know: the daemon's own
 * `home`, which moves with `OMPD_HOME` and cannot be a static pattern.
 */
function refuseIfDangerous(hostPath: string, home: string): void {
  if (!hostPath.startsWith("/")) {
    throw new ProvisionError(
      `mount path must be absolute, got ${JSON.stringify(hostPath)}`,
      "container",
    );
  }
  const reason = dangerousMountReason(hostPath) ??
    (isInside(home, hostPath) ? `inside the daemon's own state directory ${home}` : null);
  if (reason !== null) {
    throw new ProvisionError(`refusing to mount ${hostPath}: ${reason}`, "container");
  }
}

export class ContainerBackend implements ProvisionerBackend {
  readonly kind: HostKind = "container";

  #runtime: string | undefined;
  #image: string;
  #workspace: string;
  #scratchRoot: string;
  #remoteOmpPath: string;
  #home: string;
  #run: CommandRunner;
  #spawn: SpawnHost;
  #live = new Map<string, ContainerRecord>();

  constructor(opts: ContainerBackendOptions = {}) {
    this.#runtime = opts.runtime;
    this.#image = opts.image ?? DEFAULT_CONTAINER_IMAGE;
    this.#workspace = opts.workspace ?? process.cwd();
    this.#scratchRoot = opts.scratchRoot ?? DEFAULT_SCRATCH_ROOT;
    this.#remoteOmpPath = opts.remoteOmpPath ?? "omp";
    this.#home = opts.home ?? join(homedir(), ".ompd");
    this.#run = opts.run ?? execCommand;
    this.#spawn = opts.spawn ?? spawnLocalHost;
  }

  async provision(spec: HostSpec): Promise<HostHandle> {
    if (spec.kind !== "container") {
      throw new ProvisionError(`container backend cannot serve a ${spec.kind} host`, spec.kind);
    }

    // Validated before anything is created, so a refused mount costs nothing
    // to clean up. The reason lands on the same "host.provision" audit entry
    // `HostProvisioner` already writes for any provision failure -- nothing
    // new to wire, because a thrown `ProvisionError` is already audited there.
    const mounts: HostMount[] = (spec.mounts ?? []).map((mount) => {
      refuseIfDangerous(mount.hostPath, this.#home);
      return { hostPath: mount.hostPath, mode: mount.mode ?? "ro" };
    });

    const runtime = this.#runtime ?? (await detectContainerRuntime(this.#run));
    if (runtime === null) {
      throw new ProvisionError(
        `no container runtime found (tried ${CONTAINER_RUNTIMES.join(", ")})`,
        "container",
      );
    }
    const flags = RUNTIME_FLAG_SUPPORT[runtime];
    if (flags === undefined) {
      throw new ProvisionError(
        `runtime ${runtime} has no verified confinement capability entry; ` +
          `add one to RUNTIME_FLAG_SUPPORT backed by its own \`run --help\` before using it`,
        "container",
      );
    }

    const image = spec.image ?? this.#image;
    const env: string[] = [];
    if (spec.repo !== undefined) env.push("--env", `OMPD_REPO=${spec.repo}`);
    if (spec.ref !== undefined) env.push("--env", `OMPD_REF=${spec.ref}`);

    // A network of its own, created before the container that joins it.
    //
    // The default bridge puts every container on one segment, so an agent on
    // it can reach the operator's database, cache, and anything else they
    // happen to be running. Egress to the internet stays open because the
    // agent has to reach a model endpoint, and Docker cannot express "this one
    // host and nothing else" without a proxy in the path. That is a real
    // remaining exposure and `docs/running.md` says so rather than implying
    // this is a sealed box.
    const network = `ompd-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const madeNetwork = await this.#run([runtime, "network", "create", network]);
    if (madeNetwork.code !== 0) {
      throw new ProvisionError(
        `${runtime} network create failed (exit ${madeNetwork.code}): ${madeNetwork.stderr.trim()}`,
        "container",
      );
    }

    // Confinement flags this runtime's CLI actually accepts, per
    // `RuntimeFlagSupport` above. Nothing an ACP host does needs a capability;
    // none of these can be regained afterwards because no-new-privileges
    // blocks setuid; a fork bomb in a sandbox should not take the operator's
    // machine with it -- on a runtime that can express all three. An empty
    // entry here means the flag was never sent, not that it silently held.
    const confineArgs: string[] = [];
    if (flags.capDrop) confineArgs.push("--cap-drop", "ALL");
    if (flags.securityOpt) confineArgs.push("--security-opt", "no-new-privileges:true");
    if (flags.readOnly) confineArgs.push("--read-only");
    if (flags.pidsLimit) confineArgs.push("--pids-limit", "1024");

    // Each named mount lands at the identical absolute path inside, the same
    // property `--volume workspace:workspace` already relies on. Read-only
    // unless the operator opted a path into "rw" explicitly.
    const mountArgs: string[] = [];
    for (const mount of mounts) {
      mountArgs.push("--volume", `${mount.hostPath}:${mount.hostPath}:${mount.mode}`);
    }

    // `tail -f /dev/null` keeps the container alive so exec has something to
    // attach to. The ACP host is not the container's main process: one
    // container serves however many connections the supervisor opens.
    const created = await this.#run([
      runtime,
      "run",
      "--detach",
      "--rm",
      "--network",
      network,
      // The agent runs as the daemon's own user, never root. Two things follow:
      // a file it creates in the workspace belongs to the operator rather than
      // to root, and a bug in the runtime lands as an unprivileged user.
      ...userArgs(),
      ...confineArgs,
      // The one writable filesystem besides the mounts, and it dies with the
      // container. `exec` is on because omp unpacks and runs native helpers
      // out of its own scratch; withholding it would break the binary without
      // bounding anything, since the agent can already run commands from the
      // workspace by design.
      "--tmpfs",
      `${this.#scratchRoot}:rw,exec,nosuid,nodev,size=1g,mode=1777`,
      "--volume",
      `${this.#workspace}:${this.#workspace}`,
      ...mountArgs,
      "--workdir",
      this.#workspace,
      ...env,
      image,
      "tail",
      "-f",
      "/dev/null",
    ]);
    if (created.code !== 0) {
      await this.#run([runtime, "network", "rm", network]).catch(() => undefined);
      throw new ProvisionError(
        `${runtime} run failed (exit ${created.code}): ${created.stderr.trim() || created.stdout.trim()}`,
        "container",
      );
    }

    const containerId = created.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!CONTAINER_ID.test(containerId)) {
      // Something is running that we cannot name, so it cannot be removed by
      // id. Removing the network it is attached to is the only handle left,
      // and it fails while the container holds it, which is the loud version
      // of this going wrong.
      await this.#run([runtime, "network", "rm", network]).catch(() => undefined);
      throw new ProvisionError(`${runtime} run returned no usable container id`, "container");
    }

    const scratch = `${this.#scratchRoot}/ompd-${containerId.slice(0, 12)}`;
    let wrapper: GateWrapper;
    try {
      await this.#prepareScratch(runtime, containerId, scratch);
      wrapper = writeGateWrapper({
        shell: [runtime, "exec", "-i", containerId],
        attach: [runtime, "exec", "-i", containerId, this.#remoteOmpPath],
        remoteConfigPath: `${scratch}/gate.yml`,
        label: `container ${containerId.slice(0, 12)}`,
        kind: "container",
      });
    } catch (err) {
      // The container exists but is unusable. Remove it here: a half-provisioned
      // container that nobody holds a handle to is never reclaimed. The network
      // goes with it, and only after it, because a network with a container
      // still attached cannot be removed.
      await this.#run([runtime, "rm", "--force", containerId]).catch(() => undefined);
      await this.#run([runtime, "network", "rm", network]).catch(() => undefined);
      throw err instanceof ProvisionError
        ? err
        : new ProvisionError(`container ${containerId} could not be prepared: ${String(err)}`, "container", {
            cause: err,
          });
    }

    this.#live.set(containerId, { runtime, containerId, network, wrapper });
    const spawn = this.#spawn;
    return {
      // Mounts are normalized (default mode filled in) so an operator reading
      // this ref back sees exactly what the container can see, not merely
      // what they happened to type.
      ref: { kind: "container", id: containerId, spec: { ...spec, mounts } },
      // `ompPath` is overridden rather than merged: the caller's omp path is a
      // path on the daemon's machine and means nothing inside the container.
      spawn: (opts: SpawnLocalHostOptions): LocalHost => spawn({ ...opts, ompPath: wrapper.path }),
    };
  }

  async destroy(handle: HostHandle): Promise<void> {
    const record = this.#live.get(handle.ref.id);
    if (record === undefined) {
      throw new ProvisionError(`unknown container handle ${handle.ref.id}`, "container");
    }
    this.#live.delete(record.containerId);
    try {
      rmSync(record.wrapper.dir, { recursive: true, force: true });
    } catch {
      // Best effort. A leftover script in the temp dir is litter, not a risk.
    }
    const removed = await this.#run([record.runtime, "rm", "--force", record.containerId]);
    // The network is removed whether or not the container went cleanly, and
    // always after it: docker refuses to remove a network something is still
    // attached to. A leftover empty network is litter rather than a risk, so
    // its failure is logged by the caller's audit entry, not thrown here.
    await this.#run([record.runtime, "network", "rm", record.network]).catch(() => undefined);
    if (removed.code !== 0) {
      throw new ProvisionError(
        `${record.runtime} rm failed (exit ${removed.code}): ${removed.stderr.trim()}`,
        "container",
      );
    }
  }

  async #prepareScratch(runtime: string, containerId: string, scratch: string): Promise<void> {
    // A private directory created before the overlay is copied, so the copy
    // never lands somewhere another process in the image could have prepared.
    const made = await this.#run([runtime, "exec", containerId, "mkdir", "-p", scratch]);
    if (made.code !== 0) {
      throw new ProvisionError(
        `could not create ${scratch} in ${containerId}: ${made.stderr.trim()}`,
        "container",
      );
    }
    const locked = await this.#run([runtime, "exec", containerId, "chmod", "700", scratch]);
    if (locked.code !== 0) {
      throw new ProvisionError(
        `could not lock down ${scratch} in ${containerId}: ${locked.stderr.trim()}`,
        "container",
      );
    }
  }
}
