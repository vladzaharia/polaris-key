/**
 * Microsoft Store provisioning steps (A-18f; notes/S-15 §4.2, §6.3, §6.4, §8.4). Each step is ONE
 * `performStoreWrite` (`core/storefront/ledger.ts`): the natural-key read first, the gated write
 * through `MsStoreWriteClient`, a re-read, the ledger row and one audit row
 * (`distribution.msstore.<op>`). The console (A-18j) calls these with the request's
 * `Idempotency-Key`; no route is added here.
 *
 * **Natural keys (§6.3).**
 *   - Submission create: the app's `pendingApplicationSubmission`. It is REUSED only if this
 *     ledger created it (a done `submission.create` row for the app names its id). A pending
 *     submission someone else created (Partner Center, the msstore CLI) is never adopted, changed
 *     or committed: the step refuses with `MsStoreForeignDraft` and the deep link to it.
 *   - Commit: the submission's own status; anything past `PendingCommit` is already committed.
 *   - Rollout: `packagerollout` (the percentage, or a halted or completed status).
 *   - MSI/EXE submit: the product's `status`, whose `ongoingSubmissionId` means it already ran.
 *
 * **Typed confirmation (§6.4).** Commit (app and flight), MSI/EXE submit, finalize and any pricing
 * change compare what the operator typed with the app's `primaryName` as Microsoft reports it NOW
 * (`typedConfirmationRefusal`), and only then assert `typedConfirmation` to the gate.
 *
 * **"Never edit an API-created submission in the UI."** Doing so makes it uncommittable by the
 * API and only deletable, and deleting is denied. `NEVER_EDIT_IN_UI` is the warning the console
 * shows before any hand-off to Partner Center; once it has happened (a commit answers
 * `InvalidState`), `MsStoreForeignDraft` carries only the deep link.
 *
 * **CI caution (for A-18h).** `msstore publish` deletes the pending draft, discarding staged
 * metadata. `workerStagedDraft` answers whether the ledger shows a Worker-staged classic draft
 * that has not been committed, so the CI allow-list can refuse `publish` over it.
 */

import type { Db } from "../../../../core/platform.js";
import type { AdminSession } from "../../../../core/adminApi.js";
import {
  typedConfirmationRefusal,
  type ConfirmationRefusal,
} from "../../../../core/storefront/confirm.js";
import { renderDeepLink } from "../../../../core/storefront/deeplinks.js";
import {
  performStoreWrite,
  type StoreWriteResult,
} from "../../../../core/storefront/ledger.js";
import { StoreVendorError } from "../../../../core/storefront/errors.js";
import type { StoreResource } from "../../../../core/storefront/audit.js";
import { MICROSOFT_STORE_ADAPTER } from "../../../../core/storefront/stores/microsoftStore.js";
import { STORE_ID } from "./setup.js";
import { FLIGHT_ID, SUBMISSION_ID } from "./client.js";
import {
  applicationResource,
  isSasUrl,
  msiData,
  submissionResource,
  type MsStoreWriteClient,
} from "./write.js";
import { storedZip, type ZipEntry } from "./zip.js";

export const MSSTORE = "microsoft-store" as const;

/** The console's warning before any hand-off to Partner Center (S-15 §4.2). */
export const NEVER_EDIT_IN_UI =
  "Do not edit this submission in Partner Center: Microsoft then refuses every API change or commit to it, and it can only be deleted there by hand.";

/** A pending submission this ledger did not create, or one a person edited in Partner Center. */
export class MsStoreForeignDraft extends Error {
  constructor(
    readonly submissionId: string,
    /** The only thing the flow offers: Partner Center's page for it (deleting is denied). */
    readonly deepLink: string,
  ) {
    super(
      "a pending Microsoft Store submission was not created by Polaris Key (or was edited in Partner Center); finish or remove it in Partner Center",
    );
    this.name = "MsStoreForeignDraft";
  }
}

/** One step's context: the app the product's setup pinned, never the request's. */
export interface MsStepContext {
  db: Db;
  client: MsStoreWriteClient;
  session: AdminSession;
  product: string;
  /** The 12-character Store ID (classic) or product id (MSI/EXE). */
  appId: string;
  now: number;
}

export type MsStepResult =
  | StoreWriteResult
  | { outcome: "refused"; refusal: ConfirmationRefusal };

function checkApp(appId: string): string {
  if (!STORE_ID.test(appId)) throw new Error("invalid Microsoft Store id");
  return appId;
}
function checkSubmission(id: string): string {
  if (!SUBMISSION_ID.test(id)) throw new Error("invalid submission id");
  return id;
}

const appPath = (appId: string) => `/v1.0/my/applications/${checkApp(appId)}`;
const subPath = (appId: string, sid: string) =>
  `${appPath(appId)}/submissions/${checkSubmission(sid)}`;
const msiPath = (appId: string) => `/submission/v1/product/${checkApp(appId)}`;

function key(
  ctx: MsStepContext,
  op: string,
  naturalKey: string,
  idempotencyKey: string,
) {
  return {
    store: MSSTORE,
    scope: "product" as const,
    product: ctx.product,
    op,
    naturalKey,
    idempotencyKey,
  };
}

/** The app's name as Microsoft reports it now (the typed-confirmation phrase), or null. */
export async function appPrimaryName(
  client: MsStoreWriteClient,
  appId: string,
): Promise<string | null> {
  const app = await client.request("GET", appPath(appId));
  return typeof app?.primaryName === "string" ? app.primaryName : null;
}

async function confirmRefusal(
  ctx: MsStepContext,
  typed: unknown,
  action: string,
): Promise<ConfirmationRefusal | null> {
  return typedConfirmationRefusal(
    typed,
    await appPrimaryName(ctx.client, ctx.appId),
    action,
    MICROSOFT_STORE_ADAPTER.confirmation,
  );
}

/** Whether a done `submission.create` row of this ledger names `submissionId` for the app. */
export async function ownsSubmission(
  db: Db,
  product: string,
  appId: string,
  submissionId: string,
): Promise<boolean> {
  const rows = await db.all<{ result_ids_json: string | null }>(
    `SELECT result_ids_json FROM store_operations
      WHERE store = ? AND scope = 'product' AND product = ? AND op = 'submission.create'
        AND natural_key = ? AND state = 'done'`,
    MSSTORE,
    product,
    appId,
  );
  return rows.some((r) => {
    try {
      return (
        (JSON.parse(r.result_ids_json ?? "{}") as Record<string, unknown>)
          .submission === submissionId
      );
    } catch {
      return false;
    }
  });
}

function foreign(appId: string, submissionId: string): MsStoreForeignDraft {
  return new MsStoreForeignDraft(
    submissionId,
    renderDeepLink("microsoft-store.submission", {
      productId: appId,
      submissionId,
    }),
  );
}

async function readSubmission(
  ctx: MsStepContext,
  sid: string,
): Promise<StoreResource | null> {
  const raw = await ctx.client.request("GET", subPath(ctx.appId, sid));
  return raw ? submissionResource(raw) : null;
}

async function requireOwned(ctx: MsStepContext, sid: string): Promise<void> {
  if (!(await ownsSubmission(ctx.db, ctx.product, ctx.appId, sid)))
    throw foreign(ctx.appId, sid);
}

// ── Classic: the app submission ──────────────────────────────────────────────────────────────

/** Create (or reuse, if the ledger created it) the app's pending submission. */
export function stageSubmission(
  ctx: MsStepContext,
  idempotencyKey: string,
): Promise<StoreWriteResult> {
  return performStoreWrite(ctx.db, {
    key: key(ctx, "submission.create", ctx.appId, idempotencyKey),
    request: { app: ctx.appId },
    session: ctx.session,
    now: ctx.now,
    find: async () => {
      const app = await ctx.client.request("GET", appPath(ctx.appId));
      const pending = (
        app?.pendingApplicationSubmission as Record<string, unknown> | undefined
      )?.id;
      if (typeof pending !== "string" || pending === "") return null;
      if (!(await ownsSubmission(ctx.db, ctx.product, ctx.appId, pending)))
        throw foreign(ctx.appId, pending);
      return readSubmission(ctx, pending);
    },
    write: async () => {
      const raw = await ctx.client.request(
        "POST",
        `${appPath(ctx.appId)}/submissions`,
      );
      return raw ? submissionResource(raw) : null;
    },
    reread: (id) => readSubmission(ctx, id),
    resultIds: (r) => ({ app: ctx.appId, submission: r.id }),
    summary: (r, outcome) =>
      outcome === "existing"
        ? `Reused Microsoft Store submission ${r.id}`
        : `Created Microsoft Store submission ${r.id}`,
  });
}

/**
 * Update the pending submission this ledger created. `body` is the gate's classic shape; a body
 * with `pricing` is a price change and needs `confirm` (the app's name).
 */
export async function updateSubmission(
  ctx: MsStepContext,
  idempotencyKey: string,
  submissionId: string,
  body: Record<string, unknown>,
  confirm?: string,
): Promise<MsStepResult> {
  await requireOwned(ctx, submissionId);
  const pricing = body.pricing !== undefined;
  if (pricing) {
    const refusal = await confirmRefusal(ctx, confirm, "change the price");
    if (refusal) return { outcome: "refused", refusal };
  }
  return performStoreWrite(ctx.db, {
    key: key(
      ctx,
      "submission.update",
      `${ctx.appId}:${submissionId}`,
      idempotencyKey,
    ),
    request: body,
    session: ctx.session,
    now: ctx.now,
    find: () => readSubmission(ctx, submissionId),
    satisfied: () => false,
    write: async () => {
      const raw = await ctx.client.request(
        "PUT",
        subPath(ctx.appId, submissionId),
        body,
        {
          typedConfirmation: pricing,
        },
      );
      return raw ? submissionResource(raw) : null;
    },
    reread: (id) => readSubmission(ctx, id),
    resultIds: (r) => ({ app: ctx.appId, submission: r.id }),
    summary: () =>
      pricing
        ? `Updated Microsoft Store submission ${submissionId} (price confirmed by name)`
        : `Updated Microsoft Store submission ${submissionId}`,
  });
}

/**
 * Upload new listing images for the pending submission as ONE ZIP to its SAS `fileUploadUrl`
 * (listing images only, decision 2). The submission's `images[].fileName`s name the entries, so
 * call `updateSubmission` with `PendingUpload` images before committing. Idempotent: the blob is
 * overwritten.
 */
export async function uploadSubmissionImages(
  ctx: MsStepContext,
  submissionId: string,
  images: readonly ZipEntry[],
): Promise<void> {
  await requireOwned(ctx, submissionId);
  const raw = await ctx.client.request("GET", subPath(ctx.appId, submissionId));
  const sas = raw?.fileUploadUrl;
  if (!isSasUrl(sas))
    throw new StoreVendorError(
      502,
      null,
      "Microsoft Store: the submission has no upload URL",
    );
  await ctx.client.uploadToSas(sas, storedZip(images), "application/zip");
}

const COMMITTED = (r: StoreResource) => {
  const s = r.attributes?.status;
  return typeof s === "string" && s !== "PendingCommit" && s !== "CommitFailed";
};

/** Commit the pending submission to certification (typed: the app's name). */
export async function commitSubmission(
  ctx: MsStepContext,
  idempotencyKey: string,
  submissionId: string,
  confirm: string,
): Promise<MsStepResult> {
  await requireOwned(ctx, submissionId);
  const refusal = await confirmRefusal(ctx, confirm, "commit the submission");
  if (refusal) return { outcome: "refused", refusal };
  try {
    return await performStoreWrite(ctx.db, {
      key: key(
        ctx,
        "submission.commit",
        `${ctx.appId}:${submissionId}`,
        idempotencyKey,
      ),
      request: { submission: submissionId },
      session: ctx.session,
      now: ctx.now,
      find: () => readSubmission(ctx, submissionId),
      satisfied: COMMITTED,
      write: async () => {
        await ctx.client.request(
          "POST",
          `${subPath(ctx.appId, submissionId)}/commit`,
          undefined,
          { typedConfirmation: true },
        );
        return readSubmission(ctx, submissionId);
      },
      reread: (id) => readSubmission(ctx, id),
      resultIds: (r) => ({ app: ctx.appId, submission: r.id }),
      summary: () =>
        `Committed Microsoft Store submission ${submissionId} (confirmed by name)`,
    });
  } catch (e) {
    // A submission edited in Partner Center can no longer be committed by the API.
    if (e instanceof StoreVendorError && e.code === "InvalidState")
      throw foreign(ctx.appId, submissionId);
    throw e;
  }
}

// ── Classic: gradual rollout ─────────────────────────────────────────────────────────────────

async function readRollout(
  ctx: MsStepContext,
  sid: string,
): Promise<StoreResource | null> {
  const raw = await ctx.client.request(
    "GET",
    `${subPath(ctx.appId, sid)}/packagerollout`,
  );
  if (!raw) return null;
  return {
    type: "packageRollouts",
    id: sid,
    attributes: {
      isPackageRollout: raw.isPackageRollout,
      packageRolloutPercentage: raw.packageRolloutPercentage,
      packageRolloutStatus: raw.packageRolloutStatus,
    },
  };
}

type RolloutAction =
  | { kind: "percentage"; percentage: number }
  | { kind: "halt" }
  | { kind: "finalize"; confirm: string };

/** Move, halt or finalize (typed) a published submission's gradual rollout. */
export async function changeRollout(
  ctx: MsStepContext,
  idempotencyKey: string,
  submissionId: string,
  action: RolloutAction,
): Promise<MsStepResult> {
  if (action.kind === "finalize") {
    const refusal = await confirmRefusal(
      ctx,
      action.confirm,
      "release to every customer",
    );
    if (refusal) return { outcome: "refused", refusal };
  }
  const base = subPath(ctx.appId, submissionId);
  const status = (r: StoreResource) => r.attributes?.packageRolloutStatus;
  return performStoreWrite(ctx.db, {
    key: key(
      ctx,
      `rollout.${action.kind}`,
      `${ctx.appId}:${submissionId}`,
      idempotencyKey,
    ),
    request:
      action.kind === "percentage"
        ? { percentage: action.percentage }
        : { action: action.kind },
    session: ctx.session,
    now: ctx.now,
    find: () => readRollout(ctx, submissionId),
    satisfied: (r) =>
      action.kind === "percentage"
        ? r.attributes?.packageRolloutPercentage === action.percentage
        : action.kind === "halt"
          ? status(r) === "PackageRolloutStopped"
          : status(r) === "PackageRolloutComplete",
    write: async () => {
      if (action.kind === "percentage")
        await ctx.client.request(
          "POST",
          `${base}/updatepackagerolloutpercentage`,
          {
            percentage: action.percentage,
          },
        );
      else if (action.kind === "halt")
        await ctx.client.request("POST", `${base}/haltpackagerollout`);
      else
        await ctx.client.request(
          "POST",
          `${base}/finalizepackagerollout`,
          undefined,
          {
            typedConfirmation: true,
          },
        );
      return readRollout(ctx, submissionId);
    },
    reread: () => readRollout(ctx, submissionId),
    resultIds: () => ({ app: ctx.appId, submission: submissionId }),
    summary: () =>
      action.kind === "percentage"
        ? `Set the Microsoft Store rollout of ${submissionId} to ${action.percentage}%`
        : action.kind === "halt"
          ? `Halted the Microsoft Store rollout of ${submissionId}`
          : `Finalized the Microsoft Store rollout of ${submissionId} (confirmed by name)`,
  });
}

// ── Classic: package flights ─────────────────────────────────────────────────────────────────

/** Create a package flight for existing flight groups; natural key: its friendly name. */
export function createFlight(
  ctx: MsStepContext,
  idempotencyKey: string,
  flight: { friendlyName: string; groupIds: string[]; rankHigherThan?: string },
): Promise<StoreWriteResult> {
  const find = async (): Promise<StoreResource | null> => {
    const doc = await ctx.client
      .request(
        "GET",
        `${appPath(ctx.appId)}/listflights`,
        undefined,
        {},
        {
          top: "100",
          skip: "0",
        },
      )
      .catch((e: unknown) => {
        if (e instanceof StoreVendorError && e.status === 404) return null;
        throw e;
      });
    const list = Array.isArray(doc?.value)
      ? (doc.value as Record<string, unknown>[])
      : [];
    const hit = list.find((f) => f.friendlyName === flight.friendlyName);
    return hit &&
      typeof hit.flightId === "string" &&
      FLIGHT_ID.test(hit.flightId)
      ? {
          type: "flights",
          id: hit.flightId,
          attributes: { friendlyName: hit.friendlyName },
        }
      : null;
  };
  return performStoreWrite(ctx.db, {
    key: key(
      ctx,
      "flight.create",
      `${ctx.appId}:${flight.friendlyName}`,
      idempotencyKey,
    ),
    request: flight,
    session: ctx.session,
    now: ctx.now,
    find,
    write: async () => {
      const raw = await ctx.client.request(
        "POST",
        `${appPath(ctx.appId)}/flights`,
        flight,
      );
      const id = raw?.flightId;
      return typeof id === "string"
        ? {
            type: "flights",
            id,
            attributes: { friendlyName: raw?.friendlyName },
          }
        : null;
    },
    reread: async () => find(),
    resultIds: (r) => ({ app: ctx.appId, flight: r.id }),
    summary: () =>
      `Created Microsoft Store package flight ${flight.friendlyName}`,
  });
}

// ── MSI/EXE ─────────────────────────────────────────────────────────────────────────────────

async function readDraftMetadata(ctx: MsStepContext): Promise<StoreResource> {
  const d = msiData(
    await ctx.client.request("GET", `${msiPath(ctx.appId)}/metadata`),
  );
  const props = (d.properties ?? {}) as Record<string, unknown>;
  const avail = (d.availability ?? {}) as Record<string, unknown>;
  return {
    type: "draftMetadata",
    id: ctx.appId,
    attributes: {
      category: props.category,
      subcategory: props.subcategory,
      pricing: avail.pricing,
      discoverability: avail.discoverability,
    },
  };
}

/** Patch the draft's metadata modules; `availability.pricing` / `freeTrial` need `confirm`. */
export async function patchDraftMetadata(
  ctx: MsStepContext,
  idempotencyKey: string,
  body: Record<string, unknown>,
  confirm?: string,
): Promise<MsStepResult> {
  const avail = body.availability as Record<string, unknown> | undefined;
  const pricing =
    avail?.pricing !== undefined || avail?.freeTrial !== undefined;
  if (pricing) {
    const refusal = await confirmRefusal(ctx, confirm, "change the price");
    if (refusal) return { outcome: "refused", refusal };
  }
  return performStoreWrite(ctx.db, {
    key: key(ctx, "draft.metadata", ctx.appId, idempotencyKey),
    request: body,
    session: ctx.session,
    now: ctx.now,
    find: () => readDraftMetadata(ctx),
    satisfied: () => false,
    write: async () => {
      await ctx.client.request(
        "PATCH",
        `${msiPath(ctx.appId)}/metadata`,
        body,
        {
          typedConfirmation: pricing,
        },
      );
      return readDraftMetadata(ctx);
    },
    reread: () => readDraftMetadata(ctx),
    resultIds: () => ({ app: ctx.appId }),
    summary: () => `Updated the Microsoft Store draft metadata of ${ctx.appId}`,
  });
}

/**
 * Point the draft at the release's own installer (a URL, not an upload) and commit the package
 * configuration. [U] A-18k: whether Microsoft fetches a `packageUrl` that redirects.
 */
export function setDraftPackages(
  ctx: MsStepContext,
  idempotencyKey: string,
  packages: Record<string, unknown>[],
): Promise<StoreWriteResult> {
  const read = async (): Promise<StoreResource> => {
    const d = msiData(
      await ctx.client.request("GET", `${msiPath(ctx.appId)}/packages`),
    );
    const list = Array.isArray(d.packages)
      ? (d.packages as Record<string, unknown>[])
      : [];
    return {
      type: "draftPackages",
      id: ctx.appId,
      attributes: {
        packageType: list[0]?.packageType,
        architectures: list.flatMap((p) =>
          Array.isArray(p.architectures) ? p.architectures : [],
        ),
      },
    };
  };
  return performStoreWrite(ctx.db, {
    key: key(ctx, "draft.packages", ctx.appId, idempotencyKey),
    request: packages,
    session: ctx.session,
    now: ctx.now,
    find: read,
    satisfied: () => false,
    write: async () => {
      await ctx.client.request("PUT", `${msiPath(ctx.appId)}/packages`, {
        packages,
      });
      await ctx.client.request("POST", `${msiPath(ctx.appId)}/packages/commit`);
      return read();
    },
    reread: () => read(),
    resultIds: () => ({ app: ctx.appId }),
    summary: () => `Set the Microsoft Store draft packages of ${ctx.appId}`,
  });
}

export interface ListingImage {
  kind: "Screenshot" | "Logo";
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg";
}

/**
 * Replace one language's listing images (MSI/EXE): reserve SAS URLs, upload each image, commit.
 * The commit overwrites the whole set of that type and language: an update, not a deletion
 * (S-15 §8.4), so a plain confirm.
 */
export function replaceListingImages(
  ctx: MsStepContext,
  idempotencyKey: string,
  language: string,
  images: readonly ListingImage[],
): Promise<StoreWriteResult> {
  const count = (k: ListingImage["kind"]) =>
    images.filter((i) => i.kind === k).length;
  return performStoreWrite(ctx.db, {
    key: key(ctx, "listing.assets", `${ctx.appId}:${language}`, idempotencyKey),
    request: {
      language,
      screenshots: count("Screenshot"),
      logos: count("Logo"),
    },
    session: ctx.session,
    now: ctx.now,
    find: async () => null,
    write: async () => {
      const created = msiData(
        await ctx.client.request(
          "POST",
          `${msiPath(ctx.appId)}/listings/assets/create`,
          {
            language,
            createAssetRequest: {
              Screenshot: count("Screenshot"),
              Logo: count("Logo"),
            },
          },
        ),
      );
      const slots = {
        Screenshot: (created.screenshots ?? created.Screenshot ?? []) as Record<
          string,
          unknown
        >[],
        Logo: (created.storeLogos ?? created.Logo ?? []) as Record<
          string,
          unknown
        >[],
      };
      const committed: Record<
        "storeLogos" | "screenshots",
        { id: string; assetUrl: string }[]
      > = {
        storeLogos: [],
        screenshots: [],
      };
      const used = { Screenshot: 0, Logo: 0 };
      for (const img of images) {
        const slot = slots[img.kind][used[img.kind]++];
        const url = slot?.primaryAssetUploadUrl ?? slot?.assetUrl;
        if (!slot || typeof slot.id !== "string" || !isSasUrl(url))
          throw new StoreVendorError(
            502,
            null,
            "Microsoft Store: no upload slot for an image",
          );
        await ctx.client.uploadToSas(url, img.bytes, img.contentType);
        (img.kind === "Logo"
          ? committed.storeLogos
          : committed.screenshots
        ).push({
          id: slot.id,
          assetUrl: url,
        });
      }
      await ctx.client.request(
        "PUT",
        `${msiPath(ctx.appId)}/listings/assets/commit`,
        {
          listingAssets: { language, ...committed },
        },
      );
      return {
        type: "listingAssets",
        id: `${ctx.appId}-${language}`,
        attributes: { language },
      };
    },
    reread: async (id) => ({
      type: "listingAssets",
      id,
      attributes: { language },
    }),
    resultIds: () => ({ app: ctx.appId, language }),
    summary: () =>
      `Replaced the Microsoft Store ${language} listing images (${count("Screenshot")} screenshots, ${count("Logo")} logos)`,
  });
}

async function readDraftStatus(
  ctx: MsStepContext,
): Promise<StoreResource | null> {
  const d = msiData(
    await ctx.client.request("GET", `${msiPath(ctx.appId)}/status`),
  );
  const ongoing = d.ongoingSubmissionId;
  return typeof ongoing === "string" && ongoing !== ""
    ? {
        type: "draftSubmissions",
        id: ongoing,
        attributes: { submissionId: ongoing },
      }
    : null;
}

/** Submit the MSI/EXE draft to certification (typed). Natural key: an ongoing submission. */
export async function submitDraft(
  ctx: MsStepContext,
  idempotencyKey: string,
  confirm: string,
): Promise<MsStepResult> {
  const refusal = await confirmRefusal(ctx, confirm, "submit to certification");
  if (refusal) return { outcome: "refused", refusal };
  return performStoreWrite(ctx.db, {
    key: key(ctx, "draft.submit", ctx.appId, idempotencyKey),
    request: { app: ctx.appId },
    session: ctx.session,
    now: ctx.now,
    find: () => readDraftStatus(ctx),
    write: async () => {
      const d = msiData(
        await ctx.client.request(
          "POST",
          `${msiPath(ctx.appId)}/submit`,
          undefined,
          {
            typedConfirmation: true,
          },
        ),
      );
      const id = d.submissionId;
      return typeof id === "string" && id !== ""
        ? { type: "draftSubmissions", id, attributes: { submissionId: id } }
        : readDraftStatus(ctx);
    },
    reread: async () => readDraftStatus(ctx),
    resultIds: (r) => ({ app: ctx.appId, submission: r.id }),
    summary: (r) =>
      `Submitted the Microsoft Store draft of ${ctx.appId} (${r.id}; confirmed by name)`,
  });
}

// ── For the CI plane (A-18h) ─────────────────────────────────────────────────────────────────

/**
 * Whether the ledger shows a Worker-staged classic draft for the app that has not been committed:
 * a done `submission.create` whose submission has no done `submission.commit` after it. A-18h's
 * CI allow-list must not run `msstore publish` (which deletes the pending draft) while this is true.
 */
export async function workerStagedDraft(
  db: Db,
  product: string,
  appId: string,
): Promise<string | null> {
  const rows = await db.all<{
    op: string;
    natural_key: string;
    result_ids_json: string | null;
  }>(
    `SELECT op, natural_key, result_ids_json FROM store_operations
      WHERE store = ? AND scope = 'product' AND product = ? AND state = 'done'
        AND op IN ('submission.create', 'submission.commit')
      ORDER BY created_at DESC, op_id DESC LIMIT 200`,
    MSSTORE,
    product,
  );
  const committed = new Set<string>();
  const created: string[] = [];
  for (const r of rows) {
    let ids: Record<string, unknown> = {};
    try {
      ids = JSON.parse(r.result_ids_json ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const sid = typeof ids.submission === "string" ? ids.submission : null;
    if (!sid) continue;
    if (r.op === "submission.commit") committed.add(sid);
    else if (r.natural_key === appId) created.push(sid);
  }
  // Newest first; a commit row names its submission, so ordering between the two never matters.
  for (const sid of created) if (!committed.has(sid)) return sid;
  return null;
}

/** An application read as a resource (for the console's detection step). */
export async function readApplication(
  client: MsStoreWriteClient,
  appId: string,
): Promise<StoreResource | null> {
  const raw = await client.request("GET", appPath(appId));
  return raw ? applicationResource(raw) : null;
}
