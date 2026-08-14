/**
 * The provisioner decides where an agent's code runs. Two properties matter
 * more than the rest, and both are written here to fail loudly if they regress.
 *
 * 1. A host kind is served by its own backend or not at all. An operator who
 *    asks for a container or a cloud machine and silently gets a process on the
 *    laptop has lost the isolation they asked for with no way to notice.
 * 2. A remote host keeps the approval gate. `spawnLocalHost` writes the overlay
 *    and passes `--config` itself; the backend only points it at a wrapper that
 *    carries that exact file to the far side and refuses to start anything if
 *    it cannot.
 *
 * Every subprocess and network call is mocked: the container runtime and ssh
 * are a `CommandRunner` the test supplies, and the host factory is a stub. No
 * process is launched from this file, so the gate assertions below inspect the
 * seam and the generated script rather than running it. Executing the wrapper
 * against a live runtime belongs in the opt-in live lane.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { AcpClient, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";
import { Store, type HostKind, type HostMount, type HostSpec } from "@ompd/core";
import {
  CloudBackend,
  ContainerBackend,
  detectContainerRuntime,
  HostProvisioner,
  LocalBackend,
  ProvisionError,
  renderGateWrapper,
  type CloudDriver,
  type CloudMachine,
  type CommandRunner,
  type HostHandle,
  type ProvisionerBackend,
  type SpawnHost,
} from "../src/provisioner/index.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
const closables: HostProvisioner[] = [];

afterEach(async () => {
  while (closables.length) await closables.pop()?.close().catch(() => undefined);
  while (cleanups.length) cleanups.pop()?.();
});

function tempStore(): Store {
  const path = `/tmp/ompd-prov-${crypto.randomUUID()}.db`;
  const store = new Store(path);
  cleanups.push(() => {
    store.close();
    rmSync(path, { force: true });
  });
  return store;
}

/** A `LocalHost` that records kills instead of owning a process. */
class StubHost implements LocalHost {
  client: AcpClient;
  pid = 4242;
  exited: Promise<number>;
  killCount = 0;

  #exit: (code: number) => void;

  constructor() {
    const { promise, resolve } = Promise.withResolvers<number>();
    this.exited = promise;
    this.#exit = resolve;
    this.client = new AcpClient(() => {}, {
      onPermission: async () => "reject_once",
      onElicitation: async () => ({ action: "decline" as const }),
    });
  }

  kill(): void {
    this.killCount += 1;
    this.#exit(0);
  }
}

interface SpawnRecorder {
  spawn: SpawnHost;
  hosts: StubHost[];
  opts: SpawnLocalHostOptions[];
}

function spawnRecorder(): SpawnRecorder {
  const hosts: StubHost[] = [];
  const opts: SpawnLocalHostOptions[] = [];
  return {
    hosts,
    opts,
    spawn: (o) => {
      opts.push(o);
      const host = new StubHost();
      hosts.push(host);
      return host;
    },
  };
}

/**
 * Both callbacks are required by `AcpClientOptions`; no stub host uses either.
 * They decline rather than accept, which is what a client that never
 * advertised the capability produces, so pointing a real host at this fake
 * can never turn into an accidental allow.
 */
const SPAWN_OPTS: SpawnLocalHostOptions = {
  onPermission: async () => "reject_once",
  onElicitation: async () => ({ action: "decline" as const }),
};

/** Wraps a real backend so dispatch can be asserted exactly. */
class RecordingBackend implements ProvisionerBackend {
  readonly kind: HostKind;
  provisioned: HostSpec[] = [];
  destroyed: string[] = [];

  #inner: ProvisionerBackend;

  constructor(kind: HostKind, inner: ProvisionerBackend) {
    this.kind = kind;
    this.#inner = inner;
  }

  async provision(spec: HostSpec): Promise<HostHandle> {
    this.provisioned.push(spec);
    return this.#inner.provision(spec);
  }

  async destroy(handle: HostHandle): Promise<void> {
    this.destroyed.push(handle.ref.id);
    return this.#inner.destroy(handle);
  }
}

class FakeCloudDriver implements CloudDriver {
  readonly name = "fake";
  created: HostSpec[] = [];
  destroyed: string[] = [];
  failCreate: Error | null = null;
  /** Overrides the scratch dir of the next machine, to exercise bad input. */
  nextScratchDir: string | null = null;

  #machines = new Map<string, CloudMachine>();

  async create(spec: HostSpec): Promise<CloudMachine> {
    if (this.failCreate !== null) throw this.failCreate;
    this.created.push(spec);
    const id = `mch_${this.created.length}`;
    const machine: CloudMachine = {
      id,
      scratchDir: this.nextScratchDir ?? `/tmp/ompd-${id}`,
      shellArgv: ["ssh", "-T", "build-01"],
      attachArgv: ["ssh", "-T", "build-01", "omp"],
    };
    this.nextScratchDir = null;
    this.#machines.set(id, machine);
    return machine;
  }

  async destroy(id: string): Promise<void> {
    this.destroyed.push(id);
    this.#machines.delete(id);
  }

  async list(): Promise<CloudMachine[]> {
    return [...this.#machines.values()];
  }
}

interface ContainerRunner {
  run: CommandRunner;
  calls: string[][];
}

/** Stands in for a container runtime. Nothing is executed. */
function containerRunner(containerId: string): ContainerRunner {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push([...argv]);
    if (argv[1] === "run") return { code: 0, stdout: `${containerId}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  test("each kind is served by its own backend and no other", async () => {
    const store = tempStore();
    const recorder = spawnRecorder();
    const driver = new FakeCloudDriver();
    const local = new RecordingBackend("local", new LocalBackend({ spawn: recorder.spawn }));
    const container = new RecordingBackend(
      "container",
      new ContainerBackend({
        runtime: "docker",
        run: containerRunner("cnt000000001").run,
        spawn: recorder.spawn,
      }),
    );
    const cloud = new RecordingBackend("cloud", new CloudBackend({ driver, spawn: recorder.spawn }));
    const prov = new HostProvisioner({ store, backends: { local, container, cloud } });
    closables.push(prov);

    const localHost = await prov.provision({ kind: "local" });
    expect(localHost.ref.kind).toBe("local");
    expect(local.provisioned).toHaveLength(1);
    expect(container.provisioned).toHaveLength(0);
    expect(cloud.provisioned).toHaveLength(0);

    const containerHost = await prov.provision({
      kind: "container",
      image: "example.invalid/omp:1",
    });
    expect(containerHost.ref.kind).toBe("container");
    expect(containerHost.ref.id).toBe("cnt000000001");
    expect(container.provisioned).toHaveLength(1);
    expect(local.provisioned).toHaveLength(1);

    const cloudHost = await prov.provision({ kind: "cloud" });
    expect(cloudHost.ref.kind).toBe("cloud");
    expect(driver.created).toHaveLength(1);
    expect(local.provisioned).toHaveLength(1);
    expect(container.provisioned).toHaveLength(1);

    expect((await prov.list()).map((h) => h.ref.kind).sort()).toEqual([
      "cloud",
      "container",
      "local",
    ]);
  });

  test("an unknown kind fails and never falls back to local", async () => {
    const store = tempStore();
    const recorder = spawnRecorder();
    const local = new RecordingBackend("local", new LocalBackend({ spawn: recorder.spawn }));
    const prov = new HostProvisioner({ store, backends: { local } });
    closables.push(prov);

    await expect(prov.provision({ kind: "quantum" as HostKind })).rejects.toThrow(ProvisionError);

    expect(local.provisioned).toHaveLength(0);
    expect(recorder.hosts).toHaveLength(0);
    expect(await prov.list()).toHaveLength(0);

    const failures = store.listAudit().filter((e) => e.action === "host.provision");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.outcome).toBe("error");
    expect(failures[0]?.detail.kind).toBe("quantum");
  });

  test("cloud without a configured driver fails rather than running locally", async () => {
    const store = tempStore();
    const recorder = spawnRecorder();
    const local = new RecordingBackend("local", new LocalBackend({ spawn: recorder.spawn }));
    const prov = new HostProvisioner({ store, backends: { local } });
    closables.push(prov);

    await expect(prov.provision({ kind: "cloud", ttlSeconds: 60 })).rejects.toThrow(
      /no backend for host kind "cloud"/,
    );
    expect(local.provisioned).toHaveLength(0);
    expect(await prov.list()).toHaveLength(0);
  });

  test("a driver failure surfaces as ProvisionError and tracks nothing", async () => {
    const store = tempStore();
    const driver = new FakeCloudDriver();
    driver.failCreate = new Error("capacity api returned 503");
    const prov = new HostProvisioner({ store, backends: { cloud: new CloudBackend({ driver }) } });
    closables.push(prov);

    await expect(prov.provision({ kind: "cloud" })).rejects.toThrow(ProvisionError);
    await expect(prov.provision({ kind: "cloud" })).rejects.toThrow(/503/);

    expect(await prov.list()).toHaveLength(0);
    const entries = store.listAudit().filter((e) => e.action === "host.provision");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.outcome === "error")).toBe(true);
  });

  test("a machine that cannot be prepared is handed back, not leaked", async () => {
    const store = tempStore();
    const driver = new FakeCloudDriver();
    // A scratch path the wrapper generator must refuse rather than escape.
    driver.nextScratchDir = "/tmp/ompd-'; rm -rf /";
    const prov = new HostProvisioner({ store, backends: { cloud: new CloudBackend({ driver }) } });
    closables.push(prov);

    await expect(prov.provision({ kind: "cloud" })).rejects.toThrow(ProvisionError);
    expect(driver.created).toHaveLength(1);
    expect(driver.destroyed).toEqual(["mch_1"]);
    expect(await prov.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

describe("lifetime", () => {
  test("destroy is idempotent", async () => {
    const store = tempStore();
    const driver = new FakeCloudDriver();
    const cloud = new RecordingBackend("cloud", new CloudBackend({ driver }));
    const prov = new HostProvisioner({ store, backends: { cloud } });
    closables.push(prov);

    const handle = await prov.provision({ kind: "cloud" });
    await prov.destroy(handle.ref.id);
    await prov.destroy(handle.ref.id);
    await prov.destroy("mch_never_existed");

    expect(cloud.destroyed).toEqual([handle.ref.id]);
    expect(driver.destroyed).toEqual([handle.ref.id]);
    expect(await prov.list()).toHaveLength(0);
    expect(store.listAudit().filter((e) => e.action === "host.destroy")).toHaveLength(1);
  });

  test("destroy kills every connection it handed out", async () => {
    const store = tempStore();
    const recorder = spawnRecorder();
    const driver = new FakeCloudDriver();
    const prov = new HostProvisioner({
      store,
      backends: { cloud: new CloudBackend({ driver, spawn: recorder.spawn }) },
    });
    closables.push(prov);

    const handle = await prov.provision({ kind: "cloud" });
    handle.spawn(SPAWN_OPTS);
    handle.spawn(SPAWN_OPTS);
    expect(recorder.hosts).toHaveLength(2);

    await prov.destroy(handle.ref.id);
    expect(recorder.hosts.map((h) => h.killCount)).toEqual([1, 1]);
    expect(() => handle.spawn(SPAWN_OPTS)).toThrow(ProvisionError);
  });

  /**
   * Time is injected, so nothing here waits on the wall clock. The only signal
   * awaited is a connection's `exited`, which the sweep resolves when it kills
   * the host. A tripwire host with a shorter TTL proves a sweep ran at a given
   * clock value, so "still alive" is asserted against an observed sweep rather
   * than a guessed delay.
   */
  test("a ttl host is destroyed once idle, and one without a ttl is left alone", async () => {
    const store = tempStore();
    const recorder = spawnRecorder();
    const driver = new FakeCloudDriver();
    let clock = 1_000_000;
    const prov = new HostProvisioner({
      store,
      backends: { cloud: new CloudBackend({ driver, spawn: recorder.spawn }) },
      sweepIntervalMs: 1,
      now: () => clock,
    });
    closables.push(prov);

    const permanent = await prov.provision({ kind: "cloud" });
    const jit = await prov.provision({ kind: "cloud", ttlSeconds: 60 });
    jit.spawn(SPAWN_OPTS);

    // Use inside the window renews the lease, so the clock passes 60s of age
    // without the host ever having been idle that long.
    clock += 40_000;
    const renewal = jit.spawn(SPAWN_OPTS);
    const tripwire = await prov.provision({ kind: "cloud", ttlSeconds: 1 });
    const tripwireConnection = tripwire.spawn(SPAWN_OPTS);

    clock += 40_000;
    await tripwireConnection.exited;

    // The sweep that reaped the tripwire walked the same map in the same tick.
    // A TTL measured from creation rather than last use would have taken the
    // jit host with it: it is 80s old and 40s idle.
    expect(driver.destroyed).toEqual([tripwire.ref.id]);
    expect((await prov.list()).map((h) => h.ref.id).sort()).toEqual(
      [permanent.ref.id, jit.ref.id].sort(),
    );

    clock += 60_001;
    await renewal.exited;

    expect(driver.destroyed).toEqual([tripwire.ref.id, jit.ref.id]);
    expect((await prov.list()).map((h) => h.ref.id)).toEqual([permanent.ref.id]);
    expect(() => jit.spawn(SPAWN_OPTS)).toThrow(ProvisionError);
    expect(recorder.hosts.every((h) => h.killCount === 1)).toBe(true);

    // A sweep's teardown finishes after the connection dies, so drain it
    // before reading the trail it writes. `close` is what waits on it.
    await prov.close();
    const destroys = store
      .listAudit()
      .filter((e) => e.action === "host.destroy" && e.detail.reason === "ttl");
    expect(destroys).toHaveLength(2);
    expect(destroys.map((e) => e.detail.hostId).sort()).toEqual(
      [jit.ref.id, tripwire.ref.id].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

describe("detectContainerRuntime", () => {
  test("returns null when nothing is installed", async () => {
    const probed: string[] = [];
    const run: CommandRunner = async (argv) => {
      probed.push(argv[0] ?? "");
      // A missing binary throws; an installed one that cannot answer exits non-zero.
      if (argv[0] === "podman") return { code: 127, stdout: "", stderr: "broken" };
      throw new ProvisionError(`${argv[0]} could not be started`);
    };

    expect(await detectContainerRuntime(run)).toBeNull();
    expect(probed).toEqual(["docker", "podman", "container"]);
  });

  test("returns the first runtime that answers, in probe order", async () => {
    const run: CommandRunner = async (argv) => {
      if (argv[0] === "docker") throw new ProvisionError("no docker here");
      return { code: 0, stdout: `${argv[0]} version 1.0\n`, stderr: "" };
    };
    expect(await detectContainerRuntime(run)).toBe("podman");
  });

  test("provisioning fails when no runtime is installed", async () => {
    const attempted: string[][] = [];
    const run: CommandRunner = async (argv) => {
      attempted.push([...argv]);
      throw new ProvisionError("not installed");
    };
    const backend = new ContainerBackend({ run });

    await expect(backend.provision({ kind: "container" })).rejects.toThrow(/no container runtime/);
    // Probes only. Nothing was created, so nothing needs reclaiming.
    expect(attempted.every((argv) => argv[1] === "--version")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The approval gate on a remote host
// ---------------------------------------------------------------------------

describe("container hosts keep the approval gate", () => {
  const CONTAINER_ID = "abcdef012345";
  const REMOTE_CONFIG = `/far/ompd-${CONTAINER_ID}/gate.yml`;

  interface GateHarness {
    backend: ContainerBackend;
    recorder: SpawnRecorder;
    calls: string[][];
  }

  function harness(): GateHarness {
    const recorder = spawnRecorder();
    const runner = containerRunner(CONTAINER_ID);
    return {
      recorder,
      calls: runner.calls,
      backend: new ContainerBackend({
        runtime: "docker",
        remoteOmpPath: "/usr/local/bin/omp",
        scratchRoot: "/far",
        run: runner.run,
        spawn: recorder.spawn,
      }),
    };
  }

  test("the overlay stays spawnLocalHost's job: the backend only supplies a wrapper", async () => {
    const gate = harness();
    const handle = await gate.backend.provision({ kind: "container" });
    handle.spawn(SPAWN_OPTS);

    const wrapper = gate.recorder.opts[0]?.ompPath ?? "";
    expect(wrapper).toMatch(/omp-wrapper\.sh$/);
    // Private and executable, like the overlay it carries.
    expect(statSync(wrapper).mode & 0o777).toBe(0o700);

    // ompd passes no approval arguments of its own. spawnLocalHost rejects
    // these outright, so adding one would fail closed, but it must never be
    // attempted: the gate belongs to spawnLocalHost, whole.
    expect(gate.recorder.opts[0]?.extraArgs).toBeUndefined();
    const script = readFileSync(wrapper, "utf8");
    expect(script).not.toMatch(/--approval-mode|--yolo|--auto-approve/);

    await gate.backend.destroy(handle);
  });

  test("the wrapper refuses to start a host with no overlay", async () => {
    const gate = harness();
    const handle = await gate.backend.provision({ kind: "container" });
    handle.spawn(SPAWN_OPTS);
    const script = readFileSync(gate.recorder.opts[0]?.ompPath ?? "", "utf8");

    // No --config reaching the far side means the host would inherit the
    // operator's global config, and a global `approvalMode: yolo` never asks.
    expect(script).toContain(
      `[ -n "$config" ] || fail 'refusing to start an ACP host with no --config overlay'`,
    );
    expect(script).toContain("exit 78");

    await gate.backend.destroy(handle);
  });

  test("the wrapper carries, locks, and verifies the overlay before exec", async () => {
    const gate = harness();
    const handle = await gate.backend.provision({ kind: "container" });
    handle.spawn(SPAWN_OPTS);
    const script = readFileSync(gate.recorder.opts[0]?.ompPath ?? "", "utf8");

    const exec = `docker exec -i ${CONTAINER_ID}`;
    expect(script).toContain(`${exec} tee '${REMOTE_CONFIG}' < "$config" > /dev/null || fail`);
    expect(script).toContain(`${exec} chmod 600 '${REMOTE_CONFIG}' < /dev/null > /dev/null || fail`);
    // The verify step is what turns a partial or missing copy into a refusal.
    expect(script).toContain(
      `${exec} cat '${REMOTE_CONFIG}' < /dev/null | cmp -s - "$config" || fail`,
    );
    // The rewritten flag, and only then the far-side omp.
    expect(script).toContain(`set -- "$@" --config '${REMOTE_CONFIG}'`);
    expect(script).toContain(`exec ${exec} /usr/local/bin/omp "$@"`);

    // The scratch directory is created and locked down before any of that.
    expect(gate.calls).toContainEqual([
      "docker",
      "exec",
      CONTAINER_ID,
      "mkdir",
      "-p",
      `/far/ompd-${CONTAINER_ID}`,
    ]);
    expect(gate.calls).toContainEqual([
      "docker",
      "exec",
      CONTAINER_ID,
      "chmod",
      "700",
      `/far/ompd-${CONTAINER_ID}`,
    ]);

    await gate.backend.destroy(handle);
  });

  test("destroying a container removes both the container and its wrapper", async () => {
    const gate = harness();
    const handle = await gate.backend.provision({ kind: "container" });
    handle.spawn(SPAWN_OPTS);
    const wrapper = gate.recorder.opts[0]?.ompPath ?? "";

    await gate.backend.destroy(handle);

    expect(gate.calls).toContainEqual(["docker", "rm", "--force", CONTAINER_ID]);
    expect(() => statSync(wrapper)).toThrow();
    await expect(gate.backend.destroy(handle)).rejects.toThrow(ProvisionError);
  });

  test("the wrapper refuses hostile tokens instead of escaping them", () => {
    expect(() =>
      renderGateWrapper({
        shell: ["ssh", "-T", "host; rm -rf /"],
        attach: ["ssh", "-T", "host", "omp"],
        remoteConfigPath: "/tmp/ompd-x/gate.yml",
        label: "cloud x",
        kind: "cloud",
      }),
    ).toThrow(ProvisionError);

    expect(() =>
      renderGateWrapper({
        shell: ["ssh", "-T", "host"],
        attach: ["ssh", "-T", "host", "omp"],
        remoteConfigPath: "/tmp/ompd-x/gate.yml; cat /etc/shadow",
        label: "cloud x",
        kind: "cloud",
      }),
    ).toThrow(ProvisionError);
  });
});

// ---------------------------------------------------------------------------
// Runtime-shaped confinement flags
// ---------------------------------------------------------------------------

describe("the run command is shaped per runtime, not assumed docker", () => {
  function runArgvFor(runtime: string): Promise<string[]> {
    const runner = containerRunner("cnt000000001");
    const backend = new ContainerBackend({ runtime, run: runner.run });
    return backend.provision({ kind: "container" }).then(() => {
      const run = runner.calls.find((argv) => argv[1] === "run");
      if (run === undefined) throw new Error("no run call recorded");
      return run;
    });
  }

  test("docker gets every one of the four confinement flags", async () => {
    const argv = await runArgvFor("docker");
    expect(argv).toContain("--cap-drop");
    expect(argv).toContain("--security-opt");
    expect(argv).toContain("no-new-privileges:true");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--pids-limit");
  });

  test("podman is docker-shaped too, verified against podman 4.8.2 on this machine", async () => {
    // orbctl used to be asserted here and should never have been: it manages
    // OrbStack Linux machines rather than containers, its `run` takes none of
    // these flags, and OrbStack's actual container surface is `docker`.
    const argv = await runArgvFor("podman");
    expect(argv).toContain("--cap-drop");
    expect(argv).toContain("--security-opt");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--pids-limit");
  });

  test("a runtime with no capability entry is refused rather than guessed at", async () => {
    // The property that makes the table trustworthy: an unknown runtime must not
    // silently inherit docker's shape, because that is how a confinement
    // guarantee gets claimed without ever being asked for.
    await expect(runArgvFor("orbctl")).rejects.toThrow();
  });

  test("Apple `container` never receives a flag its CLI rejects", async () => {
    const argv = await runArgvFor("container");
    expect(argv).not.toContain("--cap-drop");
    expect(argv).not.toContain("--security-opt");
    expect(argv).not.toContain("no-new-privileges:true");
    expect(argv).not.toContain("--read-only");
    expect(argv).not.toContain("--pids-limit");
    // What it does still receive: the flags verified to work against a real
    // 0.4.1 install.
    expect(argv).toContain("--tmpfs");
    expect(argv).toContain("--volume");
    expect(argv).toContain("--network");
    expect(argv).toContain("--workdir");
    expect(argv).toContain("--detach");
    expect(argv).toContain("--rm");
  });
});

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

describe("extra mounts", () => {
  function harnessWithMounts(home = "/home/operator/.ompd") {
    const runner = containerRunner("cnt000000001");
    return {
      runner,
      backend: new ContainerBackend({
        runtime: "docker",
        workspace: "/work/repo",
        home,
        run: runner.run,
      }),
    };
  }

  test("each mount lands at the identical absolute path inside, workspace included", async () => {
    const { backend, runner } = harnessWithMounts();
    await backend.provision({
      kind: "container",
      mounts: [{ hostPath: "/data/shared" }, { hostPath: "/opt/tools", mode: "rw" }],
    });
    const run = runner.calls.find((argv) => argv[1] === "run") ?? [];
    expect(run).toContain("--volume");
    expect(run).toContain("/work/repo:/work/repo");
    expect(run).toContain("/data/shared:/data/shared:ro");
    expect(run).toContain("/opt/tools:/opt/tools:rw");
  });

  test("read-only is the default; only an explicit mode opts into rw", async () => {
    const { backend, runner } = harnessWithMounts();
    const handle = await backend.provision({
      kind: "container",
      mounts: [{ hostPath: "/data/shared" }],
    });
    const run = runner.calls.find((argv) => argv[1] === "run") ?? [];
    expect(run).toContain("/data/shared:/data/shared:ro");
    expect(run).not.toContain("/data/shared:/data/shared:rw");
    // The effective set an operator reads back has the default filled in,
    // not merely what they typed.
    const mounts = handle.ref.spec.mounts ?? [];
    expect(mounts).toEqual([{ hostPath: "/data/shared", mode: "ro" }]);
  });

  test("omitting mounts leaves the workspace volume exactly as it was", async () => {
    const { backend, runner } = harnessWithMounts();
    await backend.provision({ kind: "container" });
    const run = runner.calls.find((argv) => argv[1] === "run") ?? [];
    // Same two tokens, same lack of a mode suffix, as every caller that never
    // asked for an extra mount relied on before this feature existed.
    const volIndex = run.indexOf("--volume");
    expect(run[volIndex + 1]).toBe("/work/repo:/work/repo");
  });

  interface RefusalCase {
    label: string;
    hostPath: string;
    /** Only the last case needs a home that does not itself match a static pattern. */
    home?: string;
  }

  const REFUSED: RefusalCase[] = [
    { label: "the filesystem root", hostPath: "/" },
    { label: "a home directory root", hostPath: "/Users/someoperator" },
    { label: "~/.ssh", hostPath: "/Users/someoperator/.ssh" },
    { label: "~/.omp", hostPath: "/Users/someoperator/.omp" },
    { label: "~/.ompd", hostPath: "/Users/someoperator/.ompd" },
    {
      // A custom OMPD_HOME that names neither `.omp` nor `.ompd`, so this can
      // only be caught by comparing against the daemon's actual configured
      // home, never by a static pattern -- proving that check runs at all.
      label: "the daemon's own configured state directory, wherever OMPD_HOME points",
      hostPath: "/opt/ompd-state/token",
      home: "/opt/ompd-state",
    },
  ];

  for (const { label, hostPath, home } of REFUSED) {
    test(`refuses to mount ${label}, and audits the refusal`, async () => {
      const store = tempStore();
      const runner = containerRunner("cnt000000001");
      const backend = new ContainerBackend({
        runtime: "docker",
        workspace: "/work/repo",
        home: home ?? "/home/operator/.ompd",
        run: runner.run,
      });
      const prov = new HostProvisioner({ store, backends: { container: backend } });
      closables.push(prov);

      await expect(
        prov.provision({ kind: "container", mounts: [{ hostPath }] }),
      ).rejects.toThrow(ProvisionError);

      // Refused before anything was created: no network or run call at all.
      expect(runner.calls).toHaveLength(0);

      const failures = store.listAudit().filter((e) => e.action === "host.provision");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.outcome).toBe("error");
      expect(String(failures[0]?.detail.reason)).toContain(hostPath);
    });
  }

  test("a relative mount path is refused rather than guessed at", async () => {
    const { backend } = harnessWithMounts();
    await expect(
      backend.provision({ kind: "container", mounts: [{ hostPath: "relative/dir" }] }),
    ).rejects.toThrow(/must be absolute/);
  });

  test("a mount outside every protected root is accepted as written", async () => {
    const mounts: HostMount[] = [{ hostPath: "/srv/build-cache", mode: "rw" }];
    const { backend } = harnessWithMounts();
    const handle = await backend.provision({ kind: "container", mounts });
    expect(handle.ref.spec.mounts).toEqual([{ hostPath: "/srv/build-cache", mode: "rw" }]);
  });
});
