/**
 * THE GOOGLE PLAY FLOW RUNTIME (A-18j; notes/S-15 §4.1, §8.1, §8.2). A-18e's adapter runtime
 * (`connectors/play/storefront.ts`) performs every write: one edit under the package's edit lease,
 * each write a `performStoreWrite` behind Play's gate. This file only decides WHICH of those
 * functions a console step calls, with what, from the listing model:
 *
 *   createApp            a deep link (Play has no app create), verified by A-18e's read-only
 *                        edit on the package (`verifyPlayApp`)
 *   writeListingText     every projected locale's title and descriptions, and the app's contact
 *                        details, in ONE edit committed with `changesNotSentForReview` (staged)
 *   writeListingAssets   the ACCEPTED Play images of the slot board (`slots.ts`), uploaded by
 *                        hash in one staged edit; old images are never deleted (decision 6), so
 *                        the result names how many remain and where to remove them
 *   testers              a testing track's Google Groups (a closed track is created first when
 *                        it is not a standard one), in one staged edit
 *   submit               TYPED (Play's default-language title): an edit committed WITHOUT
 *                        `changesNotSentForReview`, which sends the staged changes for review
 *
 * Release and the staged rollout stay with P5-03's controls on the Rollouts page and are not
 * steps here (their typed production `complete` is A-18e's proposed follow-up); in-app products
 * and prices have no binding yet, so their steps are absent (the owner's rule). "Push listing" is
 * text plus accepted images in one edit, ALWAYS committed staged (`changesNotSentForReview`): a push
 * is never a review submission (S-15 §8.2), whatever the request asks; sending for review is
 * only the typed `submit` step.
 */

import type { StorefrontOp } from "../../../core/storefront/adapter.js";
import { isProductionTrack } from "../../../core/storefront/rules/googlePlay.js";
import type { PlayImageType } from "../../../core/storefront/rules/googlePlay.js";
import type { StoreWriteResult } from "../../../core/storefront/ledger.js";
import type { StoreOperationRow } from "../../../core/storefront/ledger.js";
import {
  isPlayRefusal,
  playAppName,
  playCommit,
  playCreateClosedTrack,
  playImageFromListingAsset,
  playSetTesters,
  playUploadImage,
  playWriteDetails,
  playWriteListing,
  verifyPlayApp,
  withPlayEditSession,
  type PlayEditSession,
  type PlayStoreContext,
} from "../connectors/play/storefront.js";
import { PLAY_STANDARD_TRACKS } from "../../../core/storefront/rules/googlePlay.js";
import type { FetchImpl } from "../connectors/play/client.js";
import { readListing } from "../listing/store.js";
import { acceptedAssets } from "./slots.js";
import { flowOp } from "./plan.js";
import {
  fitBlocker,
  isRefusal,
  projectionFor,
  refusal,
  runOutcome,
  storeStep,
} from "./outcome.js";
import type {
  FlowContext,
  FlowRuntime,
  RunOutcome,
  StepBinding,
  StepRequest,
  StepState,
} from "./runtime.js";

const STORE = "google-play";
const enc = encodeURIComponent;

function playCtx(c: FlowContext): PlayStoreContext {
  return {
    env: c.env,
    db: c.db,
    product: c.product,
    hooks: c.hooks,
    session: c.session,
    now: c.now,
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl as unknown as FetchImpl } : {}),
    ...(c.sleep ? { sleep: c.sleep } : {}),
  };
}

const stepPath = (slug: string, op: StorefrontOp) =>
  `/manage/api/products/${enc(slug)}/distribution/storefronts/${STORE}/steps/${op}`;

function newest(
  rows: readonly StoreOperationRow[],
  ops: readonly string[],
): { state: StepState; stateAt: number | null } {
  const row = rows.find((r) => ops.includes(r.op));
  return row
    ? { state: row.state, stateAt: row.finished_at ?? row.created_at }
    : { state: "todo", stateAt: null };
}

/** A store-numbered screenshot slot → Play's image type (`play:screenshot:<class>:<n>`). */
const SCREENSHOT_TYPES: Readonly<Record<string, PlayImageType>> = {
  "phone-portrait": "phoneScreenshots",
  tablet: "tenInchScreenshots",
  tv: "tvScreenshots",
  wear: "wearScreenshots",
};

/** The Play image type an accepted asset fills, or null when it is not one of Play's. */
export function playImageTypeOf(slot: string): PlayImageType | null {
  if (slot === "play:icon") return "icon";
  if (slot === "play:feature-graphic") return "featureGraphic";
  const m = /^play:screenshot:([a-z0-9-]+):(\d+)$/.exec(slot);
  return m ? (SCREENSHOT_TYPES[m[1]!] ?? null) : null;
}

/** The accepted assets Play takes, in slot order (screenshots by their number). */
async function playImages(c: FlowContext) {
  const rows = (await acceptedAssets(c.db, c.product)).filter(
    (r) => playImageTypeOf(r.slot) !== null,
  );
  const num = (s: string) => Number(/:(\d+)$/.exec(s)?.[1] ?? 0);
  return rows.sort((a, b) =>
    a.slot.replace(/:\d+$/, "") === b.slot.replace(/:\d+$/, "")
      ? num(a.slot) - num(b.slot)
      : a.slot.localeCompare(b.slot),
  );
}

async function writeText(
  c: FlowContext,
  s: PlayEditSession,
  key: string,
): Promise<StoreWriteResult[] | RunOutcome> {
  const fit = await projectionFor(c.db, c.product, "play");
  const blocked = fitBlocker(fit, "Google Play");
  if (blocked) return refusal(422, "listing_does_not_fit", blocked);
  const payload = fit!.payload!;
  const out: StoreWriteResult[] = [];
  const details: Record<string, string> = {};
  if (typeof payload.app.contactEmail === "string")
    details.contactEmail = payload.app.contactEmail;
  if (typeof payload.app.contactWebsite === "string")
    details.contactWebsite = payload.app.contactWebsite;
  if (Object.keys(details).length)
    out.push(await playWriteDetails(s, details, key));
  for (const [language, fields] of Object.entries(payload.locales)) {
    const input: Record<string, string> = {};
    for (const f of ["title", "shortDescription", "fullDescription"] as const)
      if (typeof fields[f] === "string") input[f] = fields[f] as string;
    if (Object.keys(input).length === 0) continue;
    const r = await playWriteListing(s, language, input, key);
    if (isPlayRefusal(r)) return r;
    out.push(r);
  }
  return out;
}

async function writeImages(
  c: FlowContext,
  s: PlayEditSession,
  key: string,
): Promise<{ results: StoreWriteResult[]; oldImages: number } | RunOutcome> {
  const stored = await readListing(c.db, c.product);
  const fallback = stored?.model.app.defaultLocale ?? "en-US";
  const results: StoreWriteResult[] = [];
  let oldImages = 0;
  for (const row of await playImages(c)) {
    const image = await playImageFromListingAsset(
      c.env,
      c.db,
      c.product,
      row.slot,
      row.locale,
    );
    if (!image)
      return refusal(
        409,
        "asset_missing",
        `${row.slot} is not in the blob store any more: run pkey listing assets again`,
      );
    const r = await playUploadImage(
      s,
      {
        language: row.locale || fallback,
        imageType: playImageTypeOf(row.slot)!,
        image,
        aiGenerated: false,
      },
      key,
    );
    if (isPlayRefusal(r)) return r;
    results.push(r.result);
    oldImages += r.oldImages;
  }
  return { results, oldImages };
}

/** Run `fn` in one edit, then commit (staged or sent for review); refusals pass through. */
async function inEdit(
  c: FlowContext,
  key: string,
  commit: { stageOnly: boolean; typed?: boolean; production?: boolean },
  fn: (s: PlayEditSession) => Promise<StoreWriteResult[] | RunOutcome>,
): Promise<RunOutcome> {
  return storeStep(async () => {
    const r = await withPlayEditSession(
      playCtx(c),
      "provisioning",
      async (s) => {
        const writes = await fn(s);
        if (!Array.isArray(writes)) return writes;
        if (commit.production) s.touched.production = true;
        const committed = await playCommit(
          s,
          {
            stageOnly: commit.stageOnly,
            ...(commit.typed ? { typed: true } : {}),
          },
          key,
        );
        return runOutcome([...writes, committed]);
      },
    );
    return isPlayRefusal(r)
      ? refusal(r.status, r.reason, r.message, r.fields)
      : r;
  });
}

const run = (
  path: string,
  verb: string,
  consequences: string[],
  fields: StepRequest["fields"] = [],
  confirm: StepRequest["confirm"] = "plain",
): StepRequest => ({
  method: "POST",
  path,
  body: {},
  fields,
  confirm,
  verb,
  consequences,
});

const NEEDS_APP =
  "Assign the product's Google Play app first (the app record step, or Platform → Store connections).";

export const GOOGLE_PLAY_FLOW: FlowRuntime = {
  id: STORE,

  async bind(c, op, facts, ledger): Promise<StepBinding | null> {
    const pinned = facts.app !== null;
    const blockedBy = pinned ? null : NEEDS_APP;
    const rows = ledger.product;
    switch (op) {
      case "createApp": {
        const found = rows.find((r) => r.op === flowOp("createApp")) ?? null;
        const stored = await readListing(c.db, c.product);
        const app = stored?.model.app;
        const packageName = facts.identifiers.packageName ?? facts.app?.id;
        return {
          label: "App record",
          state: pinned ? "done" : (found?.state ?? "todo"),
          stateAt: found?.finished_at ?? null,
          detail: pinned
            ? `${facts.app!.name ?? facts.app!.id} is assigned to this product.`
            : null,
          copy: [
            { label: "App name", value: app?.name ?? c.productName },
            { label: "Default language", value: app?.defaultLocale ?? "en-US" },
            ...(packageName
              ? [{ label: "Package name", value: packageName }]
              : []),
          ],
        };
      }
      case "writeListingText": {
        const fit = await projectionFor(c.db, c.product, "play");
        return {
          label: "Store listing text",
          ...newest(rows, ["listing.update", "details.update"]),
          blockedBy: blockedBy ?? fitBlocker(fit, "Google Play"),
          run: run(stepPath(c.product, op), "Send the listing text", [
            "Google Play receives every locale's title, short and full description, and the contact details, in one edit.",
            "The edit is committed staged: nothing is sent for review until the Submit step.",
            "The step shows what Google Play stored, read back after the write.",
          ]),
        };
      }
      case "writeListingAssets": {
        const images = await playImages(c);
        return {
          label: "Store listing images",
          ...newest(rows, ["image.upload"]),
          blockedBy:
            blockedBy ??
            (images.length === 0
              ? "Accept Google Play's images on the slot board first."
              : null),
          run: run(stepPath(c.product, op), "Upload the accepted images", [
            `Google Play receives ${images.length} accepted image${images.length === 1 ? "" : "s"}; an image it already has is skipped by its hash.`,
            "Play records each one as not AI-generated: accept only images that are not.",
            "Older images stay until you remove them in the Play Console: Polaris Key never deletes them.",
          ]),
        };
      }
      case "testers":
        return {
          label: "Testing track and testers",
          ...newest(rows, ["testers.update", "track.create"]),
          blockedBy,
          run: run(
            stepPath(c.product, op),
            "Set the testers",
            [
              "Google Play opens the testing track to the Google Groups you list, in one staged edit.",
              "A track that is not internal, alpha or beta is created first, or found by name.",
              "The audit trail stores how many groups, never their addresses.",
            ],
            [
              {
                name: "track",
                label: "Track",
                help: "internal, alpha (closed testing), beta (open testing), or a closed track's name.",
                value: "alpha",
                required: true,
                maxLength: 100,
              },
              {
                name: "googleGroups",
                label: "Google Groups",
                help: "Comma-separated group addresses.",
                value: "",
                required: true,
                maxLength: 4000,
              },
            ],
          ),
        };
      case "submit":
        return {
          label: "Send for review",
          ...newest(
            rows.filter(
              (r) =>
                r.op === "edit.commit" && r.natural_key.startsWith("edit:"),
            ),
            ["edit.commit"],
          ),
          blockedBy,
          run: run(
            stepPath(c.product, op),
            "Send the changes for review",
            [
              "Google Play sends every staged change of this app for review.",
              "With managed publishing on, approved changes then wait in the Play Console until you publish them there.",
            ],
            [],
            "typed",
          ),
        };
      case "release":
      case "rollout":
        // P5-03's controls on the Rollouts page own these; the state follows its poller.
        return { hidden: true, state: "todo" };
      default:
        return null;
    }
  },

  async verify(c, op) {
    if (op !== "createApp")
      return refusal(
        422,
        "not_verifiable",
        "this step is confirmed by you, not by a read",
      );
    try {
      const r = await verifyPlayApp(playCtx(c));
      if (isPlayRefusal(r))
        return refusal(r.status, r.reason, r.message, r.fields);
      return r
        ? { satisfied: true, detail: "Google Play has the app" }
        : { satisfied: false, detail: null };
    } catch (e) {
      const out = await storeStep(() => Promise.reject(e));
      if (isRefusal(out)) return out;
      throw e;
    }
  },

  async appName(c) {
    try {
      const r = await withPlayEditSession(playCtx(c), "import", playAppName);
      return isPlayRefusal(r) ? null : r;
    } catch {
      return null;
    }
  },

  async runStep(c, op, input, opts) {
    const key = opts.idempotencyKey;
    switch (op) {
      case "writeListingText":
        return inEdit(c, key, { stageOnly: true }, (s) => writeText(c, s, key));
      case "writeListingAssets":
        return inEdit(c, key, { stageOnly: true }, async (s) => {
          const r = await writeImages(c, s, key);
          return "results" in r ? r.results : r;
        });
      case "testers": {
        const track = typeof input.track === "string" ? input.track.trim() : "";
        const groups =
          typeof input.googleGroups === "string"
            ? input.googleGroups
                .split(",")
                .map((g) => g.trim())
                .filter(Boolean)
            : [];
        if (!track || isProductionTrack(track))
          return refusal(422, "invalid_body", "track must be a testing track", [
            "track",
          ]);
        if (groups.length === 0)
          return refusal(
            422,
            "invalid_body",
            "list at least one Google Group",
            ["googleGroups"],
          );
        return inEdit(c, key, { stageOnly: true }, async (s) => {
          const out: StoreWriteResult[] = [];
          if (!(PLAY_STANDARD_TRACKS as readonly string[]).includes(track)) {
            const t = await playCreateClosedTrack(s, { track }, key);
            if (isPlayRefusal(t)) return t;
            out.push(t);
          }
          const r = await playSetTesters(s, track, groups, key);
          if (isPlayRefusal(r)) return r;
          out.push(r);
          return out;
        });
      }
      case "submit":
        // The route compared the typed name with Play's title before this runs.
        if (!opts.typedConfirmation)
          return refusal(
            422,
            "confirmation_required",
            "type the app's name in confirm to send for review",
            ["confirm"],
          );
        return inEdit(
          c,
          key,
          { stageOnly: false, typed: true, production: true },
          async () => [],
        );
      default:
        return refusal(404, "unknown_step", "no such step for Google Play");
    }
  },

  pushListing: {
    stageOnly: true,
    // `stageOnly` from the request is ignored on purpose: a push is never sent for review.
    run(c, { idempotencyKey: key }) {
      return inEdit(c, key, { stageOnly: true }, async (s) => {
        const text = await writeText(c, s, key);
        if (!Array.isArray(text)) return text;
        const images = await writeImages(c, s, key);
        if (!("results" in images)) return images;
        return [...text, ...images.results];
      });
    },
  },
};
