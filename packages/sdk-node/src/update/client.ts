// The Update sub-client — the FEED over Release's truth store (D-05, §R1), and wire v4's signed
// update decision (plans/P3-01.md §2.5–§2.8).
//
//   `check()`         `GET /<p>/update/version` → what the newest build on this channel is, plus
//                     whether the running version is behind it. The comparison uses client-core's
//                     `compareSemver`, the same one the server's build gate and every other SDK
//                     use — a version check that disagreed with the gate would tell a user to
//                     update to a build the gate then blocks.
//   `appcastUrl()`    the Sparkle feed URL, taken from DISCOVERY rather than string-built here.
//                     §R1 moved these paths and left permanent aliases; a host that hard-codes one
//                     is a host that breaks the next time they move, whereas the discovery
//                     document is the product's own statement of where its feed lives.
//   `decide()`        wire v4: the signed channel feed (`pkey-feed+jws`), the release record it
//                     pins (`pkey-release+jws`, fetched by hash), and the decision over both —
//                     what an Electron main process or a CLI acts on ("verify, then stage").
//   `feed()`          the verified feed `decide()` would use, without the record.
//   `releaseRecord()` one release record by hash, verified against the PINNED release keys.
//   `buildUrl()`      the route an install downloads a build from (`distribution/builds`).
//
// ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────────────────────
//
// It verifies and decides NOTHING itself. The verification order, the `seq` floors, the
// fallback after a refusal and the error map live once in `@polaris-key/client-core`
// (`runUpdateCheck`, over `verifyFeed`, `verifyReleaseRecord`, `decideUpdate`, …), which the
// React SDK runs too, so the two JavaScript SDKs cannot drift. This module is transport (the two
// discovery endpoints and two GETs), storage (Core's read-modify-write of the `feeds` and
// `releaseRecords` cache slices) and the mapping of host state onto the decision's inputs.
//
// ── WHAT IT TRUSTS ──────────────────────────────────────────────────────────────────────────
//
//   * feeds verify against the EFFECTIVE product trust set (pins ∪ verified manifest keys), as
//     documents do;
//   * records verify against `update.pinnedReleaseKeys` only. That map is compiled into the host,
//     never persisted, never merged with the product trust set and never extended from the
//     network; a key in both raises `invalid-options` at construction;
//   * the clock is the EFFECTIVE clock, `max(system, highWaterMark)` (V3 §4.2), so winding the
//     system clock back cannot revive an expired feed;
//   * the cache holds signed JWSs only. Every entry is re-verified before use and each channel's
//     floor is derived from the committed feed that survives, never read from a stored number.

import { arch as osArch, platform as osPlatform } from "node:os";
import { base64UrlDecode, type TrustSet } from "@polaris-key/jws";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import {
  OUTLET_KINDS,
  OUTLET_SUBKINDS,
  OUTLET_UNKNOWN,
} from "@polaris-key/protocol/distribution";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import {
  BINARY_METHODS,
  type BinaryMethod,
  type ChannelFeedDoc,
  type InstalledBuild,
  type StagedUpdate,
  type UpdateCheck,
} from "@polaris-key/protocol/update";
import {
  PolarisError,
  canonicalArch,
  canonicalPlatform,
  compareSemver,
  detectOutlet,
  detectionStamp,
  feedTarget,
  isValidHostOutlet,
  reloadFeeds,
  reloadReleaseRecords,
  resolveUpdateOutlet,
  runUpdateCheck,
  verifyReleaseRecord,
  type DetectedOutlet,
  type FetchOutcome,
  type HostOutlet,
  type OutletStamp,
  type ResolvedOutlet,
  type UpdateCheckError,
} from "@polaris-key/client-core";
import {
  ARCH_VALUES,
  ErrorCode,
  Feature,
  PLATFORM_VALUES,
  type Arch,
  type Platform,
} from "../constants.generated.js";
import type { CacheManager } from "../core/cache.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import type { TrustManager } from "../core/trust.js";
import { readOutletSignals, type OutletReaderEnvironment } from "./outlet.js";
import { PacksClient, type NodePacksOptions } from "../packs/client.js";
import {
  appcastUrlFrom,
  updateEndpointsFrom,
  type ProductDiscoveryDocument,
} from "../discovery.js";

export interface VersionCheck {
  /** The newest version on the requested channel. */
  version: string;
  tag: string;
  url: string;
  /** Whether the host application's own version is older than `version`. */
  updateAvailable: boolean;
}

/**
 * Wire v4 update inputs (`PolarisKeyClientOptions.update`). The installed VERSION is
 * `CoreOptions.version`; everything else the decision needs about this install is here, and is
 * validated when the client is constructed (a bad value raises `invalid-options`).
 */
export interface UpdateClientOptions {
  /** `kid` → raw 32-byte Ed25519 release key, base64url (the `TrustSet` encoding): the ONLY keys
   *  a release record verifies against. Two or more are valid at once during a rotation. Empty
   *  or absent ⇒ `decide()` raises `not-configured`; a key that is also a trust pin ⇒
   *  construction raises `invalid-options` (a release key is never a product key). */
  pinnedReleaseKeys?: TrustSet;
  /** Where this install came from: a kind (`"direct"`, `"steam"`, …), read as
   *  `{id: kind, kind}`, or the product's outlet id with its kind, `{id, kind, subkind?}`. It wins
   *  over `stamp` and `detected`. Without it the client detects the outlet (`detect`); with no
   *  stamp and no attested evidence the outlet is `unknown`, which is never offered an update.
   *  A Node CLI is never store-installed: `"direct"` is the usual value. */
  outlet?: HostOutlet;
  /** The build stamp's outlet fields (P1-11), when the host ships one: `outlet`, `outletKind`,
   *  `outletSubkind`, and the product's `outletIds` that launcher signals must name. */
  stamp?: OutletStamp | null;
  /** An outlet detection result the host computed itself. When it is absent and `outlet` is
   *  too, the client detects in-process (`detect`). */
  detected?: DetectedOutlet | null;
  /** Detect the outlet when neither `outlet` nor `detected` is given: this process's signals
   *  (`readOutletSignals`) and the stamp, through client-core's `detectOutlet`, whose result goes
   *  to `resolveUpdateOutlet` as `detected` (plans/P3-01.md §2.9). Default true. */
  detect?: boolean;
  /** The product's npm package name, for the `node.packageManager` signal: an npx, npm or pnpm
   *  launch counts only when the script runs from `node_modules/<packageName>/`. */
  packageName?: string | null;
  /** What the readers look at; this process by default (tests pass a fake install). */
  outletEnvironment?: OutletReaderEnvironment;
  /** The installed build's build number (informational in v4). Default null. */
  buildNumber?: string | null;
  /** The installed build's format (`"zip"`, `"dmg"`, `"exe"`, …): a binary build of another
   *  format is never offered. Default null (any format). */
  format?: string | null;
  /** What this host can do with a `binary` decision. Default `["download"]`. */
  methods?: BinaryMethod[];
  /** The executable's version when it differs from `CoreOptions.version` (after a code update,
   *  the code's version is `version` and the binary's is this). Defaults to `version`. */
  binaryVersion?: string;
  /** `godot-<major>.<minor>` for a host that runs Godot code packs; null (the default) otherwise. */
  engine?: string | null;
  /** The install's platform. Defaults to `os.platform()`'s canonical value. */
  platform?: Platform;
  /** Packs (`client.update.packs`, plans/P4-01.md §2.6–§2.9): the content stamp, embedded
   *  baselines, variant preferences and the store directory. Pack records verify against
   *  `pinnedReleaseKeys`. */
  packs?: NodePacksOptions;
  /** The device's architecture. Defaults to `os.arch()`'s canonical value. */
  arch?: Arch;
}

/** `client.update.decide()`'s arguments. */
export interface UpdateDecideOptions {
  /** The channel to ask for, as REQUESTED (an alias such as `latest` is fine). Defaults to the
   *  client's channel (`CoreOptions.channel`, else derived from `version`). */
  channel?: string;
  /** An update the host staged and verified, under the `UpdateCheck.channel` it was staged on. */
  staged?: StagedUpdate | null;
  /** The version the boot guard rolled back: never re-offered automatically. */
  skipVersion?: string | null;
}

/** `client.update.feed()`'s answer: the verified feed `decide()` would decide from. */
export interface FeedCheck {
  /** The canonical channel: the feed's own `channel` claim. */
  channel: string;
  feed: ChannelFeedDoc;
  /** `"network"` when the fetched copy was committed or equals the committed one;
   *  `"committed"` when the earlier copy was used instead. */
  source: UpdateCheck["feed"];
  errors: UpdateCheckError[];
}

/** `client.update.releaseRecord()`'s answer. */
export interface ReleaseRecordCheck {
  sha256: string;
  record: ReleaseRecordDoc;
  source: "network" | "cache";
  /** True when a committed feed's target for this platform pins the hash: the record was
   *  cross-checked against that pin and committed to the cache. */
  pinned: boolean;
}

/**
 * The error `decide()`, `feed()` and `releaseRecord()` raise when there is nothing to decide
 * from (plans/P3-01.md §2.5's error map): `feed-rejected` (with the step as `detail`),
 * `feed-rollback`, `record-rejected`, `record-mismatch`, `network-error` or the Worker's own wire
 * code. The options refusals (`not-configured`, `invalid-options`) and step 1's
 * `service-unavailable` are this class too, with a null `detail`. Core's own refusals before the
 * update client runs — the D-21 gate (`service-unavailable` when the product runs no Update or
 * Release service, an `UnsupportedError` with `reason: "product"`) and `local-only` — are the
 * `PolarisError`s every sub-client raises.
 */
export class UpdateError extends PolarisError {
  readonly detail: string | null;

  constructor(code: string, message: string, detail: string | null = null) {
    super(code, message);
    this.name = "UpdateError";
    this.detail = detail;
  }
}

/** What the update client needs from the facade beyond Core: the cache and trust custodians, a
 *  way to load discovery when this session has not yet, and the host's options. */
export interface UpdateWiring {
  cache?: CacheManager;
  trust?: TrustManager;
  discover?: () => Promise<unknown>;
  options?: UpdateClientOptions;
}

/** The validated options. */
interface Configured {
  releaseKeys: TrustSet;
  outlet: ResolvedOutlet;
  detected: DetectedOutlet | null;
  methods: BinaryMethod[];
  opts: UpdateClientOptions;
}

/** A code `runUpdateCheck` never produces: `feed()` withholds the record fetch with it. */
const RECORD_WITHHELD = "record-withheld";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(message: string): UpdateError {
  return new UpdateError(ErrorCode.invalidOptions, message);
}

/** A key's raw 32 bytes as hex, for comparing keys by their bytes; null when it is not one. */
function rawKey(b64url: string): string | null {
  try {
    const raw = base64UrlDecode(b64url);
    return raw.length === 32 ? Buffer.from(raw).toString("hex") : null;
  } catch {
    return null;
  }
}

const optionalString = (v: unknown): boolean =>
  v === undefined || v === null || typeof v === "string";

/**
 * Validate `PolarisKeyClientOptions.update` against the trust pins. Throws `invalid-options`
 * (plans/P3-01.md §2.6, §2.8): an outlet outside the vocabularies, a method outside
 * `BINARY_METHODS`, a platform or arch outside the enums, or a pinned release key whose raw
 * bytes are also a trust pin.
 */
function configure(
  opts: UpdateClientOptions,
  pinnedTrust: TrustSet,
): Configured {
  if (!isPlainObject(opts)) throw invalid("update must be an options object.");
  const keys: unknown = opts.pinnedReleaseKeys ?? {};
  if (
    !isPlainObject(keys) ||
    Object.values(keys).some((k) => typeof k !== "string")
  )
    throw invalid("update.pinnedReleaseKeys must map kid to a base64url key.");
  const releaseKeys = { ...keys } as TrustSet;
  const pins = new Set(
    Object.values(pinnedTrust)
      .map(rawKey)
      .filter((k): k is string => k !== null),
  );
  for (const k of Object.values(releaseKeys)) {
    const raw = rawKey(k);
    if (raw !== null && pins.has(raw))
      throw invalid(
        "A pinned release key is also a trust pin; a release key is never a product key.",
      );
  }
  if (opts.outlet !== undefined && !isValidHostOutlet(opts.outlet))
    throw invalid(
      "update.outlet is not an outlet kind or {id, kind, subkind?}.",
    );
  if (opts.detected !== undefined && opts.detected !== null) {
    const d = opts.detected as unknown;
    const kinds: readonly string[] = [...OUTLET_KINDS, OUTLET_UNKNOWN];
    if (
      !isPlainObject(d) ||
      typeof d.kind !== "string" ||
      !kinds.includes(d.kind) ||
      !(
        d.subkind === null ||
        d.subkind === undefined ||
        (OUTLET_SUBKINDS as readonly unknown[]).includes(d.subkind)
      )
    )
      throw invalid("update.detected is not an outlet detection result.");
  }
  if (
    opts.stamp !== undefined &&
    opts.stamp !== null &&
    !isPlainObject(opts.stamp)
  )
    throw invalid("update.stamp must be an object.");
  const methods: unknown = opts.methods ?? ["download"];
  if (
    !Array.isArray(methods) ||
    methods.some((m) => !(BINARY_METHODS as readonly unknown[]).includes(m))
  )
    throw invalid(
      `update.methods must be a subset of ${BINARY_METHODS.join(", ")}.`,
    );
  if (
    opts.platform !== undefined &&
    !(PLATFORM_VALUES as readonly unknown[]).includes(opts.platform)
  )
    throw invalid(
      `update.platform must be one of ${PLATFORM_VALUES.join(", ")}.`,
    );
  if (
    opts.arch !== undefined &&
    !(ARCH_VALUES as readonly unknown[]).includes(opts.arch)
  )
    throw invalid(`update.arch must be one of ${ARCH_VALUES.join(", ")}.`);
  if (
    !optionalString(opts.buildNumber) ||
    !optionalString(opts.format) ||
    !optionalString(opts.engine) ||
    !(
      opts.binaryVersion === undefined || typeof opts.binaryVersion === "string"
    )
  )
    throw invalid(
      "update.buildNumber, format, engine and binaryVersion must be strings.",
    );
  if (opts.detect !== undefined && typeof opts.detect !== "boolean")
    throw invalid("update.detect must be a boolean.");
  if (!optionalString(opts.packageName))
    throw invalid("update.packageName must be a string.");
  let detected = (opts.detected ?? null) as DetectedOutlet | null;
  // §2.9: detection runs at every launch and is never cached; a host value always wins.
  if (opts.outlet === undefined && detected === null && opts.detect !== false) {
    const stamp = detectionStamp(opts.stamp ?? null);
    detected = detectOutlet({
      stamp,
      signals: readOutletSignals({
        ...((opts.outletEnvironment ?? {}) as OutletReaderEnvironment),
        packageName: (opts.packageName as string | null | undefined) ?? null,
        outletIds: stamp?.outletIds ?? null,
      }),
    });
  }
  const outlet = resolveUpdateOutlet({
    host: opts.outlet,
    stamp: opts.stamp ?? null,
    detected,
  });
  if (!outlet) throw invalid("update.outlet is not a valid outlet.");
  return {
    releaseKeys,
    outlet,
    detected,
    methods: [...(methods as BinaryMethod[])],
    opts,
  };
}

/** Substitute `{name}` placeholders, each percent-encoded, and resolve against the control
 *  plane (a template is normally absolute already). */
function expand(
  template: string,
  baseUrl: string,
  values: Record<string, string>,
): URL {
  let out = template;
  for (const [k, v] of Object.entries(values))
    out = out.split(`{${k}}`).join(encodeURIComponent(v));
  return new URL(out, `${baseUrl}/`);
}

/** The wire code a refusal body names (`{error: {code}}` or `{error: "code"}`), or null. */
async function wireCodeOf(res: Response): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(await res.text());
    if (!isPlainObject(body)) return null;
    const e = body.error;
    if (typeof e === "string" && e !== "") return e;
    if (isPlainObject(e) && typeof e.code === "string" && e.code !== "")
      return e.code;
    return null;
  } catch {
    return null;
  }
}

/**
 * Read at most `limit` bytes of a body and stop (plans/P3-01.md §2.5 step 11): a record body
 * longer than `MAX_RECORD_JWS_BYTES` cannot be one any feed pins, and the verifier refuses the
 * `limit`-byte prefix at step `hash` without hashing it, so the rest is never buffered. Bytes are
 * decoded as UTF-8; any non-ASCII byte stays non-ASCII, which step 12 refuses too.
 */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (total >= limit) await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, bytes.length - at);
    bytes.set(c.subarray(0, take), at);
    at += take;
    if (at >= bytes.length) break;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export class UpdateClient {
  /** The pack facet (`ensure`, `state`, `registerHandler`, progress events). */
  readonly packs: PacksClient;
  private readonly cache?: CacheManager;
  private readonly trust?: TrustManager;
  private readonly discoverNow?: () => Promise<unknown>;
  private readonly configured: Configured | null;
  /** The v4 calls run one at a time: each is a read-modify-write of the cache slices. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    private readonly discovery: () => ProductDiscoveryDocument | null,
    wiring: UpdateWiring = {},
  ) {
    this.cache = wiring.cache;
    this.trust = wiring.trust;
    this.discoverNow = wiring.discover;
    this.configured =
      wiring.options === undefined
        ? null
        : configure(wiring.options, ctx.pinnedTrust);
    this.packs = new PacksClient(
      {
        ctx,
        tokens,
        discovery,
        ...(wiring.discover ? { discover: wiring.discover } : {}),
        ...(wiring.cache ? { cache: wiring.cache } : {}),
        ...(wiring.trust ? { trust: wiring.trust } : {}),
        releaseKeys: () => this.configured?.releaseKeys ?? {},
      },
      wiring.options?.packs ?? {},
    );
  }

  /** The outlet `decide()` uses (`resolveUpdateOutlet`'s answer), or null when the client has
   *  no `update` options. For support diagnostics and UI. */
  get outlet(): ResolvedOutlet | null {
    return this.configured?.outlet ?? null;
  }

  /** The detection result `outlet` was resolved from (in-process, or the host's `detected`);
   *  null when the host named the outlet, turned detection off, or configured no updates. */
  get detected(): DetectedOutlet | null {
    return this.configured?.detected ?? null;
  }

  /**
   * `GET /<p>/update/version` — the newest build, and whether we are behind it.
   *
   * `updateAvailable` is computed from `CoreOptions.version`, the HOST APPLICATION's version,
   * not the SDK's: the SDK ships inside the thing being updated.
   */
  async check(opts: { channel?: string } = {}): Promise<VersionCheck> {
    this.ctx.requireService("update", Feature.updateCheck);
    const url = new URL(this.ctx.url("update/version"));
    if (opts.channel) url.searchParams.set("channel", opts.channel);

    const f = this.ctx.fetcher();
    const token = this.tokens.current;
    const res = await f(url.toString(), {
      headers: this.ctx.headers(
        token ? { authorization: `Bearer ${token}` } : {},
      ),
      signal: this.ctx.deadline(),
    });
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      throw new PolarisError(
        body.error?.code ?? "forbidden",
        "This build is not entitled to that update channel.",
      );
    }
    if (!res.ok) {
      throw new PolarisError(
        "not_found",
        `update/version failed with status ${res.status}.`,
      );
    }
    const body = (await res.json()) as {
      version: string;
      tag: string;
      url: string;
    };
    return {
      ...body,
      updateAvailable: compareSemver(this.ctx.version, body.version) < 0,
    };
  }

  /**
   * The Sparkle appcast URL for this product, from the discovery document.
   *
   * Returns null when discovery has not been loaded or Update is not enabled — the same
   * fail-closed posture the sub-client gate takes, expressed as a value because a host asking
   * "where is my feed?" before discovery has run is a sequencing question, not an error.
   */
  appcastUrl(opts: { channel?: string; arch?: string } = {}): string | null {
    const doc = this.discovery();
    if (!doc) return null;
    return appcastUrlFrom(doc, opts);
  }

  // ── Wire v4 ───────────────────────────────────────────────────────────────────────────

  /**
   * The signed update decision (plans/P3-01.md §2.5 steps 1–18): fetch the channel feed, verify
   * it against the effective product trust set and the channel's `seq` floor, commit it, fetch
   * the release record it pins for this platform (hash before signature, pinned release keys
   * only), and decide. Returns the `UpdateCheck` — `{channel, decision, feed, record, errors}`,
   * where `channel` is the canonical channel a host records as `staged.channel`.
   *
   * After a refusal it decides from the committed feed, reporting the refusal in `errors`; a
   * record that cannot be fetched or is refused is null for the call. It raises an
   * `UpdateError` only when it has nothing to decide from, and for `not-configured` (no
   * `update.pinnedReleaseKeys`), `service-unavailable` (the product runs no Update service, or
   * its discovery document has no v4 endpoints — fall back to `check()`) and `local-only`.
   *
   * Discovery is fetched first when this session has not loaded it. When the network is down
   * the decision still comes from the committed feed (a stale one answers `none {stale}`).
   */
  decide(opts: UpdateDecideOptions = {}): Promise<UpdateCheck> {
    return this.serialised(() => this.decideNow(opts));
  }

  /**
   * The verified feed `decide()` would decide from (§2.5 steps 1–10), without the record. It
   * runs the same steps, commits an accepted feed the same way, and falls back to the committed
   * feed the same way; it needs no release keys.
   */
  feed(opts: { channel?: string } = {}): Promise<FeedCheck> {
    return this.serialised(() => this.feedNow(opts));
  }

  /**
   * One release record by its lowercase hex SHA-256 (§2.5 steps 11–16): from the cache, else
   * `GET …/release/records/{sha256}`; the body's hash must equal `sha256` before any signature
   * work, and the signature must come from a PINNED release key. When a committed feed's target
   * for this platform pins the hash, the record is cross-checked against that pin and committed;
   * otherwise it is verified only. Raises `record-rejected` (`detail`: `hash`, `jws` or
   * `claims`), `record-mismatch`, a transport code, `not-configured` or `service-unavailable`.
   */
  releaseRecord(sha256: string): Promise<ReleaseRecordCheck> {
    return this.serialised(() => this.releaseRecordNow(sha256));
  }

  /**
   * A build's download URL (plans/P3-01.md §2.4 "Bytes", decision 5): discovery's
   * `distribution.endpoints.builds`, else Release's `release.endpoints.builds`, with
   * `{selector}` = the record's `version` and `{buildId}` = the build's `id`, each
   * percent-encoded. That route serves the build's payload from every location it has; the
   * R2-only blob route is never used. Verify the bytes against the record's `size` and `sha256`
   * before staging. Null when discovery has not been loaded or names neither template.
   */
  buildUrl(version: string, buildId: string): string | null {
    const template = updateEndpointsFrom(this.discovery()).builds;
    if (template === null) return null;
    return expand(template, this.ctx.baseUrl, {
      selector: version,
      buildId,
    }).toString();
  }

  /**
   * The reload path (§2.5 "Reload path") over the stored slices, run by `init()` after the
   * cache load: every committed feed is re-verified (steps 3–6, no freshness, its claim equal to
   * its key) and every record against the pinned release keys, kept only while a surviving
   * feed pins it. What fails is dropped from the in-memory record. Without release keys the
   * records are left for `decide()` to judge.
   */
  async reload(): Promise<void> {
    const cache = this.cache;
    const trust = this.trust;
    const platform = this.platformValue();
    if (!cache || !trust || platform === null) return;
    const slices = cache.updateSlices();
    const reloaded = await reloadFeeds(slices.feeds, {
      trust: trust.effective,
      expectedAud: this.ctx.product,
      platform,
    });
    const feeds: Record<string, string> = {};
    const pinned = new Set<string>();
    for (const [k, c] of Object.entries(reloaded.feeds)) {
      feeds[k] = c.jws;
      const t = feedTarget(c.feed.app.targets, platform);
      if (t) pinned.add(t.release.sha256);
    }
    let releaseRecords = slices.releaseRecords;
    const keys = this.configured?.releaseKeys ?? {};
    if (Object.keys(keys).length > 0) {
      const kept = await reloadReleaseRecords(slices.releaseRecords, {
        releaseKeys: keys,
        productTrust: trust.effective,
        expectedAud: this.ctx.product,
        pinned,
      });
      releaseRecords = {};
      for (const [h, r] of Object.entries(kept)) releaseRecords[h] = r.jws;
    }
    cache.keepUpdateSlices({ feeds, releaseRecords });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireConfigured(): Configured {
    const c = this.configured;
    if (!c || Object.keys(c.releaseKeys).length === 0)
      throw new UpdateError(
        ErrorCode.notConfigured,
        "Update decisions need update.pinnedReleaseKeys.",
      );
    return c;
  }

  private requireCustody(): { cache: CacheManager; trust: TrustManager } {
    if (!this.cache || !this.trust)
      throw new UpdateError(
        ErrorCode.notConfigured,
        "This update client has no cache; construct it through PolarisKeyClient.",
      );
    return { cache: this.cache, trust: this.trust };
  }

  /** The install's canonical platform, or null when this OS has none and the host set none. */
  private platformValue(): string | null {
    return this.configured?.opts.platform ?? canonicalPlatform(osPlatform());
  }

  private installed(): InstalledBuild {
    const opts = this.configured?.opts ?? {};
    const platform = this.platformValue();
    const arch = opts.arch ?? canonicalArch(osArch());
    if (platform === null || arch === null)
      throw new UpdateError(
        ErrorCode.notConfigured,
        `This host's platform or arch (${osPlatform()}/${osArch()}) has no canonical value; set update.platform and update.arch.`,
      );
    return {
      version: this.ctx.version,
      ...(opts.binaryVersion !== undefined
        ? { binaryVersion: opts.binaryVersion }
        : {}),
      buildNumber: opts.buildNumber ?? null,
      platform,
      arch,
      format: opts.format ?? null,
      engine: opts.engine ?? null,
    };
  }

  /**
   * §2.5 step 1: the feed and record templates from discovery, loading discovery first when
   * this session has not. A loaded document that lacks a needed one is refused as
   * `service-unavailable` before dialling. When discovery itself cannot be reached, null: the
   * fetches then fail as a transport failure, and the decision comes from the committed feed.
   */
  private async endpoints(need: {
    feed: boolean;
    record: boolean;
  }): Promise<{ feed: string; record: string } | null> {
    let doc = this.discovery();
    if (!doc && this.discoverNow) {
      try {
        await this.discoverNow();
      } catch (e) {
        if (e instanceof PolarisError && e.code === ErrorCode.localOnly)
          throw e;
      }
      doc = this.discovery();
    }
    if (!doc) return null;
    const ep = updateEndpointsFrom(doc);
    if ((need.feed && ep.feed === null) || (need.record && ep.record === null))
      throw new UpdateError(
        ErrorCode.serviceUnavailable,
        "This Worker serves no signed update feed (wire v4); use update.check().",
      );
    return { feed: ep.feed ?? "", record: ep.record ?? "" };
  }

  /** One `application/jose` GET. Never throws: a transport failure or a non-2xx answer is the
   *  Worker's wire code when its body names one, else `network-error`. The device bearer goes
   *  only to the control plane's own origin, never to a host a discovery document named. */
  private async getJose(
    url: URL | null,
    f: typeof fetch,
    maxBytes?: number,
  ): Promise<FetchOutcome> {
    if (url === null) return { ok: false, code: ErrorCode.networkError };
    try {
      const token = this.tokens.current;
      const sameOrigin = url.origin === new URL(this.ctx.baseUrl).origin;
      const res = await f(url.toString(), {
        headers: this.ctx.headers({
          accept: "application/jose",
          ...(token && sameOrigin ? { authorization: `Bearer ${token}` } : {}),
        }),
        signal: this.ctx.deadline(),
      });
      if (!res.ok)
        return {
          ok: false,
          code: (await wireCodeOf(res)) ?? ErrorCode.networkError,
        };
      const body =
        maxBytes === undefined
          ? await res.text()
          : await readCapped(res, maxBytes + 1);
      return { ok: true, body };
    } catch {
      return { ok: false, code: ErrorCode.networkError };
    }
  }

  /** §2.5 steps 2 and 11 over the discovered templates (null: discovery was unreachable). */
  private fetchers(
    ep: { feed: string; record: string } | null,
    platform: string,
    f: typeof fetch,
  ): {
    fetchFeed: (channel: string) => Promise<FetchOutcome>;
    fetchRecord: (sha256: string) => Promise<FetchOutcome>;
  } {
    return {
      fetchFeed: (channel) => {
        if (ep === null) return this.getJose(null, f);
        const url = expand(ep.feed, this.ctx.baseUrl, { channel });
        url.searchParams.set("platform", platform);
        return this.getJose(url, f);
      },
      fetchRecord: (sha256) =>
        this.getJose(
          ep === null ? null : expand(ep.record, this.ctx.baseUrl, { sha256 }),
          f,
          MAX_RECORD_JWS_BYTES,
        ),
    };
  }

  private raise(error: UpdateCheckError): UpdateError {
    const message = error.detail
      ? `update: ${error.code} (${error.detail})`
      : `update: ${error.code}`;
    return new UpdateError(error.code, message, error.detail);
  }

  private async decideNow(opts: UpdateDecideOptions): Promise<UpdateCheck> {
    const c = this.requireConfigured();
    const { cache, trust } = this.requireCustody();
    this.ctx.requireService("update", Feature.updateDecide);
    const f = this.ctx.fetcher();
    const installed = this.installed();
    const ep = await this.endpoints({ feed: true, record: true });
    const r = await runUpdateCheck({
      channel: opts.channel ?? this.ctx.channel,
      expectedAud: this.ctx.product,
      trust: trust.effective,
      releaseKeys: c.releaseKeys,
      // §2.5: the effective clock, max(system, highWaterMark) (V3 §4.2).
      now: this.ctx.now(),
      installId: this.ctx.deviceId || null,
      installed,
      outlet: { id: c.outlet.id, kind: c.outlet.kind },
      subkind: c.outlet.subkind,
      staged: opts.staged ?? null,
      skipVersion: opts.skipVersion ?? null,
      methods: c.methods,
      cache: cache.updateSlices(),
      ...this.fetchers(ep, installed.platform, f),
    });
    if (!r.ok) throw this.raise(r.error);
    await cache.patch({
      feeds: r.cache.feeds,
      releaseRecords: r.cache.releaseRecords,
    });
    return r.check;
  }

  private async feedNow(opts: { channel?: string }): Promise<FeedCheck> {
    const { cache, trust } = this.requireCustody();
    this.ctx.requireService("update", Feature.updateFeed);
    const f = this.ctx.fetcher();
    const installed = this.installed();
    const ep = await this.endpoints({ feed: true, record: false });
    // The same steps as `decide()`, by the same function, with the record fetch withheld: the
    // order, the floors and the fallback cannot differ between the two. The decision it makes
    // over no record is discarded, and only the `feeds` slice is written.
    const r = await runUpdateCheck({
      channel: opts.channel ?? this.ctx.channel,
      expectedAud: this.ctx.product,
      trust: trust.effective,
      releaseKeys: this.configured?.releaseKeys ?? {},
      now: this.ctx.now(),
      installId: null,
      installed,
      outlet: { id: null, kind: OUTLET_UNKNOWN },
      subkind: null,
      methods: [],
      cache: { feeds: cache.updateSlices().feeds },
      fetchFeed: this.fetchers(ep, installed.platform, f).fetchFeed,
      fetchRecord: async () => ({ ok: false, code: RECORD_WITHHELD }),
    });
    if (!r.ok) throw this.raise(r.error);
    await cache.patch({ feeds: r.cache.feeds });
    return {
      channel: r.check.channel,
      feed: r.feed,
      source: r.check.feed,
      errors: r.check.errors.filter((e) => e.code !== RECORD_WITHHELD),
    };
  }

  private async releaseRecordNow(sha256: string): Promise<ReleaseRecordCheck> {
    const c = this.requireConfigured();
    const { cache, trust } = this.requireCustody();
    this.ctx.requireService("release", Feature.releaseRecord);
    const f = this.ctx.fetcher();
    const installed = this.installed();
    const ep = await this.endpoints({ feed: false, record: true });
    const slices = cache.updateSlices();

    // The pin, from a committed feed that still verifies (the reload path).
    const committed = await reloadFeeds(slices.feeds, {
      trust: trust.effective,
      expectedAud: this.ctx.product,
      platform: installed.platform,
    });
    let pin: { deliverable: string; version: string; seq: number } | undefined;
    for (const cf of Object.values(committed.feeds)) {
      const t = feedTarget(cf.feed.app.targets, installed.platform);
      if (t && t.release.sha256 === sha256) {
        pin = {
          deliverable: "app",
          version: t.release.version,
          seq: t.release.seq,
        };
        break;
      }
    }
    const verifyOpts = {
      releaseKeys: c.releaseKeys,
      productTrust: trust.effective,
      expectedAud: this.ctx.product,
      expectedHash: sha256,
      ...(pin ? { pin } : {}),
    };

    const cached = Object.prototype.hasOwnProperty.call(
      slices.releaseRecords,
      sha256,
    )
      ? slices.releaseRecords[sha256]
      : undefined;
    if (cached !== undefined) {
      const r = await verifyReleaseRecord(cached, verifyOpts);
      if (r.ok)
        return { sha256, record: r.record, source: "cache", pinned: !!pin };
    }

    const got = await this.fetchers(ep, installed.platform, f).fetchRecord(
      sha256,
    );
    if (!got.ok) throw this.raise({ code: got.code, detail: null });
    const r = await verifyReleaseRecord(got.body, verifyOpts);
    if (!r.ok)
      throw this.raise(
        r.step === "cross-check"
          ? { code: ErrorCode.recordMismatch, detail: null }
          : { code: ErrorCode.recordRejected, detail: r.step },
      );
    if (pin)
      await cache.patch({
        releaseRecords: { ...slices.releaseRecords, [sha256]: got.body },
      });
    return { sha256, record: r.record, source: "network", pinned: !!pin };
  }
}
