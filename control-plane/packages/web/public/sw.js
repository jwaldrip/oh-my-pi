/**
 * Service worker: application shell only.
 *
 * The one rule that matters here is what is NOT cached. Agent state, updates,
 * approvals, and the socket all live under /v1/, and a stale answer from any of
 * them is worse than no answer: an operator acting on a cached roster may
 * approve a command for an agent that stopped an hour ago. Those requests are
 * passed straight through, so they either reach the daemon or fail honestly.
 *
 * What is cached is the shell: the document, the hashed bundle, the icons. That
 * is enough for the app to open offline and say "offline" out loud.
 */

const SHELL = "ompd-shell-v2";
const SHELL_DOCUMENT = "/index.html";
const PRECACHE = ["/", SHELL_DOCUMENT, "/manifest.webmanifest", "/icon.svg"];

/** Request destinations that are part of the shell and safe to serve stale. */
const SHELL_DESTINATIONS = new Set(["script", "style", "font", "image", "manifest"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // One missing entry must not fail the whole install.
      await Promise.allSettled(PRECACHE.map((path) => cache.add(path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== SHELL).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The control plane. Never cached, never intercepted.
  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return;

  if (request.mode === "navigate") {
    event.respondWith(shellDocument(request));
    return;
  }

  if (!SHELL_DESTINATIONS.has(request.destination)) return;
  event.respondWith(shellAsset(request));
});

/**
 * Network first, so a deploy is picked up on the next launch; cache second, so
 * the app still opens with no daemon reachable.
 */
async function shellDocument(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(SHELL_DOCUMENT, response.clone());
    return response;
  } catch (cause) {
    const cached = (await cache.match(request)) ?? (await cache.match(SHELL_DOCUMENT));
    if (cached) return cached;
    throw cause;
  }
}

/** Cache first: build assets carry a content hash, so a hit is never stale. */
async function shellAsset(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") cache.put(request, response.clone());
  return response;
}
