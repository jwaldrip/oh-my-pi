/**
 * Where a scoped bearer token actually lives once it leaves memory.
 *
 * `platform/connection.ts` used to hand the daemon's token to AsyncStorage
 * next to the rest of a pairing. AsyncStorage is a plain file in the app's
 * own container on both mobile platforms -- a plist on iOS, an XML/SQLite
 * blob on Android -- and both platforms fold that whole container into a
 * device backup. A token that opens a daemon which executes code as the Mac
 * user has no business surviving in either place. `readSecret`, `writeSecret`,
 * and `deleteSecret` are the only door a token goes through now; everything
 * else a pairing needs stays exactly where it already lived.
 *
 * `secrets.web.ts` is this file's counterpart for the one target that has no
 * keystore at all -- see that file for why it does not fall back to
 * `localStorage`, which would repeat the same mistake AsyncStorage already
 * was, one file over.
 */

import { ACCESSIBLE, getGenericPassword, resetGenericPassword, setGenericPassword } from "react-native-keychain";

/**
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, not the library's default
 * (`AFTER_FIRST_UNLOCK`). The default is willing to sync through iCloud
 * Keychain and to reappear on a second device the moment the operator
 * restores an encrypted backup onto it. A token that authorizes a daemon to
 * run code as the Mac user has no business showing up on a device it was
 * never paired with, so this pins the entry to the device that received it:
 * unreadable before that device's own first unlock, and never migrated by
 * an iCloud sync or a backup restore.
 */
const SECRET_ACCESSIBILITY = ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

/**
 * `true` here, `false` in `secrets.web.ts`. A caller that needs to know
 * whether a write it just made will still be there after a relaunch has a
 * fact to read rather than having to re-derive it from a platform check.
 */
export const SECRETS_PERSIST_ACROSS_LAUNCHES = true;

export async function readSecret(key: string): Promise<string | null> {
  const result = await getGenericPassword({ service: key });
  return result === false ? null : result.password;
}

export async function writeSecret(key: string, value: string): Promise<void> {
  const result = await setGenericPassword(key, value, { service: key, accessible: SECRET_ACCESSIBILITY });
  if (result === false) {
    // The library's own contract is `false` on failure, not a rejection.
    // Swallowing that would leave a caller believing the token sits behind
    // the keystore when the device in fact still has nothing durable at
    // all -- exactly the silent degrade to plaintext this file exists to
    // rule out.
    throw new Error(`keychain refused to store the secret for "${key}"`);
  }
}

export async function deleteSecret(key: string): Promise<void> {
  // Resolves `true` even when nothing was ever stored under `key`: deleting
  // something that already is not there is success, not a refusal, so
  // `clearConnection` can call this unconditionally instead of checking
  // whether a secret exists first.
  await resetGenericPassword({ service: key });
}
