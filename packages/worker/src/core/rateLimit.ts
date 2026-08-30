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
 *   (`R10-dos.md`'s fix direction proposed fail-open for licensing on availability grounds;
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
  // A3-09 / B5-11 / MG-01 — the three unmetered legs of the portal's own sign-in. Every one of
  // them is credential-adjacent and none had a limiter at all: `/callback` runs a token
  // exchange and an ID-token verification for anyone who names a `state`, and `/magic/verify`
  // is a bearer-token redemption endpoint, i.e. the exact shape a guessing loop wants. The
  // START surfaces were limited and these were not, which meant the budget guarded the cheap
  // half of each flow and left the half that mints a session unbounded.
  portalCallback: "closed",
  portalMagicVerify: "closed",

  // ── authenticated, non-credential surfaces — fail open ─────────────────────
  adminApi: "open",
  adminAccessDenied: "open",
  portalDeviceDisconnect: "open",
  portalDownloadToken: "open",

  // A magic link is a credential the platform MINTS and mails, so the per-target budget that
  // stops one address being flooded is credential-minting by any other name (B5-06). The
  // per-IP `portalMagic` bucket above already fails closed; a target bucket that failed OPEN
  // would leave the whole defence bypassable by rotating source addresses during a DO blip,
  // which is precisely the attack it exists to stop. A 429 here costs a legitimate user one
  // retry; failing open costs a third party an inbox full of platform-signed mail.
  portalMagicTarget: "closed",

  // ── public read surfaces — fail open ───────────────────────────────────────
  // The release surface (R10-05) is a *delivery* path: appcasts, version checks and binary
  // downloads. The limiter there guards a cost budget (GitHub's 5,000 req/hr installation
  // quota), not a secret, so a limiter outage must not become a software-distribution
  // outage — which is exactly the failure the finding is about. Two buckets because
  // metadata reads and multi-hundred-MB artifact streams have different legitimate rates.
  release: "open",
  releaseArtifact: "open",
  // B5-02. The per-PRODUCT upstream budget: one charge per GitHub subrequest, keyed on the
  // product slug alone rather than the caller, so it bounds the installation quota itself
  // instead of bounding one client's share of it. Same reasoning as its two per-IP siblings —
  // it guards a cost budget, and a limiter outage must not stop software distribution.
  releaseUpstream: "open",
  // A6-05. `GET /<p>/config/document` is an authenticated read (the caller already holds a
  // device token) whose cost is a full-row device read plus a signature. The limiter is
  // shaping poll frequency, not guarding a secret, so a DO blip must not stop a licensed
  // client from refreshing its configuration.
  configDocument: "open",
};

function failModeFor(bucket: string): FailMode {
  return FAIL_MODE[bucket] ?? "closed";
}

/**
 * How many Durable Objects one (product, bucket) pair spreads across (B2-03 / R10-04a).
 *
 * Before this, `RL.idFromName(product)` meant ONE object per product — and because `_admin`
 * and `_portal` are literal scope names, interactive sign-in for the entire platform
 * serialized through exactly two Durable Objects. Those two objects are reachable with no
 * credentials at all, which made them the cheapest DoS target in the system: a single
 * global lock in front of every operator's and every customer's login.
 *
 * 32 is chosen rather than a larger number because each shard is a separate object with its
 * own storage and its own alarm, so the sweep cost and the cold-start surface both scale with
 * N; 32 removes ~97% of the contention on the hot scopes while keeping an idle deployment
 * cheap.
 *
 * COUNTING SEMANTICS ARE UNCHANGED. The shard is a pure function of `(scope, bucket, id)`, so
 * one id lands in exactly one object for a given bucket, and the object's own storage key is
 * still `${bucket}:${id}`. Sharding splits *contention*, never a counter: no caller can gain
 * extra allowance by being routed to a second shard, because there is no second shard for it.
 */
export const RL_SHARDS = 32;

/**
 * FNV-1a (32-bit). Synchronous and allocation-free — this runs on every limited request, and
 * `crypto.subtle.digest` is async, which would turn every call site into an extra await for
 * no security benefit: the shard index is a load-spreading decision, not a secret. Collisions
 * are not merely tolerable but irrelevant, since two ids sharing a shard still keep separate
 * storage keys inside it.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The Durable Object name for one (scope, bucket, id) triple. Exported for the DoS tests,
 *  which assert that the hot pre-auth scopes really do spread across distinct objects. */
export function rateLimitShardName(
  scope: string,
  bucket: string,
  id: string,
): string {
  return `${scope}:${bucket}:${fnv1a(id) % RL_SHARDS}`;
}

/** Returns true if the call is within the limit (and counts it), false if it should 429. */
export async function rateLimitOk(
  env: Env,
  product: string,
  rl: RateLimit,
  now: number,
): Promise<boolean> {
  try {
    const stub = env.RL.get(
      env.RL.idFromName(rateLimitShardName(product, rl.bucket, rl.id)),
    );
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
 * The caller's IP, verbatim. Cloudflare sets `cf-connecting-ip` at the edge and it cannot be
 * spoofed by the client; we deliberately do NOT fall back to the client-controlled
 * `x-forwarded-for` header (which would let an attacker rotate the value freely). Requests
 * with no edge IP read as `unknown`.
 *
 * This is the ADDRESS — the thing you record when you need to say which host did something.
 * For a rate-limit key use `clientIp`, which aggregates IPv6 (see below); for anything an
 * operator or an auditor will read back, use this, because a /64 prefix does not identify a
 * host and is not what happened.
 */
export function clientAddress(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * Expand an IPv6 address to its eight hextets, or `null` if it is not one.
 *
 * Deliberately strict about shape but lenient about the rest: this feeds a rate-limit key, so
 * an address we cannot parse must fall back to "use the whole string" (a smaller aggregate,
 * never a larger one). Returning a wrong prefix would merge unrelated clients into one bucket.
 */
function expandIpv6(value: string): string[] | null {
  if (!value.includes(":")) return null;
  // An IPv4-mapped tail (`::ffff:203.0.113.7`) is a v4 client; leave it to the v4 path.
  if (value.includes(".")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? head.length + tail.length : head.length;
  if (halves.length === 1 ? groups !== 8 : groups > 7) return null;
  for (const part of [...head, ...tail]) {
    if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return null;
  }
  const fill = new Array<string>(8 - groups).fill("0");
  return halves.length === 2 ? [...head, ...fill, ...tail] : head;
}

/**
 * The caller's rate-limit identity (B5-05).
 *
 * IPv4 is used whole: one address is one host's worth of allowance, which is the intent.
 *
 * IPv6 is TRUNCATED TO ITS /64. Every residential and hosting IPv6 assignment hands out at
 * least a /64, so keying on the full 128-bit address gave one attacker 2^64 free identities:
 * every per-IP budget in this file — activation, enrollment, login, magic links, the release
 * surface — was bypassable at zero cost simply by picking a new suffix per request, and every
 * one of those requests also minted a permanent counter key inside the Durable Object. The /64
 * is the smallest unit an operator is actually assigned, so it is the smallest unit that
 * costs an attacker something to rotate.
 *
 * The rendered form (`2001:db8:1:2::/64`) can never collide with a literal address, so a
 * client cannot spoof its way into another network's bucket by sending that string — and in
 * any case the value comes from the edge, not from the request.
 */
export function clientIp(req: Request): string {
  const raw = clientAddress(req);
  const groups = expandIpv6(raw);
  if (!groups) return raw;
  return `${groups.slice(0, 4).join(":")}::/64`;
}
