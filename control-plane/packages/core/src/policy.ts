/**
 * The policy engine.
 *
 * `session/request_permission` is an enforcement *hook*. This is the policy. A
 * remote client's choice is evidence for a decision, never the decision itself:
 * the supervisor consults `evaluate()` first and may override any client reply.
 *
 * `evaluate()` is pure and total. It performs no I/O and must never throw --
 * the caller treats a throw as a denial, but relying on that would make the
 * failure mode silent, so every branch returns a decision explicitly.
 */

import {
  SCOPE_APPROVE,
  SCOPE_PROMPT,
  SCOPE_READ,
  type Policy,
  type PolicyContext,
  type PolicyDecision,
} from "./contracts.ts";

/**
 * Tools that only read. Cheap to allow so a phone is not a nag machine -- but
 * "read-only" is about the *filesystem*, not about secrecy. A read of
 * `~/.ssh/id_ed25519` is exfiltration, so these still pass the path checks.
 *
 * `webview_observe`/`webview_screenshot` join this table for the same reason
 * `read` does: neither mutates the page or anything on disk, so gating them
 * like a shell command would make a phone a nag machine for the one thing an
 * agent should be doing constantly -- looking. `webview_navigate`,
 * `webview_click`, and `webview_type` are deliberately absent: those are the
 * side effects `docs/browser.md` says must reach a human.
 */
const READ_ONLY_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  ls: true,
  list: true,
  lsp: true,
  todo: true,
  web_search: true,
  recall: true,
  reflect: true,
  webview_observe: true,
  webview_screenshot: true,
};

/** Tools with no filesystem reach at all; a path check is meaningless for them. */
const NON_FILESYSTEM_TOOLS: Record<string, true> = {
  todo: true,
  web_search: true,
  recall: true,
  reflect: true,
  webview_observe: true,
  webview_screenshot: true,
};

/**
 * Paths that are secret regardless of where the workspace is. Reading any of
 * these is escalation, so they are never on a fast path.
 */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /(^|\/)credentials(\.json)?$/,
  /(^|\/)\.config\/gh(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/,
  /(^|\/)\.omp\/agent\/agent\.db$/,
  /(^|\/)\.ompd(\/|$)/,
];

/**
 * Roots a container mount must never name, layered on top of
 * `SECRET_PATH_PATTERNS` rather than restating any of it.
 *
 * A mount is a much bigger door than a single gated tool call: everything
 * under it is visible to every tool at once, for as long as the container
 * runs, unfiltered by any decision `DefaultPolicy` makes afterward. So beyond
 * the credential files a read/write is denied from touching, a mount also
 * refuses filesystem and home-directory roots outright, and the whole `.omp`
 * state tree rather than only the credential DB inside it -- `agent.db` is
 * enough to gate one read, but not enough to hand the directory over whole.
 */
const DANGEROUS_MOUNT_ROOT_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/root\/?$/,
  /^\/(Users|home)\/[^/]+\/?$/,
  /(^|\/)\.omp(\/|$)/,
];

/**
 * Why `hostPath` must never be mounted whole into a container, or null when
 * it may be. `hostPath` is expected already resolved to absolute; a relative
 * path is the caller's bug, not something this function normalizes.
 */
export function dangerousMountReason(hostPath: string): string | null {
  const norm = hostPath.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  for (const pattern of DANGEROUS_MOUNT_ROOT_PATTERNS) {
    if (pattern.test(norm)) return `matches protected root ${pattern.source}`;
  }
  const secret = matchSecret(norm);
  if (secret !== null) return `matches secret path pattern ${secret}`;
  return null;
}

/**
 * Schemes the agent's WebView may load. Everything else is refused.
 *
 * `about:blank` is where a fresh sandbox starts. Beyond that, a driveable page
 * is a web page, and every other scheme a URL bar accepts is a way out of the
 * sandbox rather than a place to browse: `file:` reads the app's own container,
 * `tel:`/`sms:`/`mailto:` and any app scheme hand the request to another app
 * through the OS, and `javascript:` is script injection wearing a URL. None of
 * those are things an operator should be asked to approve, so they are refused
 * before an approval is ever raised.
 */
const DRIVEABLE_SCHEMES: Record<string, true> = { "http:": true, "https:": true };

/** Where a fresh sandbox starts, allowed without being a scheme anyone browses. */
const BLANK_PAGE = "about:blank";

/**
 * Why the WebView must not load `url`, or null when it may.
 *
 * Enforced twice on purpose, and the two are not redundant. This is the check
 * on a URL the agent supplied, and it runs before the operator is asked
 * anything. The other is the device's own `onShouldStartLoadWithRequest`, which
 * sees what this cannot: a redirect the page performed and a link the agent
 * clicked, neither of which passed through any tool call.
 */
export function undriveableUrlReason(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === BLANK_PAGE) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "not a URL";
  }
  if (DRIVEABLE_SCHEMES[parsed.protocol] !== true) return `scheme ${parsed.protocol} is not driveable`;
  // A URL with no host is not a page: `http:///etc/passwd` parses, and on some
  // platforms resolves to something local.
  if (parsed.hostname.length === 0) return "no host";
  return null;
}

/**
 * Commands that are never auto-allowed regardless of mode, because a mistake is
 * unrecoverable or exfiltrates credentials.
 */
const CRITICAL_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf]/,
  /\bmkfs(\.|\b)/,
  /\bdd\s+[^|]*\bof=\/dev\//,
  /\b(shutdown|reboot|halt)\b/,
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh/,
  /\bwget\b[^|]*\|\s*(ba)?sh/,
  /\bgit\s+push\b[^&;|]*--force(?!-with-lease)/,
  /\b(aws|gcloud|az)\s+.*\b(delete|destroy|rm)\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\bkubectl\s+delete\b/,
  /\.ssh\/|\bid_(rsa|ed25519)\b/,
  /\b(AWS_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN)\b/,
];

/** Split a shell line the way an operator reads it, not the way bash parses it. */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n|(?<!&)&(?!&)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface PolicyConfig {
  /**
   * `strict`  - everything except non-filesystem read-only tools needs a human.
   * `standard`- reads and writes inside the workspace are allowed; everything
   *             else prompts.
   * `trusted` - additionally auto-allows non-critical shell commands.
   *
   * There is deliberately no mode that auto-allows critical commands or secret
   * paths, because such a mode is indistinguishable from having no policy.
   */
  mode: "strict" | "standard" | "trusted";
  /** Extra command regexes treated as critical. */
  extraCritical?: RegExp[];
  /**
   * Roots an agent may touch without prompting. Defaults to the agent's cwd.
   * Useful when a repo's worktrees live outside it.
   */
  workspaceRoots?: string[];
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = { mode: "standard" };

export class DefaultPolicy implements Policy {
  #config: PolicyConfig;
  #critical: RegExp[];

  constructor(config: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    this.#config = config;
    // Strip the global flag: `RegExp.test` on a `/g` regex advances lastIndex,
    // so the same pattern would match on one call and miss on the next. A
    // stateful matcher in a security check is a bug that only shows up under
    // load, which is the worst time to find it.
    this.#critical = [...CRITICAL_COMMAND_PATTERNS, ...(config.extraCritical ?? [])].map((p) =>
      p.flags.includes("g") || p.flags.includes("y")
        ? new RegExp(p.source, p.flags.replace(/[gy]/g, ""))
        : p,
    );
  }

  evaluate(ctx: PolicyContext): PolicyDecision {
    const { agent, tool, input, actor } = ctx;
    const scopes = new Set(actor.scopes);

    // A device with no scope at all cannot influence anything.
    if (scopes.size === 0) {
      return { action: "deny", reason: "actor has no scopes", rule: "scope" };
    }

    const isRead = READ_ONLY_TOOLS[tool] === true;

    if (isRead) {
      if (!scopes.has(SCOPE_READ)) {
        return { action: "deny", reason: `read requires ${SCOPE_READ} scope`, rule: "scope:read" };
      }
      if (NON_FILESYSTEM_TOOLS[tool]) {
        return { action: "allow", reason: "read-only tool with no filesystem reach", rule: "read-only" };
      }
      const path = extractPath(input);
      if (path === null) {
        // A filesystem read tool whose target we cannot see is not a fast path.
        return { action: "prompt", reason: "read target not determinable", rule: "read:opaque" };
      }
      const secret = matchSecret(path);
      if (secret) {
        return {
          action: "deny",
          reason: "read targets a secret path",
          rule: `secret:${secret}`,
        };
      }
      if (!this.#inWorkspace(agent.cwd, path)) {
        return { action: "prompt", reason: "read outside workspace", rule: "read:escape" };
      }
      return { action: "allow", reason: "read inside workspace", rule: "read:workspace" };
    }

    // Everything below mutates or executes, so it needs prompt scope at minimum.
    if (!scopes.has(SCOPE_PROMPT) && !scopes.has(SCOPE_APPROVE)) {
      return { action: "deny", reason: "actor lacks prompt and approve scope", rule: "scope" };
    }

    const command = extractCommand(input);
    if (command !== null) {
      const critical = this.#criticalMatch(command);
      if (critical) {
        if (!scopes.has(SCOPE_APPROVE)) {
          return {
            action: "deny",
            reason: `critical command and actor lacks ${SCOPE_APPROVE} scope`,
            rule: `critical:${critical}`,
          };
        }
        // Not even `trusted` mode auto-allows these.
        return {
          action: "prompt",
          reason: "critical command requires explicit human approval",
          rule: `critical:${critical}`,
        };
      }
      if (this.#config.mode === "trusted") {
        return { action: "allow", reason: "non-critical command, trusted mode", rule: "trusted" };
      }
      return { action: "prompt", reason: "shell command", rule: "shell" };
    }

    const path = extractPath(input);
    if (path !== null) {
      const secret = matchSecret(path);
      if (secret) {
        return { action: "deny", reason: "write targets a secret path", rule: `secret:${secret}` };
      }
      if (this.#config.mode === "strict") {
        return { action: "prompt", reason: "strict mode prompts on every write", rule: "strict" };
      }
      if (this.#inWorkspace(agent.cwd, path)) {
        return { action: "allow", reason: "write inside workspace", rule: "write:workspace" };
      }
      return { action: "prompt", reason: "write outside workspace", rule: "write:escape" };
    }

    return { action: "prompt", reason: "no rule matched; defaulting to human", rule: "default" };
  }

  #inWorkspace(cwd: string, path: string): boolean {
    const roots = this.#config.workspaceRoots ?? [cwd];
    return roots.some((root) => isInside(root, path, cwd));
  }

  #criticalMatch(command: string): string | null {
    const segments = [command, ...commandSegments(command)];
    for (const p of this.#critical) {
      for (const seg of segments) {
        if (p.test(seg)) return p.source.slice(0, 40);
      }
    }
    return null;
  }
}

function matchSecret(path: string): string | null {
  const norm = path.replace(/\\/g, "/");
  for (const p of SECRET_PATH_PATTERNS) {
    if (p.test(norm)) return p.source.slice(0, 32);
  }
  return null;
}

/** Pull a shell command out of a tool input, whatever the tool calls the field. */
export function extractCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Pull a filesystem path out of a tool input. */
export function extractPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target", "pattern"]) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * True when `child` resolves inside `parent`.
 *
 * Naive prefix comparison is wrong twice over: `/a/bc` starts with `/a/b`, and
 * `..` segments escape. Both are handled by normalizing to segments and
 * requiring `parent` to be a segment-wise prefix.
 *
 * Note this is lexical. It cannot see through symlinks, so a symlink inside the
 * workspace pointing at `/etc` reads as inside. Resolving that needs I/O, which
 * `evaluate()` must not do; the supervisor resolves real paths before calling.
 */
export function isInside(parent: string, child: string, base = parent): boolean {
  const segs = (p: string): string[] => {
    const abs = p.startsWith("/") ? p : `${base.replace(/\/+$/, "")}/${p}`;
    const out: string[] = [];
    for (const seg of abs.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return out;
  };
  const p = segs(parent);
  const c = segs(child);
  if (c.length < p.length) return false;
  return p.every((seg, i) => c[i] === seg);
}

export type AcpOptionId = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** Map a policy decision plus an optional human reply onto an ACP option id. */
export function toAcpOption(
  decision: PolicyDecision,
  humanChoice?: { choice: "allow" | "deny"; scope?: "once" | "always" },
): AcpOptionId {
  if (decision.action === "allow") return "allow_once";
  if (decision.action === "deny") return "reject_once";
  // `prompt` and no human answered: fail closed.
  if (!humanChoice) return "reject_once";
  const always = humanChoice.scope === "always";
  if (humanChoice.choice === "allow") return always ? "allow_always" : "allow_once";
  return always ? "reject_always" : "reject_once";
}
