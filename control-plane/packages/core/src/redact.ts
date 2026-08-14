/**
 * Redaction applied before anything is persisted.
 *
 * ACP update payloads, tool inputs, and audit details are arbitrary agent
 * traffic: a `read` of a `.env`, a shell line with an inline token, a provider
 * response echoing a key. The daemon's SQLite file must not become the easiest
 * place on the machine to harvest credentials, so persistence is the choke
 * point where secrets are scrubbed.
 *
 * This is defence in depth, not a substitute for the policy engine refusing to
 * read secret paths in the first place. Redaction is best-effort by nature --
 * it recognises shapes, and a shape it has never seen gets through -- which is
 * exactly why it is the second line rather than the first.
 */

/** Ordered so more specific shapes win before generic ones. */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "private-key" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, label: "openai-key" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: "anthropic-key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, label: "github-token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "github-pat" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-access-key" },
  { re: /\bASIA[0-9A-Z]{16}\b/g, label: "aws-session-key" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "google-api-key" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: "jwt" },
  { re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g, label: "auth-header" },
  // KEY=value / "key": "value" for names that are secret by convention.
  {
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"',}]{6,})/gi,
    label: "named-secret",
  },
];

export const REDACTED = "[redacted]";

/** Replace every recognised secret shape in a string. */
export function redactString(input: string): string {
  let out = input;
  for (const { re, label } of SECRET_PATTERNS) {
    // A fresh regex per call: the module-level literals carry /g, and reusing
    // them across calls would advance lastIndex and skip matches.
    const scoped = new RegExp(re.source, re.flags);
    out = out.replace(scoped, (_match, name?: string) =>
      label === "named-secret" && typeof name === "string"
        ? `${name}=${REDACTED}`
        : `${REDACTED}:${label}`,
    );
  }
  return out;
}

export interface RedactOptions {
  /** Truncate any single string past this. Defaults to 16 KiB. */
  maxStringLength?: number;
  /** Cap the serialized result. Defaults to 256 KiB. */
  maxTotalBytes?: number;
}

const DEFAULT_MAX_STRING = 16 * 1024;
const DEFAULT_MAX_TOTAL = 256 * 1024;

/**
 * Deep-redact a value and bound its size. Returns a structure safe to persist.
 *
 * Size bounding is not cosmetic: `updates` is append-only and a single verbose
 * tool result can be megabytes. Unbounded, one chatty agent fills the disk that
 * every other agent's replay depends on.
 */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const maxString = opts.maxStringLength ?? DEFAULT_MAX_STRING;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL;

  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 32) return "[depth-limited]";
    if (typeof v === "string") {
      const r = redactString(v);
      return r.length > maxString ? `${r.slice(0, maxString)}…[truncated ${r.length}B]` : r;
    }
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      // Redact by key name too: a value that does not look like a secret is
      // still a secret when the field is called `password`.
      out[k] = /secret|token|password|passwd|api_?key|private_?key|credential|authorization/i.test(k)
        ? REDACTED
        : walk(item, depth + 1);
    }
    return out;
  };

  const redacted = walk(value, 0);
  const json = JSON.stringify(redacted) ?? "null";
  if (json.length <= maxTotal) return redacted;
  return {
    __truncated: true,
    __originalBytes: json.length,
    preview: json.slice(0, maxTotal),
  };
}
