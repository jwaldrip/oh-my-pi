/**
 * Collaboration links have exactly two ingress forms:
 *
 * - `ompd://collab/<roomId>` for custom-scheme delivery;
 * - `https://my.ompd.sh/collab/<roomId>` for verified iOS Universal Links and
 *   Android App Links.
 *
 * The room id identifies a session but grants no capability. Pairing remains
 * the authority for joining or operating that session, so query strings and
 * fragments are refused rather than becoming an accidental credential channel.
 */

const COLLAB_ORIGIN = "https://my.ompd.sh";
const ROOM_ID = /^[A-Za-z0-9_-]{10,64}$/;

export interface CollabDeepLink {
  roomId: string;
}

/** The native Linking surface, kept structural so web and tests need no native module. */
export interface DeepLinkSource {
  getInitialURL(): Promise<string | null>;
  addEventListener(type: "url", listener: (event: { url: string }) => void): { remove(): void };
}

export type OpenCollabSession = (roomId: string) => void;

/**
 * Recognises only the product-owned link forms. In particular, a URL whose
 * hostname merely contains `my.ompd.sh` must never become a navigation target.
 */
export function parseCollabDeepLink(raw: string): CollabDeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.search.length > 0 || url.hash.length > 0) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  let roomId: string;
  if (url.protocol === "ompd:" && url.hostname === "collab") {
    if (segments.length !== 1) return null;
    roomId = segments[0] ?? "";
  } else if (url.protocol === "https:" && url.origin === COLLAB_ORIGIN) {
    if (segments.length !== 2 || segments[0] !== "collab") return null;
    roomId = segments[1] ?? "";
  } else {
    return null;
  }

  return ROOM_ID.test(roomId) ? { roomId } : null;
}

/** Routes one untrusted platform URL only when it is a recognised collab link. */
export function handleCollabDeepLink(raw: string, openCollabSession: OpenCollabSession): boolean {
  const link = parseCollabDeepLink(raw);
  if (link === null) return false;
  openCollabSession(link.roomId);
  return true;
}

/**
 * Installs the cold-start and warm-link handlers that drive the app's collab
 * session view. The returned cleanup is required when the host unmounts.
 */
export function listenForCollabLinks(source: DeepLinkSource, openCollabSession: OpenCollabSession): () => void {
  let active = true;
  void source.getInitialURL().then(
    (url) => {
      if (active && url !== null) handleCollabDeepLink(url, openCollabSession);
    },
    () => {
      // An unavailable initial URL is equivalent to launching without a link.
    },
  );
  const subscription = source.addEventListener("url", ({ url }) => {
    if (active) handleCollabDeepLink(url, openCollabSession);
  });

  return () => {
    active = false;
    subscription.remove();
  };
}
