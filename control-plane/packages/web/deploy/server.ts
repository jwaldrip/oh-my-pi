/**
 * Static host for app.ompctl.ai.
 *
 * Serves the Vite build and the association files Apple/Google fetch for
 * Universal Links / App Links. TEAMID and the Play cert fingerprint are
 * injected at container start so the image stays free of account secrets.
 */
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const root = join(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 8080);
const teamId = process.env.OMPCTL_APPLE_TEAM_ID ?? "TEAMID";
const playSha = process.env.OMPCTL_PLAY_CERT_SHA256 ?? "REPLACE_WITH_PLAY_UPLOAD_CERT_SHA256";
const bundleIos = process.env.OMPCTL_IOS_BUNDLE_ID ?? "ai.ompctl.app";
const bundleMac = process.env.OMPCTL_MACOS_BUNDLE_ID ?? "ai.ompctl.macos";
const androidPkg = process.env.OMPCTL_ANDROID_PACKAGE ?? "ai.ompctl.app";

function aasa(): Response {
  const body = {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: [`${teamId}.${bundleIos}`, `${teamId}.${bundleMac}`],
          components: [{ "/": "/collab/*" }],
          paths: ["/collab/*"],
        },
      ],
    },
    webcredentials: {
      apps: [`${teamId}.${bundleIos}`, `${teamId}.${bundleMac}`],
    },
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      // Apple requires no redirects and a real content-type for AASA.
      "cache-control": "public, max-age=300",
    },
  });
}

function assetlinks(): Response {
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: androidPkg,
        sha256_cert_fingerprints: [playSha],
      },
    },
  ];
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function fileResponse(rel: string): Response | null {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.includes("..")) return null;
  const full = join(root, clean);
  if (!full.startsWith(root) || !existsSync(full)) return null;
  const data = readFileSync(full);
  return new Response(data, {
    headers: {
      "content-type": contentType(full),
      "cache-control": clean.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60",
    },
  });
}

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/.well-known/apple-app-site-association") return aasa();
    if (path === "/.well-known/assetlinks.json") return assetlinks();
    if (path === "/healthz" || path === "/v1/health") {
      return Response.json({ ok: true, service: "ompctl-web" });
    }

    // SPA: exact file, then index.html
    const exact = path === "/" ? "index.html" : path.slice(1);
    const hit = fileResponse(exact) ?? (exact.includes(".") ? null : fileResponse("index.html"));
    if (hit) return hit;
    return new Response("Not found", { status: 404 });
  },
});

console.log(JSON.stringify({ severity: "INFO", message: "ompctl web listening", port }));
