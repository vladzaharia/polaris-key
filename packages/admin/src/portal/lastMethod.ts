/**
 * "You usually sign in with Steam" (SIGN-IN.md §3.4 HintStep; THREAT-MODEL G30): the first-party
 * `pk_last_method` cookie holds only the method's kind and a salted hash of the address, so it
 * names no one and a stolen copy proves nothing. The hint is never read from a server lookup (a
 * lookup would say which addresses have accounts): the card only compares the typed address's
 * hash with the one this browser wrote itself after a sign-in. The salt and the first name for
 * "Welcome back" stay in this browser's storage and are never sent.
 */
export type LastKind = "email" | "passkey" | "apple" | "google" | "steam";
export interface LastMethod {
  kind: LastKind;
  /** Seconds since the epoch. */
  at: number;
  /** The first name this browser saw for that address, when it has one. */
  name: string | null;
}

const COOKIE = "pk_last_method";
const VIA = "pk-signin-via";
const SALT = "pk-hint-salt";
const NAME = "pk-hint-name:";
const KINDS: readonly string[] = [
  "email",
  "passkey",
  "apple",
  "google",
  "steam",
];

function salt(): string {
  try {
    let s = window.localStorage.getItem(SALT);
    if (!s) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      s = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      window.localStorage.setItem(SALT, s);
    }
    return s;
  } catch {
    return "";
  }
}

export async function hashAddress(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${salt()}:${email.trim().toLowerCase()}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}

/** This tab is about to sign in with `kind`; the portal records it once the session exists. */
export function rememberVia(kind: LastKind): void {
  try {
    window.sessionStorage.setItem(VIA, kind);
  } catch {
    // Storage off: no hint next time.
  }
}

/** After a sign-in: write the cookie for this account's address, if this tab named a method. */
export async function commitLastMethod(account: {
  email: string;
  name: string;
}): Promise<void> {
  let kind: string | null = null;
  try {
    kind = window.sessionStorage.getItem(VIA);
    window.sessionStorage.removeItem(VIA);
  } catch {
    return;
  }
  if (!kind || !KINDS.includes(kind) || !account.email) return;
  const h = await hashAddress(account.email);
  const at = Math.floor(Date.now() / 1000);
  document.cookie = `${COOKIE}=${kind}.${h}.${at}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
  const first = account.name.trim().split(/\s+/)[0] ?? "";
  try {
    if (first && first !== account.email)
      window.localStorage.setItem(NAME + h, first);
  } catch {
    // Not kept: "Welcome back" has no name.
  }
}

/** The method this browser last used for `email`, or null (no cookie, or another address). */
export async function readLastMethod(
  email: string,
): Promise<LastMethod | null> {
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const [kind, h, at] = raw?.split(".") ?? [];
  if (!kind || !h || !KINDS.includes(kind)) return null;
  if (h !== (await hashAddress(email))) return null;
  let name: string | null = null;
  try {
    name = window.localStorage.getItem(NAME + h);
  } catch {
    name = null;
  }
  return { kind: kind as LastKind, at: Number(at) || 0, name };
}

const NUDGE = "pk-signin-nudge";
/** A nudge the sign-in left before the account was known goes stale after this long. */
const NUDGE_CLAIM_MS = 10 * 60 * 1000;

/**
 * The Worker's `nudge: true` ("add another way to sign in", after a first sign-in). It is kept in
 * localStorage, not sessionStorage: a magic link opens the portal in a new tab, which has no
 * sessionStorage of the tab that asked. The sign-in does not know the account yet, so it leaves a
 * timestamp; the first signed-in page claims it for the account (`claimNudge`), and from then on it
 * is the account's own (`nudge:<id>`) until the person dismisses it.
 */
export function rememberNudge(): void {
  try {
    window.localStorage.setItem(NUDGE, String(Date.now()));
  } catch {
    // Storage off: the nudge waits for the next sign-in the Worker offers it on.
  }
}

/** Whether the nudge is waiting for this account; claims a fresh sign-in's flag first. */
export function nudgePending(accountId: string): boolean {
  try {
    const own = `${NUDGE}:${accountId}`;
    const left = Number(window.localStorage.getItem(NUDGE));
    if (left) {
      window.localStorage.removeItem(NUDGE);
      if (Date.now() - left < NUDGE_CLAIM_MS)
        window.localStorage.setItem(own, "1");
    }
    return window.localStorage.getItem(own) === "1";
  } catch {
    return false;
  }
}

/** The person answered it (dismissed it, or went to add a method). */
export function clearNudge(accountId: string): void {
  try {
    window.localStorage.removeItem(`${NUDGE}:${accountId}`);
  } catch {
    // Nothing to clear.
  }
}
