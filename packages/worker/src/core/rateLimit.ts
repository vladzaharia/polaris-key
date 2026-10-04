/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../env.js";

// Abuse protection on the credential-minting hot paths (activate/token/mint) and admin login.
// Backed by an atomic per-product Durable Object (`../rateLimitDo.ts`) so concurrent bursts
// can't slip past a non-atomic counter. Keyed by (product, bucket, id) — product-scoped like
// everything else.
//
// Only this CLIENT half lives in core. `RateLimitDO` itself stays at `src/rateLimitDo.ts`,
// re-exported by `src/index.ts`: wrangler binds the class by NAME off the entrypoint's exports
// (`[[durable_objects.bindings]] class_name = "RateLimitDO"`, `main = "src/index.ts"`), and a
// deployed Durable Object namespace is keyed to that exported class — so the export is a
// deployment contract, not an import detail, and it is not worth re-homing for tidiness.

export interface RateLimit {
  bucket: string;
  id: string;
  limit: number;
  windowSec: number;
}

/**
 * What to do when the limiter itself is unavailable — see `FAIL_MODE` below.
 *
 * - `closed`: treat the call as over-limit. The caller returns its 429.
 * - `open`:   treat the call as within limit. The request proceeds unlimited.
 */
type FailMode = "open" | "closed";

/**
 * Per-surface failure policy, keyed by bucket name.
 *
 * The limiter is a hard dependency of every credential path, and it has real failure modes
 * that reach production: DO overload, a transient error to the DO's colo, and — routinely —
 * "Durable Object reset because its code was updated", which happens on EVERY deploy to any
 * request in flight (R10-03). Previously none of that was handled: the throw escaped
 * `handleActivate`/`handleToken`/`handleEnroll`/`handleMintToken`/both logins as an unhandled
 * exception, i.e. a 500 with no degraded mode at all.
 *
 * The policy is chosen per surface rather than globally, because the two failure directions
 * trade different things:
 *
 *   FAIL CLOSED for anything that mints or exchanges a credential — `/activate`, `/token`,
 *   `/enroll`, edge-mint, the browser-session key exchange, every OIDC leg, and both interactive
 *   logins. An unlimited credential endpoint is a brute-force oracle against license keys and
 *   magic-link tokens; losing the limiter must not silently remove the only thing standing
 *   between an attacker and unbounded guessing. Note this reads *availability-hostile* but
 *   barely is: the DO error is transient and per-request, the caller surfaces a 429, and a 429
 *   is precisely the signal that makes a client back off and retry — unlike the 500 it replaces.
 *   (the R10 audit findings' fix direction proposed fail-open for licensing on availability grounds;
 *   this lane deliberately took the other side for credential paths. Revisit with metrics if a
 *   DO incident ever measurably locks out paying customers.)
 *
 *   FAIL OPEN for read-only / non-credential surfaces, where the limiter is protecting cost
 *   and noise rather than a secret, and where the request is already authenticated by
 *   something stronger. Locking a signed-in operator out of the admin console because a
 *   counter DO is unhappy trades a real outage for no security gain.
 *
 * Unknown buckets fail CLOSED: a new credential endpoint that forgets to register here should
 * degrade safely, not silently opt into "unlimited".
 */
const FAIL_MODE: Record<string, FailMode> = {
  // ── credential minting / exchange — fail closed ────────────────────────────
  activate: "closed",
  token: "closed",
  enroll: "closed",
  mint: "closed",
  // Edge-mint's per-DEVICE budget (P0-12), beside the per-IP `mint`. Same surface, same side.
  mintDevice: "closed",
  // `POST /<p>/devices/register` (wire v3 §6). The strongest case in this table for failing
  // closed: it mints a device token from nothing — no key, no session, no prior state — so
  // with the limiter gone it is an unbounded free-credential faucet, and the seat/telemetry
  // rows it writes are the DoS amplifier. A 429 tells a real client to back off; an unlimited
  // mint tells an attacker to keep going.
  register: "closed",
  browserSessionLicense: "closed",
  authStart: "closed",
  authDeviceStart: "closed",
  authDeviceVerify: "closed",
  // The RFC 8628 user-code page: the only brake on guessing a live code (§5.1) besides the
  // code space itself, so an outage must not turn it into an unlimited oracle.
  authDeviceEntry: "closed",
  authCallback: "closed",
  authCallbackState: "closed",
  authPoll: "closed",
  authPollState: "closed",
  authDevicePoll: "closed",
  authDevicePollCode: "closed",
  adminLogin: "closed",
  adminCallback: "closed",
  portalLogin: "closed",
  portalMagic: "closed",
  portalClaimKey: "closed",
  // P2-02: the trusted-publisher exchange mints a `pkeyci_` token from a GitHub OIDC token —
  // per caller IP (every request), and per product (charged only after the token passes the
  // signature, audience and publisher policy, so no outsider can spend it).
  ciPublishToken: "closed",
  ciPublishTokenProduct: "closed",
  // P5-02: App Store Connect webhook deliveries, per product, counted BEFORE the webhook secret
  // is opened. Every open is an audit row and a D1 write (P5-01), so with the limiter gone an
  // unsigned flood would become a write amplifier. A refused delivery is lost (Apple does not
  // retry on its own; an operator can resend it once): the poller re-lists versions, builds and
  // phased release, but not a Background Asset object only that delivery named
  // (THREAT-MODEL.md, the ASC section's Lost follow-ups and Residual).
  ascWebhook: "closed",
  // P6-03: the Sentry alert webhook, for the same reason — the limiter runs before the
  // `sentry-integration` credential is opened, and every open is an audit row.
  sentryWebhook: "closed",
  // P6-01: the commerce bridge. A claim (per licence) and each store hook (per product) can open
  // an outlet credential and call a store API, so a limiter outage refuses rather than letting a
  // flood through to the vault and the store's quota. A refused store delivery is retried by the
  // store (App Store Server Notifications and Pub/Sub push both redeliver on a non-2xx).
  commerceClaim: "closed",
  appStoreHook: "closed",
  playRtdnHook: "closed",
  // …and the per-client-IP buckets that bound UNVERIFIED hook traffic before any signature
  // check; the product buckets above count verified deliveries only.
  appStoreHookIp: "closed",
  playRtdnHookIp: "closed",
  // P6-02: device attestation, per device. The attest bucket guards Google's Play Integrity
  // decode quota (10,000 a day per app) and the challenge bucket the KV writes behind it; with
  // the limiter gone, one device could spend the whole product's daily quota.
  attestChallenge: "closed",
  attest: "closed",

  // ── authenticated, non-credential surfaces — fail open ─────────────────────
  adminApi: "open",
  adminAccessDenied: "open",
  portalDeviceDisconnect: "open",
  portalDownloadToken: "open",

  // ── public read surfaces — fail open ───────────────────────────────────────
  // The release surface (R10-05) is a *delivery* path: appcasts, version checks and binary
  // downloads. The limiter there guards a cost budget (GitHub's 5,000 req/hr installation
  // quota), not a secret, so a limiter outage must not become a software-distribution
  // outage — which is exactly the failure the finding is about. Two buckets because
  // metadata reads and multi-hundred-MB artifact streams have different legitimate rates.
  release: "open",
  releaseArtifact: "open",
  // P2b-05: the public storefront feeds (AltStore, Obtainium, F-Droid relay, Scoop, Flathub).
  // A D1-read budget per IP, nothing secret behind it.
  distributionFeed: "open",
  // P3-09: the app-updater feeds (WinSparkle, Velopack, App Installer, zsync, the extended
  // appcast and version check). The same D1-read budget, the same reason to fail open.
  updateFeed: "open",
};

function failModeFor(bucket: string): FailMode {
  return FAIL_MODE[bucket] ?? "closed";
}

/** Returns true if the call is within the limit (and counts it), false if it should 429. */
export async function rateLimitOk(
  env: Env,
  product: string,
  rl: RateLimit,
  now: number,
): Promise<boolean> {
  try {
    const stub = env.RL.get(env.RL.idFromName(product));
    const res = await stub.fetch("https://rl/check", {
      method: "POST",
      body: JSON.stringify({
        bucket: rl.bucket,
        id: rl.id,
        limit: rl.limit,
        windowSec: rl.windowSec,
        now,
      }),
    });
    // A non-2xx (or an HTML error page from the runtime) must not reach `res.json()` — that
    // destructure was itself one of the unhandled throws.
    if (!res.ok) return failModeFor(rl.bucket) === "open";
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { ok?: unknown }).ok !== "boolean"
    ) {
      return failModeFor(rl.bucket) === "open";
    }
    return (body as { ok: boolean }).ok;
  } catch {
    // DO reset (every deploy), overload, colo error, or a malformed body.
    return failModeFor(rl.bucket) === "open";
  }
}

/**
 * The caller's IP, for per-client limiting. Cloudflare sets `cf-connecting-ip` at the edge
 * and it cannot be spoofed by the client; we deliberately do NOT fall back to the
 * client-controlled `x-forwarded-for` header (which would let an attacker rotate the limit
 * key freely). Requests with no edge IP share the `unknown` bucket.
 */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * The caller's network, for a per-client bucket that guards a GUESSABLE secret: the IPv4
 * address as-is, or the IPv6 /64 the address sits in (`2001:db8:0:1::/64`). One ordinary IPv6
 * host is routed a whole /64 — 2^64 source addresses at no cost (R10-04b) — so keying such a
 * bucket on the full address would give it an unlimited supply of fresh budgets. Used only
 * where the budget itself is the brute-force bound (`authDeviceEntry`, the RFC 8628 user-code
 * page); every other bucket keeps `clientIp` (aggregating them is an unowned platform
 * follow-up). Anything that does not parse as IPv6 falls back to `clientIp`.
 */
export function clientNetwork(req: Request): string {
  const ip = clientIp(req);
  if (!ip.includes(":")) return ip;
  const hextets = expandIpv6(ip);
  return hextets ? `${hextets.slice(0, 4).join(":")}::/64` : ip;
}

/** The eight hextets of an IPv6 address (lower-case, no leading zeros), or null. Accepts `::`
 *  compression, a zone id and an embedded IPv4 tail (`::ffff:192.0.2.1`). */
function expandIpv6(raw: string): string[] | null {
  const addr = raw.split("%")[0]!.toLowerCase();
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): string[] | null => {
    if (part === "") return [];
    const out: string[] = [];
    const groups = part.split(":");
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (i === groups.length - 1 && g.includes(".")) {
        const octets = g.split(".");
        if (
          octets.length !== 4 ||
          !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
        )
          return null;
        const n = octets.map(Number);
        out.push(((n[0]! << 8) | n[1]!).toString(16));
        out.push(((n[2]! << 8) | n[3]!).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(g)) {
        out.push(parseInt(g, 16).toString(16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<string>(fill).fill("0"), ...tail];
}
