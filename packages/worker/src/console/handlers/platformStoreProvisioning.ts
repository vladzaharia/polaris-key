/**
 * Team provisioning on App Store Connect (A-17b; notes/S-14 §6, §7, §8.1): the New-app wizard's
 * API, before any app record exists. Platform admins only (the store-connections dispatcher checks
 * `isPlatformAdmin` before routing here), under `/manage/api/platform/store-connections/app-store`:
 *
 *   GET  …/capability-types
 *        The wizard's capability list (no Apple call). App Attest is the `entitlement` row:
 *        "entitlement in the export preset; no portal step" (A-17h: no such capability type).
 *   GET  …/bundle-ids                      the team's bundle ids (bounded)
 *   GET  …/bundle-ids?identifier=<id>      one bundle id by identifier, its capabilities, the app
 *                                          that uses it and the product holding that app
 *   POST …/bundle-ids                      `{identifier, platform, name?}` + `Idempotency-Key`
 *        Register (or find: a duplicate is `existing`, A-17h's 409 re-read by identifier).
 *   GET  …/bundle-ids/<resourceId>/capabilities
 *   POST …/bundle-ids/<resourceId>/capabilities   `{types, product?, confirm?}` + `Idempotency-Key`
 *        Enable the missing types, one idempotent ledger step each. When the bundle id's app is
 *        held by a product other than `product`, the operator must type that app's name in
 *        `confirm` (S-14 §7.1, §7.2 item 4): 422 `confirmation_required` / `confirmation_mismatch`
 *        names the holder, and nothing is sent.
 *   GET  …/apps/lookup?bundleId=<id>[&poll=1]
 *        The app record with that bundle id, or `found: false` (the wizard polls it while the
 *        operator creates the record in the portal: `POST /v1/apps` does not exist). `poll=1` is
 *        background spending: refused with 429 `asc_budget_low` below 20 % of the team key's
 *        hourly budget, which the P5-02 poller shares (core/storefront/budget.ts).
 *   GET  …/signing
 *        Certificates and profiles with their expiry: READ only (no create, revoke or delete
 *        exists on this surface, and the write gate refuses them all).
 *   GET  …/operations
 *        The team scope's ledger rows, newest first (the wizard's resumable progress).
 *
 * Every write goes through A-17a: the gated client (`connectors/asc/platform.ts`'s team client,
 * whose bearer is minted only after `checkAscRequest` admits the request), the operation ledger
 * and one `platform.asc.<op>` row in the platform trail with Apple's before and after. This file
 * imports neither the platform credential module nor a token minter: who holds an app comes from
 * the dispatcher (`holderOf`), the client from the one reviewed builder.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { getProduct } from "../../core/repo.js";
import {
  AscError,
  AscWriteDenied,
  type AscClient,
} from "../../core/asc/client.js";
import {
  isIdempotencyKey,
  listStoreOperations,
  type StoreWriteResult,
} from "../../core/storefront/ledger.js";
import {
  budgetAllows,
  readRate,
  recordTeamRate,
} from "../../core/storefront/budget.js";
import {
  appView,
  BUNDLE_PLATFORMS,
  bundleIdView,
  capabilitiesView,
  defaultBundleName,
  enableCapability,
  ENABLEABLE_CAPABILITIES,
  findBundleId,
  getBundleId,
  isBundleIdentifier,
  isBundleName,
  isBundleResourceId,
  listBundleIds,
  listCapabilities,
  lookupAppByBundleId,
  registerBundleId,
  signingExpiry,
  WIZARD_CAPABILITIES,
  type BundlePlatform,
  type TeamWriteContext,
} from "../../core/ascProvisioning.js";
import { platformAscClient } from "../../services/distribution/connectors/asc/platform.js";
import type { AdminSession } from "../../core/console/session.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";

/** Which product holds an app (by its Apple ID) or its bundle id, or null. */
export type AscHolderOf = (
  appId: string | null,
  bundleIdentifier: string,
) => Promise<string | null>;

export interface ProvisioningContext {
  req: Request;
  env: Env;
  db: Db;
  session: AdminSession;
  now: number;
  holderOf: AscHolderOf;
}

/** The most capability types one request may enable. */
const MAX_TYPES = 10;

const methodNotAllowed = () => err(405, "bad_request", "method not allowed");

/**
 * Route `rest` (after `app-store`) when it names a provisioning route; null otherwise, so the
 * dispatcher keeps its own routes.
 */
export function routeAscProvisioning(
  c: ProvisioningContext,
  rest: string[],
): Promise<Response> | null {
  const [sub, a, b] = rest;
  const m = c.req.method;
  if (sub === "capability-types" && rest.length === 1)
    return Promise.resolve(
      m === "GET"
        ? adminJson({ ok: true, capabilities: WIZARD_CAPABILITIES })
        : methodNotAllowed(),
    );
  if (sub === "bundle-ids" && rest.length === 1) {
    if (m === "GET") return withClient(c, (client) => bundleIds(c, client));
    if (m === "POST") return withClient(c, (client) => register(c, client));
    return Promise.resolve(methodNotAllowed());
  }
  if (sub === "bundle-ids" && b === "capabilities" && rest.length === 3) {
    if (!isBundleResourceId(a)) return Promise.resolve(notFound());
    if (m === "GET") return withClient(c, (client) => capabilities(client, a));
    if (m === "POST") return withClient(c, (client) => enable(c, client, a));
    return Promise.resolve(methodNotAllowed());
  }
  if (sub === "apps" && a === "lookup" && rest.length === 2) {
    if (m !== "GET") return Promise.resolve(methodNotAllowed());
    return lookup(c);
  }
  if (sub === "signing" && rest.length === 1) {
    if (m !== "GET") return Promise.resolve(methodNotAllowed());
    return withClient(c, async (client) =>
      adminJson({ ok: true, ...(await signingExpiry(client, c.now)) }),
    );
  }
  if (sub === "operations" && rest.length === 1) {
    if (m !== "GET") return Promise.resolve(methodNotAllowed());
    return operations(c);
  }
  return null;
}

// ── plumbing ─────────────────────────────────────────────────────────────────────────────────

/**
 * Run `fn` with a team client; map Apple's and the gate's refusals; keep the team key's budget
 * (shared with every product's poller) whatever happens.
 */
async function withClient(
  c: ProvisioningContext,
  fn: (client: AscClient) => Promise<Response>,
): Promise<Response> {
  const client = await platformAscClient({
    env: c.env,
    db: c.db,
    actor: { sub: c.session.sub, name: c.session.name, email: c.session.email },
    use: "asc:platform-provisioning",
    now: c.now,
  });
  if (!client)
    return err(
      409,
      "not_configured",
      "the platform App Store connection has no usable App Store Connect key: store one in the console or set PLATFORM_ASC_API_KEY",
    );
  try {
    return await fn(client);
  } catch (e) {
    const mapped = ascFailure(e);
    if (mapped) return mapped;
    throw e;
  } finally {
    await recordTeamRate(c.env, "app-store", client.lastRate, c.now);
  }
}

/** Apple's or the gate's refusal as an admin response (a status line and Apple's code only). */
function ascFailure(e: unknown, extra: Record<string, unknown> = {}) {
  // The write gate refused before anything was minted or sent (core/storefront/rules/appStore.ts).
  if (e instanceof AscWriteDenied)
    return err(409, "write_denied", e.message, { reason: e.reason, ...extra });
  if (e instanceof AscError) {
    const unavailable = e.status === 0 || e.status === 401 || e.status === 429;
    return err(
      e.status === 404 ? 404 : unavailable || e.status >= 500 ? 502 : 409,
      unavailable || e.status >= 500 ? "store_unavailable" : "store_refused",
      e.message,
      { appleStatus: e.status, appleCode: e.code, ...extra },
    );
  }
  return null;
}

function idempotencyKeyOf(req: Request): string | Response {
  const k = req.headers.get("idempotency-key");
  return isIdempotencyKey(k)
    ? k
    : err(
        428,
        "idempotency_key_required",
        "send an Idempotency-Key header (a UUID per user intent) with every App Store Connect write",
      );
}

/** One step's result in the shape every write answers. */
function stepView(r: Exclude<StoreWriteResult, { outcome: "conflict" }>) {
  if (r.outcome === "replayed")
    return {
      outcome: "replayed" as const,
      opId: r.row.op_id,
      resultIds: JSON.parse(r.row.result_ids_json ?? "{}") as Record<
        string,
        string
      >,
      after: r.row.after_json
        ? (JSON.parse(r.row.after_json) as unknown)
        : null,
    };
  return {
    outcome: r.outcome,
    opId: r.opId,
    resultIds: r.resultIds,
    after: r.after,
  };
}

const conflict = () =>
  err(
    409,
    "idempotency_conflict",
    "this Idempotency-Key was already used for a different request: send a new key for a new intent",
  );

// ── bundle ids ───────────────────────────────────────────────────────────────────────────────

async function bundleIds(
  c: ProvisioningContext,
  client: AscClient,
): Promise<Response> {
  const identifier = new URL(c.req.url).searchParams.get("identifier");
  if (identifier === null)
    return adminJson({ ok: true, ...(await listBundleIds(client)) });
  if (!isBundleIdentifier(identifier))
    return err(422, "bad_request", "identifier must be a bundle identifier", {
      fields: ["identifier"],
    });
  const found = await findBundleId(client, identifier);
  const app = await lookupAppByBundleId(client, identifier);
  const caps = found ? await listCapabilities(client, found.id) : null;
  return adminJson({
    ok: true,
    identifier,
    found: found !== null,
    bundleId: found ? bundleIdView(found) : null,
    app: app ? appView(app) : null,
    assignedProduct: await c.holderOf(app?.id ?? null, identifier),
    ...(found && caps ? capabilitiesView(caps, found.id) : {}),
  });
}

async function register(
  c: ProvisioningContext,
  client: AscClient,
): Promise<Response> {
  const key = idempotencyKeyOf(c.req);
  if (key instanceof Response) return key;
  const body = await readBody(c.req);
  if (!isBundleIdentifier(body.identifier))
    return err(
      422,
      "bad_request",
      "identifier must be an explicit reverse-DNS bundle identifier (no wildcard)",
      { fields: ["identifier"] },
    );
  if (
    typeof body.platform !== "string" ||
    !(BUNDLE_PLATFORMS as readonly string[]).includes(body.platform)
  )
    return err(
      422,
      "bad_request",
      `platform must be one of ${BUNDLE_PLATFORMS.join(", ")}`,
      { fields: ["platform"] },
    );
  const name =
    body.name === undefined || body.name === null || body.name === ""
      ? defaultBundleName(body.identifier)
      : body.name;
  if (!isBundleName(name))
    return err(
      422,
      "bad_request",
      "name must be letters, digits and spaces (at most 60)",
      { fields: ["name"] },
    );
  const r = await registerBundleId(teamCtx(c, client, key), {
    identifier: body.identifier,
    name,
    platform: body.platform as BundlePlatform,
  });
  if (r.outcome === "conflict") return conflict();
  return adminJson({ ok: true, ...stepView(r) });
}

function teamCtx(
  c: ProvisioningContext,
  client: AscClient,
  idempotencyKey: string,
): TeamWriteContext {
  return { db: c.db, client, session: c.session, now: c.now, idempotencyKey };
}

// ── capabilities ─────────────────────────────────────────────────────────────────────────────

async function capabilities(
  client: AscClient,
  bundleResourceId: string,
): Promise<Response> {
  const bundle = await getBundleId(client, bundleResourceId);
  if (!bundle)
    return err(404, "bundle_id_not_found", "no such bundle id on the team");
  return adminJson({
    ok: true,
    bundleId: bundleIdView(bundle),
    ...capabilitiesView(
      await listCapabilities(client, bundleResourceId),
      bundleResourceId,
    ),
  });
}

async function enable(
  c: ProvisioningContext,
  client: AscClient,
  bundleResourceId: string,
): Promise<Response> {
  const key = idempotencyKeyOf(c.req);
  if (key instanceof Response) return key;
  const body = await readBody(c.req);
  const raw = body.types;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_TYPES ||
    !raw.every((t) => typeof t === "string")
  )
    return err(
      422,
      "bad_request",
      `types must be a list of 1 to ${MAX_TYPES} capability types`,
      { fields: ["types"] },
    );
  const types = [...new Set(raw as string[])];
  if (types.includes("APP_ATTEST"))
    return err(
      422,
      "entitlement_only",
      "App Attest is not a capability: it is an entitlement in the export preset; no portal step",
      { fields: ["types"] },
    );
  const unknown = types.filter((t) => !ENABLEABLE_CAPABILITIES.includes(t));
  if (unknown.length > 0)
    return err(
      422,
      "bad_request",
      `not offered: ${unknown.join(", ")} (offered: ${ENABLEABLE_CAPABILITIES.join(", ")})`,
      { fields: ["types"] },
    );
  let product: string | null = null;
  if (body.product !== undefined && body.product !== null) {
    if (
      typeof body.product !== "string" ||
      !/^[a-z0-9-]+$/.test(body.product) ||
      !(await getProduct(c.db, body.product))
    )
      return err(422, "bad_request", "product must be an existing product", {
        fields: ["product"],
      });
    product = body.product;
  }

  const bundle = await getBundleId(client, bundleResourceId);
  if (!bundle)
    return err(404, "bundle_id_not_found", "no such bundle id on the team");
  const identifier = bundleIdView(bundle).identifier;
  if (!identifier || !isBundleIdentifier(identifier))
    return err(
      409,
      "bundle_id_unsupported",
      "this bundle id has no explicit identifier (a wildcard App ID cannot take these capabilities)",
    );
  const before = await listCapabilities(client, bundleResourceId);
  const missing = types.filter(
    (t) =>
      !capabilitiesView(before, bundleResourceId).capabilities.some(
        (x) => x.type === t && x.enabled === true,
      ),
  );

  // Another product's app: typed confirmation of that app's name (S-14 §7.1), checked here
  // because the gate cannot know who holds a bundle id (A-17a corrections). Only when something
  // would change.
  if (missing.length > 0) {
    const app = await lookupAppByBundleId(client, identifier);
    const holder = await c.holderOf(app?.id ?? null, identifier);
    if (holder !== null && holder !== product) {
      const phrase = (app ? appView(app).name : null) ?? identifier;
      const typed = typeof body.confirm === "string" ? body.confirm.trim() : "";
      if (typed === "")
        return err(
          422,
          "confirmation_required",
          `this bundle id belongs to product ${holder}'s app: type ${app ? "the app's name" : "the bundle identifier"} in confirm to change it`,
          {
            fields: ["confirm"],
            holder,
            appName: app ? appView(app).name : null,
          },
        );
      if (typed !== phrase.trim())
        return err(
          422,
          "confirmation_mismatch",
          `confirm does not match ${app ? "the app's name in App Store Connect" : "the bundle identifier"}`,
          { fields: ["confirm"], holder },
        );
    }
  }

  const ctx = teamCtx(c, client, key);
  const results: Array<ReturnType<typeof stepView> & { type: string }> = [];
  for (const type of types) {
    try {
      const r = await enableCapability(ctx, {
        bundleResourceId,
        identifier,
        type,
      });
      if (r.outcome === "conflict") return conflict();
      results.push({ type, ...stepView(r) });
    } catch (e) {
      // Report what was done before the refusal: each step is resumable under the same key.
      const mapped = ascFailure(e, { type, results });
      if (mapped) return mapped;
      throw e;
    }
  }
  return adminJson({
    ok: true,
    bundleId: bundleIdView(bundle),
    results,
    ...capabilitiesView(
      await listCapabilities(client, bundleResourceId),
      bundleResourceId,
    ),
  });
}

// ── app lookup ───────────────────────────────────────────────────────────────────────────────

async function lookup(c: ProvisioningContext): Promise<Response> {
  const q = new URL(c.req.url).searchParams;
  const identifier = q.get("bundleId");
  if (!isBundleIdentifier(identifier))
    return err(422, "bad_request", "bundleId must be a bundle identifier", {
      fields: ["bundleId"],
    });
  // The wizard's every-10-seconds detection is background spending: it yields to the pollers.
  if (/^(1|true)$/.test(q.get("poll") ?? "")) {
    const rate = await readRate(
      c.env,
      "app-store",
      "",
      { source: "platform" },
      c.now,
    );
    if (!budgetAllows(rate, "background"))
      return err(
        429,
        "asc_budget_low",
        "the team key's App Store Connect budget is low: detection pauses (press “I've created it” to check now)",
        { remaining: rate?.remaining ?? null, limit: rate?.limit ?? null },
      );
  }
  return withClient(c, async (client) => {
    const app = await lookupAppByBundleId(client, identifier);
    return adminJson({
      ok: true,
      bundleId: identifier,
      found: app !== null,
      app: app ? appView(app) : null,
      assignedProduct: await c.holderOf(app?.id ?? null, identifier),
    });
  });
}

// ── operations (the ledger) ──────────────────────────────────────────────────────────────────

async function operations(c: ProvisioningContext): Promise<Response> {
  const n = Number(new URL(c.req.url).searchParams.get("limit") ?? "50");
  const rows = await listStoreOperations(
    c.db,
    { scope: "team" },
    Number.isFinite(n) ? n : 50,
  );
  return adminJson({
    ok: true,
    operations: rows.map((r) => ({
      opId: r.op_id,
      op: r.op,
      naturalKey: r.natural_key,
      state: r.state,
      resultIds: r.result_ids_json
        ? (JSON.parse(r.result_ids_json) as unknown)
        : null,
      after: r.after_json ? (JSON.parse(r.after_json) as unknown) : null,
      appleStatus: r.vendor_status,
      appleCode: r.vendor_code,
      actor: r.actor,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    })),
  });
}
