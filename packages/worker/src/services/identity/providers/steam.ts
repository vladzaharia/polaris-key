/**
 * Sign in with Steam on the login card (I-06): OpenID 2.0 against Steam's fixed OP endpoint,
 * then the persona name and avatar from the Steam Web API with Polaris's key.
 *
 * OpenID 2.0 has no audience claim; its equivalents are checked instead (S-16 §5.4 item 2):
 *
 * - `openid.op_endpoint` must be Steam's endpoint, and the assertion is verified by Steam itself
 *   (`check_authentication`, stateless mode), never by trusting the redirect's parameters;
 * - `openid.return_to` must equal, exactly, the return URL this flow sent (its origin is the
 *   realm), and it must be among the `openid.signed` fields, so an assertion issued for another
 *   site, another flow or another path is refused;
 * - `openid.claimed_id` and `openid.identity` must be the same Steam identity URL and carry a
 *   SteamID64;
 * - every `openid.*` key (and `state`) must appear exactly once, and the body sent to
 *   `check_authentication` is built from those single values, so the identity checked locally is
 *   the identity Steam vouches for;
 * - `openid.response_nonce` must be fresh. Steam refuses a nonce it already verified, and the
 *   flow's `state` is single-use on our side, so an assertion cannot be replayed.
 *
 * Steam provides no email: the identity has none, and I-07's interstitial asks for one.
 */

import type { SteamClientConfig } from "./config.js";
import { ProviderVerifyError } from "./discovery.js";
import { gatedFetch, gatedJson, type ProviderFetch } from "./net.js";
import {
  cleanAvatarUrl,
  cleanDisplay,
  type ProviderSignInResult,
} from "./types.js";

export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
export const OPENID_NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const STEAM_IDENTITY_RE =
  /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const STEAM_PLAYER_SUMMARIES =
  "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/";

/** The account link's issuer key for Steam: the provider kind (a SteamID64 is global). */
export const STEAM_ISSUER_KEY = "steam";

/** How far a `response_nonce` timestamp may be from now. */
const NONCE_SKEW_SECONDS = 300;

/** The fields Steam must have signed for an assertion to be accepted. */
const REQUIRED_SIGNED = [
  "op_endpoint",
  "claimed_id",
  "identity",
  "return_to",
  "response_nonce",
  "assoc_handle",
];

/** Steam's avatar CDNs. */
const STEAM_AVATAR_HOSTS = ["steamstatic.com", "steamcdn-a.akamaihd.net"];

export function steamAuthorizeUrl(flow: {
  returnTo: string;
  realm: string;
}): string {
  const u = new URL(STEAM_OPENID_ENDPOINT);
  u.searchParams.set("openid.ns", OPENID_NS);
  u.searchParams.set("openid.mode", "checkid_setup");
  u.searchParams.set("openid.return_to", flow.returnTo);
  u.searchParams.set("openid.realm", flow.realm);
  u.searchParams.set("openid.identity", IDENTIFIER_SELECT);
  u.searchParams.set("openid.claimed_id", IDENTIFIER_SELECT);
  return u.toString();
}

/** `response_nonce` begins with its issue time, `YYYY-MM-DDTHH:MM:SSZ`. */
function nonceTime(nonce: string): number | null {
  const m = nonce.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
  if (!m?.[1]) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * Check the positive assertion in `params` (the callback's query) locally, then have Steam
 * verify it. Answers the SteamID64.
 */
export async function verifySteamAssertion(
  params: URLSearchParams,
  expect: { returnTo: string; nowSec: number },
  opts: { fetch?: ProviderFetch } = {},
): Promise<string> {
  // Every key must appear once. URLSearchParams.get answers the first occurrence while a body
  // rebuilt by iteration would carry the last, so a repeated key could make the local checks
  // and Steam's verdict look at two different assertions (a victim's claimed_id before the
  // attacker's genuinely signed one). Refuse rather than pick.
  const single = new Map<string, string>();
  for (const [k, v] of params) {
    if (!k.startsWith("openid.") && k !== "state") continue;
    if (single.has(k)) {
      throw new ProviderVerifyError("assertion repeats a parameter");
    }
    single.set(k, v);
  }
  const get = (k: string): string => single.get(`openid.${k}`) ?? "";
  if (get("ns") !== OPENID_NS) throw new ProviderVerifyError("not OpenID 2.0");
  if (get("mode") !== "id_res") {
    throw new ProviderVerifyError("not a positive assertion");
  }
  if (get("op_endpoint") !== STEAM_OPENID_ENDPOINT) {
    throw new ProviderVerifyError("assertion from another OP");
  }
  if (get("return_to") !== expect.returnTo) {
    throw new ProviderVerifyError("assertion for another return URL");
  }
  const claimed = get("claimed_id");
  const match = claimed.match(STEAM_IDENTITY_RE);
  if (!match?.[1] || get("identity") !== claimed) {
    throw new ProviderVerifyError("assertion names no Steam identity");
  }
  const signed = get("signed").split(",");
  if (!REQUIRED_SIGNED.every((f) => signed.includes(f))) {
    throw new ProviderVerifyError("assertion leaves a required field unsigned");
  }
  const issued = nonceTime(get("response_nonce"));
  if (
    issued === null ||
    Math.abs(expect.nowSec - issued) > NONCE_SKEW_SECONDS
  ) {
    throw new ProviderVerifyError("assertion is stale");
  }

  // Stateless verification: send back exactly the assertion checked above (one value per key),
  // mode switched, and require is_valid:true.
  const check = new URLSearchParams();
  for (const [k, v] of single) {
    if (k.startsWith("openid.")) check.set(k, v);
  }
  check.set("openid.mode", "check_authentication");
  const { status, body } = await gatedFetch(
    "steam",
    STEAM_OPENID_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: check.toString(),
    },
    opts.fetch,
  );
  const fields = new Map(
    body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(":");
        return [line.slice(0, i), line.slice(i + 1)] as const;
      }),
  );
  if (status !== 200 || fields.get("is_valid") !== "true") {
    throw new ProviderVerifyError("Steam did not confirm the assertion");
  }
  return match[1];
}

/** The persona name and avatar, or `null` when the Web API does not answer usefully. */
export async function steamPlayerSummary(
  client: SteamClientConfig,
  steamId: string,
  opts: { fetch?: ProviderFetch } = {},
): Promise<{ personaName: string | null; avatarUrl: string | null } | null> {
  const u = new URL(STEAM_PLAYER_SUMMARIES);
  u.searchParams.set("key", client.webApiKey);
  u.searchParams.set("steamids", steamId);
  try {
    const doc = await gatedJson(
      "steam",
      u.toString(),
      { headers: { accept: "application/json" } },
      opts.fetch,
    );
    const players = (doc.response as { players?: unknown } | undefined)
      ?.players;
    const player = Array.isArray(players)
      ? (players.find(
          (p) => (p as { steamid?: unknown })?.steamid === steamId,
        ) as Record<string, unknown> | undefined)
      : undefined;
    if (!player) return null;
    return {
      personaName: cleanDisplay(player.personaname, 64),
      avatarUrl: cleanAvatarUrl(player.avatarfull, STEAM_AVATAR_HOSTS),
    };
  } catch {
    // The profile is decoration; the sign-in itself was already verified by Steam.
    return null;
  }
}

export async function completeSteamSignIn(
  client: SteamClientConfig,
  params: URLSearchParams,
  expect: { returnTo: string; nowSec: number },
  opts: { fetch?: ProviderFetch } = {},
): Promise<ProviderSignInResult> {
  const steamId = await verifySteamAssertion(params, expect, opts);
  const summary = await steamPlayerSummary(client, steamId, opts);
  return {
    provider: "steam",
    identity: {
      issuerKey: STEAM_ISSUER_KEY,
      subject: steamId,
      kind: "steam",
      email: null,
      emailVerified: false,
      displayName: summary?.personaName ?? null,
      amr: ["steam"],
    },
    profile: {
      displayName: summary?.personaName ?? null,
      avatarUrl: summary?.avatarUrl ?? null,
    },
  };
}
