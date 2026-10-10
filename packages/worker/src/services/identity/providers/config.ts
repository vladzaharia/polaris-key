/**
 * The login card's platform clients (I-06; S-16 §5.2): one Google OAuth client, one Apple
 * Services ID and one Steam Web API key, registered once by Polaris for the whole deployment.
 * They are account sign-in methods, so nothing here reads a product or its Identity toggle
 * (owner, 2026-10-04): the portal and the Library use them for every product.
 *
 * Configuration lives in the Worker environment, per deployment:
 *
 *   SIGNIN_GOOGLE_CLIENT_ID      var     the OAuth client id (`….apps.googleusercontent.com`)
 *   SIGNIN_GOOGLE_CLIENT_SECRET  secret  SEALED: the client secret
 *   SIGNIN_APPLE_SERVICES_ID     var     the Services ID (the login card's `client_id`)
 *   SIGNIN_APPLE_TEAM_ID         var     the Apple Developer Team ID (10 characters)
 *   SIGNIN_APPLE_KEY_ID          var     the Sign in with Apple key's id (10 characters)
 *   SIGNIN_APPLE_PRIVATE_KEY     secret  SEALED: the key's `.p8` (PKCS#8 PEM)
 *   SIGNIN_STEAM_WEB_API_KEY     secret  SEALED: the Steam Web API key
 *
 * **Sealed** means the secret's value is not the credential itself but a `keyvault.seal` blob
 * under the platform KEK, bound to the slot `pkey:v2:_platform:signin-provider-secret:<id>`
 * (`signInSecretContext`). The blob opens nowhere else (no product slug can spell `_platform`,
 * and the kind is its own), and a copy of the Worker secret without the KEK is inert. The owner
 * seals a value with `pnpm --filter @polaris-key/worker signin:seal` (RUNBOOK).
 *
 * **Fail closed.** A provider is offered only when every one of its values is present and its
 * sealed secret opens; a missing client id therefore never reaches audience checking — there is
 * no "unset audience" state in which a token for any audience would pass.
 */

import { open, type SealContext } from "../../../keyvault.js";
import type { Env } from "../../../env.js";
import { secret } from "../../../env.js";

export const SIGNIN_PROVIDER_KINDS = ["google", "apple", "steam"] as const;
export type SignInProviderKind = (typeof SIGNIN_PROVIDER_KINDS)[number];

export function isSignInProviderKind(v: unknown): v is SignInProviderKind {
  return (
    typeof v === "string" &&
    (SIGNIN_PROVIDER_KINDS as readonly string[]).includes(v)
  );
}

/** The sealed slots. */
export const SIGNIN_SECRET_IDS = {
  google: "google-client-secret",
  apple: "apple-p8",
  steam: "steam-web-api-key",
} as const satisfies Record<SignInProviderKind, string>;

export type SignInSecretId =
  (typeof SIGNIN_SECRET_IDS)[keyof typeof SIGNIN_SECRET_IDS];

/** The product slot every sign-in provider secret is sealed under. No slug can spell it. */
export const SIGNIN_SEAL_PRODUCT = "_platform";

export function signInSecretContext(id: SignInSecretId): SealContext {
  return { product: SIGNIN_SEAL_PRODUCT, kind: "signin-provider-secret", id };
}

/** The Worker variable names, by provider: plain values, then the one sealed secret. */
export const SIGNIN_ENV = {
  google: {
    vars: ["SIGNIN_GOOGLE_CLIENT_ID"],
    sealed: "SIGNIN_GOOGLE_CLIENT_SECRET",
  },
  apple: {
    vars: [
      "SIGNIN_APPLE_SERVICES_ID",
      "SIGNIN_APPLE_TEAM_ID",
      "SIGNIN_APPLE_KEY_ID",
    ],
    sealed: "SIGNIN_APPLE_PRIVATE_KEY",
  },
  steam: { vars: [], sealed: "SIGNIN_STEAM_WEB_API_KEY" },
} as const satisfies Record<
  SignInProviderKind,
  { vars: readonly string[]; sealed: string }
>;

export interface GoogleClientConfig {
  kind: "google";
  clientId: string;
  clientSecret: string;
}

export interface AppleClientConfig {
  kind: "apple";
  servicesId: string;
  teamId: string;
  keyId: string;
  /** The `.p8`, PKCS#8 PEM. Never leaves this service except as an ES256 client secret. */
  privateKeyPem: string;
}

export interface SteamClientConfig {
  kind: "steam";
  webApiKey: string;
}

export type SignInClientConfig =
  | GoogleClientConfig
  | AppleClientConfig
  | SteamClientConfig;

type ConfigFor<K extends SignInProviderKind> = Extract<
  SignInClientConfig,
  { kind: K }
>;

const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
/** A client id or Services ID: printable, no whitespace, bounded. */
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{3,200}$/;

function value(env: Env, name: string): string | null {
  const v = secret(env, name)?.trim();
  return v ? v : null;
}

/**
 * Whether every value of `kind` is present. Cheap and synchronous (opens nothing), for listing
 * the providers the login card may show; `resolveSignInClient` still decides whether one works.
 */
export function signInProviderConfigured(
  env: Env,
  kind: SignInProviderKind,
): boolean {
  const spec = SIGNIN_ENV[kind];
  return (
    spec.vars.every((name) => value(env, name) !== null) &&
    value(env, spec.sealed) !== null
  );
}

/** The configured providers, in the login card's order. */
export function configuredSignInProviders(env: Env): SignInProviderKind[] {
  return SIGNIN_PROVIDER_KINDS.filter((k) => signInProviderConfigured(env, k));
}

async function openSealed(
  env: Env,
  kind: SignInProviderKind,
): Promise<string | null> {
  const blob = value(env, SIGNIN_ENV[kind].sealed);
  if (!blob) return null;
  try {
    const plain = (
      await open(env, blob, signInSecretContext(SIGNIN_SECRET_IDS[kind]))
    ).trim();
    return plain || null;
  } catch {
    // An unsealed value, the wrong slot, an unknown KEK: all "not configured".
    return null;
  }
}

/** The provider's client, or `null` when any value is missing, malformed or will not open. */
export async function resolveSignInClient<K extends SignInProviderKind>(
  env: Env,
  kind: K,
): Promise<ConfigFor<K> | null> {
  if (!signInProviderConfigured(env, kind)) return null;
  switch (kind) {
    case "google": {
      const clientId = value(env, "SIGNIN_GOOGLE_CLIENT_ID")!;
      if (!CLIENT_ID_RE.test(clientId)) return null;
      const clientSecret = await openSealed(env, "google");
      if (!clientSecret) return null;
      return { kind: "google", clientId, clientSecret } as ConfigFor<K>;
    }
    case "apple": {
      const servicesId = value(env, "SIGNIN_APPLE_SERVICES_ID")!;
      const teamId = value(env, "SIGNIN_APPLE_TEAM_ID")!;
      const keyId = value(env, "SIGNIN_APPLE_KEY_ID")!;
      if (
        !CLIENT_ID_RE.test(servicesId) ||
        !APPLE_ID_RE.test(teamId) ||
        !APPLE_ID_RE.test(keyId)
      ) {
        return null;
      }
      const privateKeyPem = await openSealed(env, "apple");
      if (!privateKeyPem?.includes("BEGIN PRIVATE KEY")) return null;
      return {
        kind: "apple",
        servicesId,
        teamId,
        keyId,
        privateKeyPem,
      } as ConfigFor<K>;
    }
    case "steam": {
      const webApiKey = await openSealed(env, "steam");
      if (!webApiKey || !/^[A-Za-z0-9]{16,64}$/.test(webApiKey)) return null;
      return { kind: "steam", webApiKey } as ConfigFor<K>;
    }
  }
  return null;
}
