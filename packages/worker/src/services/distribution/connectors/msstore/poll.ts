/**
 * The Microsoft Store poller (P5-04) on the shared connector cron (`CONNECTOR_POLL_CRON`). The
 * Store sends no webhooks; each tick reads, with GETs only:
 *
 *     application → its pending and last published submissions
 *     listflights → for every flight the manifest maps: its pending and last published submissions
 *
 * Everything is read and parsed in memory first; the writes start only once the whole state is
 * in hand, so a failed read (a 5xx, a 429 after the retries) writes NOTHING and the next tick
 * reads again. A 409 — the app uses mandatory app updates or Store-managed consumable add-ons,
 * which the submission API does not serve — is "not readable": the tick is skipped, not failed.
 *
 * What one read writes, each through P2b-03's / P2b-04's own writers with `source = ms-store` and
 * actor `connector:ms-store`:
 *
 *   - **Connector objects**: the application, every listed flight (an unmapped one is stored,
 *     shown and audited once, never read further or written anywhere else), and every submission
 *     read (status, errors, report dates, package versions, rollout). A submission no longer
 *     pending or last published is retired.
 *   - **Availability** of every build whose `buildNumber` equals a package version of a read
 *     submission (platform `windows`, an MSIX format), on that submission's outlet, by `map.ts`.
 *     A build in several submissions takes the most-served state; a build this connector
 *     reported before that no read submission carries now → `removed`.
 *   - **Submissions** of each release (that of a submission's highest resolved package version):
 *     the non-flighted submission speaks before a flight's, a newer submission before an older.
 *     `submitted_at` / `reviewed_at` come from P2b-03's writer as the states are entered; a
 *     certification verdict takes the newest certification report's date when there is one, so
 *     the console can show time in certification.
 *   - **The outlet rollout** of each Published submission on each of its (outlet, channel):
 *     `packageRollout` mirrored into `dist_rollouts` (`mirrored = 1`).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { CatalogRelease, ServiceHooks } from "../../../../core/hooks.js";
import type { Db, Env } from "../../../../core/platform.js";
import { recordOutletCredentialResult } from "../../../../core/outletCredentials.js";
import {
  findRelease,
  reportAvailability,
  reportSubmission,
  type AvailabilityState,
  type DistAvailabilityRow,
  type ReportContext,
} from "../../availability.js";
import { mirrorRollout } from "../../rollouts.js";
import type { ConnectorContext, PollOutcome } from "../index.js";
import {
  auditConnector,
  connectorWriter,
  listObjects,
  retireObject,
  upsertObject,
  type ConnectorWriteContext,
} from "../state.js";
import { MsStoreClient, MsStoreError, type FetchImpl } from "./client.js";
import {
  AVAILABILITY_RANK,
  availabilityOf,
  compareMsix,
  compareSubmissionIds,
  parseApplication,
  parseFlights,
  parseSubmission,
  rolloutOfSubmission,
  statusRow,
  submissionDetail,
  type StoreApplication,
  type StoreFlight,
  type StoreSubmission,
} from "./map.js";
import {
  flightRoutes,
  isPinReason,
  MSSTORE_CONNECTOR,
  MSSTORE_LABEL,
  resolveMsStoreSetup,
  type MsStoreRoute,
  type MsStoreSetup,
} from "./setup.js";
import { msStoreToken } from "./token.js";

export const APPLICATION_OBJECT = "application";
export const FLIGHT_OBJECT = "flight";
export const SUBMISSION_OBJECT = "submission";

/** How many releases (newest first, across deliverables) a version lookup reads at most. */
export const MAX_RELEASES_SCANNED = 200;

/** The build formats an MSIX package version can name. */
export const MSIX_FORMATS: ReadonlySet<string> = new Set([
  "msix",
  "msixbundle",
  "msixupload",
  "appx",
  "appxbundle",
  "appxupload",
]);

// ── The run ──────────────────────────────────────────────────────────────────────────────────

export interface MsStoreRun {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  setup: MsStoreSetup;
  client: MsStoreClient;
}

export function msStoreRun(o: {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  setup: MsStoreSetup;
  /** The audited `use` of a token-minting open. */
  use: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}): MsStoreRun {
  const fetchImpl: FetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const client = new MsStoreClient({
    applicationId: o.setup.productId,
    token: () =>
      msStoreToken(
        o.env,
        o.db,
        o.product,
        o.setup.credentialId,
        o.use,
        o.now,
        fetchImpl,
      ),
    fetchImpl,
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  return {
    env: o.env,
    db: o.db,
    product: o.product,
    hooks: o.hooks,
    now: o.now,
    setup: o.setup,
    client,
  };
}

/** A status line safe to store and show. */
export function errorLine(e: unknown): string {
  if (e instanceof MsStoreError) return e.message;
  if (e instanceof Error && e.message.startsWith("entra token"))
    return e.message;
  return "Microsoft Store run failed";
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

export interface ReadSubmission {
  submission: StoreSubmission;
  role: "pending" | "published";
  /** `null` = the non-flighted submission. */
  flight: StoreFlight | null;
  routes: MsStoreRoute[];
}

export interface MsStoreState {
  application: StoreApplication;
  flights: StoreFlight[];
  submissions: ReadSubmission[];
}

async function readOne(
  run: MsStoreRun,
  flight: StoreFlight | null,
  id: string,
): Promise<StoreSubmission> {
  const doc = flight
    ? await run.client.flightSubmission(flight.flightId, id)
    : await run.client.submission(id);
  const s = parseSubmission(doc);
  if (!s || s.id !== id)
    throw new MsStoreError(502, flight ? "flight submission" : "submission");
  return s;
}

/** Read the app's state (GETs only). Throws on any failed read; the caller writes nothing. */
export async function readMsStoreState(run: MsStoreRun): Promise<MsStoreState> {
  const application = parseApplication(await run.client.application());
  if (!application || application.id !== run.setup.productId)
    throw new MsStoreError(502, "application");
  const submissions: ReadSubmission[] = [];
  const add = async (
    flight: StoreFlight | null,
    refs: Array<[ReadSubmission["role"], { id: string } | null]>,
    routes: MsStoreRoute[],
  ) => {
    for (const [role, ref] of refs) {
      if (!ref) continue;
      if (
        submissions.some(
          (s) => s.flight === flight && s.submission.id === ref.id,
        )
      )
        continue;
      submissions.push({
        submission: await readOne(run, flight, ref.id),
        role,
        flight,
        routes,
      });
    }
  };
  await add(
    null,
    [
      ["pending", application.pending],
      ["published", application.lastPublished],
    ],
    run.setup.mainRoutes,
  );
  const flights = parseFlights(await run.client.flights());
  for (const f of flights) {
    const routes = flightRoutes(run.setup, f);
    // An unmapped flight is listed, never read further.
    if (!routes.length) continue;
    await add(
      f,
      [
        ["pending", f.pending],
        ["published", f.lastPublished],
      ],
      routes,
    );
  }
  return { application, flights, submissions };
}

// ── Resolving package versions ───────────────────────────────────────────────────────────────

export interface ResolvedVersion {
  release: CatalogRelease;
  buildIds: string[];
}

/**
 * Package version → (release, builds): the `windows` builds of an MSIX format whose
 * `buildNumber` is the version. Releases are read newest first (the app's deliverable first),
 * stopping once every version is found or after `MAX_RELEASES_SCANNED`. Reads only through
 * Release's catalog hook.
 */
export async function resolveVersions(
  hooks: ServiceHooks,
  versions: ReadonlySet<string>,
): Promise<Map<string, ResolvedVersion>> {
  const out = new Map<string, ResolvedVersion>();
  const catalog = hooks.releaseCatalog();
  if (!catalog || versions.size === 0) return out;
  const deliverables = (await catalog.deliverables()).sort(
    (a, b) =>
      Number(b.id === APP_DELIVERABLE_ID) - Number(a.id === APP_DELIVERABLE_ID),
  );
  let scanned = 0;
  for (const d of deliverables) {
    for (const release of await catalog.releases(d.id)) {
      if (out.size === versions.size || scanned >= MAX_RELEASES_SCANNED)
        return out;
      scanned++;
      for (const b of await catalog.builds(release.releaseId)) {
        if (
          b.platform !== "windows" ||
          b.format === null ||
          !MSIX_FORMATS.has(b.format) ||
          b.buildNumber === null ||
          !versions.has(b.buildNumber)
        )
          continue;
        const hit = out.get(b.buildNumber);
        if (!hit) out.set(b.buildNumber, { release, buildIds: [b.buildId] });
        else if (hit.release.releaseId === release.releaseId)
          hit.buildIds.push(b.buildId);
      }
    }
  }
  return out;
}

/** The release a submission is: that of its highest resolved package version. */
export function releaseOf(
  s: StoreSubmission,
  resolved: ReadonlyMap<string, ResolvedVersion>,
): CatalogRelease | null {
  const hits = s.packages
    .map((p) => p.version)
    .filter((v) => resolved.has(v))
    .sort((a, b) => compareMsix(b, a));
  return hits.length ? resolved.get(hits[0]!)!.release : null;
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────

function writeCtx(run: MsStoreRun): ConnectorWriteContext & ReportContext {
  return { db: run.db, product: run.product, now: run.now, hooks: run.hooks };
}

const routeView = (routes: readonly MsStoreRoute[]) =>
  routes.map((r) => ({ outletId: r.outletId, channel: r.channel }));

interface DesiredAvailability {
  release: CatalogRelease;
  outlet: string;
  buildId: string;
  state: AvailabilityState;
  ref: Record<string, unknown>;
  detail: Record<string, unknown>;
}

/** Write what one read says (see the file comment). Answers how many rows it wrote. */
export async function applyMsStoreState(
  run: MsStoreRun,
  state: MsStoreState,
): Promise<{ applied: number }> {
  const { setup } = run;
  const ctx = writeCtx(run);
  const versions = new Set(
    state.submissions.flatMap((r) =>
      r.submission.packages.map((p) => p.version),
    ),
  );
  const resolved = await resolveVersions(run.hooks, versions);
  let applied = 0;

  // 1. Connector objects: the application, every flight, every submission read.
  await upsertObject(ctx, MSSTORE_CONNECTOR, {
    type: APPLICATION_OBJECT,
    id: setup.productId,
    outletId: setup.outlets[0]?.outletId ?? null,
    releaseId: null,
    buildId: "",
    storeState: "readable",
    state: null,
    ref: { productId: setup.productId },
    detail: {
      primaryName: state.application.primaryName,
      pendingSubmissionId: state.application.pending?.id ?? null,
      lastPublishedSubmissionId: state.application.lastPublished?.id ?? null,
      flights: state.flights.length,
    },
    terminal: false,
  });
  for (const f of state.flights) {
    const routes = flightRoutes(setup, f);
    const { changed } = await upsertObject(ctx, MSSTORE_CONNECTOR, {
      type: FLIGHT_OBJECT,
      id: f.flightId,
      outletId: routes[0]?.outletId ?? null,
      releaseId: null,
      buildId: "",
      storeState: routes.length ? "mapped" : "unmapped",
      state: null,
      ref: { productId: setup.productId, flightId: f.flightId },
      detail: {
        friendlyName: f.friendlyName,
        mapped: routes.length > 0,
        routes: routeView(routes),
        pendingSubmissionId: f.pending?.id ?? null,
        lastPublishedSubmissionId: f.lastPublished?.id ?? null,
      },
      terminal: false,
    });
    // "Ignored and logged": one audit row when an unmapped flight first appears (or changes),
    // not one per tick. The Worker has no console logging (R12).
    if (!routes.length && changed)
      await auditConnector(
        ctx,
        MSSTORE_CONNECTOR,
        MSSTORE_LABEL,
        "distribution.connector.flight_unmapped",
        { kind: "flight", id: f.flightId },
        `Microsoft Store lists the package flight ${f.friendlyName ?? f.flightId} (${f.flightId}), which no ms-store outlet maps (outlets.<id>.flights): ignored`,
      );
  }
  const listedFlights = new Set(state.flights.map((f) => f.flightId));
  const readSubs = new Set(state.submissions.map((r) => r.submission.id));
  for (const o of await listObjects(run.db, run.product, MSSTORE_CONNECTOR, {
    types: [FLIGHT_OBJECT, SUBMISSION_OBJECT],
    limit: 500,
  })) {
    if (o.terminal === 1) continue;
    const gone =
      o.object_type === FLIGHT_OBJECT
        ? !listedFlights.has(o.object_id)
        : !readSubs.has(o.object_id);
    if (gone)
      await retireObject(ctx, MSSTORE_CONNECTOR, o.object_type, o.object_id);
  }
  for (const r of state.submissions) {
    const s = r.submission;
    const release = releaseOf(s, resolved);
    await upsertObject(ctx, MSSTORE_CONNECTOR, {
      type: SUBMISSION_OBJECT,
      id: s.id,
      outletId: r.routes[0]?.outletId ?? null,
      releaseId: release?.releaseId ?? null,
      buildId: "",
      storeState: s.rawStatus,
      state: statusRow(s.status).submission,
      ref: {
        productId: setup.productId,
        submissionId: s.id,
        ...(r.flight ? { flightId: r.flight.flightId } : {}),
      },
      detail: submissionDetail(s, {
        role: r.role,
        flightId: r.flight?.flightId,
        flightName: r.flight?.friendlyName ?? undefined,
        routes: routeView(r.routes),
      }),
      terminal: false,
    });
  }

  if (!run.hooks.releaseCatalog()) return { applied };
  const writer = connectorWriter(ctx, MSSTORE_CONNECTOR, MSSTORE_LABEL);

  // 2. Availability: per (outlet, release, build), the most-served state across submissions.
  const desired = new Map<string, DesiredAvailability>();
  for (const r of state.submissions) {
    const s = r.submission;
    const st = availabilityOf(s);
    if (!st) continue;
    for (const route of r.routes)
      for (const p of s.packages) {
        const hit = resolved.get(p.version);
        if (!hit) continue;
        for (const buildId of hit.buildIds) {
          const key = `${route.outletId}\u0000${hit.release.releaseId}\u0000${buildId}`;
          const prior = desired.get(key);
          if (prior && AVAILABILITY_RANK[prior.state] >= AVAILABILITY_RANK[st])
            continue;
          desired.set(key, {
            release: hit.release,
            outlet: route.outletId,
            buildId,
            state: st,
            ref: {
              productId: setup.productId,
              submissionId: s.id,
              packageVersion: p.version,
              ...(r.flight ? { flightId: r.flight.flightId } : {}),
            },
            detail: submissionDetail(s, {
              channel: route.channel,
              flightId: r.flight?.flightId,
            }),
          });
        }
      }
  }
  for (const d of desired.values()) {
    await reportAvailability(ctx, writer, {
      release: d.release,
      outlet: d.outlet,
      buildId: d.buildId,
      state: d.state,
      since: undefined,
      platformRef: JSON.stringify(d.ref),
      detail: JSON.stringify(d.detail),
    });
    applied++;
  }

  // 3. What this connector reported before and no read submission carries now: removed.
  const outlets = setup.outlets.map((o) => o.outletId);
  const stale = await run.db.all<DistAvailabilityRow>(
    `SELECT * FROM dist_availability
      WHERE product = ? AND source = ? AND state != 'removed'
        AND outlet_id IN (${outlets.map(() => "?").join(", ")})
      ORDER BY outlet_id, release_id, build_id`,
    run.product,
    MSSTORE_CONNECTOR,
    ...outlets,
  );
  const catalog = run.hooks.releaseCatalog()!;
  for (const row of stale) {
    if (
      desired.has(
        `${row.outlet_id}\u0000${row.release_id}\u0000${row.build_id}`,
      )
    )
      continue;
    const release = await findRelease(catalog, row.release_id);
    if (!release) continue;
    await reportAvailability(ctx, writer, {
      release,
      outlet: row.outlet_id,
      buildId: row.build_id,
      state: "removed",
      since: undefined,
      platformRef: undefined,
      detail: undefined,
    });
    applied++;
  }

  // 4. Submissions: per (outlet, release), the non-flighted submission first, then the newest.
  const speaking = new Map<
    string,
    { r: ReadSubmission; release: CatalogRelease; outlet: string }
  >();
  for (const r of state.submissions) {
    const release = releaseOf(r.submission, resolved);
    if (!release || !statusRow(r.submission.status).submission) continue;
    for (const outlet of new Set(r.routes.map((x) => x.outletId))) {
      const key = `${outlet}\u0000${release.releaseId}`;
      const prior = speaking.get(key);
      if (prior) {
        const priorMain = prior.r.flight === null;
        const main = r.flight === null;
        if (priorMain && !main) continue;
        if (
          priorMain === main &&
          compareSubmissionIds(prior.r.submission.id, r.submission.id) > 0
        )
          continue;
      }
      speaking.set(key, { r, release, outlet });
    }
  }
  for (const { r, release, outlet } of speaking.values()) {
    const s = r.submission;
    const verdict = statusRow(s.status).submission!;
    const verdictAt = s.certificationReports.at(-1);
    await reportSubmission(ctx, writer, {
      release,
      outlet,
      state: verdict,
      since:
        (verdict === "approved" || verdict === "rejected") &&
        verdictAt !== undefined &&
        verdictAt <= run.now
          ? verdictAt
          : undefined,
      detail: JSON.stringify(
        submissionDetail(s, {
          role: r.role,
          channels: r.routes
            .filter((x) => x.outletId === outlet)
            .map((x) => x.channel),
          flightId: r.flight?.flightId,
          flightName: r.flight?.friendlyName ?? undefined,
        }),
      ),
    });
    applied++;
  }

  // 5. The outlet rollout of each Published submission on each of its (outlet, channel), oldest
  //    submission first so that the newest speaks last on a shared (outlet, channel).
  const byAge = [...state.submissions].sort((a, b) =>
    compareSubmissionIds(a.submission.id, b.submission.id),
  );
  for (const r of byAge) {
    const rollout = rolloutOfSubmission(r.submission);
    const release = releaseOf(r.submission, resolved);
    if (!rollout || !release) continue;
    for (const route of r.routes) {
      const { changed } = await mirrorRollout(
        ctx,
        {
          deliverable: release.deliverableId,
          outlet: route.outletId,
          channel: route.channel,
          releaseId: release.releaseId,
          bp: rollout.bp,
          state: rollout.state,
          source: MSSTORE_CONNECTOR,
        },
        (targetId, summary) =>
          auditConnector(
            ctx,
            MSSTORE_CONNECTOR,
            MSSTORE_LABEL,
            "distribution.rollout.mirror",
            { kind: "rollout", id: targetId },
            summary,
          ),
      );
      if (changed) applied++;
    }
  }
  return { applied };
}

/** Record that the app answered 409 (not readable through the submission API). */
async function markNotReadable(run: MsStoreRun): Promise<void> {
  await upsertObject(writeCtx(run), MSSTORE_CONNECTOR, {
    type: APPLICATION_OBJECT,
    id: run.setup.productId,
    outletId: run.setup.outlets[0]?.outletId ?? null,
    releaseId: null,
    buildId: "",
    storeState: "not-readable",
    state: null,
    ref: { productId: run.setup.productId },
    detail: {
      reason:
        "the submission API answered 409: the app uses mandatory app updates or Store-managed consumable add-ons, which it does not serve",
    },
    terminal: false,
  });
}

// ── The cron step ────────────────────────────────────────────────────────────────────────────

/**
 * One connector-cron tick for one product: skip a product without the connector before any
 * call; otherwise read, then write. A failed read is this product's `error` and writes nothing;
 * the credential's health columns record the run.
 */
export async function pollMsStore(ctx: ConnectorContext): Promise<PollOutcome> {
  const product = ctx.product.slug;
  const { setup, inert } = await resolveMsStoreSetup(ctx.db, product);
  if (!setup)
    return {
      connector: MSSTORE_CONNECTOR,
      skipped: isPinReason(inert.reason)
        ? `credential-${inert.reason.replace("_", "-")}`
        : "not-configured",
      calls: 0,
      applied: 0,
    };
  const run = msStoreRun({
    env: ctx.env,
    db: ctx.db,
    product,
    hooks: ctx.hooks,
    now: ctx.now,
    setup,
    use: "ms-store:poll",
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  });
  let error: unknown = null;
  try {
    const state = await readMsStoreState(run);
    const { applied } = await applyMsStoreState(run, state);
    return { connector: MSSTORE_CONNECTOR, calls: run.client.calls, applied };
  } catch (e) {
    if (e instanceof MsStoreError && e.notReadable) {
      await markNotReadable(run);
      return {
        connector: MSSTORE_CONNECTOR,
        skipped: "not-readable",
        calls: run.client.calls,
        applied: 0,
      };
    }
    error = e;
    return {
      connector: MSSTORE_CONNECTOR,
      calls: run.client.calls,
      applied: 0,
      error: errorLine(e),
    };
  } finally {
    if (run.client.calls > 0 || error)
      await recordOutletCredentialResult(
        run.db,
        run.product,
        setup.credentialId,
        error ? { ok: false, error: errorLine(error) } : { ok: true },
        run.now,
      );
  }
}
