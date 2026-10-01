/**
 * The App Store Connect poller (P5-02): what no webhook covers (notes/E1 §A1 "Gaps"; S-07 row 16
 * — none of the 12 event types covers phased release, review submissions or internal TestFlight
 * state), plus reconciliation of what webhooks reported. Run on the connector cron
 * (`CONNECTOR_POLL_CRON`, every 15 minutes) for every product with Distribution on and an ASC
 * setup (`setup.ts`); a product without one is skipped before any call — including one whose
 * `asc-api-key` is not pinned to the app the manifest names (`credential-pin-missing`,
 * `credential-pin-mismatch`).
 *
 * One tick, in order, each step a handful of requests:
 *
 *   1. **Review submissions** — `GET /v1/apps/{id}/reviewSubmissions` (open states), with the
 *      version under review included: an override of that version's submission state.
 *   2. **App Store versions + phased release** — `GET /v1/apps/{id}/appStoreVersions` with the
 *      phased release included: state, submission and the `dist_rollouts` mirror
 *      (`phasedReleaseState`, `currentDayNumber` → 1, 2, 5, 10, 20, 50, 100 %) of a version not
 *      yet replaced or removed.
 *   3. **Builds / internal TestFlight** — `GET /v1/builds?filter[app]=…` newest first, with the
 *      beta detail and pre-release version included. A release's whole-release row follows its
 *      newest build.
 *
 *   Steps 2 and 3 read iOS before other platforms: one platform speaks for a release
 *   (`platformSpeaks` in `apply.ts`), so a second tick over unchanged state writes nothing.
 *   4. **Re-drive** — stored webhook events whose follow-up `failed`, or that still say
 *      `received` five minutes on (the follow-up was cut off), from the last 24 hours: the
 *      instance each names is re-read exactly as the webhook would have, and the event's outcome
 *      moves. This is what recovers a Background Asset version or release that a delivery named
 *      first: nothing lists them, so a lost follow-up would otherwise never be read again.
 *   5. **Reconciliation** — re-read the least recently read non-terminal Background Asset objects
 *      (their only signal is a webhook, which may have been missed).
 *
 * A delivery the webhook REFUSED (429, 401) was never stored and cannot be re-driven. App Store
 * versions, builds and phased release come back on the next tick through steps 1–3; a Background
 * Asset object first named by a refused delivery waits for Apple's next event for it or a manual
 * redelivery (THREAT-MODEL.md, the ASC section's residuals).
 *
 * **Budget.** The limit is per key over a rolling hour (`X-Rate-Limit`). The last value seen is
 * kept in KV; with under 20 % left the tick runs step 2 only, under 5 % it skips (`pollBudget`).
 * A 429 is retried with backoff by the client, then fails the tick for that product only.
 */

import type { ConnectorContext, PollOutcome } from "../index.js";
import {
  eventsToRedrive,
  objectsToReconcile,
  retireObject,
  setEventOutcome,
} from "../state.js";
import {
  eventOutcomeOf,
  syncAppStoreVersion,
  syncBackgroundAsset,
  syncBuild,
  syncEventInstance,
  type AscRun,
  type ReviewOverride,
} from "./apply.js";
import {
  AscError,
  ascPath,
  attr,
  findIncluded,
  relId,
  type AscResource,
} from "./client.js";
import {
  ASC_EVENT_EFFECTS,
  BACKGROUND_ASSET_INSTANCE_TYPES,
  INSTANCE_TYPES,
  REVIEW_SUBMISSION_STATE,
  byPlatformRank,
  eventTypeOf,
  isBackgroundAssetInstanceType,
} from "./map.js";
import { ascRun, finishRun, pollBudget, readRate } from "./run.js";
import { ASC_CONNECTOR, resolveAscSetup } from "./setup.js";

/** How many App Store versions / builds one tick reads (newest first). */
const VERSIONS_PER_TICK = 5;
const BUILDS_PER_TICK = 10;
/** Background Asset objects re-read per tick. */
const RECONCILE_PER_TICK = 10;
/** Stored webhook events re-driven per tick, and how far back. */
const REDRIVE_PER_TICK = 5;
export const REDRIVE_WINDOW_SECONDS = 24 * 60 * 60;
/** A `received` event younger than this may still have its follow-up running. */
export const REDRIVE_GRACE_SECONDS = 5 * 60;

export async function pollAsc(ctx: ConnectorContext): Promise<PollOutcome> {
  const { env, db, product, now } = ctx;
  const out: PollOutcome = { connector: ASC_CONNECTOR, calls: 0, applied: 0 };
  const { setup, inert } = await resolveAscSetup(db, product.slug);
  // An unpinned or mismatched key is skipped like a missing one (no call, no open), but says so.
  if (!setup)
    return {
      ...out,
      skipped:
        inert.reason === "pin_missing" || inert.reason === "pin_mismatch"
          ? `credential-${inert.reason.replace("_", "-")}`
          : "not-configured",
    };

  const budget = pollBudget(
    await readRate(env, product.slug, setup.apiKeyId, now),
  );
  if (budget === "skip") return { ...out, skipped: "rate-budget" };

  const run = ascRun({
    env,
    db,
    product: product.slug,
    hooks: ctx.hooks,
    now,
    setup,
    use: "asc:poll",
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  });
  let error: unknown = null;
  try {
    const reviews =
      budget === "full"
        ? await reviewOverrides(run)
        : new Map<string, ReviewOverride>();
    out.applied += await pollVersions(run, reviews);
    if (budget === "full") {
      out.applied += await pollBuilds(run);
      const readThisTick = new Set<string>();
      out.applied += await redrive(run, readThisTick);
      out.applied += await reconcile(run, readThisTick);
    }
  } catch (e) {
    error = e;
  }
  out.calls = run.client.calls;
  await finishRun(run, error);
  if (budget === "reduced") out.skipped = "reduced-budget";
  if (error) out.error = error instanceof Error ? error.message : "poll failed";
  return out;
}

async function pollVersions(
  run: AscRun,
  reviews: ReadonlyMap<string, ReviewOverride>,
): Promise<number> {
  const { data, included } = await run.client.getAll(
    ascPath("apps", run.setup.appleId, "appStoreVersions"),
    {
      include: "appStoreVersionPhasedRelease,build",
      limit: String(VERSIONS_PER_TICK),
    },
    1,
  );
  let applied = 0;
  // Highest-ranked platform first, so a Universal Purchase app's iOS version is known before
  // its macOS one is asked whether it speaks (`platformSpeaks`).
  for (const v of byPlatformRank(data, (r) => attr(r, "platform"))) {
    if (v.type !== "appStoreVersions") continue;
    // A list answer is scoped to the app already; say so for `ownApp`.
    const resource: AscResource = withApp(v, run.setup.appleId);
    if (
      (await syncAppStoreVersion(
        run,
        v.id,
        { resource, included },
        reviews.get(v.id),
      )) === "applied"
    )
      applied++;
  }
  return applied;
}

/**
 * The open review submissions, as an override per App Store version id. A version's own state
 * already says `WAITING_FOR_REVIEW` / `IN_REVIEW`; the review submission adds what it cannot
 * (`UNRESOLVED_ISSUES`, `CANCELING`). Applied INSIDE the version step, so the two never write
 * different answers to the same row on one tick.
 */
async function reviewOverrides(
  run: AscRun,
): Promise<Map<string, ReviewOverride>> {
  const { data, included } = await run.client.getAll(
    ascPath("apps", run.setup.appleId, "reviewSubmissions"),
    {
      "filter[state]":
        "WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING",
      include: "appStoreVersionForReview",
      limit: "10",
    },
    1,
  );
  const out = new Map<string, ReviewOverride>();
  for (const s of data) {
    if (s.type !== "reviewSubmissions") continue;
    const state = attr(s, "state");
    const submission = state ? REVIEW_SUBMISSION_STATE[state] : undefined;
    const versionId = relId(s, "appStoreVersionForReview");
    if (!state || !submission || !versionId) continue;
    // Only versions this app's list could return: the include must name it.
    if (!findIncluded(included, "appStoreVersions", versionId)) continue;
    out.set(versionId, {
      submission,
      reviewSubmissionId: s.id,
      reviewState: state,
    });
  }
  return out;
}

async function pollBuilds(run: AscRun): Promise<number> {
  const { data, included } = await run.client.getAll(
    ascPath("builds"),
    {
      "filter[app]": run.setup.appleId,
      sort: "-uploadedDate",
      include: "preReleaseVersion,buildBetaDetail",
      limit: String(BUILDS_PER_TICK),
    },
    1,
  );
  let applied = 0;
  // Newest first within each platform (the list's order), highest-ranked platform first.
  const ordered = byPlatformRank(data, (r) =>
    attr(
      findIncluded(
        included,
        "preReleaseVersions",
        relId(r, "preReleaseVersion"),
      ),
      "platform",
    ),
  );
  for (const b of ordered) {
    if (b.type !== "builds") continue;
    const resource = withApp(b, run.setup.appleId);
    if ((await syncBuild(run, b.id, { resource, included })) === "applied")
      applied++;
  }
  return applied;
}

/**
 * Re-drive stored webhook events whose follow-up failed or was cut off. One event's failure is
 * recorded on its row and the next is tried; the store's rate limit (a 429 the client gave up
 * on) stops the tick, as everywhere else.
 */
async function redrive(
  run: AscRun,
  readThisTick: Set<string>,
): Promise<number> {
  const write = { db: run.db, product: run.product, now: run.now };
  const rows = await eventsToRedrive(run.db, run.product, ASC_CONNECTOR, {
    since: run.now - REDRIVE_WINDOW_SECONDS,
    receivedBefore: run.now - REDRIVE_GRACE_SECONDS,
    limit: REDRIVE_PER_TICK,
  });
  let applied = 0;
  for (const row of rows) {
    const eventType = eventTypeOf(row.event_type);
    const effect = eventType ? ASC_EVENT_EFFECTS[eventType] : undefined;
    const instance =
      row.instance_type && row.instance_id
        ? { type: row.instance_type, id: row.instance_id }
        : null;
    if (
      !effect ||
      effect === "store-only" ||
      !instance ||
      !INSTANCE_TYPES[effect].includes(instance.type)
    ) {
      // The webhook never leaves such a row `received`/`failed`; settle it if one exists.
      await setEventOutcome(write, ASC_CONNECTOR, row.event_id, "unresolved");
      continue;
    }
    try {
      readThisTick.add(`${instance.type}/${instance.id}`);
      const outcome = eventOutcomeOf(
        await syncEventInstance(run, effect, instance),
      );
      await setEventOutcome(write, ASC_CONNECTOR, row.event_id, outcome);
      if (outcome === "applied") applied++;
    } catch (e) {
      if (e instanceof AscError && e.status === 429) throw e;
      await setEventOutcome(write, ASC_CONNECTOR, row.event_id, "failed");
    }
  }
  return applied;
}

async function reconcile(
  run: AscRun,
  readThisTick: ReadonlySet<string>,
): Promise<number> {
  const rows = await objectsToReconcile(
    run.db,
    run.product,
    ASC_CONNECTOR,
    BACKGROUND_ASSET_INSTANCE_TYPES,
    RECONCILE_PER_TICK,
  );
  let applied = 0;
  for (const row of rows) {
    if (!isBackgroundAssetInstanceType(row.object_type)) continue;
    // Already read this tick by a re-driven event.
    if (readThisTick.has(`${row.object_type}/${row.object_id}`)) continue;
    const outcome = await syncBackgroundAsset(
      run,
      row.object_type,
      row.object_id,
    );
    if (outcome === "applied") applied++;
    // Gone from the store, or no longer provably this app's: stop re-reading it.
    else if (outcome === "gone" || outcome === "foreign")
      await retireObject(
        { db: run.db, product: run.product, now: run.now },
        ASC_CONNECTOR,
        row.object_type,
        row.object_id,
      );
  }
  return applied;
}

/** A list item with its `app` relationship set to the app the list was filtered to. */
function withApp(r: AscResource, appleId: string): AscResource {
  return {
    ...r,
    relationships: {
      ...r.relationships,
      app: { data: { type: "apps", id: appleId } },
    },
  };
}
