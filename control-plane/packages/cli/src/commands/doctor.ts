/**
 * `ompd doctor`: one command that answers "is this set up correctly".
 *
 * This is the command someone runs when something is wrong, which makes its
 * output the whole feature. A check that reports `fail` and leaves the reader
 * to work out the next move has done half a job, so every non-ok line carries
 * the command that fixes it. Nothing here mutates anything.
 *
 * The severities mean different things and the exit code respects that. A
 * `fail` is something that is broken now: no daemon, a token the daemon
 * rejects, a login agent pointing at a path that no longer exists. A `warn` is
 * a capability that is absent rather than broken, like having no container
 * runtime installed, and does not make the exit code non-zero. Reporting a
 * missing optional as a failure would train the reader to ignore the exit code.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTAINER_RUNTIMES, loadConfig, OMPD_VERSION } from "@ompd/daemon";
import { resolveBaseUrl, resolveToken, type CliContext } from "../client.ts";
import { BINARY_NAME, findOnPath } from "../install.ts";
import { PLIST_MARKER, plistPath, plistProgram } from "./service.ts";

type Severity = "ok" | "warn" | "fail";

interface Check {
  label: string;
  severity: Severity;
  detail: string;
  /** Printed under the detail for anything not ok. Says what to run. */
  advice?: string[];
}

interface HealthResponse {
  ok?: boolean;
  version?: string;
}

export async function doctorCommand(ctx: CliContext): Promise<number> {
  const checks: Check[] = [];

  const binary = await binaryCheck(ctx);
  checks.push(binary.check);

  const daemon = await daemonCheck(ctx);
  checks.push(daemon.check);
  checks.push(versionCheck(binary.version, daemon.version));
  checks.push(await tokenCheck(ctx, daemon.reachable));
  checks.push(loginAgentCheck(ctx));
  checks.push(stateCheck(ctx));
  checks.push(await runtimeCheck(ctx));
  checks.push(awakeCheck(ctx));

  const width = checks.reduce((widest, check) => Math.max(widest, check.label.length), 0);
  for (const check of checks) {
    ctx.out(`${MARK[check.severity]} ${check.label.padEnd(width)}  ${check.detail}`);
    // Aligned under the detail, not under the mark: the advice belongs to the
    // line above it, and a ragged left edge is what makes a wall of checks
    // unreadable at the moment someone needs to read it.
    for (const line of check.advice ?? []) ctx.out(`${" ".repeat(width + 7)}${line}`);
  }

  const failed = checks.filter((check) => check.severity === "fail").length;
  const warned = checks.filter((check) => check.severity === "warn").length;

  ctx.out("");
  if (failed === 0 && warned === 0) {
    ctx.out(`all ${checks.length} checks passed`);
    return 0;
  }
  ctx.out(
    `${checks.length - failed - warned} ok, ${warned} to look at, ${failed} broken`,
  );
  return failed === 0 ? 0 : 1;
}

const MARK: Record<Severity, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

interface BinaryCheck {
  check: Check;
  /** Version the installed binary reports, or null when there is none. */
  version: string | null;
}

/**
 * Is `ompd` a command on this machine.
 *
 * Resolved by walking `PATH` rather than shelling out to `which`, so the
 * answer comes from the same environment the CLI was handed and a test can set
 * it. The binary is then run for its version, because a file on `PATH` that
 * cannot execute is worse than one that is missing.
 */
async function binaryCheck(ctx: CliContext): Promise<BinaryCheck> {
  const found = findOnPath(ctx.env, BINARY_NAME);
  if (found === null) {
    return {
      version: null,
      check: {
        label: "binary",
        severity: "fail",
        detail: `no ${BINARY_NAME} on PATH; every documented command starts with it`,
        advice: ["run: bun run build:cli && bun packages/cli/src/main.ts self-install"],
      },
    };
  }

  let reported = "";
  let failure = "";
  try {
    const result = await ctx.exec([found, "--version"]);
    if (result.code === 0) reported = result.stdout.trim();
    else failure = result.stderr.trim() || `exit ${result.code}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  if (reported.length === 0) {
    return {
      version: null,
      check: {
        label: "binary",
        severity: "fail",
        detail: `${found} is on PATH but did not report a version: ${failure || "empty output"}`,
        advice: ["it is stale, truncated, or not ompd", "run: ompd self-install"],
      },
    };
  }

  return {
    version: reported,
    check: { label: "binary", severity: "ok", detail: `${found} (${reported})` },
  };
}

interface DaemonCheck {
  check: Check;
  reachable: boolean;
  version: string | null;
}

async function daemonCheck(ctx: CliContext): Promise<DaemonCheck> {
  const base = resolveBaseUrl(ctx);

  let health: HealthResponse | null = null;
  try {
    const response = await ctx.fetch(`${base}/v1/health`);
    if (response.ok) health = (await response.json()) as HealthResponse;
  } catch {
    health = null;
  }

  if (health === null) {
    return {
      reachable: false,
      version: null,
      check: {
        label: "daemon",
        severity: "fail",
        detail: `nothing answered ${base}/v1/health`,
        advice: [
          "run: ompd start",
          "already running elsewhere? point this shell at it with OMPD_URL",
        ],
      },
    };
  }

  return {
    reachable: true,
    version: health.version ?? null,
    check: {
      label: "daemon",
      severity: "ok",
      detail: `running at ${base} (${health.version ?? "version unknown"})`,
    },
  };
}

/**
 * Do the three versions in play agree.
 *
 * There are three, not two: the code running this command, the binary on
 * `PATH`, and the daemon that is answering. They disagree in exactly the
 * situation this is here to catch, which is an upgrade that only landed in
 * some of them. A mismatch is stale rather than broken, so it warns, and the
 * advice is the pair of commands that make all three agree.
 */
function versionCheck(binary: string | null, daemon: string | null): Check {
  const holders: Array<[string, string]> = [["cli", OMPD_VERSION]];
  if (binary !== null) holders.push(["binary", binary]);
  if (daemon !== null) holders.push(["daemon", daemon]);

  const byVersion = new Map<string, string[]>();
  for (const [who, version] of holders) {
    byVersion.set(version, [...(byVersion.get(version) ?? []), who]);
  }

  if (holders.length === 1) {
    return {
      label: "versions",
      severity: "ok",
      detail: `cli ${OMPD_VERSION}; nothing else was reachable to compare against`,
    };
  }
  if (byVersion.size === 1) {
    return {
      label: "versions",
      severity: "ok",
      detail: `${holders.map(([who]) => who).join(", ")} all on ${OMPD_VERSION}`,
    };
  }

  return {
    label: "versions",
    severity: "warn",
    detail: [...byVersion].map(([version, who]) => `${who.join(" and ")} ${version}`).join(", "),
    advice: [
      "an upgrade landed in some of them and not the others",
      "run: ompd self-install, then ompd install to restart the login agent",
    ],
  };
}

async function tokenCheck(ctx: CliContext, daemonReachable: boolean): Promise<Check> {
  const token = resolveToken(ctx);
  if (token === null) {
    return {
      label: "token",
      severity: "fail",
      detail: `no token in ${join(ctx.home, "token")} and OMPD_TOKEN is unset`,
      advice: ["run: ompd start (a first start mints the local operator token)"],
    };
  }

  const source = ctx.env.OMPD_TOKEN === undefined ? join(ctx.home, "token") : "OMPD_TOKEN";
  if (!daemonReachable) {
    return { label: "token", severity: "warn", detail: `present at ${source}; no daemon to check it against` };
  }

  let status = 0;
  try {
    const response = await ctx.fetch(`${resolveBaseUrl(ctx)}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    status = response.status;
  } catch {
    return { label: "token", severity: "fail", detail: "the daemon stopped answering mid-check" };
  }

  if (status === 200) {
    return { label: "token", severity: "ok", detail: `authenticates against the daemon (${source})` };
  }
  return {
    label: "token",
    severity: "fail",
    detail: `the daemon rejected the token at ${source} (HTTP ${status})`,
    advice: [
      "it was revoked, rotated, or belongs to another daemon",
      "run: ompd rotate, or pair this shell with ompd pair <name>",
    ],
  };
}

/**
 * Is there a login agent, and will it still start anything.
 *
 * The second half is the point. A plist naming a path that has since been
 * deleted loads without complaint and fails at every login with nothing on
 * screen, which is the exact failure this release exists to prevent.
 */
function loginAgentCheck(ctx: CliContext): Check {
  const path = plistPath(ctx);
  if (!existsSync(path)) {
    return {
      label: "login agent",
      severity: "warn",
      detail: "not installed; the daemon will not start at login",
      advice: ["run: ompd install"],
    };
  }

  const contents = readFileSync(path, "utf8");
  if (!contents.includes(`<key>${PLIST_MARKER}</key>`)) {
    return {
      label: "login agent",
      severity: "warn",
      detail: `${path} exists and ompd did not write it`,
      advice: ["ompd will not touch it; move it aside first if it should be ours"],
    };
  }

  const program = plistProgram(contents);
  if (program === null) {
    return {
      label: "login agent",
      severity: "warn",
      detail: `${path} predates the program record`,
      advice: ["run: ompd install (rewrites it)"],
    };
  }
  if (!existsSync(program)) {
    return {
      label: "login agent",
      severity: "fail",
      detail: `installed, but it runs ${program}, which no longer exists`,
      advice: [
        "every login since that path went away has failed silently",
        "run: ompd self-install && ompd install",
      ],
    };
  }

  return { label: "login agent", severity: "ok", detail: `installed, runs ${program}` };
}

/**
 * The state directory and the credential inside it.
 *
 * `~/.ompd` is created 0700 and the token 0600, but a mode is only worth
 * checking after the fact: an editor, a backup restore, or a `cp -r` can
 * relax either without anyone noticing.
 */
function stateCheck(ctx: CliContext): Check {
  if (!existsSync(ctx.home)) {
    return {
      label: "state dir",
      severity: "warn",
      detail: `${ctx.home} does not exist yet`,
      advice: ["run: ompd start (a first start creates it 0700)"],
    };
  }

  const dirMode = statSync(ctx.home).mode & 0o777;
  const tokenPath = join(ctx.home, "token");
  const tokenMode = existsSync(tokenPath) ? statSync(tokenPath).mode & 0o777 : null;

  const problems: string[] = [];
  if (dirMode !== 0o700) problems.push(`run: chmod 700 ${ctx.home}`);
  if (tokenMode !== null && tokenMode !== 0o600) problems.push(`run: chmod 600 ${tokenPath}`);

  const modes = `${ctx.home} ${dirMode.toString(8).padStart(3, "0")}${
    tokenMode === null ? "" : `, token ${tokenMode.toString(8).padStart(3, "0")}`
  }`;

  if (problems.length > 0) {
    return { label: "state dir", severity: "fail", detail: `${modes} (too permissive)`, advice: problems };
  }
  return { label: "state dir", severity: "ok", detail: modes };
}

/**
 * Which container runtimes the provisioner would find.
 *
 * Every one of them, not the first, because "docker is installed but you also
 * have podman" is a thing worth seeing here. Absent entirely is a warn: local
 * hosts still work, container hosts do not.
 */
async function runtimeCheck(ctx: CliContext): Promise<Check> {
  const probes = await Promise.all(
    CONTAINER_RUNTIMES.map(async (runtime) => {
      try {
        const result = await ctx.exec([runtime, "--version"]);
        return result.code === 0 ? runtime : null;
      } catch {
        // Bun throws for a missing binary rather than exiting non-zero, so
        // this is the ordinary "not installed" path, not an error.
        return null;
      }
    }),
  );

  const found = probes.filter((runtime): runtime is string => runtime !== null);
  if (found.length === 0) {
    return {
      label: "containers",
      severity: "warn",
      detail: `none of ${CONTAINER_RUNTIMES.join(", ")} answered --version`,
      advice: ["local hosts still work; container hosts need one of those installed"],
    };
  }
  return { label: "containers", severity: "ok", detail: found.join(", ") };
}

/**
 * Whether a turn started from a phone will survive the Mac going idle.
 *
 * Read from the config on disk rather than asked of the daemon: the answer is
 * still useful when the daemon is down, which is when someone is most likely
 * to be running this.
 */
function awakeCheck(ctx: CliContext): Check {
  let keepAwake: boolean;
  try {
    keepAwake = loadConfig(ctx.home).keepAwake;
  } catch (err) {
    return {
      label: "stay awake",
      severity: "fail",
      detail: `${join(ctx.home, "config.json")} is not loadable: ${err instanceof Error ? err.message : err}`,
      advice: ["fix or delete that file; every default is the conservative one"],
    };
  }

  if (!keepAwake) {
    return {
      label: "stay awake",
      severity: "warn",
      detail: "keepAwake is off; idle sleep can kill a turn that is still running",
      advice: [`set "keepAwake": true in ${join(ctx.home, "config.json")} to hold work awake`],
    };
  }
  return {
    label: "stay awake",
    severity: "ok",
    detail: "the daemon holds an idle-sleep assertion while an agent is working",
  };
}
