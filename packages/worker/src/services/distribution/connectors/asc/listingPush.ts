/**
 * The Apple listing push (A-18m; notes/S-15 §7.5, owner decisions 1 and 2 of 2026-10-04): the
 * shared listing model (A-18b) and its screenshots (A-18d) reach App Store Connect, with a plain
 * confirmation, under `…/distribution/connectors/asc/listing/…`. These are the Apple adapter's
 * `writeListingText` and `writeListingAssets`.
 *
 *   POST listing/text         { versionId, locale }
 *        The model's Apple projection in `locale` (`projection.ts`: keywords packed under 100
 *        bytes and comma-joined; any value over a limit refuses the push, never cut) into the
 *        version's localization (description, keywords, marketing and support URLs, promotional
 *        text) and the editable app info's localization (name, subtitle, privacy policy URL). One
 *        ledger step per localization; natural key: the existing localization in that locale.
 *        What's New stays A-17d's (`distribute/version-localization`): it is a release's, not the
 *        listing's.
 *   POST listing/screenshots  { versionId, locale, sizeClass }
 *        The stored `app-store:screenshot:<sizeClass>:<n>` assets of that locale (else of every
 *        locale), in order, into the localization's set of the class's display type: the set is
 *        found or created, then each screenshot is reserved, its bytes PUT from the blob store to
 *        Apple's upload operations (`core/asc/upload.ts`, gated by `checkAscUpload`) and
 *        committed with its MD5. Natural key: a screenshot of the same checksum (or file name,
 *        which carries the SHA-256) already in the set.
 *
 * NEVER A DELETE. A screenshot already in the set that the listing does not have is left there:
 * the answer counts them and gives the version's App Store Connect page to remove or reorder them
 * by hand, as Play's push does (S-15 §8.4). The set's membership `PATCH` is denied by the gate.
 *
 * The write discipline is A-17d's (`flow.ts`): the pinned app only (the version is re-read with
 * `include=app`; the app info is listed under the pinned app), the console's `Idempotency-Key`,
 * one ledger row and one `distribution.asc.listing.*` audit row per write, every check before the
 * first write.
 */

import { createHash } from "node:crypto";
import {
  ascPath,
  attr,
  single,
  type AscResource,
} from "../../../../core/asc/client.js";
import {
  putUploadOperations,
  uploadOperations,
} from "../../../../core/asc/upload.js";
import {
  ASC_SCREENSHOT_DISPLAY_TYPES,
  ASC_SCREENSHOT_MAX_BYTES,
  ASC_SCREENSHOT_UPLOAD,
  ASC_SCREENSHOTS_PER_SET,
} from "../../../../core/storefront/rules/appStore.js";
import { matchUpload } from "../../../../core/storefront/match/multipart.js";
import { renderDeepLink } from "../../../../core/storefront/deeplinks.js";
import {
  projectListing,
  type ProjectionIssue,
} from "../../../../core/storefront/projection.js";
import type { ListingModel } from "../../../../core/storefront/listingModel.js";
import { listAssets, readListing } from "../../listing/store.js";
import type { ConnectorControl } from "./controls.js";
import { SUBMITTABLE_VERSION_STATES, proveVersionId } from "./distribute.js";
import {
  distributeControl,
  idField,
  localeField,
  step,
  stepView,
  stop,
  type Flow,
  type StepResult,
} from "./flow.js";

// ── Text ─────────────────────────────────────────────────────────────────────────────────────

/** Apple's column fields, by the localization they live on. */
const VERSION_FIELDS = [
  "description",
  "keywords",
  "marketingUrl",
  "supportUrl",
  "promotionalText",
] as const;
const APP_INFO_FIELDS = ["name", "subtitle", "privacyPolicyUrl"] as const;

/** App info states whose localizations can still change (the version being prepared). */
const EDITABLE_APP_INFO_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "WAITING_FOR_REVIEW",
  "READY_FOR_REVIEW",
]);

/** The model projected for Apple in one locale only (the other locales do not block it). */
function projectLocale(model: ListingModel, locale: string) {
  return projectListing(
    {
      model: {
        ...model,
        app: { ...model.app, defaultLocale: locale },
        locales: { [locale]: model.locales[locale] ?? {} },
      },
      releaseNotes: null,
    },
    "app-store",
  );
}

const issueView = (i: ProjectionIssue) => ({
  field: i.field,
  locale: i.locale,
  issue: i.issue,
  limit: i.limit,
  actual: i.actual,
  unit: i.unit,
});

function pick(
  values: Readonly<Record<string, string | string[]>>,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = values[k];
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(",") : v;
  }
  return out;
}

/** The app info whose localizations can change, listed under the pinned app; or null. */
async function editableAppInfo(f: Flow): Promise<AscResource | null> {
  const doc = await f.run.client.get(
    ascPath("apps", f.setup.appleId, "appInfos"),
    { limit: "10" },
  );
  const infos = Array.isArray(doc?.data) ? doc.data : [];
  return (
    infos.find((i) =>
      EDITABLE_APP_INFO_STATES.has(
        attr(i, "state") ?? attr(i, "appStoreState") ?? "",
      ),
    ) ?? null
  );
}

/** One localization's step: find it in `locale`, PATCH it or POST it. */
function localizationStep(
  f: Flow,
  o: {
    op: string;
    parentType: "appStoreVersions" | "appInfos";
    parentId: string;
    childType: "appStoreVersionLocalizations" | "appInfoLocalizations";
    relationship: "appStoreVersion" | "appInfo";
    locale: string;
    attributes: Record<string, string>;
    noun: string;
  },
): Promise<StepResult> {
  const find = async () => {
    const doc = await f.run.client.get(
      ascPath(o.parentType, o.parentId, o.childType),
      { "filter[locale]": o.locale, limit: "1" },
    );
    return Array.isArray(doc?.data)
      ? (doc.data.find((l) => attr(l, "locale") === o.locale) ?? null)
      : null;
  };
  return step(f, o.op, `${o.parentId}:${o.locale}`, {
    request: { parent: o.parentId, locale: o.locale, ...o.attributes },
    find,
    satisfied: (l) =>
      Object.entries(o.attributes).every(([k, v]) => attr(l, k) === v),
    write: async (existing) =>
      single(
        existing
          ? await f.run.client.patch(ascPath(o.childType, existing.id), {
              data: {
                type: o.childType,
                id: existing.id,
                attributes: o.attributes,
              },
            })
          : await f.run.client.post(ascPath(o.childType), {
              data: {
                type: o.childType,
                attributes: { locale: o.locale, ...o.attributes },
                relationships: {
                  [o.relationship]: {
                    data: { type: o.parentType, id: o.parentId },
                  },
                },
              },
            }),
      ),
    reread: async (id) =>
      single(await f.run.client.get(ascPath(o.childType, id))),
    resultIds: (l) => ({
      localizationId: l.id,
      [`${o.relationship}Id`]: o.parentId,
    }),
    summary: () =>
      `Pushed the listing's ${o.noun} (${o.locale}) to App Store Connect`,
  });
}

const listingText: ConnectorControl = distributeControl(async (f, body) => {
  const versionId = idField(body, "versionId");
  const locale = localeField(body);
  const stored = await readListing(f.c.db, f.c.product);
  if (!stored)
    stop(409, "no_listing", "this product has no listing to push yet");
  const projection = projectLocale(stored.model, locale);
  const blocking = projection.issues.filter((i) => i.severity === "block");
  if (blocking.length || !projection.payload) {
    // Refused with the limit and the length: never cut (conformance item 7).
    stop(
      422,
      "listing_does_not_fit",
      `the listing does not fit App Store Connect in ${locale}: ${blocking
        .map((i) => `${i.field} ${i.issue.replace("_", " ")}`)
        .join(", ")}. Edit it in the listing`,
      [...new Set(blocking.map((i) => i.field))],
    );
  }
  const values = projection.payload.locales[locale] ?? {};
  const versionAttrs = pick(values, VERSION_FIELDS);
  const appInfoAttrs = pick(values, APP_INFO_FIELDS);
  if (!Object.keys(versionAttrs).length && !Object.keys(appInfoAttrs).length)
    stop(422, "nothing_to_push", `the listing has no text in ${locale}`);

  // Every check before the first write.
  await proveVersionId(f, versionId, [], SUBMITTABLE_VERSION_STATES);
  let appInfo: AscResource | null = null;
  if (Object.keys(appInfoAttrs).length) {
    appInfo = await editableAppInfo(f);
    if (!appInfo)
      stop(
        409,
        "app_info_not_editable",
        "App Store Connect has no editable app information for this app; the name, subtitle and privacy policy URL change with a version being prepared",
      );
  }

  const version = Object.keys(versionAttrs).length
    ? await localizationStep(f, {
        op: "listing.version_text",
        parentType: "appStoreVersions",
        parentId: versionId,
        childType: "appStoreVersionLocalizations",
        relationship: "appStoreVersion",
        locale,
        attributes: versionAttrs,
        noun: "description, keywords and URLs",
      })
    : null;
  const info = appInfo
    ? await localizationStep(f, {
        op: "listing.app_info_text",
        parentType: "appInfos",
        parentId: appInfo.id,
        childType: "appInfoLocalizations",
        relationship: "appInfo",
        locale,
        attributes: appInfoAttrs,
        noun: "name, subtitle and privacy policy URL",
      })
    : null;
  return {
    ok: true,
    versionId,
    locale,
    version: version
      ? {
          ...stepView(version),
          localizationId: version.ids.localizationId ?? null,
          fields: Object.keys(versionAttrs),
        }
      : null,
    appInfo: info
      ? {
          ...stepView(info),
          appInfoId: appInfo!.id,
          localizationId: info.ids.localizationId ?? null,
          fields: Object.keys(appInfoAttrs),
        }
      : null,
    // Amber only (keywords left out by packing): shown, never blocking.
    warnings: projection.issues.map(issueView),
  };
});

// ── Screenshots ──────────────────────────────────────────────────────────────────────────────

type SizeClass = keyof typeof ASC_SCREENSHOT_DISPLAY_TYPES;
const SIZE_CLASSES = Object.keys(ASC_SCREENSHOT_DISPLAY_TYPES) as SizeClass[];

/** Screenshot states that hold the bytes: nothing more to send. */
const UPLOADED_STATES = new Set(["UPLOAD_COMPLETE", "COMPLETE"]);

interface Shot {
  slot: string;
  n: number;
  sha256: string;
  blob: string;
  size: number;
  contentType: "image/png" | "image/jpeg";
  md5: string;
  fileName: string;
}

const deliveryState = (r: AscResource | null): string | null => {
  const s = r?.attributes?.assetDeliveryState;
  return s &&
    typeof s === "object" &&
    typeof (s as { state?: unknown }).state === "string"
    ? (s as { state: string }).state
    : null;
};

/** The image type from the file's first bytes (the blob store keeps no content type). */
function sniff(head: Uint8Array): Shot["contentType"] | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => head[i] === b)) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return "image/jpeg";
  return null;
}

async function md5Of(body: ReadableStream<Uint8Array>): Promise<string> {
  const h = createHash("md5");
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      h.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return h.digest("hex");
}

/** The stored screenshots of `sizeClass` for `locale` (else for every locale), in order. */
async function storedShots(
  f: Flow,
  bucket: R2Bucket,
  locale: string,
  sizeClass: SizeClass,
): Promise<Shot[]> {
  const re = new RegExp(`^app-store:screenshot:${sizeClass}:([1-9][0-9]?)$`);
  const rows = (await listAssets(f.c.db, f.c.product)).filter((a) =>
    re.test(a.slot),
  );
  const mine = rows.filter((a) => a.locale === locale);
  const chosen = (mine.length ? mine : rows.filter((a) => a.locale === ""))
    .map((a) => ({ row: a, n: Number(re.exec(a.slot)![1]) }))
    .sort((x, y) => x.n - y.n);
  if (!chosen.length)
    stop(
      409,
      "no_screenshots",
      `the listing has no ${sizeClass} screenshots for the App Store; run pkey listing assets or add them in the listing`,
    );
  if (chosen.length > ASC_SCREENSHOTS_PER_SET)
    stop(
      422,
      "too_many_screenshots",
      `App Store Connect keeps ${ASC_SCREENSHOTS_PER_SET} screenshots per set; the listing has ${chosen.length} ${sizeClass} screenshots`,
    );
  const shots: Shot[] = [];
  for (const { row, n } of chosen) {
    if (row.alpha)
      stop(
        422,
        "screenshot_has_alpha",
        `${row.slot} has an alpha channel, which App Store Connect refuses`,
      );
    const head = await bucket.head(row.blob);
    if (!head)
      stop(409, "screenshot_missing", `${row.slot} is not in the blob store`);
    const first = await bucket.get(row.blob, {
      range: { offset: 0, length: Math.min(8, head.size) },
    });
    const contentType = first
      ? sniff(new Uint8Array(await first.arrayBuffer()))
      : null;
    if (!contentType)
      stop(
        422,
        "screenshot_not_an_image",
        `${row.slot} is not a PNG or JPEG image`,
      );
    // The upload rule's own check, before anything is sent (each operation's URL is checked again
    // with it by `putUploadOperations`).
    if (
      matchUpload(
        ASC_SCREENSHOT_UPLOAD,
        ASC_SCREENSHOT_UPLOAD.path,
        { contentType, size: head.size },
        {},
      )
    )
      stop(
        422,
        "screenshot_too_large",
        `${row.slot} is ${head.size} bytes; the Worker uploads screenshots of at most ${ASC_SCREENSHOT_MAX_BYTES}`,
      );
    const whole = await bucket.get(row.blob);
    if (!whole)
      stop(409, "screenshot_missing", `${row.slot} is not in the blob store`);
    shots.push({
      slot: row.slot,
      n,
      sha256: row.sha256,
      blob: row.blob,
      size: head.size,
      contentType,
      md5: await md5Of(whole.body),
      // The file name carries the SHA-256, so it is a natural key of its own.
      fileName: `${row.sha256.slice(0, 40)}.${contentType === "image/png" ? "png" : "jpg"}`,
    });
  }
  return shots;
}

async function setScreenshots(f: Flow, setId: string): Promise<AscResource[]> {
  const doc = await f.run.client.get(
    ascPath("appScreenshotSets", setId, "appScreenshots"),
    { limit: "50" },
  );
  return Array.isArray(doc?.data) ? doc.data : [];
}

const isShot = (r: AscResource, s: Shot) =>
  attr(r, "sourceFileChecksum") === s.md5 || attr(r, "fileName") === s.fileName;

const listingScreenshots: ConnectorControl = distributeControl(
  async (f, body) => {
    const versionId = idField(body, "versionId");
    const locale = localeField(body);
    const sizeClass = body.sizeClass;
    if (
      typeof sizeClass !== "string" ||
      !SIZE_CLASSES.includes(sizeClass as SizeClass)
    )
      stop(
        422,
        "invalid_body",
        `sizeClass must be one of ${SIZE_CLASSES.join(", ")}`,
        ["sizeClass"],
      );
    const cls = sizeClass as SizeClass;
    const displayType = ASC_SCREENSHOT_DISPLAY_TYPES[cls];
    const bucket = f.c.env.BLOBS;
    if (!bucket) stop(409, "no_blob_store", "no blob store here");

    // Every check before the first write: the screenshots, the version, its localization.
    const shots = await storedShots(f, bucket, locale, cls);
    await proveVersionId(f, versionId, [], SUBMITTABLE_VERSION_STATES);
    const locDoc = await f.run.client.get(
      ascPath("appStoreVersions", versionId, "appStoreVersionLocalizations"),
      { "filter[locale]": locale, limit: "1" },
    );
    const localization = Array.isArray(locDoc?.data)
      ? (locDoc.data.find((l) => attr(l, "locale") === locale) ?? null)
      : null;
    if (!localization)
      stop(
        409,
        "localization_missing",
        `the version has no ${locale} localization yet; push the listing text for ${locale} first`,
      );

    const findSet = async () => {
      const doc = await f.run.client.get(
        ascPath(
          "appStoreVersionLocalizations",
          localization.id,
          "appScreenshotSets",
        ),
        { "filter[screenshotDisplayType]": displayType, limit: "1" },
      );
      return Array.isArray(doc?.data)
        ? (doc.data.find(
            (s) => attr(s, "screenshotDisplayType") === displayType,
          ) ?? null)
        : null;
    };
    const set = await step(
      f,
      "listing.screenshot_set",
      `${localization.id}:${displayType}`,
      {
        request: { localizationId: localization.id, displayType },
        find: findSet,
        write: async () =>
          single(
            await f.run.client.post(ascPath("appScreenshotSets"), {
              data: {
                type: "appScreenshotSets",
                attributes: { screenshotDisplayType: displayType },
                relationships: {
                  appStoreVersionLocalization: {
                    data: {
                      type: "appStoreVersionLocalizations",
                      id: localization.id,
                    },
                  },
                },
              },
            }),
          ),
        reread: async (id) =>
          single(await f.run.client.get(ascPath("appScreenshotSets", id))),
        resultIds: (s) => ({ setId: s.id, localizationId: localization.id }),
        summary: () =>
          `Created the ${displayType} screenshot set (${locale}) in App Store Connect`,
      },
    );
    const setId = set.ids.setId;
    if (!setId)
      stop(
        502,
        "store_refused",
        "App Store Connect answered no screenshot set",
      );

    const pushed: Record<string, unknown>[] = [];
    for (const s of shots) {
      const find = async () => {
        const matches = (await setScreenshots(f, setId)).filter((r) =>
          isShot(r, s),
        );
        // A screenshot that failed processing is no answer: a new reservation replaces it.
        return matches.find((r) => deliveryState(r) !== "FAILED") ?? null;
      };
      const r = await step(f, "listing.screenshot", `${setId}:${s.sha256}`, {
        request: { setId, sha256: s.sha256, n: s.n },
        find,
        satisfied: (r) => UPLOADED_STATES.has(deliveryState(r) ?? ""),
        write: async (existing) => {
          // A reservation from an interrupted attempt is resumed while Apple still awaits it.
          let reserved =
            existing && deliveryState(existing) === "AWAITING_UPLOAD"
              ? existing
              : null;
          let ops = reserved
            ? uploadOperations(reserved.attributes?.uploadOperations, s.size)
            : null;
          if (!reserved || !ops) {
            reserved = single(
              await f.run.client.post(ascPath("appScreenshots"), {
                data: {
                  type: "appScreenshots",
                  attributes: { fileName: s.fileName, fileSize: s.size },
                  relationships: {
                    appScreenshotSet: {
                      data: { type: "appScreenshotSets", id: setId },
                    },
                  },
                },
              }),
            );
            ops = uploadOperations(
              reserved?.attributes?.uploadOperations,
              s.size,
            );
          }
          if (!reserved || !ops)
            stop(
              502,
              "store_refused",
              "App Store Connect answered a screenshot reservation without usable upload operations",
            );
          await putUploadOperations({
            operations: ops,
            upload: { contentType: s.contentType, size: s.size },
            read: async (offset, length) => {
              const part = await bucket.get(s.blob, {
                range: { offset, length },
              });
              if (!part)
                stop(
                  409,
                  "screenshot_missing",
                  `${s.slot} is not in the blob store`,
                );
              return part.arrayBuffer();
            },
            ...(f.c.fetchImpl ? { fetchImpl: f.c.fetchImpl } : {}),
          });
          return single(
            await f.run.client.patch(ascPath("appScreenshots", reserved.id), {
              data: {
                type: "appScreenshots",
                id: reserved.id,
                attributes: { uploaded: true, sourceFileChecksum: s.md5 },
              },
            }),
          );
        },
        reread: async (id) =>
          single(await f.run.client.get(ascPath("appScreenshots", id))),
        resultIds: (r) => ({ screenshotId: r.id, setId }),
        summary: () => `Uploaded ${s.slot} (${locale}) to App Store Connect`,
      });
      pushed.push({
        slot: s.slot,
        sha256: s.sha256,
        ...stepView(r),
        screenshotId: r.ids.screenshotId ?? null,
      });
    }

    // Never a delete: what the set holds beyond the listing is counted and left to the operator.
    const others = (await setScreenshots(f, setId)).filter(
      (r) => !shots.some((s) => isShot(r, s)),
    ).length;
    return {
      ok: true,
      versionId,
      locale,
      sizeClass: cls,
      displayType,
      setId,
      screenshots: pushed,
      otherScreenshots: others,
      // Removing or reordering screenshots stays in App Store Connect (no DELETE, ever).
      manage:
        others > 0
          ? renderDeepLink("app-store.version", { appId: f.setup.appleId })
          : null,
    };
  },
);

/** The listing push: path under `…/connectors/asc/` → implementation. */
export const ASC_LISTING_CONTROLS: Readonly<Record<string, ConnectorControl>> =
  {
    "listing/text": listingText,
    "listing/screenshots": listingScreenshots,
  };
