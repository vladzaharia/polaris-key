/**
 * Availability, submissions and the signing-key inventory (P2b-03, README §3.8): per release and
 * outlet, whether a build is AVAILABLE there and where it stands in a store's SUBMISSION
 * lifecycle; per product, the signing keys by purpose with their SHA-256 fingerprints.
 *
 *   - `dist_availability` / `dist_submissions`: written by CI (`POST /<p>/distribution/report`,
 *     a `pkeyci_` token with `distribution:report`) until the store connectors exist (P5-02 to
 *     P5-04), which will write them too. Read through the `delivery` hook and in the console UI.
 *   - `dist_keys`: OPERATOR-owned (the console's PUT and DELETE). CI may only report the
 *     fingerprint it signed with; see "The key inventory" below.
 *
 * ── DERIVED AVAILABILITY ────────────────────────────────────────────────────────────────────
 *
 * A self-hosted outlet needs no report: Polaris Key itself serves its bytes, so Release's truth
 * already says what is there. For an outlet whose KIND is self-hosted (`DERIVED_OUTLET_KINDS`)
 * and whose transport for the release's deliverable is `pkey-cdn`, `embedded` or `web`
 * (`DERIVED_TRANSPORTS`), a release that is not yanked and has a matching build whose payload
 * has a stored (R2) or GitHub location reads `live`, with no row. A store outlet (App Store,
 * Play, Steam, …) shows nothing until reported, whatever its transport: the default transport
 * of every outlet is `pkey-cdn`, so the transport alone cannot tell a store from our CDN.
 *
 * "Matching": an outlet whose identity names an artifact-map id (`altstore`, `obtainium`,
 * `fdroid-repo`) matches that build only; `web` matches `web` builds; `direct` with a
 * `platforms` list matches those platforms; anything else matches every build. A build with no
 * platform (a pack variant) matches any outlet's platform rule. A release with no build rows (a
 * GitHub-synced release no descriptor described) is matched by its artifacts, as one per-release
 * record (`buildId: ''`).
 *
 * A PACK release has its own rule (P4-05, `packDerivedAvailability`): `pkey-cdn`/`web` per
 * variant once every object its record names is stored and held, `embedded` per (app release,
 * outlet) from the builds' `embeds`.
 *
 * A stored row wins: a report of (release, build, outlet) replaces the derived record of that
 * build, and a per-release report (`buildId: ''`) replaces every derived record of that outlet.
 *
 * ── VOCABULARIES ────────────────────────────────────────────────────────────────────────────
 *
 * Proposed by the P2b-03 brief; P5-02 to P5-04 map store states onto them. Enforced on write
 * here, not by a CHECK (migration 0039), and normalised on read: an availability state outside
 * the list reads as `pending` (never `live`), a submission state as `prepared`. A report may
 * move a state backwards (a rejection after review): the row keeps the current state and the
 * audit log keeps every change.
 *
 * ── THE KEY INVENTORY ───────────────────────────────────────────────────────────────────────
 *
 * Its fingerprints are what players and AppVerifier check a download against, so it is the
 * independent control against a compromised pipeline, and only an operator writes it. A CI key
 * report (`type: "key"`) that matches an entry records `observed_json` on that entry and nothing
 * else. One that matches no entry for its purpose is stored as an OBSERVATION row
 * (`source = 'ci'`), flagged, and never touches an entry; the `delivery` hook's `keys()` never
 * returns an observation, and marks every entry of that purpose `flagged`. An operator adopts
 * the observation (PUT, which makes it an entry) or dismisses it (DELETE). Every operator change
 * and every CI observation is audited.
 */

import { parseJsonColumn } from "../../platform/json.js";
import { randomId } from "../../crypto.js";
import type { Db, DbStatement } from "../../db/types.js";
import { createHash } from "node:crypto";
import {
  APP_DELIVERABLE_ID,
  assetPackBase,
  parseAssetPackId,
  releaseKeyBytes,
  type ParsedManifest,
} from "@polaris-key/manifest";
import { appendAudit } from "../../repo.js";
import { ciActor, type CiPrincipal } from "../../core/ciScope.js";
import {
  DEFAULT_TRANSPORT,
  type AvailabilityRecord,
  type CatalogArtifact,
  type CatalogBuildEmbeds,
  type CatalogPackRelease,
  type CatalogRelease,
  type KeyObservation,
  type KeyRecord,
  type ReleaseCatalog,
  type ServiceHooks,
  type SubmissionRecord,
} from "../../core/hooks.js";
import {
  getOutlet,
  listOutlets,
  listTransports,
  type DistOutletRow,
  type DistTransportRow,
} from "./outlets.js";
import { referencedKeys, storedObjects } from "../../core/blobs.js";
import { reportStoreStep, type StoreStepRecord } from "./storeSteps.js";
import {
  appReleasesAffectedBy,
  applyReadinessHold,
  readinessReader,
  refreshReadiness,
  type ReadinessReader,
} from "./readiness.js";

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────

export const AVAILABILITY_STATES = [
  "pending",
  "processing",
  "in-review",
  "approved",
  "live",
  "rejected",
  "removed",
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const SUBMISSION_STATES = [
  "prepared",
  "submitted",
  "in-review",
  "approved",
  "rejected",
  "pending-developer-release",
  "released",
  "cancelled",
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** Signing-key purposes (P2b-03 brief; `release` is the CI release key P3-03 names). */
export const KEY_PURPOSES = [
  "android-app-signing",
  "android-upload",
  "android-sideload",
  "fdroid-repo",
  "sparkle-ed25519",
  "release",
  "msix-publisher",
] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/** Lower-case hex SHA-256, exactly. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** The report types `POST /<p>/distribution/report` accepts (`store-step`: A-18h, `storeSteps.ts`). */
export const REPORT_TYPES = [
  "availability",
  "submission",
  "key",
  "store-step",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Transports over which Polaris Key itself delivers the bytes (P4-05), so a self-hosted outlet's
 * availability is derived without a report. A subset of `SUPPORTED_TRANSPORTS` (`outlets.ts`),
 * which also lists the store transports P5-08 acts on through reports; a test keeps it a subset.
 */
export const DERIVED_TRANSPORTS: readonly string[] = [
  "pkey-cdn",
  "web",
  "embedded",
];

/**
 * Outlet kinds Polaris Key hosts itself (no third party reviews or serves the build): the direct
 * download, the web build, a self-hosted AltStore source, Obtainium, our own F-Droid repo and an
 * App Installer file. Every other kind is a store and is `live` only once reported.
 */
export const DERIVED_OUTLET_KINDS: readonly string[] = [
  "direct",
  "web",
  "altstore",
  "obtainium",
  "fdroid-repo",
  "app-installer",
];

/** Byte locations that count as "the bytes are there" for derived availability. */
const SERVING_PROVIDERS = new Set(["r2", "github"]);

/** Whether an artifact's bytes are there to serve (a stored or GitHub location). */
export function hasServingLocation(a: {
  locations: readonly { provider: string }[];
}): boolean {
  return a.locations.some((l) => SERVING_PROVIDERS.has(l.provider));
}

/** A report's `since` may run ahead of the server clock by at most this much (skew). */
const MAX_SINCE_SKEW_SECONDS = 300;
const MAX_NOTES_LENGTH = 500;
/**
 * The most CI observations (fingerprints outside the inventory) a product keeps. A report that
 * would add one more is refused (409 `too_many_observations`) — still a visible failure in the
 * job — so a leaked report token cannot grow `dist_keys` without bound. An operator clears them.
 */
export const MAX_KEY_OBSERVATIONS = 64;

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

export const isAvailabilityState = (v: unknown): v is AvailabilityState =>
  isOneOf(AVAILABILITY_STATES, v);
export const isSubmissionState = (v: unknown): v is SubmissionState =>
  isOneOf(SUBMISSION_STATES, v);
export const isKeyPurpose = (v: unknown): v is KeyPurpose =>
  isOneOf(KEY_PURPOSES, v);

// ── Rows and records ─────────────────────────────────────────────────────────────────────────

export interface DistAvailabilityRow {
  product: string;
  release_id: string;
  build_id: string;
  outlet_id: string;
  transport: string;
  state: string;
  since: number;
  platform_ref_json: string | null;
  detail_json: string | null;
  source: string;
  updated_at: number;
}

export interface DistSubmissionRow {
  product: string;
  release_id: string;
  outlet_id: string;
  state: string;
  submitted_at: number | null;
  reviewed_at: number | null;
  detail_json: string | null;
  source: string;
  updated_at: number;
}

export interface DistKeyRow {
  product: string;
  purpose: string;
  fingerprint_sha256: string;
  outlet_id: string | null;
  notes: string | null;
  registered_at: number | null;
  source: string;
  observed_json: string | null;
  created_at: number;
  modified_at: number;
}

function objectColumn(raw: string | null): Record<string, unknown> | null {
  const v = parseJsonColumn(raw);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function availabilityRecord(
  row: DistAvailabilityRow,
  deliverableId: string,
): AvailabilityRecord {
  return {
    deliverableId,
    releaseId: row.release_id,
    buildId: row.build_id,
    outletId: row.outlet_id,
    transport: row.transport,
    state: isAvailabilityState(row.state) ? row.state : "pending",
    since: row.since,
    platformRef: objectColumn(row.platform_ref_json),
    detail: objectColumn(row.detail_json),
    source: row.source,
    derived: false,
    updatedAt: row.updated_at,
  };
}

export function submissionRecord(
  row: DistSubmissionRow,
  deliverableId: string,
): SubmissionRecord {
  return {
    deliverableId,
    releaseId: row.release_id,
    outletId: row.outlet_id,
    state: isSubmissionState(row.state) ? row.state : "prepared",
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    detail: objectColumn(row.detail_json),
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function observationOf(raw: string | null): KeyObservation | null {
  const v = objectColumn(raw);
  if (!v || typeof v.at !== "number" || typeof v.by !== "string") return null;
  return {
    at: v.at,
    by: v.by,
    outletId: typeof v.outletId === "string" ? v.outletId : null,
  };
}

/** An inventory entry (`flagged` from whether any observation shares its purpose). */
export function keyRecord(row: DistKeyRow, flagged: boolean): KeyRecord {
  return {
    purpose: row.purpose,
    sha256: row.fingerprint_sha256,
    outletId: row.outlet_id,
    notes: row.notes,
    registered: row.registered_at !== null,
    registeredAt: row.registered_at,
    observed: observationOf(row.observed_json),
    flagged,
  };
}

/** A CI observation that matched no entry, as the console shows it. */
export function observationRecord(row: DistKeyRow) {
  return {
    purpose: row.purpose,
    sha256: row.fingerprint_sha256,
    outletId: row.outlet_id,
    observed: observationOf(row.observed_json),
    firstSeenAt: row.created_at,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

export interface AvailabilityReadContext {
  db: Db;
  product: string;
  hooks: ServiceHooks;
  /**
   * P4-14's readiness, shared across the calls of one request (`delivery.ts` memoises one per hook
   * instance). Absent: a reader is made for the call.
   */
  readiness?: ReadinessReader;
}

/** A release of one of the product's declared deliverables, found by id (two reads). */
export async function findRelease(
  catalog: ReleaseCatalog,
  releaseId: string,
): Promise<CatalogRelease | null> {
  const hit = await catalog.release(releaseId);
  if (!hit) return null;
  return (await catalog.deliverables()).some((d) => d.id === hit.deliverableId)
    ? hit
    : null;
}

/** A transport lookup over the product's `dist_transports` rows, read once (`listTransports`). */
export type TransportLookup = (deliverable: string, outlet: string) => string;

export function transportLookup(
  rows: readonly DistTransportRow[],
): TransportLookup {
  const map = new Map(
    rows.map((r) => [`${r.deliverable_id}\u0000${r.outlet_id}`, r.transport]),
  );
  return (deliverable, outlet) =>
    map.get(`${deliverable}\u0000${outlet}`) ?? DEFAULT_TRANSPORT;
}

/** The transport a deliverable uses on an outlet: its `dist_transports` row, else the default. */
export async function transportOf(
  db: Db,
  product: string,
  deliverable: string,
  outlet: string,
): Promise<string> {
  const row = await db.first<{ transport: string }>(
    `SELECT transport FROM dist_transports
      WHERE product = ? AND deliverable_id = ? AND outlet_id = ?`,
    product,
    deliverable,
    outlet,
  );
  return row?.transport ?? DEFAULT_TRANSPORT;
}

/** Does `outlet` (kind + identity) carry a build of `platform` / `buildId`? */
export function outletMatches(
  kind: string,
  identity: Record<string, unknown>,
  buildId: string | null,
  platform: string | null,
): boolean {
  if (typeof identity.artifact === "string")
    return buildId !== null && buildId === identity.artifact;
  if (platform === null) return true;
  if (kind === "web") return platform === "web";
  if (kind === "direct" && Array.isArray(identity.platforms))
    return (identity.platforms as unknown[]).includes(platform);
  return true;
}

/**
 * The derived `live` records of one release, for every live self-hosted outlet. See the file
 * comment. Reads only through Release's catalog hook.
 */
async function derivedAvailability(
  ctx: AvailabilityReadContext,
  catalog: ReleaseCatalog,
  release: CatalogRelease,
  allOutlets: readonly DistOutletRow[],
  transportOf: TransportLookup,
): Promise<AvailabilityRecord[]> {
  if (release.yanked) return [];
  const outlets = allOutlets.filter(
    (o) => o.removed_at === null && DERIVED_OUTLET_KINDS.includes(o.kind),
  );
  if (!outlets.length) return [];
  // Every deliverable that is not the app is a pack (`DELIVERABLE_KINDS`): its own rule.
  if (release.deliverableId !== APP_DELIVERABLE_ID)
    return (
      (
        await packDerivedAvailability(
          ctx,
          catalog,
          [release],
          outlets,
          packDeriveShared(catalog, transportOf),
        )
      ).get(release.releaseId) ?? []
    );

  const builds = await catalog.builds(release.releaseId);
  const artifacts = await catalog.artifacts(release.releaseId);
  // Whether an artifact's bytes are there, once per artifact: the `files` resolution is the one
  // that carries locations, and only counts when it resolves to this same artifact.
  const located = new Map<string, Promise<boolean>>();
  const hasBytes = (a: CatalogArtifact): Promise<boolean> => {
    let hit = located.get(a.artifactId);
    if (!hit) {
      hit = catalog
        .resolve({ kind: "file", releaseId: release.releaseId, name: a.name })
        .then(
          (r) =>
            r?.kind === "file" &&
            r.artifact?.artifactId === a.artifactId &&
            hasServingLocation(r.artifact),
        );
      located.set(a.artifactId, hit);
    }
    return hit;
  };

  const out: AvailabilityRecord[] = [];
  for (const outlet of outlets) {
    const transport = transportOf(release.deliverableId, outlet.outlet_id);
    if (!DERIVED_TRANSPORTS.includes(transport)) continue;
    const identity = objectColumn(outlet.identity_json) ?? {};
    const record = (buildId: string): AvailabilityRecord => ({
      deliverableId: release.deliverableId,
      releaseId: release.releaseId,
      buildId,
      outletId: outlet.outlet_id,
      transport,
      state: "live",
      since: release.publishedAt,
      platformRef: null,
      detail: null,
      source: "derived",
      derived: true,
      updatedAt: null,
    });

    if (builds.length) {
      for (const b of builds) {
        if (!outletMatches(outlet.kind, identity, b.buildId, b.platform))
          continue;
        const payload = artifacts.find(
          (a) => a.buildId === b.buildId && a.role === "payload",
        );
        if (payload && (await hasBytes(payload))) out.push(record(b.buildId));
      }
      continue;
    }
    // No build rows: a GitHub-synced release no descriptor described. One per-release record when
    // any of its files matches the outlet and has its bytes.
    for (const a of artifacts) {
      if (!outletMatches(outlet.kind, identity, a.buildId, a.platform))
        continue;
      if (await hasBytes(a)) {
        out.push(record(""));
        break;
      }
    }
  }
  return out;
}

/**
 * The derived `live` records of one PACK release (P4-05, CONTENT §6.4 "outlet readiness"), for
 * the live self-hosted `outlets` given. Per outlet, by the pack's transport there:
 *
 *   - `pkey-cdn` and `web`: one record per VARIANT (`buildId` = its build id) once every object
 *     its signed record names — `full`, the files index, its gaps, every delta — is stored with
 *     the recorded SHA-256 and length AND held by a ref of this product (Core's blob store, the
 *     same possession rule the blob route serves under). One object missing, or its ref gone,
 *     keeps the variant not live. A pack variant is platform-independent, so it matches every
 *     outlet. The file blobs an index names were checked at ingest (`pack-object`) and are held
 *     by `pack-upload` refs that nothing removes before P4-14's collector, which must keep this
 *     rule; they are not re-read here, because that would decode an index per variant per call.
 *   - `embedded`: ready by construction, with no report and no bytes of ours (the build carries
 *     them; the SDK verifies its marker and hash on the device, P4-06 to P4-08). One record per
 *     (app release, outlet) for each unyanked app release that PINS this pack release and has a
 *     build matching the outlet that EMBEDS the pack (its `embeds`, or every `baseline: embedded`
 *     pack when its descriptor said nothing): `buildId` `''`, `since` the app release's, and
 *     `detail: {appReleaseId, buildIds}`.
 *   - anything else (`apple-ba`, `play-pad`, `steam-depot`: not in `DERIVED_TRANSPORTS`; and any
 *     unsupported transport): nothing. A store transport's state comes from CI reports and the
 *     connectors (P5-08); an unsupported one's row is stored and listed unsupported.
 *
 * Reads only through Release's catalog hook and Core's blob store. A yanked release derives
 * nothing (the caller checks), as for the app.
 */
export async function packDerivedAvailability(
  ctx: AvailabilityReadContext,
  catalog: ReleaseCatalog,
  releases: readonly CatalogRelease[],
  outlets: readonly DistOutletRow[],
  shared: PackDeriveShared,
): Promise<Map<string, AvailabilityRecord[]>> {
  const { db, product } = ctx;
  const out = new Map<string, AvailabilityRecord[]>();
  // One record read per release (the record is the truth of its objects).
  const packs: CatalogPackRelease[] = [];
  for (const r of releases) {
    if (r.yanked) continue;
    const pack = await catalog.packRelease(r.deliverableId, r.releaseId);
    if (pack) packs.push(pack);
  }
  if (!packs.length || !outlets.length) return out;

  // Every object of every release, stored and held: one bulk read of each (chunked by Core).
  const keys = [
    ...new Set(
      packs.flatMap((p) =>
        p.variants.flatMap((v) => v.objects.map((o) => o.key)),
      ),
    ),
  ];
  const [stored, held] = await Promise.all([
    storedObjects(db, keys),
    referencedKeys(db, product, keys),
  ]);
  const completeOf = (pack: CatalogPackRelease): string[] =>
    pack.variants
      .filter((v) =>
        v.objects.every((o) => {
          const s = stored.get(o.key);
          return (
            s !== undefined &&
            s.sha256 === o.sha256 &&
            s.size === o.bytes &&
            held.has(o.key)
          );
        }),
      )
      .map((v) => v.buildId);

  // The embedding app releases, in bulk, only for the releases an `embedded` outlet asks about.
  const embeddedPacks = packs.filter((p) =>
    outlets.some(
      (o) =>
        shared.transport(p.release.deliverableId, o.outlet_id) === "embedded",
    ),
  );
  const embedding = await embeddingReleases(
    catalog,
    embeddedPacks.map((p) => p.release),
    shared,
  );

  for (const pack of packs) {
    const release = pack.release;
    const complete = completeOf(pack);
    const records: AvailabilityRecord[] = [];
    for (const outlet of outlets) {
      const transport = shared.transport(
        release.deliverableId,
        outlet.outlet_id,
      );
      if (!DERIVED_TRANSPORTS.includes(transport)) continue;
      const base = {
        deliverableId: release.deliverableId,
        releaseId: release.releaseId,
        outletId: outlet.outlet_id,
        transport,
        state: "live",
        platformRef: null,
        source: "derived",
        derived: true,
        updatedAt: null,
      } as const;
      if (transport !== "embedded") {
        for (const buildId of complete)
          records.push({
            ...base,
            buildId,
            since: release.publishedAt,
            detail: null,
          });
        continue;
      }
      const identity = objectColumn(outlet.identity_json) ?? {};
      for (const app of embedding.get(release.releaseId) ?? []) {
        const buildIds = app.builds
          .filter((b) =>
            outletMatches(outlet.kind, identity, b.buildId, b.platform),
          )
          .map((b) => b.buildId);
        if (!buildIds.length) continue;
        records.push({
          ...base,
          buildId: "",
          since: app.publishedAt,
          detail: { appReleaseId: app.releaseId, buildIds },
        });
      }
    }
    out.set(release.releaseId, records);
  }
  return out;
}

/**
 * Reads the pack rule shares across every pack release of one availability call or one matrix
 * page: the transport rows (read once by the caller), the app's releases and the pack
 * declarations (each read once, on first use).
 */
export interface PackDeriveShared {
  transport: TransportLookup;
  appReleases(): Promise<Map<string, CatalogRelease>>;
  /** Pack id → whether it is a `baseline: embedded` pack. */
  embeddedByDefault(): Promise<Map<string, boolean>>;
}

export function packDeriveShared(
  catalog: ReleaseCatalog,
  transport: TransportLookup,
): PackDeriveShared {
  let apps: Promise<Map<string, CatalogRelease>> | undefined;
  let declared: Promise<Map<string, boolean>> | undefined;
  return {
    transport,
    appReleases: () =>
      (apps ??= catalog
        .releases(APP_DELIVERABLE_ID)
        .then((rs) => new Map(rs.map((r) => [r.releaseId, r])))),
    embeddedByDefault: () =>
      (declared ??= catalog
        .packDeliverables()
        .then(
          (ps) => new Map(ps.map((p) => [p.id, p.baseline === "embedded"])),
        )),
  };
}

/** An unyanked app release pinning a pack release, with its builds that embed the pack. */
interface EmbeddingRelease {
  releaseId: string;
  publishedAt: number | null;
  builds: Array<{ buildId: string; platform: string | null }>;
}

/**
 * Per pack release in `releases`: the unyanked app releases that pin it and embed its pack in at
 * least one build. Bulk: one pins read, one app-release read, one builds-with-embeds read (each
 * chunked by Release), whatever the number of releases, pins or builds.
 */
async function embeddingReleases(
  catalog: ReleaseCatalog,
  releases: readonly CatalogRelease[],
  shared: PackDeriveShared,
): Promise<Map<string, EmbeddingRelease[]>> {
  const out = new Map<string, EmbeddingRelease[]>();
  if (!releases.length) return out;
  const pins = await catalog.pinnedByMany(releases.map((r) => r.releaseId));
  if (!pins.length) return out;
  const apps = await shared.appReleases();
  const live = [...new Set(pins.map((p) => p.appReleaseId))].filter((id) => {
    const app = apps.get(id);
    return app !== undefined && !app.yanked;
  });
  if (!live.length) return out;
  const byDefault = await shared.embeddedByDefault();
  const builds = new Map<string, CatalogBuildEmbeds[]>();
  for (const b of await catalog.embedsOf(live)) {
    const list = builds.get(b.releaseId) ?? [];
    list.push(b);
    builds.set(b.releaseId, list);
  }
  for (const release of releases) {
    const pack = release.deliverableId;
    const list: EmbeddingRelease[] = [];
    const appIds = [
      ...new Set(
        pins
          .filter((p) => p.packReleaseId === release.releaseId)
          .map((p) => p.appReleaseId),
      ),
    ].sort();
    for (const appReleaseId of appIds) {
      const app = apps.get(appReleaseId);
      if (!app || app.yanked) continue;
      const embedding = (builds.get(appReleaseId) ?? [])
        .filter((b) =>
          b.embeds === null
            ? byDefault.get(pack) === true
            : b.embeds.includes(pack),
        )
        .map((b) => ({ buildId: b.buildId, platform: b.platform }));
      if (embedding.length)
        list.push({
          releaseId: appReleaseId,
          publishedAt: app.publishedAt,
          builds: embedding,
        });
    }
    out.set(release.releaseId, list);
  }
  return out;
}

/**
 * Availability of one release: stored rows plus derived records, a stored row winning. Live
 * outlets only, unless `includeRemoved` (the console shows history on removed outlets too).
 */
export async function availabilityFor(
  ctx: AvailabilityReadContext,
  releaseId: string,
  opts: { includeRemoved?: boolean } = {},
): Promise<AvailabilityRecord[]> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return [];
  const release = await findRelease(catalog, releaseId);
  if (!release) return [];
  const outlets = await listOutlets(ctx.db, ctx.product);
  const live = new Set(
    outlets.filter((o) => o.removed_at === null).map((o) => o.outlet_id),
  );
  const rows = await ctx.db.all<DistAvailabilityRow>(
    `SELECT * FROM dist_availability WHERE product = ? AND release_id = ?
      ORDER BY outlet_id, build_id`,
    ctx.product,
    releaseId,
  );
  const stored = rows
    .filter((r) => opts.includeRemoved || live.has(r.outlet_id))
    .map((r) => availabilityRecord(r, release.deliverableId));
  const transports = transportLookup(await listTransports(ctx.db, ctx.product));
  const derived = (
    await derivedAvailability(ctx, catalog, release, outlets, transports)
  ).filter(
    (d) =>
      !stored.some(
        (s) =>
          s.outletId === d.outletId &&
          (s.buildId === "" || s.buildId === d.buildId),
      ),
  );
  const records = [...stored, ...derived].sort(
    (a, b) =>
      cmp(a.outletId, b.outletId) ||
      cmp(a.buildId, b.buildId) ||
      Number(a.derived) - Number(b.derived) ||
      cmp(embeddedIn(a), embeddedIn(b)),
  );
  // P4-14: an app release whose required pack set is not available through an outlet Polaris Key
  // controls is HELD there — its `live` records answer `pending` (`readiness.ts`).
  if (release.deliverableId !== APP_DELIVERABLE_ID) return records;
  const reader = ctx.readiness ?? readinessReader(ctx);
  return applyReadinessHold(records, await reader.forRelease(releaseId));
}

/** The app release an `embedded` pack record is about (`''` for any other record). */
export function embeddedIn(r: AvailabilityRecord): string {
  const v = r.detail?.appReleaseId;
  return typeof v === "string" ? v : "";
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Submission records: of one release (live outlets only unless `includeRemoved`), or of every
 * release when `releaseId` is omitted (the console's list).
 */
export async function submissionsFor(
  ctx: AvailabilityReadContext,
  releaseId: string | undefined,
  opts: { includeRemoved?: boolean } = {},
): Promise<SubmissionRecord[]> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return [];
  const rows =
    releaseId === undefined
      ? await ctx.db.all<DistSubmissionRow>(
          `SELECT * FROM dist_submissions WHERE product = ?
            ORDER BY updated_at DESC, release_id, outlet_id`,
          ctx.product,
        )
      : await ctx.db.all<DistSubmissionRow>(
          `SELECT * FROM dist_submissions WHERE product = ? AND release_id = ?
            ORDER BY outlet_id`,
          ctx.product,
          releaseId,
        );
  if (!rows.length) return [];
  const live = new Set(
    (await listOutlets(ctx.db, ctx.product))
      .filter((o) => o.removed_at === null)
      .map((o) => o.outlet_id),
  );
  const deliverableOf = new Map<string, string>();
  for (const d of await catalog.deliverables())
    for (const r of await catalog.releases(d.id))
      deliverableOf.set(r.releaseId, d.id);
  return rows
    .filter((r) => deliverableOf.has(r.release_id))
    .filter((r) => opts.includeRemoved || live.has(r.outlet_id))
    .map((r) => submissionRecord(r, deliverableOf.get(r.release_id)!));
}

/** The inventory entries (never observations), optionally of one purpose. */
export async function inventory(
  db: Db,
  product: string,
  purpose?: string,
): Promise<KeyRecord[]> {
  const rows = await db.all<DistKeyRow & { flagged: number }>(
    `SELECT k.*, EXISTS (SELECT 1 FROM dist_keys o
                          WHERE o.product = k.product AND o.purpose = k.purpose
                            AND o.source = 'ci') AS flagged
       FROM dist_keys k
      WHERE k.product = ? AND k.source != 'ci'${purpose !== undefined ? " AND k.purpose = ?" : ""}
      ORDER BY k.purpose, k.fingerprint_sha256`,
    product,
    ...(purpose !== undefined ? [purpose] : []),
  );
  return rows.map((r) => keyRecord(r, r.flagged === 1));
}

/** CI observations that matched no inventory entry. */
export async function observations(
  db: Db,
  product: string,
): Promise<ReturnType<typeof observationRecord>[]> {
  const rows = await db.all<DistKeyRow>(
    `SELECT * FROM dist_keys WHERE product = ? AND source = 'ci'
      ORDER BY purpose, fingerprint_sha256`,
    product,
  );
  return rows.map(observationRecord);
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────

/** A refusal the CI route and the console both render (the `RolloutRefusal` shape). */
export interface ReportRefusal {
  ok: false;
  status: 404 | 409 | 422;
  code: "not_found" | "bad_request";
  reason: string;
  message: string;
  fields?: string[];
}

function refuse(
  status: ReportRefusal["status"],
  reason: string,
  message: string,
  fields?: string[],
): ReportRefusal {
  return {
    ok: false,
    status,
    code: status === 404 ? "not_found" : "bad_request",
    reason,
    message,
    ...(fields ? { fields } : {}),
  };
}

const invalid = (field: string, message: string) =>
  refuse(422, "invalid_body", message, [field]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── The CI report ────────────────────────────────────────────────────────────────────────────

export interface ReportContext extends AvailabilityReadContext {
  now: number;
}

export type ReportResult =
  | { ok: true; type: "store-step"; step: StoreStepRecord }
  | { ok: true; type: "availability"; availability: AvailabilityRecord }
  | { ok: true; type: "submission"; submission: SubmissionRecord }
  | {
      ok: true;
      type: "key";
      key: {
        purpose: string;
        sha256: string;
        match: boolean;
        flagged: boolean;
      };
    }
  | ReportRefusal;

async function auditCi(
  ctx: ReportContext,
  principal: CiPrincipal,
  action: string,
  target: { kind: string; id: string },
  summary: string,
): Promise<void> {
  await appendAudit(ctx.db, {
    product: ctx.product,
    id: randomId("aud"),
    at: ctx.now,
    actor_sub: ciActor(principal),
    actor_name: "CI",
    actor_email: null,
    action,
    target_kind: target.kind,
    target_id: target.id,
    parent_id: null,
    summary,
  });
}

/**
 * Who writes an availability or submission row, and how the change is audited: CI (`source =
 * 'ci'`, actor `ci:<subject>`) or a store connector (P5-02 on: `source` = the connector kind,
 * e.g. `asc`, actor `connector:<kind>`). One implementation for both, so a connector's write
 * follows exactly the vocabulary, `since` and audit rules a CI report does.
 */
export interface AvailabilityWriter {
  /** The `source` column value. */
  source: string;
  /** Who the audit summary names ("CI", "App Store Connect"). */
  label: string;
  audit(
    action: string,
    target: { kind: string; id: string },
    summary: string,
  ): Promise<void>;
}

function ciWriter(
  ctx: ReportContext,
  principal: CiPrincipal,
): AvailabilityWriter {
  return {
    source: "ci",
    label: "CI",
    audit: (action, target, summary) =>
      auditCi(ctx, principal, action, target, summary),
  };
}

/** `outlet` must be a live outlet the product declares. */
async function liveOutlet(
  ctx: ReportContext,
  raw: unknown,
  required: boolean,
): Promise<string | null | ReportRefusal> {
  if (raw === undefined && !required) return null;
  if (typeof raw !== "string" || raw === "")
    return invalid("outlet", "outlet must be an outlet id");
  const row = await getOutlet(ctx.db, ctx.product, raw);
  if (!row || row.removed_at !== null)
    return refuse(404, "unknown_outlet", `no outlet ${raw} on ${ctx.product}`);
  return raw;
}

/** `releaseId`, or `{deliverable?, version}`, resolved through Release's catalog. */
async function reportedRelease(
  ctx: ReportContext,
  body: Record<string, unknown>,
): Promise<CatalogRelease | ReportRefusal> {
  const { releaseId, version, deliverable } = body;
  if ((releaseId === undefined) === (version === undefined))
    return refuse(
      422,
      "invalid_body",
      "give exactly one of releaseId or version",
      ["releaseId", "version"],
    );
  if (releaseId !== undefined && typeof releaseId !== "string")
    return invalid("releaseId", "releaseId must be a string");
  if (version !== undefined && typeof version !== "string")
    return invalid("version", "version must be a string");
  if (deliverable !== undefined && typeof deliverable !== "string")
    return invalid("deliverable", "deliverable must be a string");
  if (releaseId !== undefined && deliverable !== undefined)
    return invalid(
      "deliverable",
      "deliverable goes with version; a releaseId names its deliverable",
    );
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return refuse(404, "unknown_release", "no such release");
  if (typeof releaseId === "string") {
    const hit = await findRelease(catalog, releaseId);
    return (
      hit ??
      refuse(
        404,
        "unknown_release",
        `no release ${releaseId} on ${ctx.product}`,
      )
    );
  }
  const d = (deliverable as string | undefined) ?? APP_DELIVERABLE_ID;
  const hit = (await catalog.releases(d)).find((r) => r.version === version);
  return (
    hit ??
    refuse(404, "unknown_release", `no release ${String(version)} of ${d}`)
  );
}

function reportedSince(
  ctx: ReportContext,
  raw: unknown,
): number | undefined | ReportRefusal {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw <= 0 ||
    raw > ctx.now + MAX_SINCE_SKEW_SECONDS
  )
    return invalid(
      "since",
      "since must be a positive integer of epoch seconds, not in the future",
    );
  return raw;
}

/** An optional JSON object field: `undefined` keeps the stored value, `null` clears it. */
function objectField(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined | ReportRefusal {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isPlainObject(v))
    return invalid(field, `${field} must be a JSON object`);
  return JSON.stringify(v);
}

function isRefusal(v: unknown): v is ReportRefusal {
  return isPlainObject(v) && v.ok === false;
}

/**
 * Apply one CI report. Validates the type, the outlet (declared, not removed), the release and
 * build (through Release's catalog hook) and the state vocabulary BEFORE writing anything; a
 * refused report writes nothing. Audited as `ci:<subject>`.
 */
export async function applyReport(
  ctx: ReportContext,
  body: Record<string, unknown>,
  principal: CiPrincipal,
): Promise<ReportResult> {
  const type = body.type;
  if (!isOneOf(REPORT_TYPES, type))
    return invalid("type", `type must be one of ${REPORT_TYPES.join(", ")}`);
  if (type === "key") return reportKey(ctx, body, principal);
  if (type === "store-step") return reportStoreStep(ctx, body, principal);

  for (const field of type === "submission" ? ["buildId", "platformRef"] : []) {
    if (body[field] !== undefined)
      return invalid(field, `a submission report takes no ${field}`);
  }
  const outlet = await liveOutlet(ctx, body.outlet, true);
  if (isRefusal(outlet)) return outlet;
  const release = await reportedRelease(ctx, body);
  if (isRefusal(release)) return release;
  const since = reportedSince(ctx, body.since);
  if (isRefusal(since)) return since;
  const detail = objectField(body, "detail");
  if (isRefusal(detail)) return detail;

  if (type === "submission") {
    if (!isSubmissionState(body.state))
      return refuse(
        422,
        "invalid_state",
        `state must be one of ${SUBMISSION_STATES.join(", ")}`,
        ["state"],
      );
    return reportSubmission(ctx, ciWriter(ctx, principal), {
      release,
      outlet: outlet as string,
      state: body.state,
      since,
      detail,
    });
  }

  let buildId = "";
  if (body.buildId !== undefined) {
    if (typeof body.buildId !== "string" || body.buildId === "")
      return invalid("buildId", "buildId must be a build id");
    const builds = await ctx.hooks.releaseCatalog()!.builds(release.releaseId);
    if (!builds.some((b) => b.buildId === body.buildId))
      return refuse(
        404,
        "unknown_build",
        `no build ${body.buildId} in ${release.releaseId}`,
      );
    buildId = body.buildId;
  }
  if (!isAvailabilityState(body.state))
    return refuse(
      422,
      "invalid_state",
      `state must be one of ${AVAILABILITY_STATES.join(", ")}`,
      ["state"],
    );
  const platformRef = objectField(body, "platformRef");
  if (isRefusal(platformRef)) return platformRef;
  if (buildId === "")
    buildId = await assetPackBuildKey(
      ctx,
      release,
      outlet as string,
      platformRef,
    );
  const result = await reportAvailability(ctx, ciWriter(ctx, principal), {
    release,
    outlet: outlet as string,
    buildId,
    state: body.state,
    since,
    platformRef,
    detail,
  });
  if (result.ok && typeof platformRef === "string")
    await linkBackgroundAssetObjects(ctx, release, platformRef);
  return result;
}

/**
 * P5-08: the row key of an apple-ba pack report. A pack release can be bound at two content levels
 * on one outlet, through two asset packs (`<pack>-c3`, `<pack>-c4`), each with its own state; a
 * whole-release row would let one level's report overwrite the other's. So a pack report on an
 * outlet whose transport for that pack is `apple-ba`, naming `platformRef.assetPackIdentifier`
 * that maps back to the pack (`assetPackBase`), is stored with `build_id` = that asset pack, as the
 * App Store Connect connector stores its rows. Anything else keeps the whole-release key (`''`).
 */
async function assetPackBuildKey(
  ctx: ReportContext,
  release: CatalogRelease,
  outlet: string,
  platformRef: string | null | undefined,
): Promise<string> {
  if (
    release.deliverableId === APP_DELIVERABLE_ID ||
    typeof platformRef !== "string"
  )
    return "";
  let ref: Record<string, unknown>;
  try {
    ref = JSON.parse(platformRef) as Record<string, unknown>;
  } catch {
    return "";
  }
  const id = ref.assetPackIdentifier;
  if (typeof id !== "string") return "";
  const parsed = parseAssetPackId(id);
  if (!parsed || assetPackBase(release.deliverableId) !== parsed.base)
    return "";
  const t = await transportOf(
    ctx.db,
    ctx.product,
    release.deliverableId,
    outlet,
  );
  return t === "apple-ba" ? id : "";
}

/**
 * P5-08: a CI report from `pkey transport apple-ba upload` names the asset-pack version it
 * uploaded (`platformRef.ascBackgroundAssetVersionId`). App Store Connect objects of that version
 * the connector stored UNRESOLVED (its events arrived before the report) are linked to the
 * report's pack release now; the connector's next read of each (the poller's reconcile, or the
 * next event) writes their availability. Only `release_id` of still-unlinked rows changes, and
 * only when the release is a pack whose id maps to the asset pack (`assetPackBase`), so a stray
 * report can never re-link another pack's asset pack.
 */
async function linkBackgroundAssetObjects(
  ctx: ReportContext,
  release: CatalogRelease,
  platformRef: string,
): Promise<void> {
  if (release.deliverableId === APP_DELIVERABLE_ID) return;
  let ref: Record<string, unknown>;
  try {
    ref = JSON.parse(platformRef) as Record<string, unknown>;
  } catch {
    return;
  }
  const versionId = ref.ascBackgroundAssetVersionId;
  const identifier = ref.assetPackIdentifier;
  if (typeof versionId !== "string" || typeof identifier !== "string") return;
  const parsed = parseAssetPackId(identifier);
  if (!parsed || assetPackBase(release.deliverableId) !== parsed.base) return;
  await ctx.db.run(
    `UPDATE dist_connector_objects SET release_id = ?
      WHERE product = ? AND connector = 'asc' AND release_id IS NULL
        AND json_extract(ref_json, '$.ascBackgroundAssetVersionId') = ?
        AND json_extract(ref_json, '$.assetPackIdentifier') = ?`,
    release.releaseId,
    ctx.product,
    versionId,
    identifier,
  );
}

/**
 * Write one availability row (insert or update) and audit it when anything changed. Validation
 * is the caller's: the release, build and outlet must already be known to exist, and `state` to
 * be in the vocabulary. Exported for the store connectors (`connectors/`).
 */
export async function reportAvailability(
  ctx: ReportContext,
  writer: AvailabilityWriter,
  r: {
    release: CatalogRelease;
    outlet: string;
    buildId: string;
    state: AvailabilityState;
    since: number | undefined;
    platformRef: string | null | undefined;
    detail: string | null | undefined;
  },
): Promise<ReportResult> {
  const { db, product, now } = ctx;
  const { release, outlet, buildId, state } = r;
  const existing = await db.first<DistAvailabilityRow>(
    `SELECT * FROM dist_availability
      WHERE product = ? AND release_id = ? AND build_id = ? AND outlet_id = ?`,
    product,
    release.releaseId,
    buildId,
    outlet,
  );
  const since =
    r.since ?? (existing && existing.state === state ? existing.since : now);
  const platformRef =
    r.platformRef === undefined
      ? (existing?.platform_ref_json ?? null)
      : r.platformRef;
  const detail =
    r.detail === undefined ? (existing?.detail_json ?? null) : r.detail;
  const transport = await transportOf(
    db,
    product,
    release.deliverableId,
    outlet,
  );
  await db.run(
    `INSERT INTO dist_availability
       (product, release_id, build_id, outlet_id, transport, state, since,
        platform_ref_json, detail_json, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, release_id, build_id, outlet_id) DO UPDATE SET
       transport = excluded.transport,
       state = excluded.state,
       since = excluded.since,
       platform_ref_json = excluded.platform_ref_json,
       detail_json = excluded.detail_json,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    product,
    release.releaseId,
    buildId,
    outlet,
    transport,
    state,
    since,
    platformRef,
    detail,
    writer.source,
    now,
  );
  const changed =
    !existing ||
    existing.state !== state ||
    existing.since !== since ||
    existing.platform_ref_json !== platformRef ||
    existing.detail_json !== detail ||
    existing.source !== writer.source;
  const what = `${release.releaseId}${buildId ? `/${buildId}` : ""}`;
  // P4-14 trigger: an availability change for a release refreshes the readiness snapshot of the
  // app releases it can affect. The hold itself is computed on read, so this only keeps
  // `dist_readiness` (the console's and P5-08's view) current; a failure here leaves the snapshot
  // for the connector cron to refresh and never fails the report.
  if (changed) {
    const catalog = ctx.hooks.releaseCatalog();
    if (catalog)
      try {
        await refreshReadiness(
          { ...ctx, actor: `system:${writer.source}` },
          release.deliverableId === APP_DELIVERABLE_ID
            ? [release.releaseId]
            : await appReleasesAffectedBy(catalog, release.releaseId),
        );
      } catch {
        // The snapshot only; see above.
      }
  }
  if (changed)
    await writer.audit(
      "distribution.availability.report",
      { kind: "availability", id: `${what}:${outlet}` },
      existing && existing.state !== state
        ? `${writer.label} reported ${what} on ${outlet}: ${existing.state} → ${state}`
        : `${writer.label} reported ${what} on ${outlet}: ${state}`,
    );
  const row = (await db.first<DistAvailabilityRow>(
    `SELECT * FROM dist_availability
      WHERE product = ? AND release_id = ? AND build_id = ? AND outlet_id = ?`,
    product,
    release.releaseId,
    buildId,
    outlet,
  ))!;
  return {
    ok: true,
    type: "availability",
    availability: availabilityRecord(row, release.deliverableId),
  };
}

/** Write one submission row and audit it when anything changed (see `reportAvailability`). */
export async function reportSubmission(
  ctx: ReportContext,
  writer: AvailabilityWriter,
  r: {
    release: CatalogRelease;
    outlet: string;
    state: SubmissionState;
    since: number | undefined;
    detail: string | null | undefined;
  },
): Promise<ReportResult> {
  const { db, product, now } = ctx;
  const { release, outlet, state } = r;
  const existing = await db.first<DistSubmissionRow>(
    `SELECT * FROM dist_submissions
      WHERE product = ? AND release_id = ? AND outlet_id = ?`,
    product,
    release.releaseId,
    outlet,
  );
  const entering = !existing || existing.state !== state;
  const at = r.since ?? now;
  const submittedAt =
    state === "submitted" && entering ? at : (existing?.submitted_at ?? null);
  const reviewedAt =
    (state === "approved" || state === "rejected") && entering
      ? at
      : (existing?.reviewed_at ?? null);
  const detail =
    r.detail === undefined ? (existing?.detail_json ?? null) : r.detail;
  await db.run(
    `INSERT INTO dist_submissions
       (product, release_id, outlet_id, state, submitted_at, reviewed_at, detail_json, source,
        updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, release_id, outlet_id) DO UPDATE SET
       state = excluded.state,
       submitted_at = excluded.submitted_at,
       reviewed_at = excluded.reviewed_at,
       detail_json = excluded.detail_json,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    product,
    release.releaseId,
    outlet,
    state,
    submittedAt,
    reviewedAt,
    detail,
    writer.source,
    now,
  );
  const changed =
    entering ||
    existing.submitted_at !== submittedAt ||
    existing.reviewed_at !== reviewedAt ||
    existing.detail_json !== detail ||
    existing.source !== writer.source;
  if (changed)
    await writer.audit(
      "distribution.submission.report",
      { kind: "submission", id: `${release.releaseId}:${outlet}` },
      existing && existing.state !== state
        ? `${writer.label} reported the ${outlet} submission of ${release.releaseId}: ${existing.state} → ${state}`
        : `${writer.label} reported the ${outlet} submission of ${release.releaseId}: ${state}`,
    );
  const row = (await db.first<DistSubmissionRow>(
    `SELECT * FROM dist_submissions
      WHERE product = ? AND release_id = ? AND outlet_id = ?`,
    product,
    release.releaseId,
    outlet,
  ))!;
  return {
    ok: true,
    type: "submission",
    submission: submissionRecord(row, release.deliverableId),
  };
}

/** A fingerprint shortened for an audit line. */
const short = (sha: string) => `${sha.slice(0, 12)}…`;

async function reportKey(
  ctx: ReportContext,
  body: Record<string, unknown>,
  principal: CiPrincipal,
): Promise<ReportResult> {
  const { db, product, now } = ctx;
  for (const field of [
    "releaseId",
    "version",
    "deliverable",
    "buildId",
    "state",
    "since",
    "platformRef",
    "detail",
  ]) {
    if (body[field] !== undefined)
      return invalid(field, `a key report takes no ${field}`);
  }
  if (!isKeyPurpose(body.purpose))
    return refuse(
      422,
      "unknown_purpose",
      `purpose must be one of ${KEY_PURPOSES.join(", ")}`,
      ["purpose"],
    );
  if (typeof body.sha256 !== "string" || !FINGERPRINT_PATTERN.test(body.sha256))
    return refuse(
      422,
      "invalid_fingerprint",
      "sha256 must be 64 lower-case hex characters",
      ["sha256"],
    );
  const outlet = await liveOutlet(ctx, body.outlet, false);
  if (isRefusal(outlet)) return outlet;
  const purpose = body.purpose;
  const sha256 = body.sha256;

  const by = ciActor(principal);
  const observed = JSON.stringify({ at: now, by, outletId: outlet });
  const existing = await db.first<{ source: string }>(
    `SELECT source FROM dist_keys
      WHERE product = ? AND purpose = ? AND fingerprint_sha256 = ?`,
    product,
    purpose,
    sha256,
  );
  if (!existing) {
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dist_keys WHERE product = ? AND source = 'ci'",
      product,
    );
    if ((n?.n ?? 0) >= MAX_KEY_OBSERVATIONS)
      return refuse(
        409,
        "too_many_observations",
        `${product} already holds ${MAX_KEY_OBSERVATIONS} unreviewed key observations; an operator must adopt or dismiss them first`,
      );
  }
  // The only column a CI report writes on an existing row is `observed_json` (and an
  // observation row's `modified_at`); an operator entry's purpose, outlet, notes and registration
  // are never touched. A fingerprint not in the inventory becomes an observation row.
  await db.run(
    `INSERT INTO dist_keys
       (product, purpose, fingerprint_sha256, outlet_id, notes, registered_at, source,
        observed_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 'ci', ?, ?, ?)
     ON CONFLICT (product, purpose, fingerprint_sha256) DO UPDATE SET
       observed_json = excluded.observed_json,
       modified_at = CASE WHEN dist_keys.source = 'ci' THEN excluded.modified_at
                          ELSE dist_keys.modified_at END`,
    product,
    purpose,
    sha256,
    outlet,
    observed,
    now,
    now,
  );
  const match = existing !== null && existing.source !== "ci";
  await auditCi(
    ctx,
    principal,
    match ? "distribution.key.observed" : "distribution.key.mismatch",
    { kind: "key", id: `${purpose}:${sha256}` },
    match
      ? `CI signed with the inventory's ${purpose} key ${short(sha256)}`
      : `CI reported a ${purpose} key ${short(sha256)} that is not in the inventory; flagged, inventory unchanged`,
  );
  return {
    ok: true,
    type: "key",
    key: { purpose, sha256, match, flagged: !match },
  };
}

// ── The operator's inventory ─────────────────────────────────────────────────────────────────

export interface KeyUpsertInput {
  purpose: unknown;
  sha256: unknown;
  outlet?: unknown;
  notes?: unknown;
  registered?: unknown;
}

export type KeyUpsertResult =
  | { ok: true; key: KeyRecord; created: boolean; adopted: boolean }
  | ReportRefusal;

/**
 * PUT one inventory entry (upsert by purpose and fingerprint). Adopting a CI observation turns
 * it into an entry. `outlet`/`notes` may be `null` to clear; omitted fields keep their value.
 * `registered: true` records Android developer verification (keeps the first timestamp).
 */
export async function upsertKey(
  db: Db,
  product: string,
  input: KeyUpsertInput,
  now: number,
): Promise<KeyUpsertResult> {
  if (!isKeyPurpose(input.purpose))
    return refuse(
      422,
      "unknown_purpose",
      `purpose must be one of ${KEY_PURPOSES.join(", ")}`,
      ["purpose"],
    );
  if (
    typeof input.sha256 !== "string" ||
    !FINGERPRINT_PATTERN.test(input.sha256)
  )
    return refuse(
      422,
      "invalid_fingerprint",
      "sha256 must be 64 lower-case hex characters",
      ["sha256"],
    );
  if (input.outlet !== undefined && input.outlet !== null) {
    if (typeof input.outlet !== "string")
      return invalid("outlet", "outlet must be an outlet id or null");
    const row = await getOutlet(db, product, input.outlet);
    if (!row || row.removed_at !== null)
      return refuse(
        422,
        "unknown_outlet",
        `no outlet ${input.outlet} on ${product}`,
        ["outlet"],
      );
  }
  if (
    input.notes !== undefined &&
    input.notes !== null &&
    (typeof input.notes !== "string" || input.notes.length > MAX_NOTES_LENGTH)
  )
    return invalid(
      "notes",
      `notes must be a string of at most ${MAX_NOTES_LENGTH} characters, or null`,
    );
  if (input.registered !== undefined && typeof input.registered !== "boolean")
    return invalid("registered", "registered must be a boolean");

  const existing = await db.first<DistKeyRow>(
    `SELECT * FROM dist_keys WHERE product = ? AND purpose = ? AND fingerprint_sha256 = ?`,
    product,
    input.purpose,
    input.sha256,
  );
  const wasEntry = existing !== null && existing.source !== "ci";
  const keep = <T>(v: unknown, prior: T): T =>
    v === undefined ? prior : (v as T);
  const outletId = keep<string | null>(
    input.outlet,
    wasEntry ? existing!.outlet_id : (existing?.outlet_id ?? null),
  );
  const notes = keep<string | null>(
    input.notes,
    wasEntry ? existing!.notes : null,
  );
  const priorRegistered = wasEntry ? existing!.registered_at : null;
  const registeredAt =
    input.registered === undefined
      ? priorRegistered
      : input.registered
        ? (priorRegistered ?? now)
        : null;
  await db.run(
    `INSERT INTO dist_keys
       (product, purpose, fingerprint_sha256, outlet_id, notes, registered_at, source,
        observed_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', NULL, ?, ?)
     ON CONFLICT (product, purpose, fingerprint_sha256) DO UPDATE SET
       outlet_id = excluded.outlet_id,
       notes = excluded.notes,
       registered_at = excluded.registered_at,
       source = 'admin',
       modified_at = excluded.modified_at`,
    product,
    input.purpose,
    input.sha256,
    outletId,
    notes,
    registeredAt,
    now,
    now,
  );
  const key = (await inventory(db, product, input.purpose)).find(
    (k) => k.sha256 === input.sha256,
  )!;
  return {
    ok: true,
    key,
    created: existing === null,
    adopted: existing !== null && !wasEntry,
  };
}

/** DELETE one entry or observation. Returns the removed row, or `null` when there was none. */
export async function deleteKey(
  db: Db,
  product: string,
  purpose: string,
  sha256: string,
): Promise<DistKeyRow | null> {
  const existing = await db.first<DistKeyRow>(
    `SELECT * FROM dist_keys WHERE product = ? AND purpose = ? AND fingerprint_sha256 = ?`,
    product,
    purpose,
    sha256,
  );
  if (!existing) return null;
  await db.run(
    `DELETE FROM dist_keys WHERE product = ? AND purpose = ? AND fingerprint_sha256 = ?`,
    product,
    purpose,
    sha256,
  );
  return existing;
}

export { short as shortFingerprint };

// ── Declared release keys → key observations (P3-03) ─────────────────────────

/**
 * The `.pkey/release` `releaseKeys` as `release`-purpose OBSERVATIONS in the key inventory, on
 * every link and resync while Distribution is on (`manifestIngest`). A repo declaring a release
 * key is a pipeline claim, exactly like a CI key report: it never becomes an inventory entry by
 * itself. A fingerprint the operator already holds only gets `observed_json` refreshed; a new one
 * is stored as a `ci`-sourced observation that flags the purpose until an operator adopts or
 * dismisses it — the independent control against a repo writer swapping the release key.
 *
 * Statements only (the ingest contract): the observation cap (`MAX_KEY_OBSERVATIONS`) is applied
 * in SQL, so a manifest can never grow the table past it. The fingerprint is lowercase hex
 * SHA-256 of the raw 32-byte key, as `dist_keys` records Ed25519 keys and as discovery's
 * `release.releaseKeyFingerprints` advertises them.
 */
export function releaseKeyObservationStatements(
  parsed: ParsedManifest,
  product: string,
  now: number,
): DbStatement[] {
  const keys = parsed.release?.releaseKeys ?? [];
  const out: DbStatement[] = [];
  for (const key of keys) {
    const raw = releaseKeyBytes(key.publicKey);
    if (!raw) continue;
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const observed = JSON.stringify({
      at: now,
      by: "manifest",
      outletId: null,
    } satisfies KeyObservation);
    out.push(
      {
        // An entry or an earlier observation of the same fingerprint: refresh `observed_json`
        // only (and an observation's `modified_at`), exactly as a CI key report does.
        sql: `UPDATE dist_keys
                 SET observed_json = ?,
                     modified_at = CASE WHEN source = 'ci' THEN ? ELSE modified_at END
               WHERE product = ? AND purpose = 'release' AND fingerprint_sha256 = ?`,
        params: [observed, now, product, sha256],
      },
      {
        sql: `INSERT INTO dist_keys
                (product, purpose, fingerprint_sha256, outlet_id, notes, registered_at, source,
                 observed_json, created_at, modified_at)
              SELECT ?, 'release', ?, NULL, NULL, NULL, 'ci', ?, ?, ?
               WHERE (SELECT COUNT(*) FROM dist_keys WHERE product = ? AND source = 'ci') < ?
              ON CONFLICT (product, purpose, fingerprint_sha256) DO NOTHING`,
        params: [
          product,
          sha256,
          observed,
          now,
          now,
          product,
          MAX_KEY_OBSERVATIONS,
        ],
      },
    );
  }
  return out;
}
