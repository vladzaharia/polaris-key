/// <reference types="@cloudflare/workers-types" />

/**
 * The live check for the CI secrets a storefront needs (UX-69, SETUP.md D41, D42 and W20):
 *
 *     POST /manage/api/products/<slug>/distribution/storefronts/<id>/ci-secrets/<name>/check
 *          {value}  →  {ok, storefront, name, check: CredentialCheck}
 *
 * These values are never Polaris Key's to keep — they live in the repository's CI environment
 * (D41: the wizard writes them to GitHub through the App, UX-70) — but a wrong one is found at the
 * first release, minutes later and steps away. So the connect form sends the value here once, the
 * Worker makes ONE or two read-only calls at the vendor with it, and answers what it found:
 *
 *   itch    BUTLER_API_KEY               `GET api.itch.io/profile` (whose key), then
 *                                        `/profile/games` (can it push to the outlet's game)
 *   snap    SNAPCRAFT_STORE_CREDENTIALS  `GET dashboard.snapcraft.io/api/v2/tokens/whoami`: the
 *                                        account, its ACLs, the snaps and channels it is scoped
 *                                        to, and when it expires
 *   winget  PKEY_PR_TOKEN                `GET api.github.com/user` (whose token, its scopes and
 *                                        expiry), then the account's `winget-pkgs` fork
 *   steam   STEAM_USERNAME, STEAM_CONFIG_VDF   not checkable from the Worker: a SteamPipe login
 *                                        needs SteamCMD and Steam Guard. Answered `unchecked`.
 *
 * The rules, the same as the store-connection check (`connectors/credentialCheck.ts`):
 *
 *   - **Never a write, never a value out.** GETs only, each to one fixed origin with
 *     `redirect: "manual"` (a 3xx is a failure, so the token never reaches a `Location`), bodies
 *     read through `readCappedText`. The response carries what the vendor reported about the
 *     account (a username, scopes, an expiry), never the value; errors are composed here from a
 *     status and, at most, an enum-like error token — never a vendor body, never a URL.
 *   - **Nothing stored.** No seal, no KV, no D1 write, no audit row: the value lives for this
 *     request. Writing it to GitHub is UX-70's route, not this one.
 *   - **Rate-limited per operator** (`credentialCheck`, shared with the store-connection check),
 *     after the format check and before any vendor call.
 */

import { ErrorCode } from "../../core/errors.js";
import {
  b64urlDecode,
  b64urlEncode,
  parseJsonColumn,
} from "../../core/platform.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import { adminJson, err, readBody } from "../../core/adminApi.js";
import { isRedirect, readCappedText } from "../../core/readCapped.js";
import { listOutlets } from "./outlets.js";
import {
  checked,
  credentialCheckAllowed,
  formatFailure,
  storeUnavailable,
  type CheckFact,
  type CredentialCheck,
} from "./connectors/credentialCheck.js";

export const ITCH_API_ORIGIN = "https://api.itch.io";
export const SNAP_DASHBOARD_ORIGIN = "https://dashboard.snapcraft.io";
export const GITHUB_API_ORIGIN = "https://api.github.com";
/** The repository winget pull requests go to (from the token account's fork). */
export const WINGET_PKGS = "microsoft/winget-pkgs";

/** The most of one vendor answer read: each is one small JSON object. */
const MAX_VENDOR_BYTES = 256 * 1024;
/** A credential pasted into the form: the longest real one (an export-login) is ~3 KiB. */
const MAX_VALUE = 16 * 1024;
/** Warn when a value expires within this many days. */
const EXPIRY_WARNING_DAYS = 14;

/** What a check knows about the product's outlet of this storefront (its `.pkey` identity). */
interface OutletIdentity {
  [field: string]: unknown;
}

type SecretCheck = (
  value: string,
  identity: OutletIdentity | null,
  now: number,
) => Promise<CredentialCheck>;

/** Every CI secret with a check, by storefront. A name not listed here is a 404. */
export const CI_SECRET_CHECKS: Readonly<
  Record<string, Readonly<Record<string, SecretCheck>>>
> = {
  itch: { BUTLER_API_KEY: checkButlerKey },
  snap: { SNAPCRAFT_STORE_CREDENTIALS: checkSnapcraftLogin },
  winget: { PKEY_PR_TOKEN: checkWingetToken },
  steam: {
    STEAM_USERNAME: steamBuilderLogin,
    STEAM_CONFIG_VDF: steamBuilderLogin,
  },
};

// ── the route ────────────────────────────────────────────────────────────────────────────────

/** `storefronts/<id>/ci-secrets/<name>/check`, or null for any other `storefronts/…` path. */
export async function handleCiSecretCheckAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, rest } = ctx;
  if (rest.length !== 5 || rest[2] !== "ci-secrets" || rest[4] !== "check")
    return null;
  const storefront = rest[1]!;
  const name = rest[3]!;
  const run = Object.hasOwn(CI_SECRET_CHECKS, storefront)
    ? Object.hasOwn(CI_SECRET_CHECKS[storefront]!, name)
      ? CI_SECRET_CHECKS[storefront]![name]
      : undefined
    : undefined;
  if (!run)
    return err(
      404,
      "not_found",
      `${storefront} has no CI secret ${name} to check`,
    );
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  const value = typeof body.value === "string" ? body.value.trim() : "";
  const answer = (check: CredentialCheck) =>
    adminJson({ ok: true, storefront, name, check });
  if (value.length === 0 || value.length > MAX_VALUE)
    return answer(
      formatFailure("value", `paste the ${name} value (at most 16 KiB)`),
    );
  const identity = await outletIdentity(ctx, storefront);
  // Formats first: a value that cannot be the secret costs no vendor call and no budget.
  const shape = await formatCheck(storefront, value);
  if (shape) return answer(shape);
  if (run !== steamBuilderLogin) {
    if (!(await credentialCheckAllowed(ctx.env, ctx.session.sub, ctx.now)))
      return err(
        429,
        "rate_limited",
        "too many credential checks: wait a few minutes, then check again",
      );
  }
  return answer(await run(value, identity, ctx.now));
}

/** The product's live outlet of this storefront's kind, if it declares one. */
async function outletIdentity(
  ctx: ServiceContext,
  storefront: string,
): Promise<OutletIdentity | null> {
  const row = (await listOutlets(ctx.db, ctx.product.slug)).find(
    (o) => o.kind === storefront && o.removed_at === null,
  );
  const identity = row ? parseJsonColumn(row.identity_json) : null;
  return identity && typeof identity === "object" && !Array.isArray(identity)
    ? (identity as OutletIdentity)
    : null;
}

const BUTLER_KEY = /^[A-Za-z0-9]{20,128}$/;
/**
 * The GitHub token kinds a person can mint for winget, told apart by prefix (GitHub's documented
 * token formats): a classic personal token (`ghp_`, or the legacy 40-hex form), an OAuth app token
 * (`gho_`, scoped like a classic token) and a fine-grained personal token (`github_pat_`). App
 * installation, user-to-server and refresh tokens (`ghs_`, `ghu_`, `ghr_`) are not personal
 * tokens a CI secret should hold, and are refused.
 */
const CLASSIC_TOKEN = /^(?:gh[po]_[A-Za-z0-9]{30,251}|[0-9a-f]{40})$/;
const FINE_GRAINED_TOKEN = /^github_pat_[A-Za-z0-9_]{22,251}$/;

export function githubTokenType(
  value: string,
): "classic" | "fine-grained" | null {
  if (CLASSIC_TOKEN.test(value)) return "classic";
  if (FINE_GRAINED_TOKEN.test(value)) return "fine-grained";
  return null;
}

const SNAP_FORMAT =
  "this is not a snapcraft export-login output: run snapcraft export-login with --snaps, --acls and --expires, and paste the whole output";

/** A value that cannot be the secret: caught before any vendor call and before the limiter. */
async function formatCheck(
  storefront: string,
  value: string,
): Promise<CredentialCheck | null> {
  if (storefront === "itch" && !BUTLER_KEY.test(value))
    return formatFailure(
      "value",
      "an itch.io API key is letters and digits only: copy it from itch.io → Settings → API keys",
    );
  if (storefront === "winget" && githubTokenType(value) === null)
    return formatFailure(
      "value",
      "this is not a personal GitHub token: it starts with github_pat_ (fine-grained) or ghp_ (classic)",
    );
  if (storefront === "snap") {
    const login = await snapCredential(value);
    if (login === null) return formatFailure("value", SNAP_FORMAT);
    if ("unsupported" in login) return snapUnsupported();
  }
  return null;
}

/** A well-formed Ubuntu One export whose macaroons are not the v1 binary form this check reads
 *  (a v2 discharge, say): the login may well work, so it is not called malformed. */
function snapUnsupported(): CredentialCheck {
  return checked(
    "unchecked",
    "not-checkable",
    "This Snap Store login cannot be checked from Polaris Key",
    "It is a complete export-login, but in a macaroon format the check does not read. The first snapcraft upload checks it: if it fails, the release workflow's log names the reason.",
  );
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

interface VendorAnswer {
  status: number;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/**
 * One GET to `origin` + `path`: `redirect: "manual"`, a capped body, a JSON object or null.
 * Throws only a status (0 for no connection, the 3xx for a redirect, 502 for an unreadable 2xx).
 */
async function vendorGet(
  origin: string,
  path: string,
  headers: Record<string, string>,
): Promise<VendorAnswer> {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new VendorStatus(0);
  let res: Response;
  try {
    // Late-bound global fetch, so a test that swaps it is honoured.
    res = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", ...headers },
    });
  } catch {
    throw new VendorStatus(0);
  }
  if (isRedirect(res)) {
    await res.body?.cancel().catch(() => undefined);
    throw new VendorStatus(res.status);
  }
  let body: Record<string, unknown> | null = null;
  try {
    const text = await readCappedText(
      res,
      MAX_VENDOR_BYTES,
      () => new Error("too large"),
    );
    const parsed = text.trim() === "" ? null : (JSON.parse(text) as unknown);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    if (res.ok) throw new VendorStatus(502);
  }
  return { status: res.status, headers: res.headers, body };
}

class VendorStatus extends Error {
  constructor(readonly status: number) {
    super(`vendor: HTTP ${status}`);
    this.name = "VendorStatus";
  }
}

const unavailable = (vendor: string, e: unknown) =>
  storeUnavailable(vendor, e instanceof VendorStatus ? e.status : 0);

const str = (v: unknown, max = 120): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

function daysUntil(at: number, now: number): number {
  return Math.floor((at - now) / 86400);
}

function dateOf(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 10);
}

// ── itch.io ──────────────────────────────────────────────────────────────────────────────────

/** `user/game` of the outlet's butler target, lower-cased. */
function itchTarget(identity: OutletIdentity | null): {
  user: string;
  game: string;
} | null {
  const t = identity?.target;
  if (typeof t !== "string") return null;
  const m = /^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,128})$/.exec(t);
  return m ? { user: m[1]!.toLowerCase(), game: m[2]!.toLowerCase() } : null;
}

async function checkButlerKey(
  value: string,
  identity: OutletIdentity | null,
): Promise<CredentialCheck> {
  const auth = { authorization: `Bearer ${value}` };
  let profile: VendorAnswer;
  try {
    profile = await vendorGet(ITCH_API_ORIGIN, "/profile", auth);
  } catch (e) {
    return unavailable("itch.io", e);
  }
  // itch.io answers a bad key with 401/403, or with 200 and `{"errors": [...]}`.
  const user = profile.body?.user as Record<string, unknown> | undefined;
  if (
    profile.status === 401 ||
    profile.status === 403 ||
    (profile.status === 200 && (Array.isArray(profile.body?.errors) || !user))
  )
    return checked(
      "invalid",
      "rejected",
      "itch.io did not accept this API key",
      "It was revoked, or it is not an API key. Create one in itch.io → Settings → API keys (butler login uses the same kind), and paste it.",
      [],
      { status: profile.status },
    );
  if (profile.status !== 200)
    return storeUnavailable("itch.io", profile.status);
  const username = str(user!.username, 64) ?? "";
  const facts: CheckFact[] = [{ label: "itch.io user", value: username }];
  const target = itchTarget(identity);
  if (!target)
    return checked(
      "valid",
      "ok",
      `itch.io user ${username}`,
      "The outlet has no butler target yet, so which game it can push to is not checked.",
      facts,
    );
  facts.push({ label: "Pushes to", value: `${target.user}/${target.game}` });
  if (target.user !== username.toLowerCase())
    return checked(
      "warning",
      "wrong-account",
      `This key belongs to ${username}, but the outlet pushes to ${target.user}/${target.game}`,
      `butler can push with it only if ${username} is an admin of that game. Use a key of ${target.user}, or add ${username} as an admin on the game's page.`,
      facts,
    );
  let games: VendorAnswer;
  try {
    games = await vendorGet(ITCH_API_ORIGIN, "/profile/games", auth);
  } catch (e) {
    return unavailable("itch.io", e);
  }
  if (games.status !== 200) return storeUnavailable("itch.io", games.status);
  const list = Array.isArray(games.body?.games) ? games.body.games : [];
  const gameId = identity?.gameId;
  const found = list.some((g) => {
    const r = g as { id?: unknown; url?: unknown };
    if (gameId !== undefined && String(r.id) === String(gameId)) return true;
    const url = typeof r.url === "string" ? r.url : "";
    return url.toLowerCase().replace(/\/+$/, "").endsWith(`/${target.game}`);
  });
  facts.push({ label: "Games", value: String(list.length) });
  if (!found)
    return checked(
      "invalid",
      "not-found",
      `${username} has no game ${target.game} on itch.io`,
      `Create the game page first (itch.io → Upload new project) with the URL ${target.user}.itch.io/${target.game}, or fix the outlet's butler target.`,
      facts,
    );
  return checked(
    "valid",
    "ok",
    `itch.io user ${username} · can push to ${target.user}/${target.game}`,
    null,
    facts,
  );
}

// ── Snap Store ───────────────────────────────────────────────────────────────────────────────

const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

function b64decode(s: string): Uint8Array | null {
  const t = s.replace(/\s+/g, "");
  if (!B64.test(t)) return null;
  const bare = t.replace(/=+$/, "");
  if (bare.length % 4 === 1) return null;
  try {
    return b64urlDecode(bare);
  } catch {
    return null;
  }
}

interface MacaroonPacket {
  key: string;
  value: Uint8Array;
}

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** A v1 binary macaroon (libmacaroons / pymacaroons): packets of `<4 hex len><key> <value>\n`. */
export function parseMacaroonV1(serialized: string): MacaroonPacket[] | null {
  const bytes = b64decode(serialized);
  if (!bytes || bytes.length === 0) return null;
  const out: MacaroonPacket[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 4 > bytes.length) return null;
    const head = latin1(bytes.subarray(i, i + 4));
    if (!/^[0-9a-f]{4}$/i.test(head)) return null;
    const len = parseInt(head, 16);
    if (len < 7 || i + len > bytes.length) return null;
    const body = bytes.subarray(i + 4, i + len);
    if (body[body.length - 1] !== 0x0a) return null;
    const sp = body.indexOf(0x20);
    if (sp < 1) return null;
    out.push({
      key: latin1(body.subarray(0, sp)),
      value: body.slice(sp + 1, body.length - 1),
    });
    i += len;
  }
  const sig = out[out.length - 1];
  return sig && sig.key === "signature" && sig.value.length === 32 ? out : null;
}

function serializeMacaroonV1(packets: MacaroonPacket[]): string {
  const parts: Uint8Array[] = [];
  for (const p of packets) {
    const key = new TextEncoder().encode(p.key);
    const len = 4 + key.length + 1 + p.value.length + 1;
    const head = new TextEncoder().encode(len.toString(16).padStart(4, "0"));
    const out = new Uint8Array(len);
    out.set(head, 0);
    out.set(key, 4);
    out[4 + key.length] = 0x20;
    out.set(p.value, 5 + key.length);
    out[len - 1] = 0x0a;
    parts.push(out);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return b64urlEncode(all);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/**
 * Bind a discharge macaroon to its root for a request (pymacaroons `prepare_for_request`, the
 * libmacaroons binding): the discharge's signature becomes
 * `HMAC(0³², HMAC(0³², root.sig) ‖ HMAC(0³², discharge.sig))`.
 */
export async function bindDischarge(
  root: string,
  discharge: string,
): Promise<string | null> {
  const r = parseMacaroonV1(root);
  const d = parseMacaroonV1(discharge);
  if (!r || !d) return null;
  const zero = new Uint8Array(32);
  const h1 = await hmac(zero, r[r.length - 1]!.value);
  const h2 = await hmac(zero, d[d.length - 1]!.value);
  const both = new Uint8Array(64);
  both.set(h1, 0);
  both.set(h2, 32);
  const bound = await hmac(zero, both);
  return serializeMacaroonV1([
    ...d.slice(0, -1),
    { key: "signature", value: bound },
  ]);
}

/**
 * The `Authorization` header for a `snapcraft export-login` output, as craft-store builds it:
 *
 *   - base64 of `{"t":"u1-macaroon","v":{"r":<root>,"d":<discharge>}}` (Ubuntu One, the default):
 *     `Macaroon root=<root>, discharge=<discharge bound to root>`;
 *   - base64 of `{"t":"macaroon","v":<macaroon>}` (Candid): `Macaroon <macaroon>`;
 *   - the legacy INI form (`[login.ubuntu.com]`, `macaroon = …`, `unbound_discharge = …`),
 *     raw or base64: as Ubuntu One.
 */
export async function snapAuthorization(raw: string): Promise<string | null> {
  const c = await snapCredential(raw);
  return c && "header" in c ? c.header : null;
}

/** The header, `unsupported` for a well-formed Ubuntu One document whose macaroons this check
 *  cannot read, or null for a value that is not an export-login at all. */
export async function snapCredential(
  raw: string,
): Promise<{ header: string } | { unsupported: true } | null> {
  const decoded = b64decode(raw);
  const texts = [raw];
  if (decoded) texts.unshift(new TextDecoder().decode(decoded));
  for (const text of texts) {
    const t = text.trim();
    if (t.startsWith("{")) {
      let doc: { t?: unknown; v?: unknown };
      try {
        doc = JSON.parse(t) as typeof doc;
      } catch {
        continue;
      }
      if (doc.t === "u1-macaroon" && doc.v && typeof doc.v === "object") {
        const v = doc.v as { r?: unknown; d?: unknown };
        if (typeof v.r !== "string" || typeof v.d !== "string") return null;
        const bound = await bindDischarge(v.r, v.d);
        return bound
          ? { header: `Macaroon root=${v.r}, discharge=${bound}` }
          : { unsupported: true };
      }
      if (doc.t === "macaroon" && typeof doc.v === "string")
        return /^[A-Za-z0-9+/_=-]{16,8192}$/.test(doc.v)
          ? { header: `Macaroon ${doc.v}` }
          : null;
      return null;
    }
    if (/^\[login\.ubuntu\.com\]/m.test(t)) {
      const root = /^macaroon\s*=\s*(\S+)\s*$/m.exec(t)?.[1];
      const unbound = /^unbound_discharge\s*=\s*(\S+)\s*$/m.exec(t)?.[1];
      if (!root || !unbound) return null;
      const bound = await bindDischarge(root, unbound);
      return bound
        ? { header: `Macaroon root=${root}, discharge=${bound}` }
        : { unsupported: true };
    }
  }
  return null;
}

/** The ACLs `snapcraft upload --release` needs (stores/snap.ts: `package_push,package_release`). */
const SNAP_NEEDED_ACLS = ["package_push", "package_release"] as const;

async function checkSnapcraftLogin(
  value: string,
  identity: OutletIdentity | null,
  now: number,
): Promise<CredentialCheck> {
  // Parsed before the limiter too (`formatCheck`); parsed again here, where it is used.
  const login = await snapCredential(value);
  if (login === null) return formatFailure("value", SNAP_FORMAT);
  if ("unsupported" in login) return snapUnsupported();
  const authorization = login.header;
  let res: VendorAnswer;
  try {
    res = await vendorGet(SNAP_DASHBOARD_ORIGIN, "/api/v2/tokens/whoami", {
      authorization,
    });
  } catch (e) {
    return unavailable("The Snap Store", e);
  }
  const snapName = str(identity?.name, 64);
  const exportLine = `snapcraft export-login --snaps ${snapName ?? "<snap>"} --acls ${SNAP_NEEDED_ACLS.join(",")} --expires <date> -`;
  if (res.status === 401 || res.status === 403) {
    const first = Array.isArray(res.body?.error_list)
      ? (res.body.error_list[0] as { code?: unknown } | undefined)?.code
      : undefined;
    const expired =
      typeof first === "string" && /expired|needs-refresh/.test(first);
    return checked(
      "invalid",
      expired ? "expired" : "rejected",
      expired
        ? "This Snap Store login has expired"
        : "The Snap Store did not accept this login",
      `${expired ? "Export a new one" : "It was revoked or mistyped. Export a new one"}: ${exportLine}`,
      [],
      { status: res.status },
    );
  }
  if (res.status !== 200 || !res.body)
    return storeUnavailable("The Snap Store", res.status);
  const account = (res.body.account ?? {}) as Record<string, unknown>;
  const username = str(account.username, 64) ?? str(account.email) ?? "unknown";
  const permissions = Array.isArray(res.body.permissions)
    ? res.body.permissions.filter((p): p is string => typeof p === "string")
    : [];
  const packages = Array.isArray(res.body.packages)
    ? res.body.packages
        .map((p) => str((p as { name?: unknown } | null)?.name, 64))
        .filter((n): n is string => n !== null)
    : null;
  const expires = res.body.expires;
  // The dashboard writes a naive UTC timestamp (`2026-12-01T00:00:00.000`).
  const expiresAt =
    typeof expires === "string"
      ? Math.floor(
          Date.parse(
            /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(expires) ? expires : `${expires}Z`,
          ) / 1000,
        )
      : NaN;
  const facts: CheckFact[] = [
    { label: "Snap Store account", value: username },
    { label: "Permissions", value: permissions.join(", ") || "none" },
    {
      label: "Snaps",
      value:
        packages === null
          ? "all of the account's snaps"
          : packages.join(", ") || "none",
    },
  ];
  if (Number.isFinite(expiresAt))
    facts.push({ label: "Expires", value: dateOf(expiresAt) });

  if (Number.isFinite(expiresAt) && expiresAt <= now)
    return checked(
      "invalid",
      "expired",
      `This Snap Store login expired on ${dateOf(expiresAt)}`,
      `Export a new one: ${exportLine}`,
      facts,
    );
  const missing = SNAP_NEEDED_ACLS.filter((a) => !permissions.includes(a));
  if (missing.length > 0)
    return checked(
      "invalid",
      "permission",
      `This login cannot ${missing.includes("package_push") ? "upload" : "release"} snaps: it lacks ${missing.join(" and ")}`,
      `Export it again with the permissions the release needs: ${exportLine}`,
      facts,
    );
  if (snapName && packages !== null && !packages.includes(snapName))
    return checked(
      "invalid",
      "permission",
      `This login is not scoped to ${snapName}`,
      `It can reach ${packages.join(", ") || "no snaps"}. Export it again for this snap: ${exportLine}`,
      facts,
    );
  if (permissions.includes("package_manage"))
    return checked(
      "warning",
      "permission",
      `${username}'s login works, but it can also manage collaborators and close channels`,
      `It carries package_manage, which Polaris Key never needs. A narrower export is safer: ${exportLine}`,
      facts,
    );
  if (
    Number.isFinite(expiresAt) &&
    daysUntil(expiresAt, now) < EXPIRY_WARNING_DAYS
  )
    return checked(
      "warning",
      "expiring",
      `${username}'s login works, but it expires on ${dateOf(expiresAt)}`,
      `Releases stop when it does. Export a longer one: ${exportLine}`,
      facts,
    );
  return checked(
    "valid",
    "ok",
    `Snap Store account ${username} · can push${snapName ? ` ${snapName}` : ""}`,
    null,
    facts,
  );
}

// ── winget (GitHub) ──────────────────────────────────────────────────────────────────────────

const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "polaris-key",
};

async function checkWingetToken(
  value: string,
  _identity: OutletIdentity | null,
  now: number,
): Promise<CredentialCheck> {
  const auth = { ...GITHUB_HEADERS, authorization: `Bearer ${value}` };
  let me: VendorAnswer;
  try {
    me = await vendorGet(GITHUB_API_ORIGIN, "/user", auth);
  } catch (e) {
    return unavailable("GitHub", e);
  }
  if (me.status === 401)
    return checked(
      "invalid",
      "rejected",
      "GitHub did not accept this token",
      "It expired, was revoked, or is mistyped. Create a new one in GitHub → Settings → Developer settings → Personal access tokens.",
      [],
      { status: 401 },
    );
  if (me.status === 403 && me.headers.get("x-ratelimit-remaining") === "0")
    return storeUnavailable("GitHub", 429);
  if (me.status !== 200) return storeUnavailable("GitHub", me.status);
  const login = str(me.body?.login, 64) ?? "unknown";
  const facts: CheckFact[] = [{ label: "GitHub account", value: login }];
  const exp = me.headers.get("github-authentication-token-expiration");
  const expiresAt = exp
    ? Math.floor(Date.parse(exp.replace(" UTC", "Z").replace(" ", "T")) / 1000)
    : NaN;
  // No header: the token never expires. A header that does not parse: unknown, not "never".
  facts.push({
    label: "Expires",
    value: Number.isFinite(expiresAt)
      ? dateOf(expiresAt)
      : exp
        ? "unknown"
        : "never",
  });

  // The token's type is its prefix; the header only carries a classic token's scopes.
  const classic = githubTokenType(value) === "classic";
  if (classic) {
    const list = (me.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    facts.push({ label: "Scopes", value: list.join(", ") || "none" });
    if (!list.includes("public_repo") && !list.includes("repo"))
      return checked(
        "invalid",
        "permission",
        "This token cannot open pull requests on public repositories",
        `A classic token needs the public_repo scope to fork ${WINGET_PKGS} and open its pull request. Edit the token in GitHub → Settings → Developer settings and tick public_repo.`,
        facts,
      );
  } else facts.push({ label: "Type", value: "fine-grained" });

  // The fork the pull request comes from (the CLI creates it with a classic token).
  let fork: VendorAnswer;
  try {
    fork = await vendorGet(
      GITHUB_API_ORIGIN,
      `/repos/${encodeURIComponent(login)}/winget-pkgs`,
      auth,
    );
  } catch (e) {
    return unavailable("GitHub", e);
  }
  if (fork.status === 200) {
    const parent = (fork.body?.parent as { full_name?: unknown } | undefined)
      ?.full_name;
    const push = (fork.body?.permissions as { push?: unknown } | undefined)
      ?.push;
    if (fork.body?.fork !== true || parent !== WINGET_PKGS)
      return checked(
        "invalid",
        "wrong-account",
        `${login}/winget-pkgs is not a fork of ${WINGET_PKGS}`,
        `Rename or remove that repository, then fork ${WINGET_PKGS} into ${login}.`,
        facts,
      );
    facts.push({ label: "Fork", value: `${login}/winget-pkgs` });
    if (push === false)
      return checked(
        "invalid",
        "permission",
        `This token cannot push to ${login}/winget-pkgs`,
        "Give the token Contents: Read and write on the fork (fine-grained), or the public_repo scope (classic).",
        facts,
      );
  } else if (fork.status === 404) {
    if (!classic)
      return checked(
        "invalid",
        "not-found",
        `${login} has no fork of ${WINGET_PKGS}`,
        `A fine-grained token cannot create the fork. Fork ${WINGET_PKGS} into ${login} once, then give the token Contents and Pull requests: Read and write on it.`,
        facts,
      );
    facts.push({ label: "Fork", value: "created on the first release" });
  } else return storeUnavailable("GitHub", fork.status);

  if (
    Number.isFinite(expiresAt) &&
    daysUntil(expiresAt, now) < EXPIRY_WARNING_DAYS
  )
    return checked(
      "warning",
      "expiring",
      `${login}'s token works, but it expires on ${dateOf(expiresAt)}`,
      "winget pull requests stop when it does. Regenerate it with a later expiry and paste it again.",
      facts,
    );
  return checked(
    "valid",
    "ok",
    `GitHub account ${login} · can open winget pull requests`,
    null,
    facts,
  );
}

// ── Steam (SteamPipe builder) ────────────────────────────────────────────────────────────────

async function steamBuilderLogin(): Promise<CredentialCheck> {
  return checked(
    "unchecked",
    "not-checkable",
    "Steam's builder login cannot be checked from Polaris Key",
    "A SteamPipe login is accepted only by SteamCMD, with Steam Guard. The first upload checks it: if it fails, the release workflow's log names the reason.",
  );
}
