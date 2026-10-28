// FedCM provider for web automatic sign-in (I-46.6, Google). One typed function, no UI: the
// ladder calls `fedcmSignIn`, and the I-46.3 exchange consumes `{ token, nonce }`.
//
// Verified against a real Chromium (Playwright 1.63, Chromium 153.0.8010.12), 2026-10-27, with
// no Google account signed in and the user's mediation never shown:
//   - Google's config URL `https://accounts.google.com/gsi/fedcm.json` answers 200 with a valid
//     FedCM config: `accounts_endpoint`, `id_assertion_endpoint` (and the `idtoken_endpoint` /
//     `id_token_endpoint` aliases), `client_metadata_endpoint`, `login_url` (and `signin_url`),
//     `disconnect_endpoint`, `supports_add_account`, `modes` and `branding`.
//   - This Chromium reads BOTH `nonce` (top level of the provider) and `params` on an
//     IdentityProviderConfig (a getter probe saw `fields`, `loginHint`, `nonce` and `params`
//     accessed). The spec has moved the nonce into `params`; older builds only know the top
//     level. We send the same value in both, which every build that knows either accepts.
//     Not verified without signing in: which of the two Google's issuer reads. The id token's
//     own `nonce` claim is checked here either way, so a provider that ignores both is refused.
//   - `navigator.credentials.preventSilentAccess` is a function there.
// Safari and Firefox have no `IdentityCredential`: we report "unavailable" and the ladder falls
// back to the next rung.

export const GOOGLE_FEDCM_CONFIG_URL =
  "https://accounts.google.com/gsi/fedcm.json";

/** The silent attempt must not hold the page: give up after this long. */
export const FEDCM_TIMEOUT_MS = 8000;

export type FedcmMediation = "silent" | "optional" | "required";

export type FedcmResult =
  | { status: "token"; token: string; nonce: string }
  | {
      status: "unavailable";
      reason: "no-identity-credential" | "insecure-context";
    }
  /** The user dismissed the prompt, or no account is signed in to the provider. */
  | { status: "cancelled" }
  | { status: "timeout" }
  /** The token's `nonce` claim is not the one we sent: refused, never handed on. */
  | { status: "nonce-mismatch" }
  | { status: "error"; message: string };

export interface FedcmOptions {
  /** The provider's OIDC client id (the server's, not a per-device value). */
  clientId: string;
  /** A fresh single-use value the exchange later checks the token against. */
  nonce: string;
  configURL?: string;
  mediation?: FedcmMediation;
  timeoutMs?: number;
  /** Test seams; default to the page's own. */
  credentials?: CredentialsLike;
  hasIdentityCredential?: boolean;
  signal?: AbortSignal;
}

export interface CredentialsLike {
  get(options: unknown): Promise<unknown>;
  preventSilentAccess?: () => Promise<void>;
}

function pageCredentials(): CredentialsLike | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : (navigator.credentials as unknown as CredentialsLike | undefined);
}

function pageHasIdentityCredential(): boolean {
  return (
    typeof globalThis !== "undefined" && "IdentityCredential" in globalThis
  );
}

/** True when this browser can run FedCM at all (Chromium only; not Safari or Firefox). */
export function fedcmAvailable(): boolean {
  return pageHasIdentityCredential() && !!pageCredentials();
}

/** The `nonce` claim of a JWT, read without verifying (the server verifies the signature). */
function tokenNonce(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(
      atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")),
      (c) => c.charCodeAt(0),
    );
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as {
      nonce?: unknown;
    };
    return typeof claims.nonce === "string" ? claims.nonce : undefined;
  } catch {
    return undefined;
  }
}

export async function fedcmSignIn(opts: FedcmOptions): Promise<FedcmResult> {
  const has = opts.hasIdentityCredential ?? pageHasIdentityCredential();
  const credentials = opts.credentials ?? pageCredentials();
  if (!has || !credentials)
    return { status: "unavailable", reason: "no-identity-credential" };
  if (
    typeof isSecureContext !== "undefined" &&
    !isSecureContext &&
    !opts.credentials
  ) {
    return { status: "unavailable", reason: "insecure-context" };
  }

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, opts.timeoutMs ?? FEDCM_TIMEOUT_MS);
  const onOuterAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (opts.signal?.aborted) ac.abort();

  try {
    const cred = (await credentials.get({
      identity: {
        providers: [
          {
            configURL: opts.configURL ?? GOOGLE_FEDCM_CONFIG_URL,
            clientId: opts.clientId,
            nonce: opts.nonce,
            params: { nonce: opts.nonce },
          },
        ],
      },
      mediation: opts.mediation ?? "silent",
      signal: ac.signal,
    })) as { token?: unknown } | null;
    const token = cred?.token;
    // `null` is a silent attempt with nothing to offer (no signed-in account).
    if (typeof token !== "string" || token === "")
      return { status: "cancelled" };
    if (tokenNonce(token) !== opts.nonce) return { status: "nonce-mismatch" };
    return { status: "token", token, nonce: opts.nonce };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (timedOut) return { status: "timeout" };
    if (name === "AbortError" || name === "NotAllowedError")
      return { status: "cancelled" };
    return { status: "error", message: (e as Error)?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Sign-out: stop the browser auto-selecting the account again. Best effort; never throws. */
export async function fedcmPreventSilentAccess(
  credentials: CredentialsLike | undefined = pageCredentials(),
): Promise<void> {
  try {
    await credentials?.preventSilentAccess?.();
  } catch {
    // A browser without FedCM, or a refused call, leaves nothing to undo.
  }
}
