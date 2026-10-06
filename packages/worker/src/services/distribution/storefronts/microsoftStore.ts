/**
 * THE MICROSOFT STORE FLOW RUNTIME (A-18j; notes/S-15 §4.2, §8.1, §8.2). A-18f's steps
 * (`connectors/msstore/provision.ts`) perform every write, each a `performStoreWrite` behind
 * Microsoft's gate; this file builds their client and decides which a console step calls:
 *
 *   createApp            a deep link (the name is reserved in Partner Center), verified by reading
 *                        the application the product's Store ID names
 *   writeListingText     the classic (MSIX) app submission: create, or reuse the one THIS ledger
 *                        created, then put every projected locale's listing into it. The
 *                        submission stays UNCOMMITTED (S-15 §8.2): nothing reaches certification
 *   submit               TYPED (the app's `primaryName`): commit the submission this ledger staged
 *
 * A pending submission someone else created, or one edited in Partner Center, is never adopted or
 * changed (`MsStoreForeignDraft`): the step answers 409 with Partner Center's page for it. MSI/EXE
 * products, listing images, pricing, flights and the rollout have no binding yet, so those steps
 * are absent (the owner's rule); A-18f's functions for them are the seams.
 */

import type { Db, Env } from "../../../core/platform.js";
import { parsePlatformCredentialHandle } from "../../../core/platformCredentials.js";
import type { StoreWriteResult } from "../../../core/storefront/ledger.js";
import type { FetchImpl } from "../connectors/msstore/client.js";
import {
  appPrimaryName,
  commitSubmission,
  MsStoreForeignDraft,
  NEVER_EDIT_IN_UI,
  readApplication,
  stageSubmission,
  updateSubmission,
  workerStagedDraft,
  type MsStepContext,
} from "../connectors/msstore/provision.js";
import { resolveMsStoreSetup } from "../connectors/msstore/setup.js";
import {
  msStoreToken,
  platformMsStoreSellerId,
  platformMsStoreToken,
} from "../connectors/msstore/token.js";
import { MsStoreWriteClient } from "../connectors/msstore/write.js";
import { readListing } from "../listing/store.js";
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
  FlowRefusal,
  FlowRuntime,
  RunOutcome,
  StepBinding,
  StepRequest,
} from "./runtime.js";

const STORE = "microsoft-store";
const enc = encodeURIComponent;
const USE = "ms-store:provision";

/** The product's write client and Store ID, or why there is none. */
export async function msStoreClient(
  c: FlowContext,
): Promise<{ client: MsStoreWriteClient; appId: string } | FlowRefusal> {
  const { setup, inert } = await resolveMsStoreSetup(c.env, c.db, c.product);
  if (!setup)
    return refusal(
      inert.reason === "no_outlet" ? 404 : 409,
      inert.reason === "no_outlet"
        ? "not_configured"
        : `credential_${inert.reason}`,
      inert.message,
    );
  const fetchImpl: FetchImpl =
    (c.fetchImpl as unknown as FetchImpl | undefined) ??
    ((u, i) => fetch(u, i));
  const platform = parsePlatformCredentialHandle(setup.credentialId) !== null;
  const token = (env: Env, db: Db, api: "classic" | "msi") =>
    platform
      ? platformMsStoreToken(
          env,
          db,
          { product: c.product, pin: setup.productId },
          USE,
          c.now,
          fetchImpl,
          api,
        )
      : api === "classic"
        ? msStoreToken(
            env,
            db,
            c.product,
            setup.credentialId,
            USE,
            c.now,
            fetchImpl,
          )
        : Promise.resolve(null);
  const client = new MsStoreWriteClient({
    classicToken: () => token(c.env, c.db, "classic"),
    msiToken: () => token(c.env, c.db, "msi"),
    sellerId: platform ? await platformMsStoreSellerId(c.env, c.db) : null,
    fetchImpl,
    ...(c.sleep ? { sleep: c.sleep } : {}),
  });
  return { client, appId: setup.productId };
}

function stepCtx(
  c: FlowContext,
  m: { client: MsStoreWriteClient; appId: string },
): MsStepContext {
  return {
    db: c.db,
    client: m.client,
    session: c.session,
    product: c.product,
    appId: m.appId,
    now: c.now,
  };
}

/** A Microsoft step: its client, and a foreign draft answered as a refusal with the deep link. */
async function msStep(
  c: FlowContext,
  fn: (ctx: MsStepContext) => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const m = await msStoreClient(c);
  if (isRefusal(m)) return m;
  return storeStep(async () => {
    try {
      return await fn(stepCtx(c, m));
    } catch (e) {
      if (e instanceof MsStoreForeignDraft)
        return refusal(
          409,
          "foreign_submission",
          `${e.message}: ${e.deepLink}`,
        );
      throw e;
    }
  });
}

/** The keys of a classic `baseListing` the gate admits (A-18f's rule table). */
const BASE_LISTING_KEYS = [
  "copyrightAndTrademarkInfo",
  "keywords",
  "licenseTerms",
  "description",
  "features",
  "releaseNotes",
  "images",
  "recommendedHardware",
  "minimumHardware",
  "title",
  "shortDescription",
  "shortTitle",
  "sortTitle",
  "voiceTitle",
  "devStudio",
] as const;
const IMAGE_KEYS = ["fileName", "fileStatus", "id", "description", "imageType"];
const PROJECTED = [
  "description",
  "shortDescription",
  "keywords",
  "features",
  "releaseNotes",
] as const;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** An existing listing kept as Microsoft has it (only the admitted keys), images included. */
function keep(base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of BASE_LISTING_KEYS) {
    if (!(k in base)) continue;
    if (k === "images" && Array.isArray(base.images))
      out.images = (base.images as unknown[]).flatMap((i) => {
        const img = obj(i);
        return img
          ? [
              Object.fromEntries(
                IMAGE_KEYS.filter((f) => f in img).map((f) => [f, img[f]]),
              ),
            ]
          : [];
      });
    else out[k] = base[k];
  }
  return out;
}

/** Stage the submission and put the projected listings into it (every other locale kept). */
async function stageListing(
  c: FlowContext,
  ctx: MsStepContext,
  key: string,
): Promise<RunOutcome> {
  const fit = await projectionFor(c.db, c.product, "ms-store");
  const blocked = fitBlocker(fit, "the Microsoft Store");
  if (blocked) return refusal(422, "listing_does_not_fit", blocked);
  const staged = await stageSubmission(ctx, key);
  const results: StoreWriteResult[] = [staged];
  const sid =
    staged.outcome === "replayed"
      ? (
          JSON.parse(staged.row.result_ids_json ?? "{}") as Record<
            string,
            string
          >
        ).submission
      : staged.outcome === "conflict"
        ? undefined
        : staged.resultIds.submission;
  if (!sid) return runOutcome(results);
  const current = await ctx.client.request(
    "GET",
    `/v1.0/my/applications/${ctx.appId}/submissions/${sid}`,
  );
  const listings: Record<string, { baseListing: Record<string, unknown> }> = {};
  for (const [lang, l] of Object.entries(obj(current?.listings) ?? {})) {
    const base = obj(obj(l)?.baseListing);
    if (base) listings[lang.toLowerCase()] = { baseListing: keep(base) };
  }
  for (const [locale, fields] of Object.entries(fit!.payload!.locales)) {
    const lang = locale.toLowerCase();
    const base = listings[lang]?.baseListing ?? {};
    for (const f of PROJECTED) if (fields[f] !== undefined) base[f] = fields[f];
    listings[lang] = { baseListing: base };
  }
  const updated = await updateSubmission(ctx, key, sid, { listings });
  if ("refusal" in updated)
    return refusal(422, updated.refusal.reason, updated.refusal.message, [
      ...updated.refusal.fields,
    ]);
  results.push(updated);
  return runOutcome(results);
}

const run = (
  path: string,
  verb: string,
  consequences: string[],
  confirm: StepRequest["confirm"] = "plain",
): StepRequest => ({
  method: "POST",
  path,
  body: {},
  fields: [],
  confirm,
  verb,
  consequences,
});

const NEEDS_APP =
  "Assign the product's Microsoft Store app first (the app record step, or Platform → Store connections).";

export const MICROSOFT_STORE_FLOW: FlowRuntime = {
  id: STORE,

  async bind(c, op, facts, ledger): Promise<StepBinding | null> {
    const pinned = facts.app !== null;
    const blockedBy = pinned ? null : NEEDS_APP;
    const path = `/manage/api/products/${enc(c.product)}/distribution/storefronts/${STORE}/steps/${op}`;
    const rows = ledger.product;
    const newest = (ops: string[]) => {
      const row = rows.find((r) => ops.includes(r.op));
      return row
        ? { state: row.state, stateAt: row.finished_at ?? row.created_at }
        : { state: "todo" as const, stateAt: null };
    };
    switch (op) {
      case "createApp": {
        const found = rows.find((r) => r.op === flowOp("createApp")) ?? null;
        const stored = await readListing(c.db, c.product);
        return {
          label: "Name reservation",
          state: pinned ? "done" : (found?.state ?? "todo"),
          stateAt: found?.finished_at ?? null,
          detail: pinned
            ? `${facts.app!.name ?? facts.app!.id} is assigned to this product.`
            : null,
          copy: [
            {
              label: "App name",
              value: stored?.model.app.name ?? c.productName,
            },
          ],
        };
      }
      case "writeListingText": {
        const fit = await projectionFor(c.db, c.product, "ms-store");
        return {
          label: "Store listing text",
          ...newest(["submission.update", "submission.create"]),
          blockedBy: blockedBy ?? fitBlocker(fit, "the Microsoft Store"),
          run: run(path, "Stage the listing", [
            "Microsoft receives every locale's description, short description, features, keywords and release notes in the app's pending submission, created for it if there is none.",
            "The submission stays uncommitted: nothing reaches certification until the Submit step.",
            NEVER_EDIT_IN_UI,
          ]),
        };
      }
      case "submit": {
        const sid = facts.app
          ? await workerStagedDraft(c.db, c.product, facts.app.id)
          : null;
        return {
          label: "Submit to certification",
          ...newest(["submission.commit"]),
          blockedBy:
            blockedBy ??
            (sid
              ? null
              : "Stage the listing first: there is no submission to commit."),
          run: run(
            path,
            "Commit the submission",
            [
              "Microsoft starts certification of the staged submission.",
              "Once committed, the submission can't be changed from Polaris Key or Partner Center.",
            ],
            "typed",
          ),
        };
      }
      case "category":
      case "privacyDeclarations":
      case "pricing":
      case "release":
      case "rollout":
      case "testers":
      case "writeListingAssets":
        // A-18f performs these; no console binding yet, so the steps are absent.
        return null;
      default:
        return null;
    }
  },

  async verify(c, op, facts) {
    if (op !== "createApp")
      return refusal(
        422,
        "not_verifiable",
        "this step is confirmed by you, not by a read",
      );
    const m = await msStoreClient(c);
    if (isRefusal(m)) return m;
    const appId = facts.app?.id ?? m.appId;
    try {
      const app = await readApplication(m.client, appId);
      return app
        ? {
            satisfied: true,
            resultIds: { appId },
            detail: String(app.attributes?.primaryName ?? appId),
          }
        : { satisfied: false, detail: null };
    } catch (e) {
      const out = await storeStep(() => Promise.reject(e));
      if (isRefusal(out)) return out;
      throw e;
    }
  },

  async appName(c) {
    const m = await msStoreClient(c);
    if (isRefusal(m)) return null;
    try {
      return await appPrimaryName(m.client, m.appId);
    } catch {
      return null;
    }
  },

  async runStep(c, op, _input, opts) {
    const key = opts.idempotencyKey;
    switch (op) {
      case "writeListingText":
        return msStep(c, (ctx) => stageListing(c, ctx, key));
      case "submit":
        return msStep(c, async (ctx) => {
          const sid = await workerStagedDraft(c.db, c.product, ctx.appId);
          if (!sid)
            return refusal(409, "nothing_staged", "stage the listing first");
          // A-18f compares the typed name with `primaryName` again before it commits.
          const r = await commitSubmission(ctx, key, sid, opts.confirm ?? "");
          if ("refusal" in r)
            return refusal(422, r.refusal.reason, r.refusal.message, [
              ...r.refusal.fields,
            ]);
          return runOutcome([r]);
        });
      default:
        return refusal(
          404,
          "unknown_step",
          "no such step for the Microsoft Store",
        );
    }
  },

  pushListing: {
    // Microsoft has no staged commit: a push leaves the pending submission uncommitted.
    stageOnly: false,
    run: (c, { idempotencyKey }) =>
      msStep(c, (ctx) => stageListing(c, ctx, idempotencyKey)),
  },
};
