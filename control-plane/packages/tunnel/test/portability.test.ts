/**
 * This package is imported by the phone and the browser, not just by Bun.
 *
 * The check is a real browser-target bundle rather than a grep for `node:`,
 * because the failure being prevented is "the sibling app cannot build", and
 * that is exactly what this reproduces. A `node:` import or a bare `Buffer`
 * fails it; a comment mentioning either does not.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "src", "index.ts");

describe("portability", () => {
  test("the tunnel bundles for a browser target", async () => {
    const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
    // A node builtin does not resolve for this target, so the build reports it
    // rather than silently shimming.
    expect(built.logs.filter((entry2) => entry2.level === "error")).toEqual([]);
    expect(built.success).toBe(true);
  });

  test("the bundle references no node builtin and no Buffer", async () => {
    const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
    expect(built.success).toBe(true);
    const source = await (built.outputs[0] as { text(): Promise<string> }).text();
    // Belt and braces on top of the build: Bun can polyfill some builtins for
    // the browser target, and a polyfilled `Buffer` would bundle cleanly while
    // still being wrong for React Native.
    expect(source).not.toContain("node:crypto");
    expect(source).not.toContain("node:buffer");
    expect(source).not.toMatch(/\bBuffer\.from\b/);
  });
});
