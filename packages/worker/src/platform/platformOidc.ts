import type { Env } from "./env.js";

export interface PlatformOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

function str(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Read one `<PREFIX>_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` trio, or `null` when the issuer
 *  or client id is missing. The three fields always come from the same trio: a secret is never
 *  paired with another trio's client id. */
function trio(env: Env, prefix: string): PlatformOidcConfig | null {
  const issuer = str(env, `${prefix}_ISSUER`);
  const clientId = str(env, `${prefix}_CLIENT_ID`);
  if (!issuer || !clientId) return null;
  return {
    issuer,
    clientId,
    clientSecret: str(env, `${prefix}_CLIENT_SECRET`),
  };
}

/**
 * The platform IdP client (`PLATFORM_OIDC_*`): the customer portal's root sign-in and every
 * `provider: platform` product's end users.
 *
 * I-03 (S-16 §5.4 item 1): this no longer falls back to `ADMIN_OIDC_*`. Those names now belong to
 * the console's own client ({@link adminOidcConfig}), so a customer sign-in never goes through
 * the operators' client.
 */
export function platformOidcConfig(env: Env): PlatformOidcConfig | null {
  return trio(env, "PLATFORM_OIDC");
}

/**
 * The console's operator sign-in client (I-03). `ADMIN_OIDC_*` wins when both its issuer and
 * client id are set; otherwise the console falls back to the shared platform client, so a deploy
 * keeps working until the owner creates the console client and sets the admin trio.
 */
export function adminOidcConfig(env: Env): PlatformOidcConfig | null {
  return trio(env, "ADMIN_OIDC") ?? platformOidcConfig(env);
}

/** Whether the console has its own client, i.e. {@link adminOidcConfig} is not falling back. */
export function adminOidcIsDedicated(env: Env): boolean {
  return trio(env, "ADMIN_OIDC") !== null;
}
