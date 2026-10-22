/**
 * The CLI's credential store (ST-34.7): where `pkey login` keeps a personal token and what
 * `pkey whoami` and `pkey logout` read it back from.
 *
 *   storage     the OS credential store (macOS Keychain, Windows Credential Manager, Secret Service)
 *               through `@napi-rs/keyring`, an optional dependency loaded on first use and kept out
 *               of the Action bundle (bundle-action.mjs aliases it to a stub that throws). There
 *               is NO file fallback: a computer without a store refuses and names
 *               `PKEY_ADMIN_TOKEN`. (Shelling out to `security` would put the secret in argv, and
 *               Windows has no reader to shell to.) On Linux every entry is pinned to the Secret
 *               Service: unpinned, the module falls back silently to the kernel keyutils keyring
 *               (in memory, readable by the user's other processes, gone at reboot), the finding
 *               sdk-node closed as R4-11.
 *   binding     an entry is keyed by ORIGIN (service `pkey`, account `https://host[:port]`), so a
 *               token minted by one origin is looked up only for that origin and can never be
 *               offered to another. The origin is read after `normalizeBaseUrl`'s https-or-loopback
 *               rule, before anything is sent.
 *   no echo     nothing here puts a token in a message, a log or an error. A store failure is
 *               reported by a fixed sentence; the underlying error text is dropped.
 *   encoding    the entry is JSON `{t, e, l, h}`: token, expiresAt (epoch seconds), label, last-4
 *               hint. Frozen with ST-34.7; a bare `{t, e}` and a bare token still read. The store
 *               holds `pkeyp_` tokens only.
 *   resolution  `PKEY_ADMIN_TOKEN` (a `pkeya_` or `pkeyp_` shape) first, then the store for the
 *               origin, else "Not signed in".
 */

import { ADMIN_TOKEN_ENV, normalizeBaseUrl } from "./bundle.js";

export const KEYCHAIN_SERVICE = "pkey";

/** `pkeya_` (admin API) or `pkeyp_` (personal): the prefix plus 256 bits, as the Worker checks. */
const CREDENTIAL_SHAPE = /^pkey[ap]_[A-Za-z0-9_-]{43,}$/;
const PERSONAL_SHAPE = /^pkeyp_[A-Za-z0-9_-]{43,}$/;

export function isCredentialShape(value: string): boolean {
  return CREDENTIAL_SHAPE.test(value);
}

/** The store keeps personal tokens only: a `pkeya_` is a CI credential and never lives here. */
export function isPersonalShape(value: string): boolean {
  return PERSONAL_SHAPE.test(value);
}

/** What the store keeps for an origin: the token, and what `pkey login` knew about it. */
export interface StoredCredential {
  token: string;
  /** Epoch seconds; `null` when unknown. */
  expiresAt: number | null;
  /** The label the token was minted under ("pkey on key.plrs.im"); absent in an older entry. */
  label?: string | null;
  /** The token's last four characters, to tell it from another in Personal tokens. */
  hint?: string | null;
}

/** A credential's last four characters, as the console lists it ("…h7Q2"). */
export function hintOf(c: Pick<StoredCredential, "token" | "hint">): string {
  return c.hint ?? c.token.slice(-4);
}

export interface CredentialStore {
  get(origin: string): StoredCredential | null;
  set(origin: string, credential: StoredCredential): void;
  /** True when an entry was removed. */
  delete(origin: string): boolean;
}

/** A refusal (exit 4): the sentence, the one fix, and the `--json` error code. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly fix?: string,
    readonly code: string = "refused",
  ) {
    super(message);
    this.name = "Refusal";
  }
}

/** The tail of a fix that names no command; the account commands put theirs in its place. */
export const COMMAND_AGAIN = "run the command again";

/** No usable store here (no keyring module, no keychain service). Never carries a token. */
export class NoStoreError extends Refusal {
  constructor() {
    super(
      "No credential store on this computer.",
      `Set ${ADMIN_TOKEN_ENV} to a personal token (pkeyp_…) instead.`,
      "no-credential-store",
    );
    this.name = "NoStoreError";
  }
}

/** The store is there and said no: a denied keychain prompt, a locked Secret Service. */
export class KeychainRefusedError extends Refusal {
  constructor() {
    super(
      "The credential store refused access.",
      `Allow pkey when it asks, or unlock the store, then ${COMMAND_AGAIN}.`,
      "keychain-refused",
    );
    this.name = "KeychainRefusedError";
  }
}

/** The origin a credential is bound to: `https://host[:port]`, lowercased by `URL`. */
export function originOf(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl, ADMIN_TOKEN_ENV)).origin;
}

/** The value kept in the store: JSON, so the end date travels with the token. */
export function encode(c: StoredCredential): string {
  if (!isPersonalShape(c.token))
    throw new Error("The credential store keeps personal tokens only.");
  return JSON.stringify({
    t: c.token,
    e: c.expiresAt,
    l: c.label ?? null,
    h: hintOf(c),
  });
}

const short = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;

export function decode(raw: string): StoredCredential | null {
  try {
    const v = JSON.parse(raw) as {
      t?: unknown;
      e?: unknown;
      l?: unknown;
      h?: unknown;
    };
    if (typeof v.t === "string" && isPersonalShape(v.t))
      return {
        token: v.t,
        expiresAt: typeof v.e === "number" && v.e > 0 ? v.e : null,
        label: short(v.l),
        hint: typeof v.h === "string" && /^.{1,8}$/.test(v.h) ? v.h : null,
      };
    return null;
  } catch {
    /* fall through: a bare token written by hand */
  }
  return isPersonalShape(raw) ? { token: raw, expiresAt: null } : null;
}

/** The test backend: a map, nothing persisted. */
export function memoryStore(
  seed: Record<string, StoredCredential> = {},
): CredentialStore & { entries: Map<string, StoredCredential> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    get: (origin) => entries.get(origin) ?? null,
    set: (origin, c) => {
      if (!isPersonalShape(c.token))
        throw new Error("The credential store keeps personal tokens only.");
      entries.set(origin, { ...c });
    },
    delete: (origin) => entries.delete(origin),
  };
}

/** The slice of `@napi-rs/keyring` used here. */
interface KeyringModule {
  Entry: new (
    service: string,
    account: string,
    options?: { linux?: { store: "secret-service" } },
  ) => {
    getPassword(): string | null;
    setPassword(value: string): void;
    deletePassword(): boolean;
  };
}

/** A keyring failure that means "the store said no", not "there is no store". Text is never shown. */
const REFUSED =
  /NoStorageAccess|denied|locked|cancel|interaction|authori[sz]|not allowed|permission/i;

/**
 * The OS store. `load` and `platform` are the test seams; the default imports `@napi-rs/keyring`
 * on first call, and a failure to load (not installed on this platform, a stub in the Action) is
 * a `NoStoreError`. On Linux every entry is pinned to the Secret Service.
 */
export async function keyringStore(
  load: () => Promise<KeyringModule> = () =>
    import("@napi-rs/keyring") as Promise<KeyringModule>,
  platform: NodeJS.Platform = process.platform,
): Promise<CredentialStore> {
  let mod: KeyringModule;
  try {
    mod = await load();
  } catch {
    throw new NoStoreError();
  }
  // Every call is wrapped: the keyring's own error text is never shown, only classified.
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw REFUSED.test(e instanceof Error ? e.message : String(e))
        ? new KeychainRefusedError()
        : new NoStoreError();
    }
  };
  const entry = (origin: string) =>
    new mod.Entry(
      KEYCHAIN_SERVICE,
      origin,
      platform === "linux" ? { linux: { store: "secret-service" } } : undefined,
    );
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
  /** The stored label and last-4 hint; absent for the environment's token. */
  label?: string | null;
  hint?: string | null;
}

/**
 * The credential for `baseUrl`: `PKEY_ADMIN_TOKEN` when set, else the store's entry for that
 * origin. `store` is a thunk so the keychain is never touched when the env token answers.
 * Throws `Refusal` when there is none or the env value is not a token.
 */
export async function adminCredential(opts: {
  env: Readonly<Record<string, string | undefined>>;
  baseUrl: string;
  store: () => Promise<CredentialStore>;
}): Promise<ResolvedCredential> {
  const origin = originOf(opts.baseUrl);
  const fromEnv = opts.env[ADMIN_TOKEN_ENV]?.trim();
  if (fromEnv) {
    if (!isCredentialShape(fromEnv))
      throw new Refusal(
        `${ADMIN_TOKEN_ENV} is not a pkeya_ or pkeyp_ token.`,
        "Copy it again whole.",
        "env-token-refused",
      );
    return { token: fromEnv, source: "env", origin, expiresAt: null };
  }
  const stored = (await opts.store()).get(origin);
  if (!stored)
    throw new Refusal(
      `Not signed in to ${new URL(origin).host}.`,
      "Run pkey login.",
      "not-signed-in",
    );
  return {
    token: stored.token,
    source: "store",
    origin,
    expiresAt: stored.expiresAt,
    label: stored.label ?? null,
    hint: hintOf(stored),
  };
}
