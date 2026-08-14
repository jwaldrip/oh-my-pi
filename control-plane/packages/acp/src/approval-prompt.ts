/**
 * Reading OMP's internal approval prompt back into something a policy engine
 * can decide about.
 *
 * OMP has two approval gates. The ACP permission wrapper sends structured
 * JSON-RPC and never fires for `write` or `ast_edit`, and fires for `edit`
 * only on a delete or a rename. The internal gate covers every tool, but it
 * renders one string for a human and hands it to whatever UI is attached. In a
 * headless ACP host that UI is the elicitation bridge, so for the tools that
 * matter most this string is the *only* description of the call ompd ever
 * sees. Parsing it is not elegant. It is the channel that exists.
 *
 * The shape, from `formatApprovalPrompt` in omp 17.2.12:
 *
 * ```
 * Allow tool: <name>
 * [Origin: MCP server tool]
 * [Reason: <why>]
 * <the tool's own detail lines>
 * ```
 *
 * Detail lines, measured against the shipped binary rather than read off an
 * interface (`scripts/probe-elicitation-gate.ts` prints them verbatim):
 *
 * ```
 * write     Path: <path>      then  Content:\n<content>
 * edit      File: <path>
 * ast_edit  Pattern: / Replacement: / [+N more ops] / Paths: <a, b, c>
 * bash      Command: <command>
 * ```
 *
 * Two facts drive every design choice below.
 *
 * **A target we cannot fully see is a target we cannot decide about.** omp
 * elides long values at 2000 characters. A path carrying that marker is
 * reported as truncated so the caller can fail closed instead of matching a
 * prefix against a workspace root.
 *
 * **A scheme is not a path.** `Path: xd://ast_edit` and `Path: local://plan.md`
 * are dispatches into OMP's device and artifact namespaces. Where they land on
 * disk is OMP-internal and not derivable here, so they are kept out of `paths`
 * entirely rather than handed to a lexical workspace check that would call
 * `xd://ast_edit` a file inside the workspace.
 */

/** The `[…Nch elided…]` marker omp writes when it truncates a value. */
const ELISION = /\[\u2026\d+ch elided\u2026\]/;

/** `scheme://` prefix. A target with one is not a filesystem path. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const HEADER = /^Allow tool: (.+)$/;

/**
 * Detail keys that name a single target. `Path` is write's, `File` is edit's.
 */
const SINGLE_TARGET_KEYS: Record<string, true> = { Path: true, File: true };

export interface ParsedApprovalPrompt {
  /** Tool name exactly as omp reported it, so policy keys off the real name. */
  tool: string;
  /** Everything after the header, verbatim. What an operator should read. */
  detail: string;
  /** Filesystem targets recovered from the detail lines. */
  paths: string[];
  /**
   * Targets that carry a URI scheme. Held separately because they are not
   * filesystem paths and must never be workspace-checked as if they were.
   */
  uriTargets: string[];
  /** A shell command, when the tool reported one. */
  command: string | null;
  /** True when a line naming a target was elided, so the target is unknowable. */
  truncated: boolean;
}

/**
 * Parse a gate-2 approval prompt. Returns null when the message is not one,
 * which is how a caller tells a tool approval apart from every other thing
 * OMP asks a UI to render.
 */
export function parseApprovalPrompt(message: string): ParsedApprovalPrompt | null {
  const lines = message.split("\n");
  const header = HEADER.exec(lines[0] ?? "");
  if (!header) return null;

  const tool = header[1]?.trim() ?? "";
  if (tool.length === 0) return null;

  const paths: string[] = [];
  const uriTargets: string[] = [];
  let command: string | null = null;
  let truncated = false;

  const addTarget = (raw: string): void => {
    const value = raw.trim();
    if (value.length === 0) return;
    if (ELISION.test(value)) {
      truncated = true;
      return;
    }
    if (URI_SCHEME.test(value)) {
      uriTargets.push(value);
      return;
    }
    paths.push(value);
  };

  // Every line is scanned, including the body of a `Content:` or a multi-line
  // `Replacement:`. A tool call cannot forge its way past the gate by planting
  // a `Path:` line in the bytes it writes, because a planted line can only add
  // a target, the caller decides on every target it is given, and the most
  // restrictive of those decisions wins. Injection here tightens; it never
  // loosens.
  for (const line of lines.slice(1)) {
    const sep = line.indexOf(": ");
    if (sep < 0) continue;
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);

    if (SINGLE_TARGET_KEYS[key] === true) {
      addTarget(value);
      continue;
    }
    if (key === "Paths") {
      if (ELISION.test(value)) {
        // The list was cut off, so some target is invisible even if the
        // visible ones parse. Splitting what is left would decide about a
        // subset and call it the whole call.
        truncated = true;
        continue;
      }
      // omp joins with ", ". A path containing that sequence splits wrong, and
      // the halves then fail the workspace check, which prompts rather than
      // allows. Wrong in the safe direction.
      for (const part of value.split(", ")) addTarget(part);
      continue;
    }
    if (key === "Command" && command === null) {
      command = ELISION.test(value) ? null : value;
      if (command === null) truncated = true;
      continue;
    }
    // `Content:` is the write body, which omp puts on the following lines. It
    // is not a target and is deliberately not scanned: a path mentioned inside
    // a file being written is not a path being written to.
  }

  return { tool, detail: lines.slice(1).join("\n"), paths, uriTargets, command, truncated };
}
