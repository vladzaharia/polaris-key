/// <reference types="@cloudflare/workers-types" />

/**
 * The Steam storefront adapter's admin surface (A-18g; notes/S-15 §4.3, owner decision 5) —
 * `/manage/api/products/<slug>/distribution/storefronts/steam…`:
 *
 *     GET  …/storefronts/steam                       the plan: the adapter's declaration (what is
 *                                                    API, what is a link), the app and key the
 *                                                    product resolves to (or why it is inert), the
 *                                                    deep links, the checklist, the store-page copy
 *                                                    card, the generated asset pack, the newest
 *                                                    Steam ledger rows and the budget. No Steam call
 *     GET  …/storefronts/steam/apps                  GetPartnerAppListForWebAPIKey: the apps the
 *                                                    key may act on, and whether the app is listed
 *                                                    (the "create the app" verifier)
 *     GET  …/storefronts/steam/builds                GetAppBetas and GetAppBuilds: branches, the
 *                                                    build live on each, recent builds (the public-
 *                                                    branch release verifier)
 *     POST …/storefronts/steam/branches/<branch>/live  { buildId, description? } with an
 *                                                    `Idempotency-Key`: SetAppBuildLive on a NAMED
 *                                                    branch. `public` is refused with App Admin's
 *                                                    deep link (decision 5)
 *     GET  …/storefronts/steam/pack                  the generated Steam asset pack (A-18d's
 *                                                    `pack:steam`), as an attachment
 *     PUT  …/storefronts/steam/checklist             { item, done } — an operator tick, audited
 *
 * Narrative-only like the rest of the console API (`routeCoverage`'s `adminApi` kind); session,
 * CSRF, rate limit and the platform-admin gate run in `admin/api.ts` first.
 *
 * EVERY Steam call goes through `SteamClient` (`core/steam/client.ts`): the gate admits it first,
 * then the per-day budget (stopped on the first 403), and only then is the publisher key opened
 * (audited, `steam:storefront`). The branch move is ONE `performStoreWrite` step: the natural key is
 * `GetAppBetas` (the branch already showing that build id answers `existing` with nothing sent),
 * the write is the gated `SetAppBuildLive`, the re-read is `GetAppBetas` again, and one audit row
 * (`distribution.steam.branch.set_live`) names the ledger row.
 */

import { ErrorCode } from "../../../../core/errors.js";
import type { ServiceContext } from "../../../../core/registry.js";
import type { AdminSession } from "../../../../admin/session.js";
import { adminJson, err, readBody } from "../../../../admin/lib/respond.js";
import { audit } from "../../../../admin/audit.js";
import { blobResponse, hasRef } from "../../../../core/blobs.js";
import { storefrontAdapter } from "../../../../core/storefront/adapter.js";
import {
  readRate,
  storeMeter,
  type BudgetKey,
} from "../../../../core/storefront/budget.js";
import { renderDeepLink } from "../../../../core/storefront/deeplinks.js";
import {
  StoreVendorError,
  StoreWriteDenied,
} from "../../../../core/storefront/errors.js";
import {
  isIdempotencyKey,
  listStoreOperations,
  performStoreWrite,
} from "../../../../core/storefront/ledger.js";
import type { StoreResource } from "../../../../core/storefront/audit.js";
import type { ListingModel } from "../../../../core/storefront/listingModel.js";
import {
  isSteamDefaultBranch,
  STEAM_BRANCH,
} from "../../../../core/storefront/rules/steam.js";
import {
  STEAM_NUMERIC_ID,
  SteamClient,
  type SteamBranch,
} from "../../../../core/steam/client.js";
import { openSteamPublisherKey } from "../../commerce/steam.js";
import { StoreUnavailable } from "../../commerce/http.js";
import { listAssets, readListing } from "../../listing/store.js";
import {
  isSteamChecklistItem,
  setSteamChecklistTick,
  STEAM_CHECKLIST,
  steamChecklistView,
} from "./checklist.js";
import { steamCopyCard } from "./copyCard.js";
import { resolveSteamSetup, type SteamSetup } from "./setup.js";

type AdminCtx = ServiceContext & { session: AdminSession };

/** The asset pack slot A-18d registers for Steam. */
export const STEAM_PACK_SLOT = "pack:steam";

/** The publisher-key open's audited use. */
export const STEAM_STOREFRONT_USE = "steam:storefront";

const FALLBACK_LOCALE = "en-US";

/** A refusal raised inside a step (before anything is sent). */
class Refused extends Error {
  constructor(readonly response: Response) {
    super("refused");
  }
}

function budgetKey(setup: SteamSetup): BudgetKey {
  return setup.credentialSource === "platform"
    ? { source: "platform" }
    : { source: "product", credentialId: setup.credentialId };
}

/** The gated client for the product's app, wired to its key, its budget slot and the clock. */
export function steamClientFor(ctx: AdminCtx, setup: SteamSetup): SteamClient {
  const meter = storeMeter(
    ctx.env,
    "steam",
    ctx.product.slug,
    budgetKey(setup),
  );
  return new SteamClient({
    key: () =>
      openSteamPublisherKey(
        ctx.env,
        ctx.db,
        ctx.product.slug,
        setup.appId,
        setup.credentialId,
        STEAM_STOREFRONT_USE,
        ctx.now,
      ),
    budget: {
      stopped: async () => (await meter.read(ctx.now))?.stopped === true,
      spend: () => meter.spend(ctx.now),
      stop: () => meter.stop(ctx.now),
    },
  });
}

/** Map a Steam failure onto the console's answer. */
function failure(e: unknown): Response {
  if (e instanceof Refused) return e.response;
  if (e instanceof StoreWriteDenied)
    return err(422, ErrorCode.BadRequest, e.message, {
      reason: "steam_gate_refused",
      denied: e.reason,
    });
  if (e instanceof StoreUnavailable)
    return err(
      409,
      ErrorCode.BadRequest,
      "the Steam publisher key could not be opened",
      {
        reason: "credential_unavailable",
      },
    );
  if (e instanceof StoreVendorError) {
    if (e.code === "budget_stopped" || e.status === 403)
      return err(
        e.status === 403 ? 502 : 429,
        ErrorCode.BadRequest,
        "Steam refused a call with 403, which rate-limits the Worker's address: every Steam call is stopped until the day's window ends",
        { reason: "steam_stopped", vendorStatus: e.status },
      );
    return err(502, ErrorCode.BadRequest, e.message, {
      reason: "steam_unavailable",
      vendorStatus: e.status,
      vendorCode: e.code,
    });
  }
  throw e;
}

/** Distribution's `storefronts/steam` routes; `null` when the path is not one. */
export async function handleSteamStorefrontAdmin(
  ctx: AdminCtx,
): Promise<Response | null> {
  const { req, rest } = ctx;
  if (rest[0] !== "storefronts" || rest[1] !== "steam") return null;
  const method = req.method;
  const sub = rest[2];
  const notAllowed = () => err(405, ErrorCode.BadRequest, "method not allowed");
  if (rest.length === 2) return method === "GET" ? getPlan(ctx) : notAllowed();
  if (rest.length === 3 && sub === "apps")
    return method === "GET" ? getApps(ctx) : notAllowed();
  if (rest.length === 3 && sub === "builds")
    return method === "GET" ? getBuilds(ctx) : notAllowed();
  if (rest.length === 3 && sub === "pack")
    return method === "GET" || method === "HEAD" ? getPack(ctx) : notAllowed();
  if (rest.length === 3 && sub === "checklist")
    return method === "PUT" ? putChecklist(ctx) : notAllowed();
  if (rest.length === 5 && sub === "branches" && rest[4] === "live")
    return method === "POST" ? postSetLive(ctx, rest[3]!) : notAllowed();
  return null;
}

function links(appId: string | null) {
  return {
    newApp: renderDeepLink("steam.new-app"),
    storePage: appId ? renderDeepLink("steam.store-page", { appId }) : null,
    appAdmin: appId ? renderDeepLink("steam.app-admin", { appId }) : null,
  };
}

async function packRow(ctx: AdminCtx) {
  return (
    (await listAssets(ctx.db, ctx.product.slug)).find(
      (a) => a.slot === STEAM_PACK_SLOT && a.locale === "",
    ) ?? null
  );
}

async function getPlan(ctx: AdminCtx): Promise<Response> {
  const { env, db, product, now } = ctx;
  const adapter = storefrontAdapter("steam")!;
  const resolved = await resolveSteamSetup(env, db, product.slug);
  const appId = resolved.setup?.appId ?? resolved.inert?.appId ?? null;
  const stored = await readListing(db, product.slug);
  const model: ListingModel = stored?.model ?? {
    app: { defaultLocale: FALLBACK_LOCALE },
    locales: {},
    overrides: [],
  };
  const assets = (await listAssets(db, product.slug)).filter((a) =>
    a.slot.startsWith("steam:"),
  );
  const pack = await packRow(ctx);
  const rows = await listStoreOperations(
    db,
    { scope: "product", product: product.slug },
    20,
    "steam",
  );
  const rate = resolved.setup
    ? await readRate(env, "steam", product.slug, budgetKey(resolved.setup), now)
    : null;
  return adminJson({
    store: {
      id: adapter.id,
      label: adapter.label,
      ops: Object.fromEntries(
        Object.entries(adapter.capabilities.ops).map(([op, s]) => [op, s.mode]),
      ),
      limits: adapter.capabilities.limits,
    },
    setup: resolved.setup
      ? {
          appId: resolved.setup.appId,
          branches: resolved.setup.branches,
          outletIds: resolved.setup.outletIds,
          credentialSource: resolved.setup.credentialSource,
        }
      : null,
    inert: resolved.inert,
    links: links(appId),
    checklist: await steamChecklistView(db, product.slug, appId),
    copyCard: { exists: stored !== null, ...steamCopyCard({ model }) },
    pack: pack
      ? {
          sha256: pack.sha256,
          source: pack.source,
          modifiedAt: pack.modified_at,
          download: `/manage/api/products/${product.slug}/distribution/storefronts/steam/pack`,
        }
      : null,
    assets: assets.map((a) => ({
      slot: a.slot,
      sha256: a.sha256,
      width: a.width,
      height: a.height,
      source: a.source,
    })),
    operations: rows.map((r) => ({
      opId: r.op_id,
      op: r.op,
      state: r.state,
      naturalKey: r.natural_key,
      vendorStatus: r.vendor_status,
      vendorCode: r.vendor_code,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    })),
    budget: rate
      ? {
          limit: rate.limit,
          remaining: rate.remaining,
          stopped: rate.stopped === true,
          until: rate.until ?? null,
        }
      : null,
  });
}

/** The setup, or the inert refusal. */
async function setupOr(ctx: AdminCtx): Promise<SteamSetup | Response> {
  const resolved = await resolveSteamSetup(ctx.env, ctx.db, ctx.product.slug);
  if (resolved.setup) return resolved.setup;
  return err(409, ErrorCode.BadRequest, resolved.inert.message, {
    reason: `steam_${resolved.inert.reason}`,
  });
}

async function getApps(ctx: AdminCtx): Promise<Response> {
  const setup = await setupOr(ctx);
  if (setup instanceof Response) return setup;
  try {
    const apps = await steamClientFor(ctx, setup).apps();
    return adminJson({
      appId: setup.appId,
      listed: apps.some((a) => a.appId === setup.appId),
      apps,
    });
  } catch (e) {
    return failure(e);
  }
}

async function getBuilds(ctx: AdminCtx): Promise<Response> {
  const setup = await setupOr(ctx);
  if (setup instanceof Response) return setup;
  try {
    const client = steamClientFor(ctx, setup);
    const branches = await client.betas(setup.appId);
    const builds = await client.builds(setup.appId);
    const live = (name: string) =>
      branches.find((b) => b.name === name)?.buildId ?? null;
    return adminJson({
      appId: setup.appId,
      branches,
      builds,
      declared: Object.entries(setup.branches).map(([channel, branch]) => ({
        channel,
        branch,
        buildId: live(branch),
      })),
      public: { buildId: live("public"), link: links(setup.appId).appAdmin },
    });
  } catch (e) {
    return failure(e);
  }
}

const branchResource = (b: SteamBranch): StoreResource => ({
  type: "betas",
  id: b.name,
  attributes: {
    name: b.name,
    buildId: b.buildId,
    description: b.description,
    updatedAt: b.updatedAt,
    locked: b.locked,
  },
});

async function postSetLive(ctx: AdminCtx, branch: string): Promise<Response> {
  const { db, product, session, now } = ctx;
  if (!STEAM_BRANCH.test(branch))
    return err(422, ErrorCode.BadRequest, "not a Steam branch name", {
      reason: "invalid_branch",
      fields: ["branch"],
    });
  const setup = await setupOr(ctx);
  if (setup instanceof Response) return setup;
  if (isSteamDefaultBranch(branch))
    return err(
      409,
      ErrorCode.BadRequest,
      "the default (public) branch is set live in Steamworks App Admin, not by Polaris Key (S-15 decision 5, until the key is verified)",
      { reason: "public_branch_deep_link", link: links(setup.appId).appAdmin },
    );
  const key = ctx.req.headers.get("idempotency-key");
  if (!isIdempotencyKey(key))
    return err(
      428,
      ErrorCode.BadRequest,
      "send an Idempotency-Key header (a UUID per operator intent)",
      { reason: "idempotency_key_required" },
    );
  const body = await readBody(ctx.req);
  const stray = Object.keys(body).filter(
    (k) => k !== "buildId" && k !== "description",
  );
  const buildId =
    typeof body.buildId === "number" ? String(body.buildId) : body.buildId;
  const fields: string[] = [...stray];
  if (typeof buildId !== "string" || !STEAM_NUMERIC_ID.test(buildId))
    fields.push("buildId");
  if (
    body.description !== undefined &&
    (typeof body.description !== "string" ||
      body.description.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(body.description))
  )
    fields.push("description");
  if (fields.length)
    return err(
      422,
      ErrorCode.BadRequest,
      "buildId (a Steam build id) is required; description is optional text of at most 200 characters",
      { reason: "invalid_body", fields },
    );
  const build = buildId as string;
  const description = body.description as string | undefined;
  const client = steamClientFor(ctx, setup);
  const find = async (): Promise<StoreResource | null> => {
    const b = (await client.betas(setup.appId)).find((x) => x.name === branch);
    if (!b)
      throw new Refused(
        err(
          404,
          ErrorCode.NotFound,
          `app ${setup.appId} has no branch ${branch}: create it in Steamworks App Admin first`,
          {
            reason: "unknown_branch",
            link: links(setup.appId).appAdmin,
          },
        ),
      );
    return branchResource(b);
  };
  try {
    const r = await performStoreWrite(db, {
      key: {
        store: "steam",
        scope: "product",
        product: product.slug,
        op: "branch.set_live",
        naturalKey: `${setup.appId}/${branch}/${build}`,
        idempotencyKey: key,
      },
      request: {
        appId: setup.appId,
        branch,
        buildId: build,
        description: description ?? null,
      },
      session,
      now,
      find,
      satisfied: (existing) => existing.attributes?.buildId === build,
      write: async () => {
        await client.setBuildLive(setup.appId, build, branch, description);
        return null;
      },
      reread: async () => find(),
      resultIds: () => ({ appId: setup.appId, branch, buildId: build }),
      summary: (after, outcome) =>
        `${outcome === "existing" ? "Found" : "Set"} build ${build} live on Steam branch ${branch} of app ${setup.appId}${after.attributes?.buildId === build ? "" : " (Steam does not show it yet)"}`,
    });
    if (r.outcome === "conflict")
      return err(
        409,
        ErrorCode.BadRequest,
        "this Idempotency-Key was used for another request",
        {
          reason: "idempotency_conflict",
        },
      );
    if (r.outcome === "replayed")
      return adminJson({
        outcome: "replayed",
        opId: r.row.op_id,
        state: r.row.state,
      });
    return adminJson({
      outcome: r.outcome,
      opId: r.opId,
      branch: r.after,
      live: r.after?.attributes.buildId === build,
    });
  } catch (e) {
    return failure(e);
  }
}

async function getPack(ctx: AdminCtx): Promise<Response> {
  const { env, db, product } = ctx;
  const row = await packRow(ctx);
  if (!row || !env.BLOBS || !(await hasRef(db, product.slug, row.blob)))
    return err(
      404,
      ErrorCode.NotFound,
      "no Steam asset pack yet: run pkey listing assets in CI",
      {
        reason: "no_pack",
      },
    );
  return blobResponse(ctx.req, env.BLOBS, row.blob, {
    sha256: row.sha256,
    gated: true,
    env,
    host: "console",
    filename: `${product.slug}-steam-assets.zip`,
  });
}

async function putChecklist(ctx: AdminCtx): Promise<Response> {
  const { db, product, session, now } = ctx;
  const body = await readBody(ctx.req);
  const fields: string[] = [];
  if (!isSteamChecklistItem(body.item)) fields.push("item");
  if (typeof body.done !== "boolean") fields.push("done");
  if (fields.length)
    return err(
      422,
      ErrorCode.BadRequest,
      `item (${STEAM_CHECKLIST.map((c) => c.item).join(", ")}) and done (boolean) are required`,
      { reason: "invalid_body", fields },
    );
  const resolved = await resolveSteamSetup(ctx.env, db, product.slug);
  const appId = resolved.setup?.appId ?? resolved.inert?.appId ?? null;
  if (!appId)
    return err(409, ErrorCode.BadRequest, resolved.inert!.message, {
      reason: `steam_${resolved.inert!.reason}`,
    });
  const item = body.item as (typeof STEAM_CHECKLIST)[number]["item"];
  const done = body.done as boolean;
  const label = await setSteamChecklistTick(
    db,
    product.slug,
    appId,
    item,
    done,
    session.sub,
    now,
  );
  await audit(
    db,
    product.slug,
    session,
    now,
    `distribution.steam.checklist.${done ? "tick" : "untick"}`,
    { kind: "steam-checklist", id: `${appId}/${item}` },
    `${done ? "Ticked" : "Unticked"} the Steam step "${label}" for app ${appId} (an operator assertion; not verified)`,
  );
  return adminJson({
    checklist: await steamChecklistView(db, product.slug, appId),
  });
}
