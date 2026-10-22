/**
 * The CLI's credential store (ST-34.7): where `pkey login` keeps a personal token and what
 * `pkey whoami` and `pkey logout` read it back from.
 *
 *   storage     the OS credential store (macOS Keychain, Windows Credential Manager, Secret Service)
 *               through `@napi-rs/keyring`, an optional dependency loaded on first use and kept out
 *               of the Action bundle. There is NO file fallback: a machine without a store refuses
 *               and names `PKEY_ADMIN_TOKEN`. (Shelling out to `security` would put the secret in
 *               argv, and Windows has no reader to shell to.)
 *   binding     an entry is keyed by ORIGIN (service `pkey`, account `https://host[:port]`), so a
 *               token minted by one origin is looked up only for that origin and can never be
 *               offered to another. The origin is read after `normalizeBaseUrl`'s https-or-loopback
 *               rule, before anything is sent.
 *   no echo     nothing here puts a token in a message, a log or an error. A store failure is
 *               reported by a fixed sentence; the underlying error text is dropped.
 *   resolution  `PKEY_ADMIN_TOKEN` (a `pkeya_` or `pkeyp_` shape) first, then the store for the
 *               origin, else "Not signed in".
 */

import { ADMIN_TOKEN_ENV, normalizeBaseUrl } from "./bundle.js";
import { RETIRED_COOKIE_REFUSAL, retiredCookieSet } from "./retired.js";

export const KEYCHAIN_SERVICE = "pkey";

/** `pkeya_` (admin API) or `pkeyp_` (personal): the prefix plus 256 bits, as the Worker checks. */
const CREDENTIAL_SHAPE = /^pkey[ap]_[A-Za-z0-9_-]{43,}$/;

export function isCredentialShape(value: string): boolean {
  return CREDENTIAL_SHAPE.test(value);
}

/** What the store keeps for an origin: the token, and when it ends where `pkey login` knew. */
export interface StoredCredential {
  token: string;
  /** Epoch seconds; `null` when unknown. */
  expiresAt: number | null;
}

export interface CredentialStore {
  get(origin: string): StoredCredential | null;
  set(origin: string, credential: StoredCredential): void;
  /** True when an entry was removed. */
  delete(origin: string): boolean;
}

/** A refusal (exit 4): the sentence, and the one fix. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

/** No usable store here (no keyring module, no keychain service). Never carries a token. */
export class NoStoreError extends Refusal {
  constructor() {
    super(
      "No credential store on this machine.",
      `Set ${ADMIN_TOKEN_ENV} instead.`,
    );
    this.name = "NoStoreError";
  }
}

/** The origin a credential is bound to: `https://host[:port]`, lowercased by `URL`. */
export function originOf(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl, ADMIN_TOKEN_ENV)).origin;
}

/** The value kept in the store: JSON, so the end date travels with the token. */
function encode(c: StoredCredential): string {
  return JSON.stringify({ t: c.token, e: c.expiresAt });
}

function decode(raw: string): StoredCredential | null {
  try {
    const v = JSON.parse(raw) as { t?: unknown; e?: unknown };
    if (typeof v.t === "string" && isCredentialShape(v.t))
      return {
        token: v.t,
        expiresAt: typeof v.e === "number" && v.e > 0 ? v.e : null,
      };
  } catch {
    /* fall through: a bare token written by hand */
  }
  return isCredentialShape(raw) ? { token: raw, expiresAt: null } : null;
}

/** The test backend: a map, nothing persisted. */
export function memoryStore(
  seed: Record<string, StoredCredential> = {},
): CredentialStore & { entries: Map<string, StoredCredential> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    get: (origin) => entries.get(origin) ?? null,
    set: (origin, c) => void entries.set(origin, { ...c }),
    delete: (origin) => entries.delete(origin),
  };
}

/** The slice of `@napi-rs/keyring` used here. */
interface KeyringModule {
  Entry: new (
    service: string,
    account: string,
  ) => {
    getPassword(): string | null;
    setPassword(value: string): void;
    deletePassword(): boolean;
  };
}

/**
 * The OS store. `load` is the test seam; the default imports `@napi-rs/keyring` on first call,
 * and any failure (not installed on this platform, no Secret Service daemon) is a `NoStoreError`.
 */
export async function keyringStore(
  load: () => Promise<KeyringModule> = () =>
    import("@napi-rs/keyring") as Promise<KeyringModule>,
): Promise<CredentialStore> {
  let mod: KeyringModule;
  try {
    mod = await load();
  } catch {
    throw new NoStoreError();
  }
  // Every call is wrapped: the keyring's own error text is never shown.
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch {
      throw new NoStoreError();
    }
  };
  const entry = (origin: string) => new mod.Entry(KEYCHAIN_SERVICE, origin);
  return {
    get: (origin) =>
      guard(() => {
        const raw = entry(origin).getPassword();
        return raw ? decode(raw) : null;
      }),
    set: (origin, c) => guard(() => entry(origin).setPassword(encode(c))),
    delete: (origin) => guard(() => entry(origin).deletePassword()),
  };
}

export interface ResolvedCredential {
  token: string;
  source: "env" | "store";
  /** The origin this credential is for (the one it will be sent to). */
  origin: string;
  expiresAt: number | null;
}

/**
 * The credential for `baseUrl`: `PKEY_ADMIN_TOKEN` when set, else the store's entry for that
 * origin. `store` is a thunk so the keychain is never touched when the env token answers.
 * Throws `Refusal` when there is none, the env value is not a token, or the retired
 * cookie variable is set (`retired.ts`).
 */
export async function adminCredential(opts: {
  env: Readonly<Record<string, string | undefined>>;
  baseUrl: string;
  store: () => Promise<CredentialStore>;
}): Promise<ResolvedCredential> {
  // Before the origin is read and before the store is opened: nothing is sent, nothing is looked up.
  if (retiredCookieSet(opts.env))
    throw new Refusal(
      RETIRED_COOKIE_REFUSAL.message,
      RETIRED_COOKIE_REFUSAL.fix,
    );
  const origin = originOf(opts.baseUrl);
  const fromEnv = opts.env[ADMIN_TOKEN_ENV]?.trim();
  if (fromEnv) {
    if (!isCredentialShape(fromEnv))
      throw new Refusal(
        `${ADMIN_TOKEN_ENV} is not a pkeya_ or pkeyp_ token.`,
        "Copy it again whole.",
      );
    return { token: fromEnv, source: "env", origin, expiresAt: null };
  }
  const stored = (await opts.store()).get(origin);
  if (!stored)
    throw new Refusal(
      `Not signed in to ${new URL(origin).host}.`,
      "Run pkey login.",
    );
  return {
    token: stored.token,
    source: "store",
    origin,
    expiresAt: stored.expiresAt,
  };
}
