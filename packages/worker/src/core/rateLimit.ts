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
