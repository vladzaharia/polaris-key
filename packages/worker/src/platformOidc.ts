import type { Env } from "./env.js";

export interface PlatformOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

export function platformOidcConfig(env: Env): PlatformOidcConfig | null {
  const issuer =
    typeof env.PLATFORM_OIDC_ISSUER === "string"
      ? env.PLATFORM_OIDC_ISSUER
      : typeof env.ADMIN_OIDC_ISSUER === "string"
        ? env.ADMIN_OIDC_ISSUER
        : undefined;
  const clientId =
    typeof env.PLATFORM_OIDC_CLIENT_ID === "string"
      ? env.PLATFORM_OIDC_CLIENT_ID
      : typeof env.ADMIN_OIDC_CLIENT_ID === "string"
        ? env.ADMIN_OIDC_CLIENT_ID
        : undefined;
  if (!issuer || !clientId) return null;
  const clientSecret =
    typeof env.PLATFORM_OIDC_CLIENT_SECRET === "string"
      ? env.PLATFORM_OIDC_CLIENT_SECRET
      : typeof env.ADMIN_OIDC_CLIENT_SECRET === "string"
        ? env.ADMIN_OIDC_CLIENT_SECRET
        : undefined;
  return { issuer, clientId, clientSecret };
}
