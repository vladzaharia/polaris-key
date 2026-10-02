/**
 * The console's distribution MATRIX (P2b-06, README §6.2 item 1): releases × outlets, each cell
 * the release's availability, submission and rollout on that outlet —
 *
 *     GET /manage/api/products/<slug>/distribution/matrix?deliverable=app&limit=20
 *
 * (`admin.ts`; narrative-only, like the rest of the console API). Rows are the deliverable's
 * newest releases through Release's catalog hook; columns are the product's live outlets. The
 * cell controls are P2b-04's admin rollout routes (`…/distribution/rollouts/<outlet>/<channel>/
 * {pause,resume,halt,complete}`), which this module never calls: it says which verbs a rollout's
 * state allows (`TRANSITIONS`), and none for a MIRRORED rollout, which a store connector owns.
 *
 * ── ONE ANSWER, READ IN BULK ────────────────────────────────────────────────────────────────
 *
 * Availability is `availability.ts`'s answer — stored reports first, a self-hosted outlet's
 * derived `live` otherwise — computed for the whole page at once rather than through
 * `availabilityFor` per release (which re-reads every release row, the outlets and a transport
 * per outlet on each call): the stored rows, submissions and rollouts are one query each, the
 * transports one, and each release's builds and artifacts one each. The derivation applies the
 * same helpers (`outletMatches`, `hasServingLocation`, `DERIVED_*`) and the `files` route's
 * first-artifact-by-name rule `availabilityFor` reaches through `resolve`;
 * `test/distributionMatrix.test.ts` checks the two agree cell by cell.
 *
 * A pack deliverable's cells derive by the pack rule (`packDerivedAvailability`, P4-05), the one
 * `availabilityFor` applies; store-mirrored states are P5-02 to P5-04's (they arrive here through
 * the same tables). An app release's cells carry P4-14's readiness (`readiness.ts`): the blockers,
 * the hold (applied to the records exactly as `availabilityFor` applies it) and, on a store outlet
 * Polaris Key cannot hold, the warning.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db } from "../../core/platform.js";
import type {
  AvailabilityRecord,
  CatalogRelease,
  CatalogSourceArtifact,
  RolloutRecord,
  ServiceHooks,
  SubmissionRecord,
} from "../../core/hooks.js";
import {
  AVAILABILITY_STATES,
  DERIVED_OUTLET_KINDS,
  DERIVED_TRANSPORTS,
  SUBMISSION_STATES,
  availabilityRecord,
  embeddedIn,
  hasServingLocation,
  packDerivedAvailability,
  packDeriveShared,
  transportLookup,
  outletMatches,
  submissionRecord,
  type DistAvailabilityRow,
  type DistSubmissionRow,
} from "./availability.js";
import {
  listOutlets,
  listTransports,
  parseJsonColumn,
  transportSupported,
} from "./outlets.js";
import {
  ROLLOUT_STATES,
  TRANSITIONS,
  listRollouts,
  rolloutRecord,
  type RolloutVerb,
} from "./rollouts.js";
import { DEFAULT_TRANSPORT } from "../../core/hooks.js";
import {
  applyReadinessHold,
  readinessReader,
  type OutletReadiness,
} from "./readiness.js";

export const MATRIX_DEFAULT_LIMIT = 20;
export const MATRIX_MAX_LIMIT = 50;

/**
 * What a halt does, said next to every control (P2b-04's caveat, as it stands after P3-03): the
 * signed feed carries rollouts and halts, and the storefront feeds and the download page drop a
 * held release at once, but the legacy surfaces keep serving.
 */
export const MATRIX_EFFECT = {
  reachesDevices: "signed-feed",
  note: "A pause or halt reaches devices through the signed feed (wire v4 SDKs), and the storefront feeds and the public download page stop listing the held release at once. The legacy feeds (appcast, /update/version) and direct download URLs keep serving it: to stop a release everywhere now, yank it or pin the channel under Releases.",
} as const;

/** The order a cell's availability summary prefers, best first. */
const AVAILABILITY_RANK: readonly string[] = [
  "live",
  "approved",
  "in-review",
  "processing",
  "pending",
  "rejected",
  "removed",
];

export interface MatrixOutlet {
  outletId: string;
  kind: string;
  /** The transport the deliverable uses on this outlet. */
  transport: string;
  /** Self-hosted on a transport we serve: `live` is derived without a report. */
  derives: boolean;
  /** Whether Polaris Key acts on the transport in v1 (`SUPPORTED_TRANSPORTS`, P4-05); an
   *  unsupported one is stored and shown "not supported yet". */
  supported: boolean;
}

export interface MatrixRelease {
  releaseId: string;
  version: string;
  channel: string | null;
  publishedAt: number | null;
  yanked: boolean;
}

export interface MatrixRollout extends RolloutRecord {
  /** The verbs the state allows; empty for a mirrored rollout (its store connector owns it). */
  controls: Exclude<RolloutVerb, "set">[];
}

export interface MatrixCell {
  releaseId: string;
  outletId: string;
  /** The best state among the records (`live` first), or `null` with none. */
  availability: string | null;
  /** Every availability record, per build (`''` = the whole release). */
  records: AvailabilityRecord[];
  submission: SubmissionRecord | null;
  /** Rollouts of this release on this outlet (one per channel). */
  rollouts: MatrixRollout[];
  /**
   * P4-14: the app release's readiness on this outlet — its required pack set's blockers, whether
   * Polaris Key holds it here (then its `live` records read `pending`, as `availabilityFor`
   * answers), and on a store outlet it cannot hold, the warning. `null` for a pack deliverable's
   * cells and for a product that declares no pack.
   */
  readiness: OutletReadiness | null;
}

export interface Matrix {
  deliverableId: string;
  limit: number;
  outlets: MatrixOutlet[];
  releases: MatrixRelease[];
  cells: MatrixCell[];
  states: {
    availability: readonly string[];
    submission: readonly string[];
    rollout: readonly string[];
  };
  effect: typeof MATRIX_EFFECT;
}

function objectOf(raw: string | null): Record<string, unknown> {
  const v = parseJsonColumn(raw);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** The artifact the `files` route serves for `name` in a release: the first by id. */
function servedFor(
  artifacts: readonly CatalogSourceArtifact[],
  name: string,
): CatalogSourceArtifact | undefined {
  let first: CatalogSourceArtifact | undefined;
  for (const a of artifacts)
    if (a.name === name && (!first || a.artifactId < first.artifactId))
      first = a;
  return first;
}

/** Placeholders for a SQL `IN` list (releases are capped at `MATRIX_MAX_LIMIT`). */
function inList(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/**
 * Build the matrix for `deliverableId`, newest `limit` releases. `null` when Release is off or
 * the deliverable does not exist.
 */
export async function buildMatrix(
  ctx: { db: Db; product: string; hooks: ServiceHooks },
  deliverableId: string = APP_DELIVERABLE_ID,
  limit: number = MATRIX_DEFAULT_LIMIT,
): Promise<Matrix | null> {
  const { db, product } = ctx;
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const deliverables = await catalog.deliverables();
  if (!deliverables.some((d) => d.id === deliverableId)) return null;
  const n = Math.max(1, Math.min(MATRIX_MAX_LIMIT, Math.floor(limit)));
  const releases: CatalogRelease[] = (
    await catalog.releases(deliverableId)
  ).slice(0, n);

  const transports = await listTransports(db, product);
  const outletRows = (await listOutlets(db, product)).filter(
    (o) => o.removed_at === null,
  );
  const outlets: MatrixOutlet[] = outletRows.map((o) => {
    const transport =
      transports.find(
        (t) =>
          t.outlet_id === o.outlet_id && t.deliverable_id === deliverableId,
      )?.transport ?? DEFAULT_TRANSPORT;
    return {
      outletId: o.outlet_id,
      kind: o.kind,
      transport,
      derives:
        DERIVED_OUTLET_KINDS.includes(o.kind) &&
        DERIVED_TRANSPORTS.includes(transport),
      supported: transportSupported(transport),
    };
  });
  const identities = new Map(
    outletRows.map((o) => [o.outlet_id, objectOf(o.identity_json)]),
  );

  const ids = releases.map((r) => r.releaseId);
  const stored = ids.length
    ? await db.all<DistAvailabilityRow>(
        `SELECT * FROM dist_availability WHERE product = ? AND release_id IN (${inList(ids.length)})
          ORDER BY outlet_id, build_id`,
        product,
        ...ids,
      )
    : [];
  const submissions = ids.length
    ? await db.all<DistSubmissionRow>(
        `SELECT * FROM dist_submissions WHERE product = ? AND release_id IN (${inList(ids.length)})`,
        product,
        ...ids,
      )
    : [];
  const rollouts = (await listRollouts(db, product))
    .filter((r) => r.deliverable_id === deliverableId)
    .map(rolloutRecord);

  // A pack deliverable's releases derive by the pack rule, for the whole page at once: one record
  // read per release, then bulk reads shared by every release (P4-05, B1).
  const isPack = deliverableId !== APP_DELIVERABLE_ID;
  const packRecordsOf =
    isPack && outlets.some((o) => o.derives)
      ? await packDerivedAvailability(
          { db, product, hooks: ctx.hooks },
          catalog,
          releases,
          outletRows.filter((o) =>
            outlets.some((m) => m.outletId === o.outlet_id && m.derives),
          ),
          packDeriveShared(catalog, transportLookup(transports)),
        )
      : new Map<string, AvailabilityRecord[]>();

  // P4-14: readiness of each app release, one reader for the page (shared reads), applied to the
  // cells exactly as `availabilityFor` applies it.
  const readiness =
    deliverableId === APP_DELIVERABLE_ID
      ? readinessReader({ db, product, hooks: ctx.hooks })
      : null;

  const cells: MatrixCell[] = [];
  for (const release of releases) {
    const ready = readiness
      ? await readiness.forRelease(release.releaseId)
      : null;
    // Derived records need the builds and artifacts; a yanked release derives nothing.
    const anyDerives = !release.yanked && outlets.some((o) => o.derives);
    const packRecords = packRecordsOf.get(release.releaseId) ?? [];
    const builds =
      anyDerives && !isPack ? await catalog.builds(release.releaseId) : [];
    const artifacts =
      anyDerives && !isPack ? await catalog.artifacts(release.releaseId) : [];
    const hasBytes = (a: CatalogSourceArtifact) =>
      servedFor(artifacts, a.name)?.artifactId === a.artifactId &&
      hasServingLocation(a);

    for (const outlet of outlets) {
      const own = stored
        .filter(
          (r) =>
            r.release_id === release.releaseId &&
            r.outlet_id === outlet.outletId,
        )
        .map((r) => availabilityRecord(r, release.deliverableId));
      const derived: AvailabilityRecord[] = packRecords.filter(
        (r) => r.outletId === outlet.outletId,
      );
      if (anyDerives && outlet.derives && !isPack) {
        const identity = identities.get(outlet.outletId) ?? {};
        const record = (buildId: string): AvailabilityRecord => ({
          deliverableId: release.deliverableId,
          releaseId: release.releaseId,
          buildId,
          outletId: outlet.outletId,
          transport: outlet.transport,
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
            if (payload && hasBytes(payload)) derived.push(record(b.buildId));
          }
        } else if (
          artifacts.some(
            (a) =>
              outletMatches(outlet.kind, identity, a.buildId, a.platform) &&
              hasBytes(a),
          )
        )
          derived.push(record(""));
      }
      const merged = [
        ...own,
        ...derived.filter(
          (d) => !own.some((s) => s.buildId === "" || s.buildId === d.buildId),
        ),
      ];
      const cellReadiness =
        ready?.find((r) => r.outletId === outlet.outletId) ?? null;
      const records = applyReadinessHold(
        merged,
        cellReadiness ? [cellReadiness] : null,
      ).sort(
        (a, b) =>
          (a.buildId < b.buildId ? -1 : a.buildId > b.buildId ? 1 : 0) ||
          Number(a.derived) - Number(b.derived) ||
          (embeddedIn(a) < embeddedIn(b)
            ? -1
            : embeddedIn(a) > embeddedIn(b)
              ? 1
              : 0),
      );
      const best =
        AVAILABILITY_RANK.find((s) => records.some((r) => r.state === s)) ??
        null;
      const sub = submissions.find(
        (s) =>
          s.release_id === release.releaseId && s.outlet_id === outlet.outletId,
      );
      cells.push({
        releaseId: release.releaseId,
        outletId: outlet.outletId,
        availability: best,
        records,
        submission: sub ? submissionRecord(sub, release.deliverableId) : null,
        rollouts: rollouts
          .filter(
            (r) =>
              r.releaseId === release.releaseId &&
              r.outletId === outlet.outletId,
          )
          .map((r) => ({
            ...r,
            controls: r.mirrored
              ? []
              : (
                  Object.keys(TRANSITIONS) as Exclude<RolloutVerb, "set">[]
                ).filter((v) => TRANSITIONS[v].from.includes(r.state)),
          })),
        readiness: cellReadiness,
      });
    }
  }

  return {
    deliverableId,
    limit: n,
    outlets,
    releases: releases.map((r) => ({
      releaseId: r.releaseId,
      version: r.version,
      channel: r.channel,
      publishedAt: r.publishedAt,
      yanked: r.yanked,
    })),
    cells,
    states: {
      availability: AVAILABILITY_STATES,
      submission: SUBMISSION_STATES,
      rollout: ROLLOUT_STATES,
    },
    effect: MATRIX_EFFECT,
  };
}
