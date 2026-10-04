/**
 * The App Store Connect **Distribute** API (A-17d; notes/S-14 §8.2, §7). The console's Distribute
 * flow (A-17g) drives a build of the pinned app to TestFlight and the App Store through these
 * named handlers, under `…/distribution/connectors/asc/distribute/…`. There is no generic proxy:
 * each handler sends exactly one kind of request, through Core's gated client.
 *
 *   GET  distribute/builds          the app's unexpired builds, newest first: processing state,
 *                                   export compliance, TestFlight states, the build upload's
 *                                   state with Apple's warning and error codes, and the Polaris
 *                                   Key release the connector linked it to
 *   GET  distribute/beta-groups     the app's TestFlight groups (to tick)
 *   GET  distribute/versions        the app's App Store versions (editable or not, build, phased
 *                                   release) and its open review submissions
 *   GET  distribute/preflight?versionId=
 *                                   what the API exposes about readiness: build, export
 *                                   compliance, screenshots, age rating, review contact (present,
 *                                   never its values), price, availability, beta review details
 *
 *   POST distribute/export-compliance        { buildId, usesNonExemptEncryption }
 *   POST distribute/beta-localization        { buildId, locale, whatsNew }
 *   POST distribute/testflight/groups        { buildId, betaGroupIds }
 *   POST distribute/testflight/beta-review   { buildId }
 *   POST distribute/version                  { platform, versionString }   create or reuse
 *   POST distribute/version/build            { versionId, buildId }
 *   POST distribute/version/release-type     { versionId, releaseType, earliestReleaseDate? }
 *   POST distribute/version/phased-release   { versionId }
 *   POST distribute/version-localization     { versionId, locale, whatsNew?, promotionalText? }
 *   POST distribute/submit                   { versionId, confirm,         TYPED
 *                                              inAppPurchaseVersionIds?,
 *                                              backgroundAssetVersionIds? }
 *   POST distribute/submission/cancel        { submissionId }
 *
 * The write discipline is S-14 §7's, through A-17a's substrate:
 *
 *   - **Pinned app only.** Every handler runs inside P5-02's `withRun`, so a missing or
 *     mismatched pin refuses before any token is minted. The app id is never request input: an
 *     `app` relationship is filled from the setup, and every object a request names (a build, a
 *     group, a version, a submission) is RE-READ from Apple with `include=app` and must belong to
 *     the pinned app before anything is written (`unknown_build`, `unknown_beta_group`,
 *     `unknown_version`, `unknown_submission`).
 *   - **Idempotent and resumable.** Every write requires the console's `Idempotency-Key` header
 *     (one per user intent) and runs as a ledger step (`core/asc/ledger.ts`): a natural-key read
 *     first (S-14 §7.3's table), nothing sent when Apple already has it, a replay of a done step
 *     answered from the row, the same key with another body a 409 `idempotency_conflict`. A
 *     multi-step handler (groups, submit) is a sequence of such steps under the one key, so a
 *     closed tab or a 429 resumes where it stopped.
 *   - **Audited with before and after.** Each step that writes appends one
 *     `distribution.asc.<op>` row naming its ledger `op_id`, whose row holds Apple's projected
 *     before and after reads.
 *   - **Typed confirmation for submit for review** (owner decision, 2026-10-04): `confirm` must be
 *     the app's name as App Store Connect reports it now, compared server-side
 *     (`checkTypedConfirmation`, shared with P5-02's `release`), and only then does the handler
 *     assert `typedConfirmation` to the write gate, which refuses `submitted: true` without it.
 *     Cancelling a submission is a plain confirm.
 *
 * A-17e: `distribute/submit` also adds the IAP and Background Asset versions it is given (listed by
 * `GET distribute/submission-items`), each proven the pinned app's by `commerce/appleCatalog.ts`
 * before the submission is opened, and the preflight carries the first-IAP portal note. The shared
 * plumbing (`distributeControl`, `step`, `proveOwned`) lives in `flow.ts`.
 *
 * Out of this file: the console (A-17g) and a manual release (P5-02's `release`).
 */

import {
  ascPath,
  attr,
  findIncluded,
  relId,
  single,
  type AscResource,
} from "../../../../core/asc/client.js";
import { getObject } from "../state.js";
import { syncAppStoreVersion } from "./apply.js";
import {
  checkTypedConfirmation,
  type ConnectorControl,
  type ConnectorRead,
} from "./controls.js";
import {
  ID,
  distributeControl,
  distributeRead,
  idField,
  localeField,
  proveOwned,
  step,
  stepView,
  stop,
  textField,
  type Flow,
  type StepResult,
} from "./flow.js";
import { ASC_CONNECTOR } from "./setup.js";
import {
  firstIapCheck,
  proveSubmissionExtras,
  submissionExtras,
} from "../../commerce/appleCatalog.js";

// ── Validation ───────────────────────────────────────────────────────────────────────────────

const VERSION_STRING = /^\d{1,5}(\.\d{1,5}){0,3}$/;
const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;
const RELEASE_TYPES = ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"] as const;
/** Apple's limits: What to Test and What's New 4,000 characters; promotional text 170. */
const WHATS_NEW_MAX = 4000;
const PROMO_MAX = 170;
const MAX_GROUPS = 20;

// ── Ownership proofs ─────────────────────────────────────────────────────────────────────────

/**
 * Version states in which the version's metadata, build and release type can still change (the
 * version Distribute reuses or edits). Submitting adds READY_FOR_REVIEW (in an open submission,
 * not yet sent).
 */
const EDITABLE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);
const SUBMITTABLE_VERSION_STATES = new Set([
  ...EDITABLE_VERSION_STATES,
  "READY_FOR_REVIEW",
]);
/** A phased release can be chosen until the version ships. */
const PHASED_VERSION_STATES = new Set([
  ...SUBMITTABLE_VERSION_STATES,
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PENDING_DEVELOPER_RELEASE",
]);

/** A version's state: Apple's newer `appVersionState`, else `appStoreState`. */
function versionState(v: AscResource | null): string | null {
  return attr(v, "appVersionState") ?? attr(v, "appStoreState");
}

function proveBuild(f: Pick<Flow, "run" | "setup">, buildId: string) {
  return proveOwned(f, "builds", buildId, [], "unknown_build", "build");
}

/** A build that can go to testers or a version: processed and valid. */
async function proveValidBuild(
  f: Pick<Flow, "run" | "setup">,
  buildId: string,
) {
  const { resource } = await proveBuild(f, buildId);
  if (resource.attributes?.expired === true)
    stop(409, "build_expired", `build ${buildId} has expired`);
  const processing = attr(resource, "processingState");
  if (processing !== "VALID")
    stop(
      409,
      "build_not_ready",
      `build ${buildId} is ${processing ?? "in an unknown state"}, not VALID`,
    );
  return resource;
}

async function proveVersionId(
  f: Pick<Flow, "run" | "setup">,
  versionId: string,
  include: string[] = [],
  states?: ReadonlySet<string>,
) {
  const proven = await proveOwned(
    f,
    "appStoreVersions",
    versionId,
    include,
    "unknown_version",
    "App Store version",
  );
  const state = versionState(proven.resource);
  if (states && (!state || !states.has(state)))
    stop(
      409,
      "version_not_editable",
      `the App Store version ${versionId} is ${state ?? "in an unknown state"}`,
    );
  return proven;
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

const BUILD_LIMIT_DEFAULT = 20;

function limitParam(q: URLSearchParams, dflt: number, max: number): number {
  const n = Number(q.get("limit") ?? dflt);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : dflt;
}

/** Apple's per-upload notes: `{ code, description }`, bounded. */
function stateDetails(v: unknown): { code: string; description: string }[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).flatMap((d) => {
    const o = d as { code?: unknown; description?: unknown };
    return typeof o?.code === "string"
      ? [
          {
            code: o.code.slice(0, 100),
            description:
              typeof o.description === "string"
                ? o.description.slice(0, 300)
                : "",
          },
        ]
      : [];
  });
}

/**
 * A build upload's state. The 4.5 spec makes `state` an object (`{ state, warnings, errors,
 * infos }`); an older answer carries the bare state string.
 */
function uploadView(u: AscResource | null) {
  if (!u) return null;
  const raw = u.attributes?.state;
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const state =
    typeof raw === "string"
      ? raw
      : typeof obj?.state === "string"
        ? obj.state
        : null;
  return {
    id: u.id,
    state,
    warnings: stateDetails(obj?.warnings),
    errors: stateDetails(obj?.errors),
    uploadedDate: attr(u, "uploadedDate"),
  };
}

const builds: ConnectorRead = distributeRead(async ({ c, run, setup }, q) => {
  const doc = await run.client.get(ascPath("builds"), {
    "filter[app]": setup.appleId,
    "filter[expired]": "false",
    sort: "-uploadedDate",
    limit: String(limitParam(q, BUILD_LIMIT_DEFAULT, 50)),
    include: "preReleaseVersion,buildUpload,buildBetaDetail",
  });
  const data = Array.isArray(doc?.data) ? doc.data : [];
  const out = [];
  for (const b of data) {
    // `filter[app]` is Apple's; the include proves it again for each row.
    const prv = findIncluded(
      doc?.included,
      "preReleaseVersions",
      relId(b, "preReleaseVersion"),
    );
    const detail = findIncluded(
      doc?.included,
      "buildBetaDetails",
      relId(b, "buildBetaDetail"),
    );
    const upload = findIncluded(
      doc?.included,
      "buildUploads",
      relId(b, "buildUpload"),
    );
    const linked = await getObject(
      c.db,
      c.product,
      ASC_CONNECTOR,
      "builds",
      b.id,
    );
    const encryption = b.attributes?.usesNonExemptEncryption;
    out.push({
      id: b.id,
      buildNumber: attr(b, "version"),
      version: attr(prv, "version"),
      platform: attr(prv, "platform"),
      processingState: attr(b, "processingState"),
      usesNonExemptEncryption:
        typeof encryption === "boolean" ? encryption : null,
      exportComplianceNeeded: typeof encryption !== "boolean",
      uploadedDate: attr(b, "uploadedDate"),
      expirationDate: attr(b, "expirationDate"),
      internalBuildState: attr(detail, "internalBuildState"),
      externalBuildState: attr(detail, "externalBuildState"),
      upload: uploadView(upload),
      releaseId: linked?.release_id ?? null,
    });
  }
  return { ok: true, appleId: setup.appleId, builds: out };
});

const betaGroups: ConnectorRead = distributeRead(async ({ run, setup }) => {
  const doc = await run.client.get(
    ascPath("apps", setup.appleId, "betaGroups"),
    {
      limit: "50",
    },
  );
  const data = Array.isArray(doc?.data) ? doc.data : [];
  return {
    ok: true,
    betaGroups: data.map((g) => ({
      id: g.id,
      name: attr(g, "name"),
      isInternalGroup: g.attributes?.isInternalGroup === true,
      hasAccessToAllBuilds: g.attributes?.hasAccessToAllBuilds === true,
      publicLinkEnabled: g.attributes?.publicLinkEnabled === true,
    })),
  };
});

/** Review submissions that are open or with Apple (the ones a console can follow or cancel). */
const LIVE_SUBMISSION_STATES = [
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
];

const versions: ConnectorRead = distributeRead(async ({ run, setup }, q) => {
  const platform = q.get("platform");
  if (platform !== null && !(PLATFORMS as readonly string[]).includes(platform))
    stop(
      422,
      "invalid_query",
      "platform must be IOS, MAC_OS, TV_OS or VISION_OS",
      ["platform"],
    );
  const doc = await run.client.get(
    ascPath("apps", setup.appleId, "appStoreVersions"),
    {
      limit: "10",
      include: "build,appStoreVersionPhasedRelease",
      ...(platform ? { "filter[platform]": platform } : {}),
    },
  );
  const data = Array.isArray(doc?.data) ? doc.data : [];
  const subs = await run.client.get(ascPath("reviewSubmissions"), {
    "filter[app]": setup.appleId,
    "filter[state]": LIVE_SUBMISSION_STATES.join(","),
    limit: "10",
  });
  const subData = Array.isArray(subs?.data) ? subs.data : [];
  return {
    ok: true,
    versions: data.map((v) => {
      const phasedId = relId(v, "appStoreVersionPhasedRelease");
      const phased = findIncluded(
        doc?.included,
        "appStoreVersionPhasedReleases",
        phasedId,
      );
      const state = versionState(v);
      return {
        id: v.id,
        platform: attr(v, "platform"),
        versionString: attr(v, "versionString"),
        state,
        appStoreState: attr(v, "appStoreState"),
        releaseType: attr(v, "releaseType"),
        earliestReleaseDate: attr(v, "earliestReleaseDate"),
        editable: state !== null && EDITABLE_VERSION_STATES.has(state),
        buildId: relId(v, "build"),
        phasedReleaseId: phasedId,
        phasedReleaseState: attr(phased, "phasedReleaseState"),
      };
    }),
    submissions: subData.map((s) => ({
      id: s.id,
      platform: attr(s, "platform"),
      state: attr(s, "state"),
      submittedDate: attr(s, "submittedDate"),
      cancelable: [
        "WAITING_FOR_REVIEW",
        "IN_REVIEW",
        "UNRESOLVED_ISSUES",
      ].includes(attr(s, "state") ?? ""),
    })),
  };
});

/** Age-rating keys that are overrides or optional detail, not questions to answer. */
const AGE_RATING_OPTIONAL = new Set([
  "ageRatingOverride",
  "ageRatingOverrideV2",
  "koreaAgeRatingOverride",
  "gracRatingClassificationNumber",
  "developerAgeRatingInfoUrl",
  "kidsAgeBand",
]);

const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** A review detail's contact as booleans only: the values (and the demo password) never leave. */
function contactComplete(d: AscResource | null): boolean {
  const a = d?.attributes ?? {};
  const contact =
    nonEmpty(a.contactFirstName) &&
    nonEmpty(a.contactLastName) &&
    nonEmpty(a.contactEmail) &&
    nonEmpty(a.contactPhone);
  const demo =
    a.demoAccountRequired === true ? nonEmpty(a.demoAccountName) : true;
  return contact && demo;
}

interface Check {
  id: string;
  /** `null`: not verifiable through the API (a portal step the operator confirms). */
  ok: boolean | null;
  detail?: string;
  missing?: string[];
}

/** Localizations whose screenshot sets the preflight reads (each is one request). */
const MAX_LOCALIZATIONS_CHECKED = 10;

const preflight: ConnectorRead = distributeRead(async (f, q) => {
  const { run, setup } = f;
  const versionId = q.get("versionId");
  if (!versionId || !ID.test(versionId))
    stop(422, "invalid_query", "versionId is required", ["versionId"]);
  const { resource: version, doc } = await proveVersionId(f, versionId, [
    "build",
    "appStoreReviewDetail",
    "appStoreVersionLocalizations",
  ]);
  const checks: Check[] = [];

  const buildId = relId(version, "build");
  const build = findIncluded(doc.included, "builds", buildId);
  checks.push({
    id: "build",
    ok: buildId !== null && attr(build, "processingState") === "VALID",
    detail: buildId
      ? `build ${buildId} is ${attr(build, "processingState") ?? "unknown"}`
      : "no build is attached to the version",
  });
  checks.push({
    id: "exportCompliance",
    ok: build
      ? typeof build.attributes?.usesNonExemptEncryption === "boolean"
      : false,
  });

  const locIds = (() => {
    const d = version.relationships?.appStoreVersionLocalizations?.data;
    return Array.isArray(d) ? d.map((x) => x.id) : [];
  })();
  const withoutShots: string[] = [];
  for (const locId of locIds.slice(0, MAX_LOCALIZATIONS_CHECKED)) {
    const loc = findIncluded(
      doc.included,
      "appStoreVersionLocalizations",
      locId,
    );
    const sets = await run.client.get(
      ascPath("appStoreVersionLocalizations", locId, "appScreenshotSets"),
      {
        limit: "1",
      },
    );
    if (!Array.isArray(sets?.data) || sets.data.length === 0)
      withoutShots.push(attr(loc, "locale") ?? locId);
  }
  checks.push({
    id: "screenshots",
    ok: locIds.length > 0 && withoutShots.length === 0,
    ...(locIds.length === 0
      ? { detail: "the version has no localizations" }
      : {}),
    ...(withoutShots.length ? { missing: withoutShots } : {}),
  });

  const infos = await run.client.get(
    ascPath("apps", setup.appleId, "appInfos"),
    {
      include: "ageRatingDeclaration",
      limit: "5",
    },
  );
  const infoList = Array.isArray(infos?.data) ? infos.data : [];
  // The app info being edited (a new version's), else the live one.
  const info =
    infoList.find((i) => attr(i, "state") !== "READY_FOR_DISTRIBUTION") ??
    infoList[0] ??
    null;
  const rating = findIncluded(
    infos?.included,
    "ageRatingDeclarations",
    relId(info, "ageRatingDeclaration"),
  );
  const unanswered = rating
    ? Object.entries(rating.attributes ?? {})
        .filter(
          ([k, v]) =>
            !AGE_RATING_OPTIONAL.has(k) && (v === null || v === undefined),
        )
        .map(([k]) => k)
    : [];
  checks.push({
    id: "ageRating",
    ok: rating !== null && unanswered.length === 0,
    ...(rating ? {} : { detail: "no age rating declaration" }),
    ...(unanswered.length ? { missing: unanswered } : {}),
  });

  const review = findIncluded(
    doc.included,
    "appStoreReviewDetails",
    relId(version, "appStoreReviewDetail"),
  );
  checks.push({
    id: "reviewContact",
    ok: review !== null && contactComplete(review),
    ...(review ? {} : { detail: "no App Review contact on the version" }),
  });

  const price = single(
    await run.client.getOrNull(
      ascPath("apps", setup.appleId, "appPriceSchedule"),
    ),
  );
  checks.push({ id: "price", ok: price !== null });
  const availability = single(
    await run.client.getOrNull(
      ascPath("apps", setup.appleId, "appAvailabilityV2"),
    ),
  );
  checks.push({ id: "availability", ok: availability !== null });

  const betaDetail = single(
    await run.client.getOrNull(
      ascPath("apps", setup.appleId, "betaAppReviewDetail"),
    ),
  );
  const betaLocs = await run.client.getOrNull(
    ascPath("apps", setup.appleId, "betaAppLocalizations"),
    {
      limit: "1",
    },
  );
  checks.push({
    id: "betaReviewDetails",
    ok: betaDetail !== null && contactComplete(betaDetail),
    detail: "needed for external TestFlight groups only",
  });
  checks.push({
    id: "betaLocalizations",
    ok: Array.isArray(betaLocs?.data) && betaLocs.data.length > 0,
    detail: "needed for external TestFlight groups only",
  });
  // A-17e: an app's first In-App Purchase is submitted in the portal, with an app version.
  const firstIap = await firstIapCheck(f);
  if (firstIap) checks.push(firstIap);
  checks.push({
    id: "appPrivacy",
    ok: null,
    detail: "portal-only: confirm App Privacy in App Store Connect",
  });

  const blocking = checks.filter(
    (k) => !k.id.startsWith("beta") && k.ok === false,
  );
  return {
    ok: true,
    versionId,
    state: versionState(version),
    ready: blocking.length === 0,
    checks,
  };
});

// ── Writes: builds and TestFlight ─────────────────────────────────────────────────────────────

const exportCompliance: ConnectorControl = distributeControl(
  async (f, body) => {
    const buildId = idField(body, "buildId");
    const value = body.usesNonExemptEncryption;
    if (typeof value !== "boolean")
      stop(422, "invalid_body", "usesNonExemptEncryption must be a boolean", [
        "usesNonExemptEncryption",
      ]);
    const { resource } = await proveBuild(f, buildId);
    const current = resource.attributes?.usesNonExemptEncryption;
    if (typeof current === "boolean" && current !== value)
      stop(
        409,
        "already_answered",
        `build ${buildId} already answers export compliance`,
      );
    const path = ascPath("builds", buildId);
    const r = await step(f, "build.export_compliance", buildId, {
      request: { buildId, usesNonExemptEncryption: value },
      find: async () => single(await f.run.client.get(path)),
      satisfied: (b) => b.attributes?.usesNonExemptEncryption === value,
      write: async () =>
        single(
          await f.run.client.patch(path, {
            data: {
              type: "builds",
              id: buildId,
              attributes: { usesNonExemptEncryption: value },
            },
          }),
        ),
      reread: async () => single(await f.run.client.get(path)),
      resultIds: () => ({ buildId }),
      summary: () =>
        `Answered export compliance for build ${buildId}: ${value ? "uses" : "does not use"} non-exempt encryption`,
    });
    return {
      ok: true,
      ...stepView(r),
      buildId,
      usesNonExemptEncryption: value,
    };
  },
);

const betaLocalization: ConnectorControl = distributeControl(
  async (f, body) => {
    const buildId = idField(body, "buildId");
    const locale = localeField(body);
    const whatsNew = textField(body, "whatsNew", WHATS_NEW_MAX);
    if (whatsNew === undefined)
      stop(422, "invalid_body", "whatsNew is required", ["whatsNew"]);
    await proveBuild(f, buildId);
    const find = async () => {
      const doc = await f.run.client.get(ascPath("betaBuildLocalizations"), {
        "filter[build]": buildId,
        "filter[locale]": locale,
        limit: "1",
      });
      return Array.isArray(doc?.data) ? (doc.data[0] ?? null) : null;
    };
    const r = await step(f, "testflight.whats_new", `${buildId}:${locale}`, {
      request: { buildId, locale, whatsNew },
      find,
      satisfied: (l) => attr(l, "whatsNew") === whatsNew,
      write: async (existing) =>
        single(
          existing
            ? await f.run.client.patch(
                ascPath("betaBuildLocalizations", existing.id),
                {
                  data: {
                    type: "betaBuildLocalizations",
                    id: existing.id,
                    attributes: { whatsNew },
                  },
                },
              )
            : await f.run.client.post(ascPath("betaBuildLocalizations"), {
                data: {
                  type: "betaBuildLocalizations",
                  attributes: { locale, whatsNew },
                  relationships: {
                    build: { data: { type: "builds", id: buildId } },
                  },
                },
              }),
        ),
      reread: async (id) =>
        single(await f.run.client.get(ascPath("betaBuildLocalizations", id))),
      resultIds: (l) => ({ betaBuildLocalizationId: l.id, buildId }),
      summary: () =>
        `Set TestFlight's What to Test (${locale}) for build ${buildId}`,
    });
    return { ok: true, ...stepView(r), buildId, locale, ...r.ids };
  },
);

const buildToGroups: ConnectorControl = distributeControl(async (f, body) => {
  const buildId = idField(body, "buildId");
  const raw = body.betaGroupIds;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_GROUPS ||
    !raw.every((g) => typeof g === "string" && ID.test(g)) ||
    new Set(raw).size !== raw.length
  )
    stop(
      422,
      "invalid_body",
      `betaGroupIds must list 1 to ${MAX_GROUPS} distinct group ids`,
      ["betaGroupIds"],
    );
  const groupIds = raw as string[];
  await proveValidBuild(f, buildId);
  // Every group first: a request naming another app's group sends nothing at all.
  const groups: AscResource[] = [];
  for (const g of groupIds)
    groups.push(
      (
        await proveOwned(
          f,
          "betaGroups",
          g,
          [],
          "unknown_beta_group",
          "beta group",
        )
      ).resource,
    );
  const results = [];
  for (const group of groups) {
    const inGroup = async () => {
      const doc = await f.run.client.get(ascPath("builds"), {
        "filter[app]": f.setup.appleId,
        "filter[betaGroups]": group.id,
        "filter[id]": buildId,
        limit: "1",
      });
      return Array.isArray(doc?.data)
        ? (doc.data.find((b) => b.id === buildId) ?? null)
        : null;
    };
    const r = await step(
      f,
      "testflight.build_to_group",
      `${group.id}:${buildId}`,
      {
        request: { buildId, betaGroupId: group.id },
        find: inGroup,
        write: async () => {
          await f.run.client.post(
            ascPath("betaGroups", group.id, "relationships", "builds"),
            {
              data: [{ type: "builds", id: buildId }],
            },
          );
          // A linkage answers 204: the build is what the step re-reads.
          return { type: "builds", id: buildId };
        },
        reread: () => inGroup(),
        resultIds: () => ({ betaGroupId: group.id, buildId }),
        summary: () =>
          `Added build ${buildId} to TestFlight group ${attr(group, "name") ?? group.id}`,
      },
    );
    const internal = group.attributes?.isInternalGroup === true;
    results.push({
      betaGroupId: group.id,
      name: attr(group, "name"),
      isInternalGroup: internal,
      // External testers see the build only after beta review (`testflight/beta-review`).
      needsBetaReview: !internal,
      ...stepView(r),
    });
  }
  return { ok: true, buildId, groups: results };
});

const betaReview: ConnectorControl = distributeControl(async (f, body) => {
  const buildId = idField(body, "buildId");
  await proveValidBuild(f, buildId);
  const find = async () => {
    const doc = await f.run.client.get(ascPath("betaAppReviewSubmissions"), {
      "filter[build]": buildId,
      limit: "1",
    });
    return Array.isArray(doc?.data) ? (doc.data[0] ?? null) : null;
  };
  const r = await step(f, "testflight.beta_review", buildId, {
    request: { buildId },
    find,
    write: async () =>
      single(
        await f.run.client.post(ascPath("betaAppReviewSubmissions"), {
          data: {
            type: "betaAppReviewSubmissions",
            relationships: { build: { data: { type: "builds", id: buildId } } },
          },
        }),
      ),
    reread: async (id) =>
      single(await f.run.client.get(ascPath("betaAppReviewSubmissions", id))),
    resultIds: (s) => ({ betaAppReviewSubmissionId: s.id, buildId }),
    summary: () => `Submitted build ${buildId} for TestFlight beta review`,
  });
  const after = r.ids.betaAppReviewSubmissionId
    ? single(
        await f.run.client.getOrNull(
          ascPath("betaAppReviewSubmissions", r.ids.betaAppReviewSubmissionId),
        ),
      )
    : null;
  return {
    ok: true,
    ...stepView(r),
    buildId,
    betaAppReviewSubmissionId: r.ids.betaAppReviewSubmissionId ?? null,
    betaReviewState: attr(after, "betaReviewState"),
  };
});

// ── Writes: the App Store version ────────────────────────────────────────────────────────────

const createVersion: ConnectorControl = distributeControl(async (f, body) => {
  const platform = body.platform;
  if (
    typeof platform !== "string" ||
    !(PLATFORMS as readonly string[]).includes(platform)
  )
    stop(
      422,
      "invalid_body",
      "platform must be IOS, MAC_OS, TV_OS or VISION_OS",
      ["platform"],
    );
  const versionString = body.versionString;
  if (typeof versionString !== "string" || !VERSION_STRING.test(versionString))
    stop(422, "invalid_body", "versionString must be a version such as 1.2.0", [
      "versionString",
    ]);
  const find = async () => {
    const doc = await f.run.client.get(
      ascPath("apps", f.setup.appleId, "appStoreVersions"),
      {
        "filter[platform]": platform,
        "filter[versionString]": versionString,
        limit: "1",
      },
    );
    const hit = Array.isArray(doc?.data)
      ? (doc.data.find(
          (v) =>
            attr(v, "versionString") === versionString &&
            attr(v, "platform") === platform,
        ) ?? null)
      : null;
    // Reuse only a version that can still change: a shipped one is never edited.
    const state = versionState(hit);
    if (hit && (!state || !EDITABLE_VERSION_STATES.has(state)))
      stop(
        409,
        "version_not_editable",
        `version ${versionString} (${platform}) already exists and is ${state ?? "in an unknown state"}`,
      );
    return hit;
  };
  const r = await step(f, "version.create", `${platform}:${versionString}`, {
    request: { platform, versionString },
    find,
    write: async () =>
      single(
        await f.run.client.post(ascPath("appStoreVersions"), {
          data: {
            type: "appStoreVersions",
            attributes: { platform, versionString },
            // The pinned app, never the request's.
            relationships: {
              app: { data: { type: "apps", id: f.setup.appleId } },
            },
          },
        }),
      ),
    reread: async (id) =>
      single(await f.run.client.get(ascPath("appStoreVersions", id))),
    resultIds: (v) => ({ versionId: v.id }),
    summary: (v, outcome) =>
      `${outcome === "written" ? "Created" : "Reused"} App Store version ${versionString} (${platform}) ${v.id}`,
  });
  return {
    ok: true,
    ...stepView(r),
    versionId: r.ids.versionId ?? null,
    platform,
    versionString,
  };
});

const versionBuild: ConnectorControl = distributeControl(async (f, body) => {
  const versionId = idField(body, "versionId");
  const buildId = idField(body, "buildId");
  await proveVersionId(f, versionId, [], EDITABLE_VERSION_STATES);
  await proveValidBuild(f, buildId);
  const read = async () =>
    single(
      await f.run.client.get(ascPath("appStoreVersions", versionId), {
        include: "build",
      }),
    );
  const r = await step(f, "version.build", `${versionId}:${buildId}`, {
    request: { versionId, buildId },
    find: read,
    satisfied: (v) => relId(v, "build") === buildId,
    write: async () => {
      await f.run.client.patch(
        ascPath("appStoreVersions", versionId, "relationships", "build"),
        {
          data: { type: "builds", id: buildId },
        },
      );
      return { type: "appStoreVersions", id: versionId };
    },
    reread: () => read(),
    resultIds: () => ({ versionId, buildId }),
    summary: () =>
      `Attached build ${buildId} to App Store version ${versionId}`,
  });
  return { ok: true, ...stepView(r), versionId, buildId };
});

const releaseType: ConnectorControl = distributeControl(async (f, body) => {
  const versionId = idField(body, "versionId");
  const type = body.releaseType;
  if (
    typeof type !== "string" ||
    !(RELEASE_TYPES as readonly string[]).includes(type)
  )
    stop(
      422,
      "invalid_body",
      "releaseType must be MANUAL, AFTER_APPROVAL or SCHEDULED",
      ["releaseType"],
    );
  let date: string | undefined;
  if (type === "SCHEDULED") {
    const raw = body.earliestReleaseDate;
    const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ms) || ms <= f.c.now * 1000)
      stop(
        422,
        "invalid_body",
        "a scheduled release needs a future earliestReleaseDate",
        ["earliestReleaseDate"],
      );
    // Apple schedules on the hour.
    date = new Date(Math.ceil(ms / 3_600_000) * 3_600_000).toISOString();
  } else if (body.earliestReleaseDate !== undefined) {
    stop(
      422,
      "invalid_body",
      "earliestReleaseDate is for a SCHEDULED release only",
      ["earliestReleaseDate"],
    );
  }
  await proveVersionId(f, versionId, [], SUBMITTABLE_VERSION_STATES);
  const path = ascPath("appStoreVersions", versionId);
  const r = await step(f, "version.release_type", versionId, {
    request: {
      versionId,
      releaseType: type,
      earliestReleaseDate: date ?? null,
    },
    find: async () => single(await f.run.client.get(path)),
    satisfied: (v) => {
      if (attr(v, "releaseType") !== type) return false;
      if (!date) return true;
      const current = attr(v, "earliestReleaseDate");
      return current !== null && Date.parse(current) === Date.parse(date);
    },
    // The gate types a release type that auto-releases a version in or after review (A-18a); it
    // is told the state of the pre-read this step just made (always a submittable one here).
    write: async (existing) => {
      const state = versionState(existing);
      return single(
        await f.run.client.patch(
          path,
          {
            data: {
              type: "appStoreVersions",
              id: versionId,
              attributes: {
                releaseType: type,
                ...(date ? { earliestReleaseDate: date } : {}),
              },
            },
          },
          state ? { resourceState: state } : {},
        ),
      );
    },
    reread: async () => single(await f.run.client.get(path)),
    resultIds: () => ({ versionId }),
    summary: () =>
      `Set the release of App Store version ${versionId} to ${type}${date ? ` (${date})` : ""}`,
  });
  return {
    ok: true,
    ...stepView(r),
    versionId,
    releaseType: type,
    earliestReleaseDate: date ?? null,
  };
});

const phasedRelease: ConnectorControl = distributeControl(async (f, body) => {
  const versionId = idField(body, "versionId");
  await proveVersionId(f, versionId, [], PHASED_VERSION_STATES);
  const find = async () =>
    single(
      await f.run.client.getOrNull(
        ascPath("appStoreVersions", versionId, "appStoreVersionPhasedRelease"),
      ),
    );
  const r = await step(f, "version.phased_release", versionId, {
    request: { versionId },
    find,
    write: async () =>
      single(
        await f.run.client.post(ascPath("appStoreVersionPhasedReleases"), {
          data: {
            type: "appStoreVersionPhasedReleases",
            // INACTIVE until the version is released; P5-02's controls manage it afterwards.
            attributes: { phasedReleaseState: "INACTIVE" },
            relationships: {
              appStoreVersion: {
                data: { type: "appStoreVersions", id: versionId },
              },
            },
          },
        }),
      ),
    reread: async (id) =>
      single(
        await f.run.client.get(ascPath("appStoreVersionPhasedReleases", id)),
      ),
    resultIds: (p) => ({ phasedReleaseId: p.id, versionId }),
    summary: () => `Chose a phased release for App Store version ${versionId}`,
  });
  return {
    ok: true,
    ...stepView(r),
    versionId,
    phasedReleaseId: r.ids.phasedReleaseId ?? null,
  };
});

const versionLocalization: ConnectorControl = distributeControl(
  async (f, body) => {
    const versionId = idField(body, "versionId");
    const locale = localeField(body);
    const whatsNew = textField(body, "whatsNew", WHATS_NEW_MAX);
    const promotionalText = textField(body, "promotionalText", PROMO_MAX);
    if (whatsNew === undefined && promotionalText === undefined)
      stop(422, "invalid_body", "whatsNew or promotionalText is required", [
        "whatsNew",
        "promotionalText",
      ]);
    await proveVersionId(f, versionId, [], SUBMITTABLE_VERSION_STATES);
    const attributes = {
      ...(whatsNew !== undefined ? { whatsNew } : {}),
      ...(promotionalText !== undefined ? { promotionalText } : {}),
    };
    const find = async () => {
      const doc = await f.run.client.get(
        ascPath("appStoreVersions", versionId, "appStoreVersionLocalizations"),
        { "filter[locale]": locale, limit: "1" },
      );
      return Array.isArray(doc?.data)
        ? (doc.data.find((l) => attr(l, "locale") === locale) ?? null)
        : null;
    };
    const r = await step(f, "version.whats_new", `${versionId}:${locale}`, {
      request: { versionId, locale, ...attributes },
      find,
      satisfied: (l) =>
        Object.entries(attributes).every(([k, v]) => attr(l, k) === v),
      write: async (existing) =>
        single(
          existing
            ? await f.run.client.patch(
                ascPath("appStoreVersionLocalizations", existing.id),
                {
                  data: {
                    type: "appStoreVersionLocalizations",
                    id: existing.id,
                    attributes,
                  },
                },
              )
            : await f.run.client.post(ascPath("appStoreVersionLocalizations"), {
                data: {
                  type: "appStoreVersionLocalizations",
                  attributes: { locale, ...attributes },
                  relationships: {
                    appStoreVersion: {
                      data: { type: "appStoreVersions", id: versionId },
                    },
                  },
                },
              }),
        ),
      reread: async (id) =>
        single(
          await f.run.client.get(ascPath("appStoreVersionLocalizations", id)),
        ),
      resultIds: (l) => ({ localizationId: l.id, versionId }),
      summary: () =>
        `Set the release notes (${locale}) of App Store version ${versionId}`,
    });
    return { ok: true, ...stepView(r), versionId, locale, ...r.ids };
  },
);

// ── Writes: review submission ────────────────────────────────────────────────────────────────

/** A submission still being assembled (Apple keeps one open per platform). */
const OPEN_SUBMISSION_STATES = ["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"];
/** A submission Apple has: submitting again is "already done". */
const SUBMITTED_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);
const CANCELABLE_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
]);

/** The open review submission for `platform`, or a new one: one ledger step. */
async function openSubmission(
  f: Flow,
  platform: string,
): Promise<{ id: string; step: StepResult }> {
  const find = async () => {
    const doc = await f.run.client.get(ascPath("reviewSubmissions"), {
      "filter[app]": f.setup.appleId,
      "filter[platform]": platform,
      "filter[state]": OPEN_SUBMISSION_STATES.join(","),
      include: "app",
      limit: "5",
    });
    const data = Array.isArray(doc?.data) ? doc.data : [];
    return (
      data.find(
        (s) =>
          relId(s, "app") === f.setup.appleId &&
          attr(s, "platform") === platform &&
          OPEN_SUBMISSION_STATES.includes(attr(s, "state") ?? ""),
      ) ?? null
    );
  };
  const r = await step(f, "review_submission.open", platform, {
    request: { platform },
    find,
    write: async () =>
      single(
        await f.run.client.post(ascPath("reviewSubmissions"), {
          data: {
            type: "reviewSubmissions",
            attributes: { platform },
            relationships: {
              app: { data: { type: "apps", id: f.setup.appleId } },
            },
          },
        }),
      ),
    reread: async (id) =>
      single(await f.run.client.get(ascPath("reviewSubmissions", id))),
    resultIds: (s) => ({ submissionId: s.id }),
    summary: (s, outcome) =>
      `${outcome === "written" ? "Opened" : "Reused"} review submission ${s.id} (${platform})`,
  });
  const id = r.ids.submissionId;
  if (!id)
    stop(502, "store_refused", "App Store Connect opened no review submission");
  return { id, step: r };
}

/**
 * Add one item to a review submission (one ledger step). `relationship` is the item's kind on
 * `reviewSubmissionItems` (`appStoreVersion`; A-17e adds `inAppPurchaseVersion` and
 * `backgroundAssetVersion`, each allowed by the write gate) and `id` an object the caller has
 * already proven to be the pinned app's.
 */
export async function addSubmissionItem(
  f: Flow,
  submissionId: string,
  relationship:
    | "appStoreVersion"
    | "inAppPurchaseVersion"
    | "backgroundAssetVersion",
  type:
    | "appStoreVersions"
    | "inAppPurchaseVersions"
    | "backgroundAssetVersions",
  id: string,
): Promise<StepResult> {
  const find = async () => {
    const doc = await f.run.client.get(
      ascPath("reviewSubmissions", submissionId, "items"),
      {
        include: relationship,
        limit: "50",
      },
    );
    const data = Array.isArray(doc?.data) ? doc.data : [];
    return data.find((i) => relId(i, relationship) === id) ?? null;
  };
  return step(f, "review_submission.item", `${submissionId}:${type}:${id}`, {
    request: { submissionId, type, id },
    find,
    write: async () =>
      single(
        await f.run.client.post(ascPath("reviewSubmissionItems"), {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: {
                data: { type: "reviewSubmissions", id: submissionId },
              },
              [relationship]: { data: { type, id } },
            },
          },
        }),
      ),
    reread: async (itemId) =>
      single(
        await f.run.client.getOrNull(ascPath("reviewSubmissionItems", itemId)),
      ),
    resultIds: (i) => ({ itemId: i.id, submissionId }),
    summary: () => `Added ${type} ${id} to review submission ${submissionId}`,
  });
}

const submit: ConnectorControl = distributeControl(async (f, body) => {
  const versionId = idField(body, "versionId");
  // A-17e: IAP and Background Asset versions that ride the same submission (optional).
  const extras = submissionExtras(body);
  if (typeof body.confirm !== "string" || body.confirm.trim() === "")
    stop(
      422,
      "confirmation_required",
      "type the app's name in confirm to submit for review",
      ["confirm"],
    );
  const { resource: version } = await proveVersionId(
    f,
    versionId,
    ["build"],
    SUBMITTABLE_VERSION_STATES,
  );
  if (!relId(version, "build"))
    stop(
      409,
      "no_build",
      `attach a build to App Store version ${versionId} first`,
    );
  const platform = attr(version, "platform");
  if (!platform || !(PLATFORMS as readonly string[]).includes(platform))
    stop(
      409,
      "store_refused",
      `App Store version ${versionId} has no known platform`,
    );
  // Typed: compared with Apple's own app name now, then asserted to the write gate.
  const unconfirmed = await checkTypedConfirmation(
    f.run,
    f.setup,
    body.confirm,
    "submit for review",
  );
  if (unconfirmed) return unconfirmed;
  // Every extra item is proven the pinned app's (and ready) before the submission is touched.
  await proveSubmissionExtras(f, platform, extras);

  const open = await openSubmission(f, platform);
  const item = await addSubmissionItem(
    f,
    open.id,
    "appStoreVersion",
    "appStoreVersions",
    versionId,
  );
  const items = [];
  for (const id of extras.inAppPurchaseVersionIds)
    items.push({
      inAppPurchaseVersionId: id,
      ...stepView(
        await addSubmissionItem(
          f,
          open.id,
          "inAppPurchaseVersion",
          "inAppPurchaseVersions",
          id,
        ),
      ),
    });
  for (const id of extras.backgroundAssetVersionIds)
    items.push({
      backgroundAssetVersionId: id,
      ...stepView(
        await addSubmissionItem(
          f,
          open.id,
          "backgroundAssetVersion",
          "backgroundAssetVersions",
          id,
        ),
      ),
    });
  const path = ascPath("reviewSubmissions", open.id);
  const read = async () =>
    single(await f.run.client.get(path, { include: "app" }));
  const sent = await step(f, "review_submission.submit", open.id, {
    request: { submissionId: open.id, versionId, ...extras },
    find: read,
    satisfied: (s) => SUBMITTED_STATES.has(attr(s, "state") ?? ""),
    write: async () =>
      single(
        await f.run.client.patch(
          path,
          {
            data: {
              type: "reviewSubmissions",
              id: open.id,
              attributes: { submitted: true },
            },
          },
          { typedConfirmation: true },
        ),
      ),
    reread: () => read(),
    resultIds: () => ({ submissionId: open.id, versionId }),
    summary: () =>
      `Submitted App Store version ${versionId} for App Review (submission ${open.id})`,
  });
  const after = single(await f.run.client.get(path));
  // The version's own state follows (P5-02's poller and webhook keep it from here).
  await syncAppStoreVersion(f.run, versionId).catch(() => undefined);
  return {
    ok: true,
    versionId,
    submissionId: open.id,
    state: attr(after, "state"),
    steps: {
      open: stepView(open.step),
      item: stepView(item),
      items,
      submit: stepView(sent),
    },
  };
});

const cancelSubmission: ConnectorControl = distributeControl(
  async (f, body) => {
    const submissionId = idField(body, "submissionId");
    const { resource } = await proveOwned(
      f,
      "reviewSubmissions",
      submissionId,
      [],
      "unknown_submission",
      "review submission",
    );
    const state = attr(resource, "state");
    if (state !== "CANCELING" && !CANCELABLE_STATES.has(state ?? ""))
      stop(
        409,
        "not_cancelable",
        `review submission ${submissionId} is ${state ?? "in an unknown state"}`,
      );
    const path = ascPath("reviewSubmissions", submissionId);
    const r = await step(f, "review_submission.cancel", submissionId, {
      request: { submissionId },
      find: async () => single(await f.run.client.get(path)),
      satisfied: (s) =>
        attr(s, "state") === "CANCELING" || attr(s, "state") === "COMPLETE",
      write: async () =>
        single(
          await f.run.client.patch(path, {
            data: {
              type: "reviewSubmissions",
              id: submissionId,
              attributes: { canceled: true },
            },
          }),
        ),
      reread: async () => single(await f.run.client.get(path)),
      resultIds: () => ({ submissionId }),
      summary: () => `Cancelled review submission ${submissionId}`,
    });
    const after = single(await f.run.client.get(path));
    return {
      ok: true,
      ...stepView(r),
      submissionId,
      state: attr(after, "state"),
    };
  },
);

// ── Tables ───────────────────────────────────────────────────────────────────────────────────

/** The Distribute writes: path under `…/connectors/asc/` → implementation. */
export const ASC_DISTRIBUTE_CONTROLS: Readonly<
  Record<string, ConnectorControl>
> = {
  "distribute/export-compliance": exportCompliance,
  "distribute/beta-localization": betaLocalization,
  "distribute/testflight/groups": buildToGroups,
  "distribute/testflight/beta-review": betaReview,
  "distribute/version": createVersion,
  "distribute/version/build": versionBuild,
  "distribute/version/release-type": releaseType,
  "distribute/version/phased-release": phasedRelease,
  "distribute/version-localization": versionLocalization,
  "distribute/submit": submit,
  "distribute/submission/cancel": cancelSubmission,
};

/** The Distribute reads: path under `GET …/connectors/asc/` → implementation. */
export const ASC_DISTRIBUTE_READS: Readonly<Record<string, ConnectorRead>> = {
  "distribute/builds": builds,
  "distribute/beta-groups": betaGroups,
  "distribute/versions": versions,
  "distribute/preflight": preflight,
};

/** For A-17e's IAP and Background Asset submission items (`addSubmissionItem`). */
export type { Flow as DistributeFlow };
