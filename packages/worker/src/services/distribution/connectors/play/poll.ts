/**
 * The Google Play poller (P5-03) on the shared connector cron (`CONNECTOR_POLL_CRON`). Play has
 * no release or review webhooks; the only way to know what is live per track is to read a fresh
 * edit (notes/E2 §A1 "Tracks"):
 *
 *     edits.insert → edits.tracks.list → edits.delete
 *
 * The edit is deleted before the tick ends, whatever happened — never held open between
 * requests. Edits are fragile (one open edit per user; a new edit, a Console change or another
 * commit invalidates every open one), so a read that fails — an edit invalidated mid-poll, a
 * 429 after the retries — writes NOTHING: everything is read and mapped in memory first, and the
 * writes start only once the whole track list is in hand. The next tick reads again.
 *
 * What one read writes (`applyPlayState`), each through P2b-03's / P2b-04's own writers with
 * `source = play` and actor `connector:play`:
 *
 *   - **A connector object per track** (`dist_connector_objects`, type `track`): its releases,
 *     version codes, statuses, fractions and priorities, the (outlet, channel) pairs that map it,
 *     and the release it resolves to. A track Play lists that no outlet maps — an internal track
 *     whose id is `qa`, say — is stored and shown, never written anywhere else.
 *   - **Availability** of every build whose `buildNumber` equals a version code on a mapped track
 *     (platform `android`), on that track's outlet: `inProgress`/`completed` → `live`, `halted`
 *     → `approved`, `draft` → `pending` (`map.ts`). A build on several tracks of one outlet takes
 *     the most-served state. A build this connector reported before that is on none of the
 *     outlet's tracks now → `removed`.
 *   - **The outlet rollout** of each mapped (outlet, channel): the track's staged release (else
 *     its completed one) mirrored into `dist_rollouts` (`mirrored = 1`): `userFraction` →
 *     `rollout_bp`, status → state. A track with only drafts mirrors nothing.
 *
 * Then, when an operator turned it on, the vitals auto-halt (`vitals.ts`).
 *
 * A-18e: the tick first takes the package's EDIT LEASE (`lease.ts`, purpose `poll`). While another
 * caller holds it (a provisioning run's long edit, an operator's control) the tick is SKIPPED
 * (`skipped: "edit-lease-held"`): no token, no edit, nothing written, so it can neither invalidate
 * that edit nor mirror a half-made change. The next tick reads again.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { CatalogRelease, ServiceHooks } from "../../../../core/hooks.js";
import {
  findRelease,
  reportAvailability,
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
import {
  AVAILABILITY_RANK,
  parseTrackList,
  releaseBp,
  rolloutReleaseOf,
  statusToAvailability,
  statusToRolloutState,
  type PlayRelease,
  type PlayTrack,
} from "./map.js";
import { readPlaySettings } from "./policy.js";
import {
  acquirePlayEditLease,
  isLeaseHeld,
  releasePlayEditLease,
} from "./lease.js";
import { errorLine, finishRun, playRun, type PlayRun } from "./run.js";
import {
  isPinReason,
  PLAY_CONNECTOR,
  PLAY_LABEL,
  resolvePlaySetup,
} from "./setup.js";
import { runVitals } from "./vitals.js";

/** The connector object type of one track. */
export const TRACK_OBJECT = "track";

/** How many releases (newest first, across deliverables) a version-code lookup reads at most. */
export const MAX_RELEASES_SCANNED = 200;

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

/**
 * Read every track of the app from a throwaway edit. The edit is deleted before this returns or
 * throws; a failure anywhere (insert, list) throws and the caller writes nothing.
 */
export async function readPlayState(run: PlayRun): Promise<PlayTrack[]> {
  const editId = await run.publisher.insertEdit();
  try {
    return parseTrackList(await run.publisher.listTracks(editId));
  } finally {
    await run.publisher.deleteEdit(editId);
  }
}

// ── Resolving version codes ──────────────────────────────────────────────────────────────────

/** The release and android build a version code is. */
export interface ResolvedCode {
  release: CatalogRelease;
  buildId: string;
}

/**
 * Version code → (release, build): the `android` build whose `buildNumber` is the code. Releases
 * are read newest first (the app's deliverable first) and the scan stops as soon as every code is
 * found, or after `MAX_RELEASES_SCANNED` releases — a version code on a Play track belongs to a
 * recent release. Reads only through Release's catalog hook.
 */
export async function resolveVersionCodes(
  hooks: ServiceHooks,
  codes: ReadonlySet<string>,
): Promise<Map<string, ResolvedCode>> {
  const out = new Map<string, ResolvedCode>();
  const catalog = hooks.releaseCatalog();
  if (!catalog || codes.size === 0) return out;
  const deliverables = (await catalog.deliverables()).sort(
    (a, b) =>
      Number(b.id === APP_DELIVERABLE_ID) - Number(a.id === APP_DELIVERABLE_ID),
  );
  let scanned = 0;
  for (const d of deliverables) {
    for (const release of await catalog.releases(d.id)) {
      if (out.size === codes.size || scanned >= MAX_RELEASES_SCANNED)
        return out;
      scanned++;
      for (const b of await catalog.builds(release.releaseId)) {
        if (
          b.platform === "android" &&
          b.buildNumber !== null &&
          codes.has(b.buildNumber) &&
          !out.has(b.buildNumber)
        )
          out.set(b.buildNumber, { release, buildId: b.buildId });
      }
    }
  }
  return out;
}

/** The release a track release is: that of its largest resolved version code. */
export function releaseOf(
  r: PlayRelease,
  resolved: ReadonlyMap<string, ResolvedCode>,
): CatalogRelease | null {
  const hits = r.versionCodes
    .filter((c) => resolved.has(c))
    .sort((a, b) =>
      BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0,
    );
  return hits.length ? resolved.get(hits[0]!)!.release : null;
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────

function writeCtx(run: PlayRun): ConnectorWriteContext & ReportContext {
  return {
    db: run.db,
    product: run.product,
    now: run.now,
    hooks: run.hooks,
  };
}

/** The view of one release stored on its track object and shown on the connector page. */
function releaseView(
  r: PlayRelease,
  resolved: ReadonlyMap<string, ResolvedCode>,
) {
  const release = releaseOf(r, resolved);
  return {
    name: r.name,
    versionCodes: r.versionCodes,
    status: r.status,
    userFraction: r.userFraction,
    inAppUpdatePriority: r.inAppUpdatePriority,
    releaseId: release?.releaseId ?? null,
    builds: r.versionCodes
      .map((c) => resolved.get(c))
      .filter((x): x is ResolvedCode => !!x)
      .map((x) => ({ releaseId: x.release.releaseId, buildId: x.buildId })),
  };
}

interface DesiredAvailability {
  release: CatalogRelease;
  outlet: string;
  buildId: string;
  state: AvailabilityState;
  ref: Record<string, unknown>;
  detail: Record<string, unknown>;
}

/**
 * Write what one track list says (see the file comment). Answers how many availability rows and
 * rollout mirrors it wrote.
 */
export async function applyPlayState(
  run: PlayRun,
  tracks: readonly PlayTrack[],
): Promise<{ applied: number }> {
  const { setup } = run;
  const ctx = writeCtx(run);
  const codes = new Set(
    tracks.flatMap((t) => t.releases.flatMap((r) => r.versionCodes)),
  );
  const resolved = await resolveVersionCodes(run.hooks, codes);
  let applied = 0;

  // 1. One connector object per track; a stored track Play no longer lists is retired.
  for (const t of tracks) {
    const routes = setup.routes.get(t.track) ?? [];
    const speaking = rolloutReleaseOf(t);
    const speakingRelease = speaking ? releaseOf(speaking, resolved) : null;
    await upsertObject(ctx, PLAY_CONNECTOR, {
      type: TRACK_OBJECT,
      id: t.track,
      outletId: routes[0]?.outletId ?? null,
      releaseId: routes.length ? (speakingRelease?.releaseId ?? null) : null,
      buildId: "",
      storeState: speaking?.status ?? (t.releases.length ? "draft" : "empty"),
      state: speaking ? statusToRolloutState(speaking.status) : null,
      ref: { packageName: setup.packageName, track: t.track },
      detail: {
        mapped: routes.length > 0,
        routes: routes.map((r) => ({
          outletId: r.outletId,
          channel: r.channel,
        })),
        releases: t.releases.map((r) => releaseView(r, resolved)),
      },
      terminal: false,
    });
  }
  const listed = new Set(tracks.map((t) => t.track));
  for (const o of await listObjects(run.db, run.product, PLAY_CONNECTOR, {
    types: [TRACK_OBJECT],
  }))
    if (!listed.has(o.object_id) && o.terminal === 0)
      await retireObject(ctx, PLAY_CONNECTOR, TRACK_OBJECT, o.object_id);

  if (!run.hooks.releaseCatalog()) return { applied };

  // 2. Availability: per (outlet, release, build), the most-served state across its tracks.
  const desired = new Map<string, DesiredAvailability>();
  for (const t of tracks) {
    for (const route of setup.routes.get(t.track) ?? []) {
      for (const r of t.releases) {
        const state = statusToAvailability(r.status);
        if (!state) continue;
        for (const code of r.versionCodes) {
          const hit = resolved.get(code);
          if (!hit) continue;
          const key = `${route.outletId}\u0000${hit.release.releaseId}\u0000${hit.buildId}`;
          const prior = desired.get(key);
          if (
            prior &&
            AVAILABILITY_RANK[prior.state]! >= AVAILABILITY_RANK[state]!
          )
            continue;
          desired.set(key, {
            release: hit.release,
            outlet: route.outletId,
            buildId: hit.buildId,
            state,
            ref: {
              packageName: setup.packageName,
              versionCode: code,
              track: t.track,
            },
            detail: {
              track: t.track,
              playStatus: r.status,
              userFraction: r.userFraction,
              inAppUpdatePriority: r.inAppUpdatePriority,
              releaseName: r.name,
              versionCodes: r.versionCodes,
            },
          });
        }
      }
    }
  }
  const writer = connectorWriter(ctx, PLAY_CONNECTOR, PLAY_LABEL);
  for (const d of desired.values()) {
    await reportAvailability(ctx, writer, {
      release: d.release,
      outlet: d.outlet,
      buildId: d.buildId,
      state: d.state,
      since: undefined,
      platformRef: JSON.stringify(d.ref),
      detail: JSON.stringify(stripNulls(d.detail)),
    });
    applied++;
  }

  // 3. What this connector reported before and no track of that outlet carries now: removed.
  const outlets = setup.outlets.map((o) => o.outletId);
  const stale = await run.db.all<DistAvailabilityRow>(
    `SELECT * FROM dist_availability
      WHERE product = ? AND source = ? AND state != 'removed'
        AND outlet_id IN (${outlets.map(() => "?").join(", ")})
      ORDER BY outlet_id, release_id, build_id`,
    run.product,
    PLAY_CONNECTOR,
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

  // 4. The outlet rollout of each mapped (outlet, channel).
  for (const t of tracks) {
    const routes = setup.routes.get(t.track) ?? [];
    const speaking = rolloutReleaseOf(t);
    const state = speaking ? statusToRolloutState(speaking.status) : null;
    const release = speaking ? releaseOf(speaking, resolved) : null;
    if (!speaking || !state || !release) continue;
    for (const route of routes) {
      const { changed } = await mirrorRollout(
        ctx,
        {
          deliverable: release.deliverableId,
          outlet: route.outletId,
          channel: route.channel,
          releaseId: release.releaseId,
          bp: releaseBp(speaking),
          state,
          source: PLAY_CONNECTOR,
        },
        (targetId, summary) =>
          auditConnector(
            ctx,
            PLAY_CONNECTOR,
            PLAY_LABEL,
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

function stripNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined),
  );
}

/** Read and write in one go: the poller's step, and every control's re-read. */
export async function syncPlay(
  run: PlayRun,
): Promise<{ tracks: PlayTrack[]; applied: number }> {
  const tracks = await readPlayState(run);
  const { applied } = await applyPlayState(run, tracks);
  return { tracks, applied };
}

// ── The cron step ────────────────────────────────────────────────────────────────────────────

/**
 * One connector-cron tick for one product: skip a product without the connector before any
 * call; otherwise read, write, then the vitals check when an operator turned it on. A failed read
 * is this product's `error` and writes nothing; the credential's health columns record the run.
 */
export async function pollPlay(ctx: ConnectorContext): Promise<PollOutcome> {
  const product = ctx.product.slug;
  const { setup, inert } = await resolvePlaySetup(ctx.env, ctx.db, product);
  // An unpinned or mismatched credential is skipped like a missing one (no call, no open, no
  // mirror write, no vitals read), but says so.
  if (!setup)
    return {
      connector: PLAY_CONNECTOR,
      skipped: isPinReason(inert.reason)
        ? `credential-${inert.reason.replace("_", "-")}`
        : "not-configured",
      calls: 0,
      applied: 0,
    };
  // The edit lease (A-18e): a held lease skips the tick before any token or edit.
  const lease = await acquirePlayEditLease(ctx.db, {
    packageName: setup.packageName,
    purpose: "poll",
    actor: `connector:${PLAY_CONNECTOR}`,
    now: ctx.now,
  });
  if (isLeaseHeld(lease))
    return {
      connector: PLAY_CONNECTOR,
      skipped: "edit-lease-held",
      calls: 0,
      applied: 0,
    };
  const run = playRun({
    env: ctx.env,
    db: ctx.db,
    product,
    hooks: ctx.hooks,
    now: ctx.now,
    setup,
    use: "play:poll",
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  });
  let error: unknown = null;
  let applied = 0;
  try {
    const synced = await syncPlay(run);
    applied = synced.applied;
    const settings = await readPlaySettings(ctx.db, product);
    const vitals = await runVitals(run, synced.tracks, settings.vitals);
    return {
      connector: PLAY_CONNECTOR,
      calls: run.calls(),
      applied: applied + vitals.halted,
      ...(vitals.error ? { error: vitals.error } : {}),
    };
  } catch (e) {
    error = e;
    return {
      connector: PLAY_CONNECTOR,
      calls: run.calls(),
      applied,
      error: errorLine(e),
    };
  } finally {
    await releasePlayEditLease(ctx.db, lease);
    await finishRun(run, error);
  }
}
