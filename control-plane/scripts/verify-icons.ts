/**
 * Prove every glyph in the web client's icon table actually renders.
 *
 * A Font Awesome kit can be subsetted. When it is, an icon the property has
 * never used before does not fail: it renders a dashed-circle placeholder, and
 * a console full of dashed circles is the kind of thing that ships. So this
 * loads the real kit in a real browser, asks it to draw the whole table, and
 * checks each one turned into an `<svg>` carrying actual path data.
 *
 * Usage: bun run scripts/verify-icons.ts
 * Exits non-zero if any glyph is missing, so it can gate a release.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLYPHS } from "../packages/web/src/ui/icons.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KIT = "https://kit.fontawesome.com/bcb2ad36f1.js";
const SETTLE_MS = 4_000;

const entries = Object.entries(GLYPHS);

const page = `<!doctype html>
<html><head><meta charset="utf-8"><script src="${KIT}" crossorigin="anonymous"></script></head>
<body><div id="host"></div><pre id="out">pending</pre>
<script>
const TABLE = ${JSON.stringify(entries)};
const host = document.getElementById("host");
for (const [name, classes] of TABLE) {
  const wrap = document.createElement("div");
  wrap.dataset.name = name;
  const i = document.createElement("i");
  i.className = classes;
  wrap.append(i);
  host.append(wrap);
}
setTimeout(() => {
  const rows = [];
  for (const wrap of host.children) {
    const svg = wrap.querySelector("svg");
    const paths = svg ? [...svg.querySelectorAll("path")] : [];
    const drawn = paths.reduce((total, path) => total + (path.getAttribute("d") || "").length, 0);
    rows.push(JSON.stringify({ name: wrap.dataset.name, svg: Boolean(svg), paths: paths.length, drawn }));
  }
  document.getElementById("out").textContent = rows.join("\\n");
}, ${SETTLE_MS});
</script></body></html>`;

const server = Bun.serve({ port: 0, fetch: () => new Response(page, { headers: { "content-type": "text/html" } }) });
const profile = mkdtempSync(join(tmpdir(), "ompd-icons-"));

const dom = await new Promise<string>((resolve, reject) => {
  const child = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    `--user-data-dir=${profile}`,
    `--virtual-time-budget=${SETTLE_MS + 4_000}`,
    "--dump-dom",
    `http://127.0.0.1:${server.port}/`,
  ]);
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", () => {
    resolve(out);
  });
});

server.stop(true);
rmSync(profile, { recursive: true, force: true });

const block = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
if (block === null) {
  console.error("could not read the probe output; the kit may not have loaded");
  process.exit(2);
}

const missing: string[] = [];
for (const line of (block[1] ?? "").trim().split("\n")) {
  const report: { name: string; svg: boolean; paths: number; drawn: number } = JSON.parse(line);
  const ok = report.svg && report.paths > 0 && report.drawn > 40;
  const glyph = GLYPHS[report.name as keyof typeof GLYPHS];
  console.log(
    `${ok ? "ok  " : "MISS"} ${report.name.padEnd(11)} ${String(glyph).padEnd(40)} paths=${report.paths} d=${report.drawn}`,
  );
  if (!ok) missing.push(report.name);
}

if (missing.length > 0) {
  console.error(`\n${missing.length} glyph(s) did not render: ${missing.join(", ")}`);
  console.error("The kit is subsetted for these. Inline the Pro SVGs instead of shipping placeholders.");
  process.exit(1);
}

console.log(`\nall ${entries.length} glyphs render from the kit`);
