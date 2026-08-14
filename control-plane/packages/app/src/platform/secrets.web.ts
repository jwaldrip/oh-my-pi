/**
 * The web build's answer to "where does a scoped bearer token live": nowhere
 * durable, on purpose.
 *
 * A browser tab has no keystore. The one storage this build does have --
 * `localStorage` -- is plaintext, readable by any script that ever runs on
 * this origin, and exactly the failure `platform/secrets.ts`'s header
 * describes AsyncStorage as being. Writing the daemon's token there would
 * not be a lesser version of secure storage; it would be the same mistake
 * this whole slice exists to remove, just moved one file over. So this file
 * does not try: a secret written here lives in a module-level `Map` for as
 * long as this page stays loaded, and nowhere else. There is no persistence
 * to opt into and no degraded fallback hiding behind these three functions.
 *
 * The consequence is real, and it is meant to be reached rather than hidden
 * behind a swallowed error. A page reload clears this module the same way
 * it clears every other one, while `platform/connection.ts`'s metadata half
 * of a pairing survives a reload because it goes through AsyncStorage,
 * which on web is backed by `localStorage`. `loadConnection` already treats
 * metadata with no matching secret as half a pairing and refuses to treat
 * it as a whole one, so a web reload lands back on the pairing screen
 * instead of opening a socket with a token that silently stopped existing.
 * That refusal is a real state transition a caller actually reaches, not an
 * exception this module eats on the way out.
 *
 * This is `.web.ts` -- resolved the same way Metro resolves `.ios.tsx` and
 * Vite resolves it per `vite.config.ts`'s `resolve.extensions` -- so a
 * caller importing `./secrets` gets this file's honest behaviour on the web
 * target without ever having to ask which platform it is running on.
 */

const memory = new Map<string, string>();

/** `false` here, `true` on every target with a real keystore. See `secrets.ts`. */
export const SECRETS_PERSIST_ACROSS_LAUNCHES = false;

export async function readSecret(key: string): Promise<string | null> {
  return memory.get(key) ?? null;
}

export async function writeSecret(key: string, value: string): Promise<void> {
  memory.set(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  memory.delete(key);
}
