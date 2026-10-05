/**
 * The import sources of the shared listing (A-18c; notes/S-15 §7.2). Each answers a
 * `ListingSnapshot` (`core/storefront/listingImport.ts`), or why it could not be read:
 *
 *   - `app-store`, `play`, `ms-store`: the store's own listing, through each adapter's
 *     `readListing` (`connectors/<store>/listing.ts`) with the product's resolved setup and its
 *     pinned credential. All three only READ: Apple's GETs pass A-17a's gate, Play's reads sit in
 *     a read-only edit that is deleted, Microsoft's client can send nothing but GET. The setup is
 *     resolved first, so an unconfigured store or a pin that disagrees with the manifest mints no
 *     token and sends nothing (the same refusals as each connector's controls);
 *   - `godot`: what `pkey listing import --godot` read from `project.godot` and
 *     `export_presets.cfg` and uploaded, validated here (it is operator-supplied data);
 *   - `manifest`: `.pkey/distribution` `listing` as an outlet shows it (A-18b's import);
 *   - `product`: `.pkey/product`'s product name.
 */

import type { Db, Env } from "../../../core/platform.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import type { FetchImpl } from "../../../core/outletTokens.js";
import { AscError, AscWriteDenied } from "../../../core/asc/client.js";
import {
  canonicalCategory,
  emptySnapshot,
  normaliseLocale,
  textOf,
  type ImportSource,
  type ListingSnapshot,
  type SnapshotAsset,
  type SourceOutcome,
} from "../../../core/storefront/listingImport.js";
import { listOutlets, parseJsonColumn } from "../outlets.js";
import { readAppStoreListing } from "../connectors/asc/listing.js";
import { ascRun, finishRun as finishAscRun } from "../connectors/asc/run.js";
import { resolveAscSetup } from "../connectors/asc/setup.js";
import { readPlayListing } from "../connectors/play/listing.js";
import { PlayError } from "../connectors/play/client.js";
import {
  acquirePlayEditLease,
  PlayEditLeaseHeld,
  releasePlayEditLease,
} from "../connectors/play/lease.js";
import { finishRun as finishPlayRun, playRun } from "../connectors/play/run.js";
import {
  isPinReason as isPlayPinReason,
  resolvePlaySetup,
} from "../connectors/play/setup.js";
import { MsStoreError } from "../connectors/msstore/client.js";
import { readMsStoreListing } from "../connectors/msstore/listing.js";
import {
  errorLine as msErrorLine,
  msStoreRun,
} from "../connectors/msstore/poll.js";
import {
  isPinReason as isMsPinReason,
  resolveMsStoreSetup,
} from "../connectors/msstore/setup.js";
import { recordOutletCredentialResult } from "../../../core/outletCredentials.js";
import {
  parsePlatformCredentialHandle,
  recordPlatformCredentialResult,
} from "../../../core/platformCredentials.js";

/** What a store read needs. */
export interface SourceContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

/** The audited `use` of a token-minting open for an import (`<connector>:listing-import`). */
export const IMPORT_USE = "listing-import";

const fail = (
  status: 404 | 409 | 422 | 502,
  reason: string,
  message: string,
): SourceOutcome => ({ ok: false, status, reason, message });

/** A vendor status → the console's: not found stays, a quota or server error is 502, else 409. */
const vendorStatus = (status: number): 404 | 409 | 502 =>
  status === 404 ? 404 : status >= 500 || status === 429 ? 502 : 409;

// ── The stores ───────────────────────────────────────────────────────────────────────────────

export async function appStoreSource(c: SourceContext): Promise<SourceOutcome> {
  const { setup, inert } = await resolveAscSetup(c.env, c.db, c.product);
  if (!setup)
    return inert.reason === "pin_missing" || inert.reason === "pin_mismatch"
      ? fail(409, `credential_${inert.reason}`, inert.message)
      : fail(
          404,
          "not_configured",
          "App Store Connect is not configured: declare an app-store or testflight outlet with an appleId and store an asc-api-key credential pinned to that app",
        );
  const run = ascRun({
    env: c.env,
    db: c.db,
    product: c.product,
    hooks: c.hooks,
    now: c.now,
    setup,
    use: `asc:${IMPORT_USE}`,
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
    ...(c.sleep ? { sleep: c.sleep } : {}),
  });
  let error: unknown = null;
  try {
    return { ok: true, snapshot: await readAppStoreListing(run) };
  } catch (e) {
    error = e;
    // A read the gate refuses (personal data) is a bug in the reader, never sent.
    if (e instanceof AscWriteDenied)
      return fail(409, "write_denied", e.message);
    if (e instanceof AscError)
      return fail(vendorStatus(e.status), "store_refused", e.message);
    throw e;
  } finally {
    await finishAscRun(run, error);
  }
}

export async function playSource(c: SourceContext): Promise<SourceOutcome> {
  const { setup, inert } = await resolvePlaySetup(c.env, c.db, c.product);
  if (!setup)
    return isPlayPinReason(inert.reason)
      ? fail(409, `credential_${inert.reason}`, inert.message)
      : fail(
          404,
          "not_configured",
          "Google Play is not configured: declare a play or play-testing outlet with a packageName and tracks, and store a google-service-account credential pinned to that package",
        );
  // The per-package edit lease (A-18e; S-15 §5.3), taken before any token is minted: the import's
  // read-only edit must not be invalidated by, or invalidate, a poll, a control or a provisioning
  // session. A held lease answers 409 and opens nothing; the operator retries.
  const lease = await acquirePlayEditLease(c.db, {
    packageName: setup.packageName,
    purpose: "import",
    actor: "connector:play-listing-import",
  });
  if ("held" in lease)
    return fail(
      409,
      "edit_lease_held",
      new PlayEditLeaseHeld(lease.purpose, lease.expiresAt).message,
    );
  const run = playRun({
    env: c.env,
    db: c.db,
    product: c.product,
    hooks: c.hooks,
    now: c.now,
    setup,
    use: `play:${IMPORT_USE}`,
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
    ...(c.sleep ? { sleep: c.sleep } : {}),
  });
  let error: unknown = null;
  try {
    return {
      ok: true,
      snapshot: await readPlayListing(run.publisher, setup.packageName),
    };
  } catch (e) {
    error = e;
    if (e instanceof PlayError)
      return fail(vendorStatus(e.status), "store_refused", e.message);
    throw e;
  } finally {
    try {
      await finishPlayRun(run, error);
    } finally {
      await releasePlayEditLease(c.db, lease);
    }
  }
}

export async function msStoreSource(c: SourceContext): Promise<SourceOutcome> {
  const { setup, inert } = await resolveMsStoreSetup(c.env, c.db, c.product);
  if (!setup)
    return isMsPinReason(inert.reason)
      ? fail(409, `credential_${inert.reason}`, inert.message)
      : fail(
          404,
          "not_configured",
          "the Microsoft Store is not configured: declare an ms-store outlet with a productId and store an ms-partner-center credential pinned to that app",
        );
  const run = msStoreRun({
    env: c.env,
    db: c.db,
    product: c.product,
    hooks: c.hooks,
    now: c.now,
    setup,
    use: `ms-store:${IMPORT_USE}`,
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
    ...(c.sleep ? { sleep: c.sleep } : {}),
  });
  let error: unknown = null;
  try {
    return await readMsStoreListing(run.client, setup.productId);
  } catch (e) {
    error = e;
    if (e instanceof MsStoreError)
      return e.notReadable
        ? fail(
            409,
            "not_readable",
            "the Microsoft Store answers 409 for this app (mandatory updates or Store-managed add-ons): its submissions cannot be read through the API",
          )
        : fail(vendorStatus(e.status), "store_refused", e.message);
    throw e;
  } finally {
    if (run.client.calls > 0 || error) {
      const result = error
        ? { ok: false as const, error: msErrorLine(error) }
        : { ok: true as const };
      const platformId = parsePlatformCredentialHandle(setup.credentialId);
      if (platformId)
        await recordPlatformCredentialResult(c.db, platformId, result, c.now);
      else
        await recordOutletCredentialResult(
          c.db,
          c.product,
          setup.credentialId,
          result,
          c.now,
        );
    }
  }
}

// ── The manifest and the product ─────────────────────────────────────────────────────────────

const MANIFEST_ASSETS = ["iconUrl", "headerUrl", "screenshots"] as const;

/**
 * `.pkey/distribution` `listing` as `outletId` shows it (or the first live outlet with one):
 * name, developer name, category, website and tint at the app level; subtitle and description in
 * `locale`. Asset URLs are not imported (assets are uploaded blobs, A-18d).
 */
export async function manifestSource(
  db: Db,
  product: string,
  outletId: string | null,
  locale: string,
): Promise<SourceOutcome> {
  const live = (await listOutlets(db, product))
    .filter((o) => o.removed_at === null)
    .sort((a, b) => (a.outlet_id < b.outlet_id ? -1 : 1));
  let found: { outlet: string; listing: Record<string, unknown> } | null = null;
  for (const o of live) {
    if (outletId !== null && o.outlet_id !== outletId) continue;
    const l = parseJsonColumn(o.listing_json);
    if (l && typeof l === "object" && !Array.isArray(l)) {
      found = { outlet: o.outlet_id, listing: l as Record<string, unknown> };
      break;
    }
    if (outletId !== null) break;
  }
  if (!found)
    return fail(
      404,
      "no_manifest_listing",
      outletId === null
        ? "no live outlet has a .pkey/distribution listing"
        : `outlet ${outletId} has no .pkey/distribution listing`,
    );
  const l = found.listing;
  const snap = emptySnapshot("manifest", found.outlet);
  const str = (v: unknown) =>
    typeof v === "string" && v !== "" ? v : undefined;
  const set = <K extends keyof ListingSnapshot["app"]>(
    k: K,
    v: ListingSnapshot["app"][K] | undefined,
  ) => {
    if (v !== undefined) snap.app[k] = v;
  };
  set("name", str(l.name));
  set("developerName", str(l.developerName));
  const category = str(l.category);
  if (category) set("category", canonicalCategory(category) ?? category);
  set("tint", str(l.tintColor));
  const website = str(l.website);
  if (website) snap.app.urls = { website };
  const subtitle = str(l.subtitle);
  const description = str(l.description);
  if (subtitle || description)
    snap.locales[locale] = {
      ...(subtitle ? { subtitle } : {}),
      ...(description ? { description } : {}),
    };
  for (const f of MANIFEST_ASSETS)
    if (l[f] !== undefined)
      snap.skipped.push({
        field: f,
        reason:
          "asset URLs are not imported: listing assets are uploaded blobs (pkey listing assets)",
      });
  return { ok: true, snapshot: snap };
}

/** `.pkey/product`'s product name. */
export async function productSource(
  db: Db,
  product: string,
): Promise<SourceOutcome> {
  const row = await db.first<{ name: string }>(
    "SELECT name FROM products WHERE slug = ?",
    product,
  );
  const snap = emptySnapshot("product", product);
  const name = textOf(row?.name);
  if (name) snap.app.name = name;
  return { ok: true, snapshot: snap };
}

// ── The Godot project (uploaded by the CLI) ──────────────────────────────────────────────────

/** The most entries of each list a Godot upload may carry. */
const MAX_ENTRIES = 32;
/** The longest text a Godot upload's field may be (the model's own limits refuse beyond theirs). */
const MAX_TEXT = 4000;
const PLATFORM = /^[a-z][a-z0-9-]{0,31}$/;
const ICON_KEYS = new Set([
  "slot",
  "path",
  "setting",
  "sha256",
  "width",
  "height",
]);
const ICON_SLOTS = new Set([
  "icon-master",
  "icon-adaptive-fg",
  "icon-adaptive-bg",
  "icon-adaptive-mono",
]);

export interface GodotProblem {
  field: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The `godot` upload → a snapshot, or the problems with it. The shape is what the CLI sends
 * (`packages/cli/src/listing.ts`): `{project?, name?, nameLocalized?, copyright?, company?,
 * versions?, bundleIds?, categoryHints?, icons?}`, each list of `{platform, value}` (icons:
 * `{slot, path, sha256?, width?, height?}`). Unknown keys are refused, so a typo is not dropped.
 * Godot's `application/config/description` is a Project Manager tooltip, never a store
 * description (S-15 §7.2), and the CLI never sends it; neither key is accepted here.
 */
export function godotSnapshot(
  raw: unknown,
):
  | { ok: true; snapshot: ListingSnapshot }
  | { ok: false; problems: GodotProblem[] } {
  const problems: GodotProblem[] = [];
  const bad = (field: string, message: string) =>
    problems.push({ field: `godot.${field}`, message });
  if (!isRecord(raw))
    return {
      ok: false,
      problems: [{ field: "godot", message: "godot must be an object" }],
    };
  const known = new Set([
    "project",
    "name",
    "nameLocalized",
    "copyright",
    "company",
    "versions",
    "bundleIds",
    "categoryHints",
    "icons",
  ]);
  for (const k of Object.keys(raw))
    if (!known.has(k)) bad(k, `${k} is not part of a Godot import`);
  const text = (k: string, max = MAX_TEXT): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || v.length > max) {
      bad(k, `${k} must be text of at most ${max} characters`);
      return undefined;
    }
    return textOf(v);
  };
  const project = text("project", 200);
  const snap = emptySnapshot("godot", project ?? null);
  const name = text("name");
  if (name) snap.app.name = name;
  const copyright = text("copyright");
  if (copyright) snap.app.copyright = copyright;
  const company = text("company");
  if (company) snap.app.developerName = company;

  const nl = raw.nameLocalized;
  if (nl !== undefined && nl !== null) {
    if (!isRecord(nl) || Object.keys(nl).length > 64)
      bad(
        "nameLocalized",
        "nameLocalized must map at most 64 locales to names",
      );
    else
      for (const [k, v] of Object.entries(nl)) {
        const locale = normaliseLocale(k);
        if (!locale) {
          bad(`nameLocalized.${k}`, `${k} is not a locale code`);
          continue;
        }
        if (typeof v !== "string" || v.length > MAX_TEXT) {
          bad(`nameLocalized.${k}`, "a localized name must be text");
          continue;
        }
        const n = textOf(v);
        if (n && n !== name) (snap.locales[locale] ??= {}).name = n;
      }
  }

  const pairs = (
    k: "versions" | "bundleIds" | "categoryHints",
  ): { platform: string; value: string }[] => {
    const v = raw[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > MAX_ENTRIES) {
      bad(k, `${k} must be a list of at most ${MAX_ENTRIES} entries`);
      return [];
    }
    const out: { platform: string; value: string }[] = [];
    v.forEach((e, i) => {
      if (
        !isRecord(e) ||
        typeof e.platform !== "string" ||
        !PLATFORM.test(e.platform) ||
        typeof e.value !== "string" ||
        e.value === "" ||
        e.value.length > 255 ||
        Object.keys(e).some((x) => x !== "platform" && x !== "value")
      )
        bad(`${k}[${i}]`, `${k}[${i}] must be {platform, value}`);
      else out.push({ platform: e.platform, value: e.value });
    });
    return out;
  };
  for (const v of pairs("versions"))
    snap.identifiers.push({
      kind: "version",
      platform: v.platform,
      value: v.value,
    });
  for (const v of pairs("bundleIds"))
    snap.identifiers.push({
      kind: "bundleId",
      platform: v.platform,
      value: v.value,
    });
  for (const h of pairs("categoryHints")) {
    const id = canonicalCategory(h.value);
    if (id && !snap.app.category) snap.app.category = id;
  }

  const icons = raw.icons;
  if (icons !== undefined && icons !== null) {
    if (!Array.isArray(icons) || icons.length > MAX_ENTRIES)
      bad("icons", `icons must be a list of at most ${MAX_ENTRIES} entries`);
    else
      icons.forEach((e, i) => {
        const at = `icons[${i}]`;
        if (
          !isRecord(e) ||
          typeof e.slot !== "string" ||
          !ICON_SLOTS.has(e.slot)
        ) {
          bad(at, `${at}.slot must be one of ${[...ICON_SLOTS].join(", ")}`);
          return;
        }
        const stray = Object.keys(e).filter((x) => !ICON_KEYS.has(x));
        if (stray.length) {
          bad(at, `${at} has unknown keys: ${stray.join(", ")}`);
          return;
        }
        if (
          e.setting !== undefined &&
          (typeof e.setting !== "string" || e.setting.length > 100)
        ) {
          bad(at, `${at}.setting must be the preset or project setting's name`);
          return;
        }
        if (
          typeof e.path !== "string" ||
          e.path === "" ||
          e.path.length > 1024
        ) {
          bad(at, `${at}.path must be the icon's project path`);
          return;
        }
        const dim = (v: unknown) =>
          typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 16384
            ? v
            : null;
        const asset: SnapshotAsset = {
          slot: e.slot,
          locale: null,
          ref: e.path,
          width: dim(e.width),
          height: dim(e.height),
          sha256:
            typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256)
              ? e.sha256
              : null,
          vendorSlot: typeof e.setting === "string" ? e.setting : null,
        };
        snap.assets.push(asset);
      });
  }
  return problems.length
    ? { ok: false, problems }
    : { ok: true, snapshot: snap };
}

/** Every source an import can name. */
export const IMPORT_SOURCES: readonly ImportSource[] = [
  "app-store",
  "play",
  "ms-store",
  "godot",
  "manifest",
  "product",
];
