/**
 * THE GOOGLE PLAY STOREFRONT ADAPTER'S RUNTIME (A-18e; notes/S-15 §4.1, §5.3, §6.2–§6.6, §8.4).
 * The declaration is `core/storefront/stores/googlePlay.ts`; the rule table
 * `core/storefront/rules/googlePlay.ts`. This module performs the declared `api` operations for one
 * product's pinned Play app, and nothing else:
 *
 *   - **One edit, under the lease.** `PlayEditSession.begin` takes the package's EDIT LEASE
 *     (`lease.ts`, purpose `provisioning`, or `import` for a read-only edit) BEFORE any token or
 *     edit, so P5-03's poll skips its ticks and its controls answer 409 while the session's edit is
 *     open; every step renews the lease (`keepAlive`), and a session whose lease was lost stops
 *     before its next request. `close` discards an uncommitted edit and releases the lease.
 *   - **Every write is a ledger step** (`performStoreWrite`, `store_operations`, store
 *     `google-play`): the console's `Idempotency-Key`, a natural-key pre-read (S-15 §6.3: the
 *     listing by language, the image by its hash, the track by name, the product by id), the gated
 *     write, a re-read, one audit row (`distribution.play.<op>`). Replays answer the stored row.
 *   - **Through the gate.** The session's client is gated: every request is checked before its
 *     token. Typed confirmation (Play's default-language title, `playTypedConfirmation`) is asserted
 *     only by the caller after comparing it: the commit of an edit that touched production, a
 *     completed production release, and any one-time product price after the initial one.
 *   - **Budget.** Each request sent spends the local per-minute counter (3,000 per bucket, no rate
 *     header); a session or product step refuses with 429 `rate_budget` when the tier says no.
 *   - **Decision 6: no image deletes.** Uploading a replacement leaves the old images in place;
 *     the result names how many remain and the deep link where the operator removes them.
 *
 * NOT HERE (seams): the console routes and pages that call these functions (A-18j), the listing
 * import that maps `readPlayListing` into the model (A-18c), AAB upload (CI only), data safety
 * (Console only, decision 4), live permission checks (A-18k).
 */

import type { Db, Env } from "../../../../core/platform.js";
import type { ServiceHooks } from "../../../../core/hooks.js";
import type { AdminSession } from "../../../../core/adminApi.js";
import { parsePlatformCredentialHandle } from "../../../../core/platformCredentials.js";
import {
  budgetAllows,
  readRate,
  storeMeter,
  type BudgetKey,
  type StoreSpend,
} from "../../../../core/storefront/budget.js";
import {
  typedConfirmationRefusal,
  type ConfirmationRefusal,
} from "../../../../core/storefront/confirm.js";
import {
  performStoreWrite,
  type StoreOpKey,
  type StoreWriteResult,
} from "../../../../core/storefront/ledger.js";
import type { StoreResource } from "../../../../core/storefront/audit.js";
import {
  isProductionTrack,
  PLAY_EDIT_SCOPE,
  PLAY_IMAGE_MAX_BYTES,
  type PlayImageType,
} from "../../../../core/storefront/rules/googlePlay.js";
import { GOOGLE_PLAY_ADAPTER } from "../../../../core/storefront/stores/googlePlay.js";
import { PlayError, type FetchImpl, type GoogleApiClient } from "./client.js";
import {
  acquirePlayEditLease,
  isLeaseHeld,
  releasePlayEditLease,
  renewPlayEditLease,
  type PlayEditLease,
} from "./lease.js";
import { finishRun, playRun, type PlayRun } from "./run.js";
import {
  isPinReason,
  PLAY_TRACK,
  resolvePlaySetup,
  type PlaySetup,
} from "./setup.js";

const STORE = "google-play" as const;

export interface PlayStoreContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  session: AdminSession;
  now: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  /** The wall clock for lease renewal and the budget during a long session (epoch seconds). */
  clock?: () => number;
}

/** A refusal decided before (or instead of) a write; the handler maps it onto its answer. */
export interface PlayStoreRefusal {
  ok: false;
  status: 404 | 409 | 422 | 429 | 502;
  reason: string;
  message: string;
  fields?: string[];
}

const refuse = (
  status: PlayStoreRefusal["status"],
  reason: string,
  message: string,
  fields?: string[],
): PlayStoreRefusal => ({
  ok: false,
  status,
  reason,
  message,
  ...(fields ? { fields } : {}),
});

export function isPlayRefusal(v: unknown): v is PlayStoreRefusal {
  return (
    typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false
  );
}

/** The session's lease was lost (expired, taken over): its edit may be invalid; stop. */
export class PlayEditLeaseLost extends Error {
  constructor() {
    super(
      "the Google Play edit lease was lost; the edit may have been invalidated",
    );
    this.name = "PlayEditLeaseLost";
  }
}

const clockOf = (ctx: PlayStoreContext) =>
  ctx.clock ?? (() => Math.floor(Date.now() / 1000));

function budgetKey(setup: PlaySetup): BudgetKey {
  return parsePlatformCredentialHandle(setup.credentialId)
    ? { source: "platform" }
    : { source: "product", credentialId: setup.credentialId };
}

/** The product's pinned Play setup, or the refusal the controls give (`controls.ts` `withRun`). */
async function setupOf(
  ctx: PlayStoreContext,
): Promise<PlaySetup | PlayStoreRefusal> {
  const { setup, inert } = await resolvePlaySetup(ctx.env, ctx.db, ctx.product);
  if (setup) return setup;
  if (isPinReason(inert.reason))
    return refuse(409, `credential_${inert.reason}`, inert.message);
  return refuse(
    404,
    "not_configured",
    "Google Play is not configured: declare a play or play-testing outlet with a packageName, and pin a Google service account to that package",
  );
}

/** A connector run for provisioning, whose every request spends the budget. */
async function provisioningRun(
  ctx: PlayStoreContext,
  setup: PlaySetup,
  use: string,
  spend: StoreSpend,
): Promise<PlayRun | PlayStoreRefusal> {
  const key = budgetKey(setup);
  const rate = await readRate(ctx.env, STORE, ctx.product, key, clockOf(ctx)());
  if (!budgetAllows(rate, spend))
    return refuse(
      429,
      "rate_budget",
      "the Google Play budget for this credential is spent for this minute; try again shortly",
    );
  const meter = storeMeter(ctx.env, STORE, ctx.product, key);
  return playRun({
    env: ctx.env,
    db: ctx.db,
    product: ctx.product,
    hooks: ctx.hooks,
    now: ctx.now,
    setup,
    use,
    onSend: () => meter.spend(clockOf(ctx)()),
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  });
}

function opKey(
  ctx: PlayStoreContext,
  op: string,
  naturalKey: string,
  idempotencyKey: string,
): StoreOpKey {
  return {
    store: STORE,
    scope: "product",
    product: ctx.product,
    op,
    naturalKey,
    idempotencyKey,
  };
}

/** A Google read that answers null for a 404 (the natural-key pre-read's "absent"). */
async function readOrNull(
  p: Promise<Record<string, unknown> | null>,
): Promise<Record<string, unknown> | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlayError && e.status === 404) return null;
    throw e;
  }
}

const strOf = (v: unknown): string | null => (typeof v === "string" ? v : null);

// ── The edit session ─────────────────────────────────────────────────────────────────────────

export type PlaySessionPurpose = "provisioning" | "import";

/**
 * One Play edit, held under the package's edit lease for its whole life. Open it, run steps, then
 * `close` (always, in a `finally`): an uncommitted edit is discarded and the lease released.
 */
export class PlayEditSession {
  /** What the edit's steps touched, for the commit's gate scope. */
  readonly touched = { production: false, statusChange: false };
  committed = false;
  private error: unknown = null;

  private constructor(
    readonly ctx: PlayStoreContext,
    readonly setup: PlaySetup,
    readonly run: PlayRun,
    readonly lease: PlayEditLease,
    readonly editId: string,
  ) {}

  get packageName(): string {
    return this.setup.packageName;
  }

  get api(): GoogleApiClient {
    return this.run.publisher.api;
  }

  /**
   * Take the lease, then open the edit. Answers a refusal (no token, no edit) when the setup is
   * missing or mis-pinned, the budget says no, or another caller holds the lease.
   */
  static async begin(
    ctx: PlayStoreContext,
    purpose: PlaySessionPurpose = "provisioning",
    spend: StoreSpend = "operator",
  ): Promise<PlayEditSession | PlayStoreRefusal> {
    const setup = await setupOf(ctx);
    if (isPlayRefusal(setup)) return setup;
    const lease = await acquirePlayEditLease(ctx.db, {
      packageName: setup.packageName,
      purpose,
      actor: `admin:${ctx.session.sub}`,
      now: clockOf(ctx)(),
    });
    if (isLeaseHeld(lease))
      return refuse(
        409,
        "edit_lease_held",
        `Google Play is busy: a ${lease.purpose} edit holds this app's edit lease until ${new Date(
          lease.expiresAt * 1000,
        ).toISOString()}`,
      );
    const run = await provisioningRun(
      ctx,
      setup,
      purpose === "import" ? "play:import" : "play:provision",
      spend,
    );
    if (isPlayRefusal(run)) {
      await releasePlayEditLease(ctx.db, lease);
      return run;
    }
    try {
      const editId = await run.publisher.insertEdit();
      return new PlayEditSession(ctx, setup, run, lease, editId);
    } catch (e) {
      await releasePlayEditLease(ctx.db, lease);
      await finishRun(run, e);
      throw e;
    }
  }

  /** Renew the lease before a step (a long upload renews it again). Throws when it was lost. */
  async keepAlive(): Promise<void> {
    if (
      !(await renewPlayEditLease(this.ctx.db, this.lease, clockOf(this.ctx)()))
    )
      throw new PlayEditLeaseLost();
  }

  /** Remember a failure for the credential's health columns. */
  fail(e: unknown): void {
    this.error ??= e;
  }

  /** Discard an uncommitted edit, release the lease, record the run. Idempotent enough to call once in a `finally`. */
  async close(): Promise<void> {
    try {
      if (!this.committed) await this.run.publisher.deleteEdit(this.editId);
    } finally {
      await releasePlayEditLease(this.ctx.db, this.lease);
      await finishRun(this.run, this.error);
    }
  }

  /** `["edits", <editId>, ...rest]`. */
  seg(...rest: string[]): string[] {
    return ["edits", this.editId, ...rest];
  }
}

/** Run `fn` in a fresh session, closing it whatever happens. */
export async function withPlayEditSession<T>(
  ctx: PlayStoreContext,
  purpose: PlaySessionPurpose,
  fn: (s: PlayEditSession) => Promise<T>,
): Promise<T | PlayStoreRefusal> {
  const s = await PlayEditSession.begin(ctx, purpose);
  if (isPlayRefusal(s)) return s;
  try {
    return await fn(s);
  } catch (e) {
    s.fail(e);
    throw e;
  } finally {
    await s.close();
  }
}

// ── Typed confirmation ───────────────────────────────────────────────────────────────────────

/** Play's name for the app: the default-language listing's title, as Play reports it now. */
export async function playAppName(s: PlayEditSession): Promise<string | null> {
  const details = await s.api.request(
    "GET",
    s.seg("details"),
    "edits.details.get",
  );
  const lang = strOf(details?.defaultLanguage);
  if (!lang) return null;
  const listing = await readOrNull(
    s.api.request("GET", s.seg("listings", lang), "edits.listings.get"),
  );
  return strOf(listing?.title);
}

/**
 * Compare what the operator typed with Play's title for the app (`confirm.ts`). Only after this
 * answers null may the caller pass `typed: true` to a step.
 */
export async function playTypedConfirmation(
  s: PlayEditSession,
  typed: unknown,
  action: string,
): Promise<ConfirmationRefusal | null> {
  return typedConfirmationRefusal(
    typed,
    await playAppName(s),
    action,
    GOOGLE_PLAY_ADAPTER.confirmation,
  );
}

// ── Listing text (writeListingText) ──────────────────────────────────────────────────────────

export interface PlayDetailsInput {
  defaultLanguage?: string;
  contactEmail?: string;
  contactWebsite?: string;
}

function detailsResource(
  pkg: string,
  d: Record<string, unknown> | null,
): StoreResource | null {
  return d ? { type: "details", id: pkg, attributes: d } : null;
}

/** `edits.details.patch`: the default language, public contact email and website. */
export function playWriteDetails(
  s: PlayEditSession,
  input: PlayDetailsInput,
  idempotencyKey: string,
): Promise<StoreWriteResult> {
  const read = async () =>
    detailsResource(
      s.packageName,
      await s.api.request("GET", s.seg("details"), "edits.details.get"),
    );
  return performStoreWrite(s.ctx.db, {
    key: opKey(s.ctx, "details.update", "details", idempotencyKey),
    request: input,
    session: s.ctx.session,
    now: s.ctx.now,
    find: read,
    satisfied: (r) =>
      Object.entries(input).every(([k, v]) => r.attributes?.[k] === v),
    write: async () => {
      await s.keepAlive();
      return detailsResource(
        s.packageName,
        await s.api.request("PATCH", s.seg("details"), "edits.details.patch", {
          body: input,
        }),
      );
    },
    reread: read,
    resultIds: () => ({ packageName: s.packageName }),
    summary: (_r, outcome) =>
      `${outcome === "written" ? "Updated" : "Kept"} the Google Play app details of ${s.packageName}`,
  });
}

export interface PlayListingInput {
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
  video?: string;
}

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

function listingResource(
  language: string,
  l: Record<string, unknown> | null,
): StoreResource | null {
  return l
    ? { type: "listings", id: language, attributes: { ...l, language } }
    : null;
}

/**
 * One language's listing (`edits.listings.patch`, or `update` when Play has none yet), natural key
 * the language (`edits.listings.get`).
 */
export async function playWriteListing(
  s: PlayEditSession,
  language: string,
  input: PlayListingInput,
  idempotencyKey: string,
): Promise<StoreWriteResult | PlayStoreRefusal> {
  if (!LOCALE.test(language))
    return refuse(
      422,
      "invalid_body",
      "language must be a Play language code",
      ["language"],
    );
  const read = async () =>
    listingResource(
      language,
      await readOrNull(
        s.api.request("GET", s.seg("listings", language), "edits.listings.get"),
      ),
    );
  return performStoreWrite(s.ctx.db, {
    key: opKey(s.ctx, "listing.update", `listing:${language}`, idempotencyKey),
    request: { language, ...input },
    session: s.ctx.session,
    now: s.ctx.now,
    find: read,
    satisfied: (r) =>
      Object.entries(input).every(([k, v]) => r.attributes?.[k] === v),
    write: async (existing) => {
      await s.keepAlive();
      const body = { language, ...input };
      return listingResource(
        language,
        existing
          ? await s.api.request(
              "PATCH",
              s.seg("listings", language),
              "edits.listings.patch",
              { body },
            )
          : await s.api.request(
              "PUT",
              s.seg("listings", language),
              "edits.listings.update",
              { body },
            ),
      );
    },
    reread: read,
    resultIds: () => ({ language }),
    summary: (_r, outcome) =>
      `${outcome === "written" ? "Wrote" : "Kept"} the Google Play listing in ${language}`,
  });
}

// ── Listing images (writeListingAssets; decision 2, decision 6) ──────────────────────────────

/** An image to upload, from the blob store's record. `read` answers the bytes. */
export interface PlayImageSource {
  contentType: string;
  size: number;
  /** Hex SHA-256 of the bytes (the blob store's content address). */
  sha256: string;
  read(): Promise<Uint8Array>;
}

/** The listing slots (A-18b's `dist_listing_assets`) Play's image types are filled from. */
export const PLAY_IMAGE_SLOTS: Readonly<Record<string, PlayImageType>> = {
  "play:icon": "icon",
  "play:feature-graphic": "featureGraphic",
  "screenshot:phone-portrait": "phoneScreenshots",
  "screenshot:tablet": "tenInchScreenshots",
  "screenshot:tv": "tvScreenshots",
  "screenshot:wear": "wearScreenshots",
};

/**
 * A listing asset's bytes from the blob store, for `playUploadImage`: the product's
 * `dist_listing_assets` row for (slot, locale), its R2 object's size and type, and a reader that
 * re-checks the SHA-256. Null when the row or the object is missing.
 */
export async function playImageFromListingAsset(
  env: Env,
  db: Db,
  product: string,
  slot: string,
  locale: string,
): Promise<PlayImageSource | null> {
  const row = await db.first<{ blob: string; sha256: string }>(
    "SELECT blob, sha256 FROM dist_listing_assets WHERE product = ? AND slot = ? AND locale = ?",
    product,
    slot,
    locale,
  );
  if (!row || !env.BLOBS) return null;
  const head = await env.BLOBS.head(row.blob);
  if (!head) return null;
  const bucket = env.BLOBS;
  return {
    contentType: head.httpMetadata?.contentType ?? "application/octet-stream",
    size: head.size,
    sha256: row.sha256,
    async read() {
      const obj = await bucket.get(row.blob);
      if (!obj) throw new Error("listing asset is gone from the blob store");
      return new Uint8Array(await obj.arrayBuffer());
    },
  };
}

interface PlayImage {
  id: string;
  sha1: string | null;
  sha256: string | null;
  aiGeneratedState: string | null;
}

function parseImages(doc: Record<string, unknown> | null): PlayImage[] {
  const list = Array.isArray(doc?.images) ? (doc!.images as unknown[]) : [];
  return list.flatMap((i) => {
    const r = i as Record<string, unknown>;
    const id = strOf(r.id);
    return id
      ? [
          {
            id,
            sha1: strOf(r.sha1),
            sha256: strOf(r.sha256),
            aiGeneratedState: strOf(r.aiGeneratedState),
          },
        ]
      : [];
  });
}

async function hexDigest(
  algo: "SHA-1" | "SHA-256",
  bytes: Uint8Array,
): Promise<string> {
  const d = await crypto.subtle.digest(algo, bytes);
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface PlayImageUploadResult {
  result: StoreWriteResult;
  /** Images of this type and language other than the uploaded one: Play keeps them until the
   *  operator removes them in the Console (decision 6: no image deletes in v1). */
  oldImages: number;
  /** The deep-link row where the operator removes them (`renderDeepLink` with the Console ids). */
  removeOldAt: "google-play.main-store-listing" | null;
}

/**
 * Upload one listing image (`edits.images.upload`, simple media upload). Natural key: the image's
 * hash among Play's images of that type and language (`images.list` reports `sha256` and `sha1`);
 * when Play reports neither, the ledger's own done upload row of the same bytes, if its image id is
 * still listed. Nothing is ever deleted (decision 6).
 */
export async function playUploadImage(
  s: PlayEditSession,
  input: {
    language: string;
    imageType: PlayImageType;
    image: PlayImageSource;
    aiGenerated: boolean;
  },
  idempotencyKey: string,
): Promise<PlayImageUploadResult | PlayStoreRefusal> {
  const { language, imageType, image } = input;
  if (!LOCALE.test(language))
    return refuse(
      422,
      "invalid_body",
      "language must be a Play language code",
      ["language"],
    );
  if (image.size > PLAY_IMAGE_MAX_BYTES)
    return refuse(
      422,
      "too_large",
      "a Play listing image may be at most 15 MiB",
      ["image"],
    );
  if (!/^[0-9a-f]{64}$/.test(image.sha256))
    return refuse(
      422,
      "invalid_body",
      "the image's SHA-256 is not a hex digest",
      ["image"],
    );
  const naturalKey = `image:${language}:${imageType}:${image.sha256}`;
  const list = async () =>
    parseImages(
      await s.api.request(
        "GET",
        s.seg("listings", language, imageType),
        "edits.images.list",
      ),
    );
  const resource = (img: PlayImage): StoreResource => ({
    type: "images",
    id: img.id,
    attributes: {
      imageType,
      language,
      sha1: img.sha1,
      sha256: img.sha256,
      aiGeneratedState: img.aiGeneratedState,
    },
  });
  let listed: PlayImage[] = [];
  let uploadedId: string | null = null;
  const result = await performStoreWrite(s.ctx.db, {
    key: opKey(s.ctx, "image.upload", naturalKey, idempotencyKey),
    request: {
      language,
      imageType,
      sha256: image.sha256,
      aiGenerated: input.aiGenerated,
    },
    session: s.ctx.session,
    now: s.ctx.now,
    find: async () => {
      listed = await list();
      const byHash = listed.find((i) => i.sha256 === image.sha256);
      if (byHash) return resource(byHash);
      if (listed.some((i) => i.sha256 === null && i.sha1 !== null)) {
        const sha1 = await hexDigest("SHA-1", await image.read());
        const bySha1 = listed.find((i) => i.sha1 === sha1);
        if (bySha1) return resource(bySha1);
      }
      if (listed.some((i) => i.sha1 === null && i.sha256 === null)) {
        // The ledger's own record of uploading these bytes here, under any intent.
        const rows = await s.ctx.db.all<{ result_ids_json: string | null }>(
          `SELECT result_ids_json FROM store_operations
            WHERE store = ? AND scope = 'product' AND product = ? AND op = 'image.upload'
              AND natural_key = ? AND state = 'done'`,
          STORE,
          s.ctx.product,
          naturalKey,
        );
        for (const r of rows) {
          const id = strOf(
            (JSON.parse(r.result_ids_json ?? "{}") as Record<string, unknown>)
              .imageId,
          );
          const hit = id ? listed.find((i) => i.id === id) : undefined;
          if (hit) return resource(hit);
        }
      }
      return null;
    },
    write: async () => {
      await s.keepAlive();
      const bytes = await image.read();
      if (
        bytes.byteLength !== image.size ||
        (await hexDigest("SHA-256", bytes)) !== image.sha256
      )
        throw new Error(
          "the listing image's bytes do not match the blob store's record",
        );
      const doc = await s.api.upload(
        s.seg("listings", language, imageType),
        "edits.images.upload",
        {
          query: {
            aiGeneratedState: input.aiGenerated
              ? "aiGeneratedStateAiGeneratedDeveloperAttested"
              : "aiGeneratedStateNotAiGenerated",
          },
          contentType: image.contentType,
          bytes,
        },
      );
      // A long upload: renew again before the next step.
      await s.keepAlive();
      const img = parseImages({ images: [doc?.image] })[0];
      if (!img) throw new PlayError(502, "POST", "edits.images.upload");
      uploadedId = img.id;
      return resource(img);
    },
    reread: async (id) => {
      const hit = (await list()).find((i) => i.id === id);
      return hit ? resource(hit) : null;
    },
    resultIds: (r) => ({ imageId: r.id }),
    summary: (_r, outcome) =>
      `${outcome === "written" ? "Uploaded" : "Kept"} a Google Play ${imageType} image in ${language}`,
  });
  const keep =
    result.outcome === "written" || result.outcome === "existing"
      ? (result.resultIds.imageId ?? uploadedId)
      : null;
  const oldImages = listed.filter(
    (i) => i.id !== keep && i.sha256 !== image.sha256,
  ).length;
  return {
    result,
    oldImages,
    removeOldAt: oldImages > 0 ? "google-play.main-store-listing" : null,
  };
}

// ── Testing (testers) ────────────────────────────────────────────────────────────────────────

interface ParsedTrack {
  track: string;
  releases: Record<string, unknown>[];
}

function parseTrackDoc(doc: unknown): ParsedTrack | null {
  const d = doc as { track?: unknown; releases?: unknown } | null;
  if (!d || typeof d.track !== "string") return null;
  return {
    track: d.track,
    releases: Array.isArray(d.releases)
      ? (d.releases as Record<string, unknown>[])
      : [],
  };
}

function trackResource(
  t: ParsedTrack,
  more: Record<string, unknown> = {},
): StoreResource {
  return {
    type: "tracks",
    id: t.track,
    attributes: {
      track: t.track,
      releaseCount: t.releases.length,
      statuses: t.releases.map((r) => String(r.status ?? "")).slice(0, 20),
      ...more,
    },
  };
}

/** Create a closed-testing track (`edits.tracks.create`), natural key its name (`tracks.list`). */
export async function playCreateClosedTrack(
  s: PlayEditSession,
  input: { track: string; formFactor?: "DEFAULT" | "WEAR" | "AUTOMOTIVE" },
  idempotencyKey: string,
): Promise<StoreWriteResult | PlayStoreRefusal> {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(input.track))
    return refuse(422, "invalid_body", "track must be a closed track name", [
      "track",
    ]);
  const find = async () => {
    const doc = await s.api.request(
      "GET",
      s.seg("tracks"),
      "edits.tracks.list",
    );
    const tracks = Array.isArray(doc?.tracks) ? (doc!.tracks as unknown[]) : [];
    const hit = tracks.map(parseTrackDoc).find((t) => t?.track === input.track);
    return hit ? trackResource(hit) : null;
  };
  return performStoreWrite(s.ctx.db, {
    key: opKey(s.ctx, "track.create", `track:${input.track}`, idempotencyKey),
    request: input,
    session: s.ctx.session,
    now: s.ctx.now,
    find,
    write: async () => {
      await s.keepAlive();
      const doc = await s.api.request(
        "POST",
        s.seg("tracks"),
        "edits.tracks.create",
        {
          body: {
            track: input.track,
            type: "CLOSED_TESTING",
            ...(input.formFactor ? { formFactor: input.formFactor } : {}),
          },
        },
      );
      const t = parseTrackDoc(doc) ?? { track: input.track, releases: [] };
      return trackResource(t, {
        type: "CLOSED_TESTING",
        formFactor: input.formFactor ?? "DEFAULT",
      });
    },
    reread: find,
    resultIds: (r) => ({ track: r.id }),
    summary: (_r, outcome) =>
      `${outcome === "written" ? "Created" : "Kept"} the Google Play closed track ${input.track}`,
  });
}

/**
 * A testing track's Google Groups (`edits.testers.patch`; the API takes no email lists, which stay
 * in the Console). Natural key the track; the groups are compared as a set and stored as a COUNT,
 * never their addresses (S-15 §6.3).
 */
export async function playSetTesters(
  s: PlayEditSession,
  track: string,
  googleGroups: readonly string[],
  idempotencyKey: string,
): Promise<StoreWriteResult | PlayStoreRefusal> {
  if (!PLAY_TRACK.test(track) || isProductionTrack(track))
    return refuse(422, "invalid_body", "track must be a testing track", [
      "track",
    ]);
  if (googleGroups.length > 200)
    return refuse(422, "invalid_body", "at most 200 Google Groups", [
      "googleGroups",
    ]);
  const wanted = [
    ...new Set(googleGroups.map((g) => g.trim().toLowerCase())),
  ].sort();
  const resource = (groups: string[]): StoreResource => ({
    type: "testers",
    id: track,
    attributes: { track, googleGroupCount: groups.length, groups },
  });
  const read = async () => {
    const doc = await readOrNull(
      s.api.request("GET", s.seg("testers", track), "edits.testers.get"),
    );
    if (!doc) return null;
    const groups = (Array.isArray(doc.googleGroups) ? doc.googleGroups : [])
      .filter((g): g is string => typeof g === "string")
      .map((g) => g.toLowerCase())
      .sort();
    return resource(groups);
  };
  return performStoreWrite(s.ctx.db, {
    key: opKey(s.ctx, "testers.update", `testers:${track}`, idempotencyKey),
    request: { track, googleGroups: wanted },
    session: s.ctx.session,
    now: s.ctx.now,
    find: read,
    satisfied: (r) =>
      JSON.stringify(r.attributes?.groups) === JSON.stringify(wanted),
    write: async () => {
      await s.keepAlive();
      await s.api.request(
        "PATCH",
        s.seg("testers", track),
        "edits.testers.patch",
        {
          body: { googleGroups: wanted },
        },
      );
      return resource(wanted);
    },
    reread: read,
    resultIds: () => ({ track }),
    summary: () =>
      `Set ${wanted.length} Google Group${wanted.length === 1 ? "" : "s"} as testers of the Google Play track ${track}`,
  });
}

// ── Release notes on tracks ──────────────────────────────────────────────────────────────────

/**
 * Replace one release's notes on a track (`edits.tracks.patch` with the track's releases as read,
 * only the target's `releaseNotes` changed). On a production track the edit is marked as touching
 * production (its commit is typed), and the patch itself is typed when the release is completed:
 * the caller passes `typed` only after `playTypedConfirmation`.
 */
export async function playSetReleaseNotes(
  s: PlayEditSession,
  input: {
    track: string;
    versionCode: string;
    notes: ReadonlyArray<{ language: string; text: string }>;
    typed?: boolean;
  },
  idempotencyKey: string,
): Promise<StoreWriteResult | PlayStoreRefusal> {
  const { track, versionCode } = input;
  if (!PLAY_TRACK.test(track))
    return refuse(422, "invalid_body", "track must be a Play track id", [
      "track",
    ]);
  if (!/^[1-9][0-9]{0,18}$/.test(versionCode))
    return refuse(422, "invalid_body", "versionCode must be a version code", [
      "versionCode",
    ]);
  for (const n of input.notes)
    if (!LOCALE.test(n.language) || n.text.length > 500)
      return refuse(
        422,
        "invalid_body",
        "each note needs a Play language and at most 500 characters",
        ["notes"],
      );
  const notes = [...input.notes]
    .map((n) => ({ language: n.language, text: n.text }))
    .sort((a, b) => a.language.localeCompare(b.language));
  const getTrack = async () =>
    parseTrackDoc(
      await readOrNull(
        s.api.request("GET", s.seg("tracks", track), "edits.tracks.get"),
      ),
    );
  const target = (t: ParsedTrack) =>
    t.releases.findIndex(
      (r) =>
        Array.isArray(r.versionCodes) &&
        (r.versionCodes as unknown[]).includes(versionCode),
    );
  const notesOf = (r: Record<string, unknown>) =>
    JSON.stringify(
      (Array.isArray(r.releaseNotes)
        ? (r.releaseNotes as { language: string; text: string }[])
        : []
      )
        .map((n) => ({ language: n.language, text: n.text }))
        .sort((a, b) => a.language.localeCompare(b.language)),
    );
  let current: ParsedTrack | null = null;
  current = await getTrack();
  if (!current || target(current) < 0)
    return refuse(
      404,
      "unknown_release",
      `no release on track ${track} carries version code ${versionCode}`,
    );
  if (isProductionTrack(track)) s.touched.production = true;
  return performStoreWrite(s.ctx.db, {
    key: opKey(
      s.ctx,
      "release_notes.update",
      `notes:${track}:${versionCode}`,
      idempotencyKey,
    ),
    request: { track, versionCode, notes },
    session: s.ctx.session,
    now: s.ctx.now,
    find: async () => {
      current = await getTrack();
      return current
        ? trackResource(current, {
            notes: current.releases[target(current)]
              ? notesOf(current.releases[target(current)]!)
              : "",
          })
        : null;
    },
    satisfied: (r) => r.attributes?.notes === JSON.stringify(notes),
    write: async () => {
      await s.keepAlive();
      const t = current!;
      const i = target(t);
      if (i < 0) throw new PlayError(404, "PATCH", "edits.tracks.patch");
      const releases = t.releases.map((r, j) =>
        j === i ? { ...r, releaseNotes: notes } : r,
      );
      const doc = await s.api.request(
        "PATCH",
        s.seg("tracks", track),
        "edits.tracks.patch",
        {
          body: { track, releases },
          gate: {
            resourceState: isProductionTrack(track)
              ? PLAY_EDIT_SCOPE.production
              : PLAY_EDIT_SCOPE.testing,
            ...(input.typed ? { typedConfirmation: true } : {}),
          },
        },
      );
      return trackResource(parseTrackDoc(doc) ?? { track, releases });
    },
    reread: async () => {
      const t = await getTrack();
      return t ? trackResource(t) : null;
    },
    resultIds: () => ({ track, versionCode }),
    summary: (_r, outcome) =>
      `${outcome === "written" ? "Set" : "Kept"} the release notes (${notes.length} language${notes.length === 1 ? "" : "s"}) of version code ${versionCode} on the Google Play track ${track}`,
  });
}

// ── The commit (submit, release) ─────────────────────────────────────────────────────────────

/**
 * Validate and commit the session's edit (`edits.validate`, then `edits.commit` with
 * `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, and `changesNotSentForReview=true` to stage only).
 * An edit that touched production or changed a release status is TYPED: the caller passes `typed`
 * only after `playTypedConfirmation`; the gate refuses it otherwise.
 */
export async function playCommit(
  s: PlayEditSession,
  input: { typed?: boolean; stageOnly?: boolean },
  idempotencyKey: string,
): Promise<StoreWriteResult> {
  const scope =
    s.touched.production || s.touched.statusChange
      ? PLAY_EDIT_SCOPE.production
      : PLAY_EDIT_SCOPE.testing;
  const resource = (committed: boolean): StoreResource => ({
    type: "edits",
    id: s.editId,
    attributes: {
      committed,
      changesNotSentForReview: input.stageOnly === true,
    },
  });
  const result = await performStoreWrite(s.ctx.db, {
    key: opKey(s.ctx, "edit.commit", `edit:${s.editId}`, idempotencyKey),
    request: { stageOnly: input.stageOnly === true, scope },
    session: s.ctx.session,
    now: s.ctx.now,
    // An edit is committed once: nothing to look up before (a replay answers the ledger row).
    find: async () => (s.committed ? resource(true) : null),
    write: async () => {
      await s.keepAlive();
      await s.run.publisher.validateEdit(s.editId);
      await s.run.publisher.commitEdit(
        s.editId,
        {
          resourceState: scope,
          ...(input.typed ? { typedConfirmation: true } : {}),
        },
        { changesNotSentForReview: input.stageOnly === true },
      );
      s.committed = true;
      return resource(true);
    },
    reread: async () => resource(true),
    resultIds: () => ({ editId: s.editId }),
    summary: () =>
      `Committed a Google Play edit of ${s.packageName}${input.stageOnly ? " (staged, not sent for review)" : ""}${scope === PLAY_EDIT_SCOPE.production ? " touching production" : ""}`,
  });
  return result;
}

// ── One-time products and prices (iap, pricing) ──────────────────────────────────────────────

export interface PlayPurchaseOptionInput {
  purchaseOptionId: string;
  /** Per region: price and availability. */
  regions: ReadonlyArray<{
    regionCode: string;
    price: { currencyCode: string; units: string; nanos?: number };
    availability?: "AVAILABLE" | "NO_LONGER_AVAILABLE";
  }>;
}

export interface PlayOneTimeProductInput {
  productId: string;
  listings: ReadonlyArray<{
    languageCode: string;
    title: string;
    description?: string;
  }>;
  /** Prices: omitted to change the listings only. */
  purchaseOption?: PlayPurchaseOptionInput;
  /** Play's regions version the prices were made for (required by the API). */
  regionsVersion: string;
  /** The operator typed the app's name (compared by the caller): a price change after the first. */
  typed?: boolean;
}

function otpResource(id: string, d: Record<string, unknown>): StoreResource {
  const options = Array.isArray(d.purchaseOptions)
    ? (d.purchaseOptions as Record<string, unknown>[])
    : [];
  const regions = options.flatMap((o) =>
    Array.isArray(o.regionalPricingAndAvailabilityConfigs)
      ? (o.regionalPricingAndAvailabilityConfigs as unknown[])
      : [],
  );
  return {
    type: "oneTimeProducts",
    id,
    attributes: {
      productId: id,
      listingCount: Array.isArray(d.listings) ? d.listings.length : 0,
      purchaseOptionCount: options.length,
      regionCount: regions.length,
      listingsKey: canonicalListings(d.listings),
      pricesKey: canonicalPrices(options[0]),
    },
  };
}

function canonicalListings(v: unknown): string {
  const list = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  return JSON.stringify(
    list
      .map((l) => ({
        languageCode: strOf(l.languageCode),
        title: strOf(l.title),
        description: strOf(l.description) ?? "",
      }))
      .sort((a, b) =>
        String(a.languageCode).localeCompare(String(b.languageCode)),
      ),
  );
}

function canonicalPrices(option: unknown): string {
  const o = option as Record<string, unknown> | undefined;
  const regions = Array.isArray(o?.regionalPricingAndAvailabilityConfigs)
    ? (o!.regionalPricingAndAvailabilityConfigs as Record<string, unknown>[])
    : [];
  return JSON.stringify(
    regions
      .map((r) => {
        const p = (r.price ?? {}) as Record<string, unknown>;
        return [
          strOf(r.regionCode),
          strOf(p.currencyCode),
          strOf(p.units) ?? "0",
          Number(p.nanos ?? 0),
          strOf(r.availability) ?? "AVAILABLE",
        ];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/**
 * Create or update one one-time product (`monetization.onetimeproducts.patch` with
 * `allowMissing=true`), for a `play` row of the product's commerce map (`dist_store_products`)
 * only. Natural key the product id (`onetimeproducts.get`). The first price is `initial` (the
 * pre-read found no product); a later price change needs `typed`. Not an edit: no lease.
 */
export async function playUpsertOneTimeProduct(
  ctx: PlayStoreContext,
  input: PlayOneTimeProductInput,
  idempotencyKey: string,
): Promise<StoreWriteResult | PlayStoreRefusal> {
  const mapped = await ctx.db.first<{ store_product_id: string }>(
    `SELECT store_product_id FROM dist_store_products
      WHERE product = ? AND store = 'play' AND store_product_id = ?`,
    ctx.product,
    input.productId,
  );
  if (!mapped)
    return refuse(
      404,
      "unmapped_product",
      `${input.productId} is not a Google Play product of this product's commerce map`,
      ["productId"],
    );
  if (!/^[a-z0-9][a-z0-9._]{0,138}$/.test(input.productId))
    return refuse(422, "invalid_body", "productId is not a Play product id", [
      "productId",
    ]);
  if (!/^[0-9A-Za-z._/-]{1,32}$/.test(input.regionsVersion))
    return refuse(422, "invalid_body", "regionsVersion is required", [
      "regionsVersion",
    ]);
  const setup = await setupOf(ctx);
  if (isPlayRefusal(setup)) return setup;
  const run = await provisioningRun(ctx, setup, "play:provision", "operator");
  if (isPlayRefusal(run)) return run;
  const api = run.publisher.api;
  const listings = input.listings.map((l) => ({
    languageCode: l.languageCode,
    title: l.title,
    ...(l.description !== undefined ? { description: l.description } : {}),
  }));
  const option = input.purchaseOption
    ? {
        purchaseOptionId: input.purchaseOption.purchaseOptionId,
        buyOption: { legacyCompatible: true },
        regionalPricingAndAvailabilityConfigs: input.purchaseOption.regions.map(
          (r) => ({
            regionCode: r.regionCode,
            price: {
              currencyCode: r.price.currencyCode,
              units: r.price.units,
              nanos: r.price.nanos ?? 0,
            },
            availability: r.availability ?? "AVAILABLE",
          }),
        ),
      }
    : null;
  const read = async () => {
    const d = await readOrNull(
      api.request(
        "GET",
        ["oneTimeProducts", input.productId],
        "onetimeproducts.get",
      ),
    );
    return d ? otpResource(input.productId, d) : null;
  };
  let error: unknown = null;
  try {
    return await performStoreWrite(ctx.db, {
      key: opKey(
        ctx,
        "one_time_product.upsert",
        `otp:${input.productId}`,
        idempotencyKey,
      ),
      request: {
        productId: input.productId,
        listings,
        option,
        regionsVersion: input.regionsVersion,
      },
      session: ctx.session,
      now: ctx.now,
      find: read,
      satisfied: (r) =>
        r.attributes?.listingsKey === canonicalListings(listings) &&
        (!option || r.attributes?.pricesKey === canonicalPrices(option)),
      write: async (existing) => {
        const initial = existing === null;
        // Prices only when they are new or change; an unchanged price is never re-sent (and so
        // never needs typing).
        const sendPrices =
          option !== null &&
          (initial ||
            existing.attributes?.pricesKey !== canonicalPrices(option));
        const fields = sendPrices ? "listings,purchaseOptions" : "listings";
        const d = await api.request(
          "PATCH",
          ["onetimeproducts", input.productId],
          "onetimeproducts.patch",
          {
            query: {
              allowMissing: "true",
              "regionsVersion.version": input.regionsVersion,
              updateMask: fields,
            },
            body: {
              packageName: setup.packageName,
              productId: input.productId,
              listings,
              ...(sendPrices ? { purchaseOptions: [option] } : {}),
            },
            gate: {
              ...(initial ? { initial: true } : {}),
              ...(input.typed ? { typedConfirmation: true } : {}),
            },
          },
        );
        return d ? otpResource(input.productId, d) : null;
      },
      reread: read,
      resultIds: (r) => ({ productId: r.id }),
      summary: (_r, outcome) =>
        `${outcome === "written" ? "Wrote" : "Kept"} the Google Play one-time product ${input.productId}`,
    });
  } catch (e) {
    error = e;
    throw e;
  } finally {
    await finishRun(run, error);
  }
}

// ── Reads: readListing, status, the app-created verifier ─────────────────────────────────────

export interface PlayListingRead {
  defaultLanguage: string | null;
  contactWebsite: string | null;
  contactEmail: string | null;
  locales: Record<
    string,
    {
      title: string | null;
      shortDescription: string | null;
      fullDescription: string | null;
      video: string | null;
    }
  >;
}

/**
 * Play's current listing, from a read-only edit under the lease (purpose `import`; A-18c maps it
 * into the shared model). The edit is discarded; nothing is written.
 */
export async function readPlayListing(
  ctx: PlayStoreContext,
  locales?: readonly string[],
): Promise<PlayListingRead | PlayStoreRefusal> {
  return withPlayEditSession(ctx, "import", async (s) => {
    const details = await s.api.request(
      "GET",
      s.seg("details"),
      "edits.details.get",
    );
    const doc = await s.api.request(
      "GET",
      s.seg("listings"),
      "edits.listings.list",
    );
    const out: PlayListingRead = {
      defaultLanguage: strOf(details?.defaultLanguage),
      contactWebsite: strOf(details?.contactWebsite),
      contactEmail: strOf(details?.contactEmail),
      locales: {},
    };
    for (const l of Array.isArray(doc?.listings)
      ? (doc!.listings as Record<string, unknown>[])
      : []) {
      const language = strOf(l.language);
      if (!language || !LOCALE.test(language)) continue;
      if (locales && !locales.includes(language)) continue;
      out.locales[language] = {
        title: strOf(l.title),
        shortDescription: strOf(l.shortDescription),
        fullDescription: strOf(l.fullDescription),
        video: strOf(l.video),
      };
    }
    return out;
  });
}

/** Play's release lifecycle states (`tracks.releases.list`), without the enum prefix. */
export interface PlayReleaseStatus {
  track: string;
  releaseName: string | null;
  state: string;
}

/**
 * The review and publishing state of each mapped track's releases (`tracks.releases.list` →
 * `releaseLifecycleState`). Not an edit: no lease.
 */
export async function playStatus(
  ctx: PlayStoreContext,
): Promise<PlayReleaseStatus[] | PlayStoreRefusal> {
  const setup = await setupOf(ctx);
  if (isPlayRefusal(setup)) return setup;
  const run = await provisioningRun(ctx, setup, "play:status", "background");
  if (isPlayRefusal(run)) return run;
  let error: unknown = null;
  try {
    const out: PlayReleaseStatus[] = [];
    const tracks = [...new Set(["production", ...setup.routes.keys()])];
    for (const track of tracks) {
      const doc = await readOrNull(
        run.publisher.api.request(
          "GET",
          ["tracks", track, "releases"],
          "tracks.releases.list",
        ),
      );
      for (const r of Array.isArray(doc?.releases)
        ? (doc!.releases as Record<string, unknown>[])
        : [])
        out.push({
          track,
          releaseName: strOf(r.releaseName),
          state: (
            strOf(r.releaseLifecycleState) ??
            "RELEASE_LIFECYCLE_STATE_UNSPECIFIED"
          ).replace(/^RELEASE_LIFECYCLE_STATE_/, ""),
        });
    }
    return out;
  } catch (e) {
    error = e;
    throw e;
  } finally {
    await finishRun(run, error);
  }
}

/**
 * The `google-play.create-app` verifier: the app exists (and the account may edit it) once a
 * read-only edit opens on its package and its details read. A 404 or 403 from Google answers
 * `false`; any other failure is thrown.
 */
export async function verifyPlayApp(
  ctx: PlayStoreContext,
): Promise<boolean | PlayStoreRefusal> {
  try {
    return await withPlayEditSession(ctx, "import", async (s) => {
      await s.api.request("GET", s.seg("details"), "edits.details.get");
      return true;
    });
  } catch (e) {
    if (e instanceof PlayError && (e.status === 404 || e.status === 403))
      return false;
    throw e;
  }
}
