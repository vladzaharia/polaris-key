// The web `autoSignIn()` ladder (plan-auto-sign-in §1; I-46.4). Loaded on demand: the page bundle
// pays nothing for it until the first call.
//
//   rung 1  a stored bearer token                       -> `signedIn` (via "stored")
//   rung 2  a restore secret                            -> skipped on the web (I-49)
//   rung 3  the provider asks silently                  -> the exchange
//   rung 4  the provider may show its chooser           -> the exchange, only with the
//                                                          developer's `prompt: "optional"` (D-A12)
//
// After an explicit sign-out the flag in the bearer store skips rungs 3 and 4 until the next
// explicit sign-in clears it, so nothing silent survives a sign-out on this device.
//
// A provider that offers no token ends its rung without an error; a refusal from the Worker is a
// typed `PolarisError`, except `device_limit` (a result) and `unsupported_grant_type` (an older
// Worker: the rung simply failed, §2.7). The subject token, the grant and the link handle are
// never logged.

import type { DeviceKeyPort } from "@polaris-key/client-core";
import { ErrorCode } from "../../constants.generated.js";
import type {
  AutoSignInOptions,
  AutoSignInResult,
  AutoSignInUnavailable,
  AutoSyncKey,
  PlatformIdentityProvider,
  PlatformMediation,
} from "../../core/signIn.js";
import { PolarisError } from "../../core/types.js";
import type { ExchangeDiscovery } from "../discovery.js";
import {
  fedcmAvailable,
  fedcmPreventSilentAccess,
  fedcmSignIn,
} from "../platformIdentity/fedcm.js";
import type { KeyringClient } from "../../core/keyring.js";
import type { BearerSession } from "./session.js";
import { EXCHANGE_ABORTED, hidden, type ExchangeOutcome } from "./exchange.js";

/** What the ladder reads from the adapter. */
export interface AutoSignInContext {
  bearer: BearerSession;
  port: DeviceKeyPort;
  /** The provider to ask, or null where this browser has none. */
  provider: PlatformIdentityProvider | null;
  /** Discovery's platform sign-in, or null. */
  endpoints: ExchangeDiscovery | null;
  /** True after an explicit sign-out and until the next explicit sign-in. */
  explicitSignOut(): Promise<boolean>;
  /** The sign-out generation: bumped by every `signOut()`. A ladder whose generation changed
   *  abandons its sign-in before it stores a token. */
  generation(): number;
  /** `present`/`needed` from the ring engine when E2E is on here, else undefined. */
  syncKey(): Promise<AutoSyncKey | undefined>;
}

/** Google through FedCM (I-46.6). `clientId` is the product's server client id from discovery. */
export function fedcmGoogleProvider(
  clientId: () => string | undefined,
): PlatformIdentityProvider {
  return {
    kind: "google",
    available: () => fedcmAvailable() && clientId() !== undefined,
    async token(nonce, mediation) {
      const id = clientId();
      if (id === undefined) return null;
      const r = await fedcmSignIn({ clientId: id, nonce, mediation });
      return r.status === "token" ? r.token : null;
    },
    signOutCleanup: () => fedcmPreventSilentAccess(),
  };
}

/** Cloud Sync's root key for the result, read through the `KeyringClient` interface only (the
 *  engine stays lazy): `present` when unlocked, else `needed`; absent where no E2E client runs. */
export async function ringSyncKey(
  ring: Pick<KeyringClient, "unsupported" | "status">,
): Promise<AutoSyncKey | undefined> {
  if (ring.unsupported !== null) return undefined;
  try {
    return (await ring.status()).state === "unlocked" ? "present" : "needed";
  } catch {
    return undefined;
  }
}

/** Sign-out: let the provider stop choosing the account. Never throws. */
export async function runSignOutCleanup(
  provider: PlatformIdentityProvider | null,
): Promise<void> {
  try {
    await provider?.signOutCleanup();
  } catch {
    // best effort
  }
}

/** Thrown from `subjectToken` when the provider offered nothing; ends the rung, not the call. */
class NoProviderToken extends Error {}

/** A sign-out happened while the ladder ran. */
class SignedOutDuringLadder extends Error {}

const unavailable = (code: AutoSignInUnavailable): AutoSignInResult => ({
  kind: "unavailable",
  code,
});

const needs = (reason: "signedOut" | "noCredential"): AutoSignInResult => ({
  kind: "needsSignIn",
  reason,
});

/** Carry the non-enumerable secrets of an exchange outcome onto the result. */
function resultOf(o: ExchangeOutcome): AutoSignInResult {
  switch (o.kind) {
    case "signedIn":
      return {
        kind: "signedIn",
        via: "platform",
        subject: o.subject,
        scope: o.scope,
        activation: o.activation,
        ...(o.syncError ? { syncError: o.syncError } : {}),
      };
    case "pendingConsent":
      return hidden(
        { kind: "confirm", expiresIn: o.expiresIn, consent: o.consent },
        "grant",
        o.grant,
      ) as AutoSignInResult;
    case "pendingSignIn":
      return hidden(
        { kind: "choose", expiresIn: o.expiresIn, choices: o.choices },
        "grant",
        o.grant,
      ) as AutoSignInResult;
    case "needsSignIn": {
      const r = {
        kind: "needsSignIn" as const,
        reason: o.reason === "terms" ? ("terms" as const) : ("noLink" as const),
        url: o.url,
        ...(o.expiresIn !== undefined ? { expiresIn: o.expiresIn } : {}),
      };
      return o.linkHandle !== undefined
        ? (hidden(r, "linkHandle", o.linkHandle) as AutoSignInResult)
        : r;
    }
    case "unavailable":
      return unavailable(o.reason);
  }
}

/** One exchange attempt at one mediation; `null` when the provider offered no token. */
async function attempt(
  ctx: AutoSignInContext,
  provider: PlatformIdentityProvider,
  mediation: PlatformMediation,
  opts: AutoSignInOptions,
  generation: number,
): Promise<AutoSignInResult | null> {
  const stillOn = async () =>
    ctx.generation() === generation && !(await ctx.explicitSignOut());
  try {
    const outcome = await ctx.bearer.exchange(ctx.port, {
      mayStore: stillOn,
      kind: provider.kind,
      licenseChoice: opts.licenseChoice ?? "app",
      ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
      subjectToken: async (nonce) => {
        const token = await provider.token(nonce, mediation);
        if (token === null) throw new NoProviderToken();
        // Signed out while the provider was answering: the token goes nowhere.
        if (!(await stillOn())) throw new SignedOutDuringLadder();
        return token;
      },
    });
    return resultOf(outcome);
  } catch (e) {
    if (e instanceof NoProviderToken) return null;
    if (
      e instanceof SignedOutDuringLadder ||
      (e as { name?: string } | null)?.name === EXCHANGE_ABORTED
    )
      return needs("signedOut");
    if (e instanceof PolarisError) {
      if (e.wireCode === ErrorCode.deviceLimit)
        return {
          kind: "deviceLimit",
          ...(e.manageUrl !== undefined ? { manageUrl: e.manageUrl } : {}),
        };
      // An older Worker does not know the grant: this rung failed, the form still works.
      if (e.wireCode === ErrorCode.unsupportedGrantType) return null;
    }
    throw e;
  }
}

/** True for a cancellation, the one thing the ladder rethrows. */
const isAbort = (e: unknown): boolean =>
  (e as { name?: string } | null)?.name === "AbortError";

/**
 * The ladder. It never throws except a cancellation (`AbortError`): a refusal or a failure is
 * `unavailable(code)`, and `device_limit` is `deviceLimit`.
 */
export async function runAutoSignIn(
  ctx: AutoSignInContext,
  opts: AutoSignInOptions = {},
): Promise<AutoSignInResult> {
  try {
    return await ladder(ctx, opts);
  } catch (e) {
    if (isAbort(e)) throw e;
    return unavailable(
      e instanceof PolarisError && e.code === ErrorCode.networkError
        ? "network"
        : "refused",
    );
  }
}

async function ladder(
  ctx: AutoSignInContext,
  opts: AutoSignInOptions,
): Promise<AutoSignInResult> {
  const b = ctx.bearer;
  const generation = ctx.generation();
  await b.init();

  // Rung 1. Only a token a sign-in produced counts: an anonymous registration, a key activation
  // and a token stored before provenance was kept are devices, not a sign-in.
  if (b.hasToken && b.provenance === "signin") {
    const syncKey = await ctx.syncKey();
    return {
      kind: "signedIn",
      via: "stored",
      subject: b.account,
      ...(syncKey !== undefined ? { syncKey } : {}),
    };
  }

  // Rung 2 (a restore secret) is not built on the web (I-49).

  if (await ctx.explicitSignOut()) return needs("signedOut");
  const provider = ctx.provider;
  if (provider !== null) {
    if (ctx.endpoints === null) return unavailable("product");
    if (!ctx.endpoints.kinds.includes(provider.kind))
      return unavailable("kind");
  }
  if (provider === null || !provider.available()) return needs("noCredential");

  const silent = await attempt(ctx, provider, "silent", opts, generation);
  const result =
    silent ??
    (opts.prompt === "optional"
      ? await attempt(ctx, provider, "optional", opts, generation)
      : null);
  if (result === null) return needs("noCredential");
  if (result.kind !== "signedIn") return result;
  const syncKey = await ctx.syncKey();
  return syncKey !== undefined ? { ...result, syncKey } : result;
}
