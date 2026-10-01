/**
 * Read one App Store Connect object and write what it says (P5-02). Shared by the webhook (a
 * hint naming an instance) and the poller (lists and reconciliation): **the API GET is truth**,
 * so every path ends here, with a fresh GET, whatever the payload claimed.
 *
 * What each object writes:
 *
 *   - `appStoreVersions` → availability and submission of the app release whose version is the
 *     store `versionString`, on the `app-store` outlet (build `''`: one binary per release); its
 *     phased release, when there is one, mirrored into `dist_rollouts`.
 *   - `builds` (and the `buildUploads` / `buildBetaDetails` that lead to one) → availability on
 *     the `testflight` outlet, of the release build whose `buildNumber` is the store build
 *     `version` (or of the whole release when none matches).
 *   - Background Asset versions and their three release kinds → a connector object with the
 *     asset pack's ids, UNRESOLVED until P5-08 maps the pack to a pack release; once resolved,
 *     availability on that release with transport `apple-ba`.
 *
 * Store ids go into `platform_ref_json` and the connector object, never into a release record
 * (README §3.3).
 *
 * **Ownership fails closed.** The App Store Connect key is team-scoped, so it can read every app
 * in the team, and a webhook names any instance its signer likes. Before anything is written,
 * each path proves the object is the outlet's app (`ownApp`): the GET asks for
 * `include=app`, because the real API puts `data` in a relationship only when that relationship
 * is included, and an absent or different app is "foreign" — nothing stored, nothing written.
 * Objects with no `app` relationship of their own prove it through the object that has one: a
 * beta detail through its build, a Background Asset release through its version and asset
 * (`backgroundAssets/{id}?include=app`). A list the poller reads through an app-scoped endpoint
 * (`/v1/apps/{appleId}/…`, `/v1/builds?filter[app]=…`) is proven by the endpoint.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db, Env } from "../../../../core/platform.js";
import type { CatalogRelease, ServiceHooks } from "../../../../core/hooks.js";
import {
  isAvailabilityState,
  reportAvailability,
  reportSubmission,
  type AvailabilityState,
  type ReportContext,
  type SubmissionState,
} from "../../availability.js";
import { mirrorRollout } from "../../rollouts.js";
import {
  auditConnector,
  connectorWriter,
  upsertObject,
  type ConnectorWriteContext,
} from "../state.js";
import {
  AscClient,
  ascPath,
  attr,
  findIncluded,
  numAttr,
  relId,
  single,
  type AscResource,
} from "./client.js";
import {
  APP_VERSION_AVAILABILITY,
  APP_VERSION_SUBMISSION,
  APP_VERSION_TERMINAL,
  BACKGROUND_ASSET_STATES,
  BUILD_UPLOAD_AVAILABILITY,
  appVersionStateOf,
  phasedDayToBp,
  phasedStateToRollout,
  sameVersion,
  isBackgroundAssetInstanceType,
  testflightAvailability,
  type AscEventEffect,
  type BackgroundAssetInstanceType,
} from "./map.js";
import { ASC_CONNECTOR, ASC_LABEL, outletFor, type AscSetup } from "./setup.js";

/** Everything one connector run needs: one product, one setup, one client. */
export interface AscRun {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  setup: AscSetup;
  client: AscClient;
}

/** What reading one object came to. */
export type ApplyOutcome =
  /** state written (availability, submission or a rollout) */
  | "applied"
  /** object stored, but no release claims it yet */
  | "unresolved"
  /** the object is not proven to be the outlet's app; nothing stored or written */
  | "foreign"
  /** the store no longer has it (404); nothing written */
  | "gone";

const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

function writeCtx(run: AscRun): ConnectorWriteContext & ReportContext {
  return {
    db: run.db,
    product: run.product,
    now: run.now,
    hooks: run.hooks,
  };
}

/** The release of `deliverable` whose version is the store's version string. */
async function releaseForVersion(
  run: AscRun,
  versionString: string | null,
  deliverable = APP_DELIVERABLE_ID,
): Promise<CatalogRelease | null> {
  if (!versionString) return null;
  const catalog = run.hooks.releaseCatalog();
  if (!catalog) return null;
  const releases = await catalog.releases(deliverable);
  return releases.find((r) => sameVersion(r.version, versionString)) ?? null;
}

async function releaseById(
  run: AscRun,
  releaseId: string,
): Promise<CatalogRelease | null> {
  const catalog = run.hooks.releaseCatalog();
  if (!catalog) return null;
  for (const d of await catalog.deliverables()) {
    const hit = (await catalog.releases(d.id)).find(
      (r) => r.releaseId === releaseId,
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Is this resource proven to be the outlet's app? Fails closed: a resource that does not name
 * its app (the GET did not include `app`, or the type has no such relationship) is not.
 */
export function ownApp(run: AscRun, r: AscResource | null): boolean {
  if (!r) return false;
  return relId(r, "app") === run.setup.appleId;
}

function stripNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined),
  );
}

// ── App Store versions ───────────────────────────────────────────────────────────────────────

/** An open review submission's say on a version's submission state (the poller's). */
export interface ReviewOverride {
  submission: SubmissionState;
  reviewSubmissionId: string;
  reviewState: string;
}

/**
 * Read one `appStoreVersions` resource (or take one a list already returned, with its
 * `included`) and write availability, submission and the phased-release mirror.
 */
export async function syncAppStoreVersion(
  run: AscRun,
  versionId: string,
  prefetched?: { resource: AscResource; included: readonly AscResource[] },
  review?: ReviewOverride,
): Promise<ApplyOutcome> {
  let resource = prefetched?.resource ?? null;
  let included = prefetched?.included ?? [];
  if (!resource) {
    const doc = await run.client.getOrNull(
      ascPath("appStoreVersions", versionId),
      { include: "app,appStoreVersionPhasedRelease,build" },
    );
    resource = single(doc);
    included = doc?.included ?? [];
  }
  if (!resource) return "gone";
  if (!ownApp(run, resource)) return "foreign";

  const storeState = appVersionStateOf(resource.attributes);
  const versionString = attr(resource, "versionString");
  const platform = attr(resource, "platform");
  const phasedId = relId(resource, "appStoreVersionPhasedRelease");
  const phased = findIncluded(
    included,
    "appStoreVersionPhasedReleases",
    phasedId,
  );
  const buildId = relId(resource, "build");
  const release = await releaseForVersion(run, versionString);
  const availability = storeState
    ? (APP_VERSION_AVAILABILITY[storeState] ?? null)
    : null;
  const ctx = writeCtx(run);
  const outlet = run.setup.appStoreOutlet;

  const ref = stripNulls({
    ascAppId: run.setup.appleId,
    ascVersionId: resource.id,
    ascBuildId: buildId,
    ascPhasedReleaseId: phased?.id ?? phasedId,
  });
  const detail = stripNulls({
    ascState: storeState,
    versionString,
    platform,
    releaseType: attr(resource, "releaseType"),
    phasedReleaseState: attr(phased, "phasedReleaseState"),
    currentDayNumber: numAttr(phased, "currentDayNumber"),
  });
  await upsertObject(ctx, ASC_CONNECTOR, {
    type: "appStoreVersions",
    id: resource.id,
    outletId: outlet,
    releaseId: release?.releaseId ?? null,
    buildId: "",
    storeState,
    state: availability,
    ref,
    detail,
    terminal: storeState !== null && APP_VERSION_TERMINAL.has(storeState),
  });
  if (!release || !outlet) return "unresolved";

  const writer = connectorWriter(ctx, ASC_CONNECTOR, ASC_LABEL);
  if (availability) {
    await reportAvailability(ctx, writer, {
      release,
      outlet,
      buildId: "",
      state: availability,
      since: undefined,
      platformRef: JSON.stringify(ref),
      detail: JSON.stringify(detail),
    });
  }
  const submission =
    review?.submission ??
    (storeState ? APP_VERSION_SUBMISSION[storeState] : undefined);
  if (submission) {
    await reportSubmission(ctx, writer, {
      release,
      outlet,
      state: submission,
      since: undefined,
      detail: JSON.stringify(
        stripNulls({
          ascState: storeState,
          ascVersionId: resource.id,
          ascReviewSubmissionId: review?.reviewSubmissionId ?? null,
          ascReviewSubmissionState: review?.reviewState ?? null,
        }),
      ),
    });
  }
  if (phased) await mirrorPhasedRelease(run, release, outlet, phased);
  return "applied";
}

/**
 * Mirror an `appStoreVersionPhasedReleases` resource into `dist_rollouts` (`mirrored = 1`,
 * `source = asc`): `ACTIVE` → `active`, `PAUSED` → `paused`, `COMPLETE` → `complete`, at the
 * basis points of Apple's day (`phasedDayToBp`). `INACTIVE` — configured, not started — writes
 * nothing.
 */
export async function mirrorPhasedRelease(
  run: AscRun,
  release: CatalogRelease,
  outlet: string,
  phased: AscResource,
): Promise<boolean> {
  const state = phasedStateToRollout(attr(phased, "phasedReleaseState"));
  if (!state) return false;
  const bp =
    state === "complete"
      ? 10000
      : phasedDayToBp(numAttr(phased, "currentDayNumber"));
  const channel =
    release.channel && CHANNEL.test(release.channel)
      ? release.channel
      : "stable";
  const ctx = writeCtx(run);
  const { changed } = await mirrorRollout(
    ctx,
    {
      deliverable: release.deliverableId,
      outlet,
      channel,
      releaseId: release.releaseId,
      bp,
      state,
      source: ASC_CONNECTOR,
    },
    (targetId, summary) =>
      auditConnector(
        ctx,
        ASC_CONNECTOR,
        ASC_LABEL,
        "distribution.rollout.mirror",
        { kind: "rollout", id: targetId },
        summary,
      ),
  );
  return changed;
}

// ── Builds and TestFlight ────────────────────────────────────────────────────────────────────

/** Read one `builds` resource (with its beta detail and pre-release version) and write the
 *  `testflight` availability of the release build it is. */
export async function syncBuild(
  run: AscRun,
  buildId: string,
  prefetched?: { resource: AscResource; included: readonly AscResource[] },
): Promise<ApplyOutcome> {
  let resource = prefetched?.resource ?? null;
  let included = prefetched?.included ?? [];
  if (!resource) {
    const doc = await run.client.getOrNull(ascPath("builds", buildId), {
      include: "app,preReleaseVersion,buildBetaDetail",
    });
    resource = single(doc);
    included = doc?.included ?? [];
  }
  if (!resource) return "gone";
  if (!ownApp(run, resource)) return "foreign";

  const pre = findIncluded(
    included,
    "preReleaseVersions",
    relId(resource, "preReleaseVersion"),
  );
  const beta = findIncluded(
    included,
    "buildBetaDetails",
    relId(resource, "buildBetaDetail"),
  );
  const versionString = attr(pre, "version");
  const buildNumber = attr(resource, "version");
  const processingState = attr(resource, "processingState");
  const internal = attr(beta, "internalBuildState");
  const external = attr(beta, "externalBuildState");
  const expired = resource.attributes?.expired === true;
  let state: AvailabilityState | null;
  if (expired) state = "removed";
  else if (processingState === "PROCESSING") state = "processing";
  else if (processingState === "FAILED" || processingState === "INVALID")
    state = "rejected";
  else state = testflightAvailability(internal, external);

  const release = await releaseForVersion(run, versionString);
  let releaseBuild = "";
  if (release && buildNumber) {
    const builds = await run.hooks.releaseCatalog()!.builds(release.releaseId);
    releaseBuild =
      builds.find(
        (b) => b.buildNumber !== null && b.buildNumber === buildNumber,
      )?.buildId ?? "";
  }
  const outlet = run.setup.testflightOutlet;
  const ctx = writeCtx(run);
  const ref = stripNulls({
    ascAppId: run.setup.appleId,
    ascBuildId: resource.id,
    ascBuildBetaDetailId: beta?.id ?? null,
    ascPreReleaseVersionId: pre?.id ?? null,
  });
  const detail = stripNulls({
    processingState,
    internalBuildState: internal,
    externalBuildState: external,
    buildNumber,
    versionString,
    expired: expired || null,
  });
  await upsertObject(ctx, ASC_CONNECTOR, {
    type: "builds",
    id: resource.id,
    outletId: outlet,
    releaseId: release?.releaseId ?? null,
    buildId: releaseBuild,
    storeState: [processingState, internal, external]
      .map((s) => s ?? "-")
      .join("/"),
    state,
    ref,
    detail,
    terminal: expired,
  });
  if (!release || !outlet || !state) return "unresolved";
  await reportAvailability(
    ctx,
    connectorWriter(ctx, ASC_CONNECTOR, ASC_LABEL),
    {
      release,
      outlet,
      buildId: releaseBuild,
      state,
      since: undefined,
      platformRef: JSON.stringify(ref),
      detail: JSON.stringify(detail),
    },
  );
  return "applied";
}

/** `BUILD_UPLOAD_STATE_UPDATED`: read the upload; once it has a build, read the build. */
export async function syncBuildUpload(
  run: AscRun,
  uploadId: string,
): Promise<ApplyOutcome> {
  const doc = await run.client.getOrNull(ascPath("buildUploads", uploadId), {
    include: "app,build",
  });
  const upload = single(doc);
  if (!upload) return "gone";
  if (!ownApp(run, upload)) return "foreign";
  const state = attr(upload, "state");
  const build = relId(upload, "build");
  const versionString = attr(upload, "cfBundleShortVersionString");
  const buildNumber = attr(upload, "cfBundleVersion");
  const ctx = writeCtx(run);
  const release = await releaseForVersion(run, versionString);
  const mapped = state ? (BUILD_UPLOAD_AVAILABILITY[state] ?? null) : null;
  await upsertObject(ctx, ASC_CONNECTOR, {
    type: "buildUploads",
    id: upload.id,
    outletId: run.setup.testflightOutlet,
    releaseId: release?.releaseId ?? null,
    buildId: "",
    storeState: state,
    state: mapped,
    ref: stripNulls({ ascAppId: run.setup.appleId, ascBuildId: build }),
    detail: stripNulls({ versionString, buildNumber }),
    terminal: state === "COMPLETE" || state === "FAILED",
  });
  // Processing finished: the build (and its beta detail) is the truth from here on.
  if (state === "COMPLETE" && build) return syncBuild(run, build);
  const outlet = run.setup.testflightOutlet;
  if (!release || !outlet || !mapped) return "unresolved";
  let releaseBuild = "";
  if (buildNumber) {
    const builds = await run.hooks.releaseCatalog()!.builds(release.releaseId);
    releaseBuild =
      builds.find((b) => b.buildNumber === buildNumber)?.buildId ?? "";
  }
  await reportAvailability(
    ctx,
    connectorWriter(ctx, ASC_CONNECTOR, ASC_LABEL),
    {
      release,
      outlet,
      buildId: releaseBuild,
      state: mapped,
      since: undefined,
      platformRef: undefined,
      detail: JSON.stringify(
        stripNulls({ buildUploadState: state, ascBuildUploadId: upload.id }),
      ),
    },
  );
  return "applied";
}

/** `BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED`: the beta detail names its build. */
export async function syncBuildBetaDetail(
  run: AscRun,
  detailId: string,
): Promise<ApplyOutcome> {
  const doc = await run.client.getOrNull(
    ascPath("buildBetaDetails", detailId),
    { include: "build" },
  );
  const detail = single(doc);
  if (!detail) return "gone";
  const build = relId(detail, "build");
  if (!build) return "unresolved";
  return syncBuild(run, build);
}

// ── Background Assets ────────────────────────────────────────────────────────────────────────

/**
 * Read one Background Asset version or release and store it as a connector object. Which pack
 * release it belongs to is P5-08's mapping: until then the object is UNRESOLVED (shown, never
 * written as availability). A row P5-08 has resolved writes availability on that release with
 * the outlet's transport for its deliverable (`apple-ba` when declared).
 */
export async function syncBackgroundAsset(
  run: AscRun,
  type: BackgroundAssetInstanceType,
  id: string,
): Promise<ApplyOutcome> {
  const spec = BACKGROUND_ASSET_STATES[type];
  const isVersion = type === "backgroundAssetVersions";
  const doc = await run.client.getOrNull(ascPath(type, id), {
    include: isVersion ? "backgroundAsset" : "backgroundAssetVersion",
  });
  const r = single(doc);
  if (!r) return "gone";
  // A release names its version; the version names its asset; the asset names its app. Each
  // link is read from the primary data of its own GET (an included resource carries no
  // relationship data on the real API), and a missing link is unproven: nothing is stored.
  let version: AscResource | null = r;
  if (!isVersion) {
    const linked = relId(r, "backgroundAssetVersion");
    if (!linked) return "foreign";
    version = single(
      await run.client.getOrNull(ascPath("backgroundAssetVersions", linked), {
        include: "backgroundAsset",
      }),
    );
    if (!version) return "gone";
  }
  const versionId = version.id;
  const assetId = relId(version, "backgroundAsset");
  if (!assetId) return "foreign";
  const asset = single(
    await run.client.getOrNull(ascPath("backgroundAssets", assetId), {
      include: "app",
    }),
  );
  if (!ownApp(run, asset)) return "foreign";

  const storeState = attr(r, "state");
  const state = storeState ? (spec.states[storeState] ?? null) : null;
  const outlet = outletFor(run.setup, spec.outletKind);
  const ctx = writeCtx(run);

  const stateDetails = isVersion ? r.attributes?.stateDetails : undefined;
  const { row } = await upsertObject(ctx, ASC_CONNECTOR, {
    type,
    id: r.id,
    outletId: outlet,
    releaseId: undefined,
    buildId: "",
    storeState,
    state,
    ref: stripNulls({
      ascAppId: run.setup.appleId,
      ascBackgroundAssetId: assetId,
      ascBackgroundAssetVersionId: versionId,
      assetPackIdentifier: attr(asset, "assetPackIdentifier"),
    }),
    detail: stripNulls({
      version: attr(version, "version") ?? numAttr(version, "version"),
      platforms: version.attributes?.platforms ?? null,
      stateDetails:
        stateDetails && typeof stateDetails === "object" ? stateDetails : null,
    }),
    terminal: storeState !== null && spec.terminal.includes(storeState),
  });
  if (row.release_id === null) return "unresolved";
  const release = await releaseById(run, row.release_id);
  if (!release || !outlet || !state || !isAvailabilityState(state))
    return "unresolved";
  await reportAvailability(
    ctx,
    connectorWriter(ctx, ASC_CONNECTOR, ASC_LABEL),
    {
      release,
      outlet,
      buildId: row.build_id,
      state,
      since: undefined,
      platformRef: row.ref_json,
      detail: JSON.stringify(
        stripNulls({ ascState: storeState, ascType: type }),
      ),
    },
  );
  return "applied";
}

/** The stored object a control acts on: the App Store version of one release. */
export async function versionObjectForRelease(
  db: Db,
  product: string,
  releaseId: string,
): Promise<{
  versionId: string;
  phasedId: string | null;
  storeState: string | null;
} | null> {
  const row = await db.first<{
    object_id: string;
    ref_json: string | null;
    store_state: string | null;
  }>(
    `SELECT object_id, ref_json, store_state FROM dist_connector_objects
      WHERE product = ? AND connector = ? AND object_type = 'appStoreVersions'
        AND release_id = ?
      ORDER BY updated_at DESC LIMIT 1`,
    product,
    ASC_CONNECTOR,
    releaseId,
  );
  if (!row) return null;
  let phasedId: string | null = null;
  try {
    const ref = JSON.parse(row.ref_json ?? "{}") as Record<string, unknown>;
    if (typeof ref.ascPhasedReleaseId === "string")
      phasedId = ref.ascPhasedReleaseId;
  } catch {
    /* no ref */
  }
  return { versionId: row.object_id, phasedId, storeState: row.store_state };
}

/** The event outcome recorded for what re-reading its instance came to. */
export function eventOutcomeOf(
  applied: ApplyOutcome | "unresolved",
): "applied" | "unresolved" | "ignored" {
  return applied === "applied"
    ? "applied"
    : applied === "unresolved"
      ? "unresolved"
      : "ignored";
}

/**
 * Re-read the instance one webhook event named, by the event type's effect. Shared by the webhook
 * (right after the delivery) and the poller (re-driving a stored event whose follow-up failed or
 * never finished). Throws only what the client throws (an ASC error, a network failure).
 */
export async function syncEventInstance(
  run: AscRun,
  effect: Exclude<AscEventEffect, "store-only">,
  instance: { type: string; id: string },
): Promise<ApplyOutcome | "unresolved"> {
  switch (effect) {
    case "app-store-version":
      return syncAppStoreVersion(run, instance.id);
    case "build-upload":
      return syncBuildUpload(run, instance.id);
    case "build-beta-detail":
      return syncBuildBetaDetail(run, instance.id);
    case "background-asset":
      return isBackgroundAssetInstanceType(instance.type)
        ? syncBackgroundAsset(run, instance.type, instance.id)
        : "unresolved";
  }
}
