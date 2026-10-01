/**
 * The App Store Connect poller (P5-02): what no webhook covers (notes/E1 §A1 "Gaps"; S-07 row 16
 * — none of the 12 event types covers phased release, review submissions or internal TestFlight
 * state), plus reconciliation of what webhooks reported. Run on the connector cron
 * (`CONNECTOR_POLL_CRON`, every 15 minutes) for every product with Distribution on and an ASC
 * setup (`setup.ts`); a product without one is skipped before any call.
 *
 * One tick, in order, each step a handful of requests:
 *
 *   1. **Review submissions** — `GET /v1/apps/{id}/reviewSubmissions` (open states), with the
 *      version under review included: an override of that version's submission state.
 *   2. **App Store versions + phased release** — `GET /v1/apps/{id}/appStoreVersions` with the
 *      phased release included: state, submission and the `dist_rollouts` mirror
 *      (`phasedReleaseState`, `currentDayNumber` → 1, 2, 5, 10, 20, 50, 100 %).
 *   3. **Builds / internal TestFlight** — `GET /v1/builds?filter[app]=…` newest first, with the
 *      beta detail and pre-release version included.
 *   4. **Reconciliation** — re-read the least recently read non-terminal Background Asset objects
 *      (their only signal is a webhook, which may have been missed).
 *
 * **Budget.** The limit is per key over a rolling hour (`X-Rate-Limit`). The last value seen is
 * kept in KV; with under 20 % left the tick runs step 2 only, under 5 % it skips (`pollBudget`).
 * A 429 is retried with backoff by the client, then fails the tick for that product only.
 */

import type { ConnectorContext, PollOutcome } from "../index.js";
import { objectsToReconcile } from "../state.js";
import {
  syncAppStoreVersion,
  syncBackgroundAsset,
  syncBuild,
  type AscRun,
  type ReviewOverride,
} from "./apply.js";
import {
  ascPath,
  attr,
  findIncluded,
  relId,
  type AscResource,
} from "./client.js";
import {
  BACKGROUND_ASSET_INSTANCE_TYPES,
  REVIEW_SUBMISSION_STATE,
  isBackgroundAssetInstanceType,
} from "./map.js";
import { ascRun, finishRun, pollBudget, readRate } from "./run.js";
import { ASC_CONNECTOR, ascSetup } from "./setup.js";

/** How many App Store versions / builds one tick reads (newest first). */
const VERSIONS_PER_TICK = 5;
const BUILDS_PER_TICK = 10;
/** Background Asset objects re-read per tick. */
const RECONCILE_PER_TICK = 10;

export async function pollAsc(ctx: ConnectorContext): Promise<PollOutcome> {
  const { env, db, product, now } = ctx;
  const out: PollOutcome = { connector: ASC_CONNECTOR, calls: 0, applied: 0 };
  const setup = await ascSetup(db, product.slug);
  if (!setup) return { ...out, skipped: "not-configured" };

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
      out.applied += await reconcile(run);
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
  for (const v of data) {
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
  for (const b of data) {
    if (b.type !== "builds") continue;
    const resource = withApp(b, run.setup.appleId);
    if ((await syncBuild(run, b.id, { resource, included })) === "applied")
      applied++;
  }
  return applied;
}

async function reconcile(run: AscRun): Promise<number> {
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
    if (
      (await syncBackgroundAsset(run, row.object_type, row.object_id)) ===
      "applied"
    )
      applied++;
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
