/**
 * The returning-person store, one factory for both brands (SIGN-IN.md §3.4, the console's
 * returning-person step): a first-party cookie `kind.hash.at`, where `hash` is the first 12 bytes of
 * SHA-256 of `salt:address`. The salt, the first name and the tab's pending method stay in this
 * browser's storage; nothing here is sent anywhere, and a lookup by address never leaves the page.
 */
export interface LastMethod<K extends string = LastKind> {
  kind: K;
  /** Seconds since the epoch. */
  at: number;
  /** The first name this browser saw for that address, when it has one. */
  name: string | null;
}

/** Polaris Locker's kinds, here so both stores read from one place. */
export type LastKind = "email" | "passkey" | "apple" | "google" | "steam";

export interface LastMethodConfig {
  kinds: readonly string[];
  /** The cookie's name. */
  cookie: string;
  /** The sessionStorage key naming the method this tab is about to use. */
  via: string;
  /** The localStorage key of the salt, and the prefix of the first-name keys. */
  salt: string;
  name: string;
  /** Everything after `name=value; ` in the Set-Cookie text (Path, Max-Age, SameSite, Secure). */
  cookieAttrs: string;
}

export interface LastMethodStore<K extends string> {
  hashAddress(email: string): Promise<string>;
  rememberVia(kind: K): void;
  /** After a sign-in: write the cookie for this account's address, if this tab named a method. */
  commitLastMethod(account: { email: string; name: string }): Promise<void>;
  /** Drops this tab's pending method without writing anything (an account that must not be remembered). */
  clearVia(): void;
  readLastMethod(email: string): Promise<LastMethod<K> | null>;
}

export function createLastMethodStore<K extends string = LastKind>(
  cfg: LastMethodConfig,
): LastMethodStore<K> {
  function salt(): string {
    try {
      let s = window.localStorage.getItem(cfg.salt);
      if (!s) {
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        s = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        window.localStorage.setItem(cfg.salt, s);
      }
      return s;
    } catch {
      return "";
    }
  }

  async function hashAddress(email: string): Promise<string> {
    const bytes = new TextEncoder().encode(
      `${salt()}:${email.trim().toLowerCase()}`,
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest).slice(0, 12), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
  }

  function rememberVia(kind: K): void {
    try {
      window.sessionStorage.setItem(cfg.via, kind);
    } catch {
      // Storage off: no hint next time.
    }
  }

  function clearVia(): void {
    try {
      window.sessionStorage.removeItem(cfg.via);
    } catch {
      // Nothing to clear.
    }
  }

  async function commitLastMethod(account: {
    email: string;
    name: string;
  }): Promise<void> {
    let kind: string | null = null;
    try {
      kind = window.sessionStorage.getItem(cfg.via);
      window.sessionStorage.removeItem(cfg.via);
    } catch {
      return;
    }
    if (!kind || !cfg.kinds.includes(kind) || !account.email) return;
    const h = await hashAddress(account.email);
    const at = Math.floor(Date.now() / 1000);
    document.cookie = `${cfg.cookie}=${kind}.${h}.${at}; ${cfg.cookieAttrs}`;
    const first = account.name.trim().split(/\s+/)[0] ?? "";
    try {
      if (first && first !== account.email)
        window.localStorage.setItem(cfg.name + h, first);
    } catch {
      // Not kept: "Welcome back" has no name.
    }
  }

  async function readLastMethod(email: string): Promise<LastMethod<K> | null> {
    const raw = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${cfg.cookie}=`))
      ?.slice(cfg.cookie.length + 1);
    const [kind, h, at] = raw?.split(".") ?? [];
    if (!kind || !h || !cfg.kinds.includes(kind)) return null;
    if (h !== (await hashAddress(email))) return null;
    let name: string | null = null;
    try {
      name = window.localStorage.getItem(cfg.name + h);
    } catch {
      name = null;
    }
    return { kind: kind as K, at: Number(at) || 0, name };
  }

  return {
    hashAddress,
    rememberVia,
    clearVia,
    commitLastMethod,
    readLastMethod,
  };
}

/** The console's store: passkey or single sign-on, scoped to `/manage`, never sent cross-site. */
export type ConsoleKind = "passkey" | "sso";
export const consoleLastMethod = createLastMethodStore<ConsoleKind>({
  kinds: ["passkey", "sso"],
  cookie: "pk_console_last_method",
  via: "pk-console-signin-via",
  salt: "pk-console-hint-salt",
  name: "pk-console-hint-name:",
  cookieAttrs: "Path=/manage; Max-Age=31536000; SameSite=Strict; Secure",
});
