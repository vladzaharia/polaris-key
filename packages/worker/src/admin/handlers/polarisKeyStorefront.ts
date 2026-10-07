/**
 * The Polaris Key storefront's console panel (PS-06; notes/S-21 §6.6, §6.7) —
 * `/manage/api/products/<slug>/storefronts/polaris-key…`:
 *
 *     GET  …/storefronts/polaris-key            the first-party `status` op: the listing state, the
 *                                               configured and offered obtain paths, the mapped
 *                                               groups with their labels, and the readiness
 *                                               checklist (`PolarisKeyStatus`)
 *     POST …/storefronts/polaris-key/preview    "Who can see this?": `{platformAccount?, groups?,
 *                                               emailDomain?, stores?, holds?}`, a SYNTHETIC person,
 *                                               answered with the Discover tile that person would
 *                                               see (or why they see none)
 *     GET  …/storefronts/polaris-key/analytics  the last 28 days of `storefront_daily`: totals, per
 *                                               path kind and per day
 *
 * CORE, like `assets`: every product can list on Polaris Key whether or not it runs Distribution
 * (notes/S-21 §6.2), so the panel is not under a service. It is the composition root of the
 * first-party ports (`core/storefront/firstParty.ts`): Identity answers `status` from the tables
 * and the engine it owns (`services/identity/portal/store/panelStatus.ts`), Distribution the listing
 * model's fit for `polaris-key` (its own tables), and the GET runs the declared handler
 * (`polaris-key.status`) over them, so the panel and the conformance suite read the same op.
 *
 * WRITES. The panel changes the listing through Identity's portal-settings route (`PATCH
 * …/identity/portal`, PS-02: `storefront.polarisKey.*` through `writeSetting()`, audited
 * `storefront.polarisKey.update`, audience `everyone` behind its level-2 confirmation), never
 * through these routes, which write nothing: no row, no audit, no impression. The preview is a
 * POST only because it carries a body.
 *
 * THE PREVIEW NEVER IDENTIFIES A PERSON (owner decision 11). Its body is closed: exactly
 * `PERSONA_FIELDS`, none of which names or looks up a person (IdP group names, an email DOMAIN,
 * store ids, two booleans); any other key, an email address included, is refused with 422. The
 * engine runs on the persona in memory (`previewPersona`) and reads no account row.
 *
 * Narrative-only (rule 10, `routeCoverage`'s `adminApi` kind); session, CSRF, rate limit and the
 * platform-admin gate run in `admin/api.ts` first.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { buildHooks } from "../../core/hooks.js";
import { loadProductPublic, type ProductPublic } from "../../core/products.js";
import {
  firstPartyHandler,
  firstPartyHandlerName,
  type FirstPartyPorts,
} from "../../core/storefront/firstParty.js";
import {
  fitReport,
  projectListing,
  type FitStatus,
} from "../../core/storefront/projection.js";
import { GROUP_NAME_MAX } from "../../core/storefront/polarisKeyListing.js";
import { SERVICES } from "../../mount.js";
import { readListing } from "../../services/distribution/listing/store.js";
import { storefrontTileView } from "../../services/identity/portal/discover.js";
import { storefrontAnalytics } from "../../services/identity/portal/store/analytics.js";
import { polarisKeyStatus } from "../../services/identity/portal/store/panelStatus.js";
import {
  previewPersona,
  type Persona,
} from "../../services/identity/portal/store/obtain.js";
import type { AdminSession } from "../session.js";
import { audit } from "../audit.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";

/** The store id these routes serve; every other `storefronts/<id>` is 404. */
export const POLARIS_KEY_STORE = "polaris-key";

/**
 * THE PREVIEW'S WHOLE INPUT. A test pins this list and checks that none of it identifies a
 * person; a key outside it is refused, never ignored.
 */
export const PERSONA_FIELDS = [
  "platformAccount",
  "groups",
  "emailDomain",
  "stores",
  "holds",
] as const;

/** At most this many groups and linked stores in one persona. */
export const PERSONA_GROUPS_MAX = 50;
export const PERSONA_STORES_MAX = 10;

/** A DNS name: labels of letters, digits and inner hyphens, a letter-led last label. No `@`. */
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
/** A store id (`steam`). */
const STORE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type PersonaParse =
  | { ok: true; persona: Persona }
  | { ok: false; fields: string[] };

/** Validate a preview body into a persona. See `PERSONA_FIELDS`. */
export function parsePersona(body: Record<string, unknown>): PersonaParse {
  const fields: string[] = [];
  for (const k of Object.keys(body))
    if (!(PERSONA_FIELDS as readonly string[]).includes(k)) fields.push(k);

  const bool = (k: string, dflt: boolean): boolean => {
    const v = body[k];
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") fields.push(k);
    return v === true;
  };
  const list = (
    k: string,
    max: number,
    ok: (s: string) => boolean,
  ): string[] => {
    const v = body[k];
    if (v === undefined) return [];
    if (
      !Array.isArray(v) ||
      v.length > max ||
      !v.every((x) => typeof x === "string" && ok(x))
    ) {
      fields.push(k);
      return [];
    }
    return [...new Set(v as string[])];
  };

  const platformAccount = bool("platformAccount", true);
  const holds = bool("holds", false);
  const groups = list(
    "groups",
    PERSONA_GROUPS_MAX,
    (g) => g.length > 0 && g.length <= GROUP_NAME_MAX,
  );
  const stores = list("stores", PERSONA_STORES_MAX, (s) => STORE_ID_RE.test(s));
  let emailDomain: string | null = null;
  const d = body.emailDomain;
  if (d !== undefined && d !== null && d !== "") {
    const domain = typeof d === "string" ? d.trim().toLowerCase() : "";
    if (DOMAIN_RE.test(domain)) emailDomain = domain;
    else fields.push("emailDomain");
  }
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    persona: { platformAccount, groups, emailDomain, stores, holds },
  };
}

interface Ctx {
  req: Request;
  env: Env;
  db: Db;
  session: AdminSession;
  product: ProductPublic;
  now: number;
}

/** `storefronts/…` in product scope; `rest` is the path after `storefronts`. */
export async function handleProductStorefronts(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest[0] !== POLARIS_KEY_STORE || rest.length > 2)
    return err(404, "not_found", "no such storefront panel", {
      reason: "unknown_store",
    });
  const product = await loadProductPublic(db, slug);
  if (!product) return notFound();
  const ctx: Ctx = { req, env, db, session, product, now };
  const sub = rest[1];
  if (sub === undefined)
    return req.method === "GET" ? status(ctx) : notAllowed();
  if (sub === "preview")
    return req.method === "POST" ? preview(ctx) : notAllowed();
  if (sub === "analytics")
    return req.method === "GET" ? analytics(ctx) : notAllowed();
  return notFound();
}

const notAllowed = () => err(405, ErrorCode.BadRequest, "method not allowed");

function hooksFor(env: Env, db: Db) {
  return (product: ProductPublic, at: number) =>
    buildHooks(SERVICES, product.services, { env, db, product, now: at });
}

/**
 * The listing model's grade for `polaris-key` in its default locale (PS-01's readiness check 2),
 * from Distribution's own tables; `null` when the product has no listing.
 */
export async function polarisKeyListingFit(
  db: Db,
  product: string,
): Promise<FitStatus | null> {
  const stored = await readListing(db, product);
  if (!stored) return null;
  const locale = stored.model.app.defaultLocale;
  const [row] = fitReport({ model: stored.model }, [POLARIS_KEY_STORE]);
  const issues = (row?.issues ?? []).filter(
    (i) => i.locale === null || i.locale === locale,
  );
  if (issues.some((i) => i.severity === "block")) return "red";
  return issues.length ? "amber" : "green";
}

/**
 * The first-party ports for one product (`FirstPartyPorts`), each implemented by the service that
 * owns the table it reads. Only the reads are served from the console: the panel's listing
 * writes are Identity's portal-settings route, and the A-18j flow has no Polaris Key steps
 * (SETUP.md D48: the built-in storefront has no wizard), so nothing calls a write handler here.
 */
export function polarisKeyPorts(ctx: Omit<Ctx, "req">): FirstPartyPorts {
  const { env, db, product, now, session } = ctx;
  const unserved = (op: string) => async (): Promise<never> => {
    throw new Error(
      `${op} is not served by the Polaris Key panel's routes: the console writes the listing through Identity's portal settings and Distribution's listing model`,
    );
  };
  return {
    async readListing(slug) {
      const stored = await readListing(db, slug);
      return stored
        ? {
            model: stored.model,
            projection: projectListing(
              { model: stored.model },
              POLARIS_KEY_STORE,
            ),
          }
        : null;
    },
    writeListing: unserved("writeListing"),
    setListing: unserved("setListing"),
    async status(slug) {
      return polarisKeyStatus({
        env,
        db,
        product,
        delivery: hooksFor(env, db)(product, now).delivery(),
        now,
        listingFit: await polarisKeyListingFit(db, slug),
      });
    },
    async audit(entry) {
      await audit(
        db,
        entry.product,
        session,
        now,
        `distribution.${POLARIS_KEY_STORE}.${entry.op}`,
        entry.target,
        entry.summary,
      );
    },
  };
}

async function status(ctx: Ctx): Promise<Response> {
  const handler = firstPartyHandler(firstPartyHandlerName("status"))!;
  const body = await handler.run({
    product: ctx.product.slug,
    ports: polarisKeyPorts(ctx),
  });
  return adminJson(body);
}

async function preview(ctx: Ctx): Promise<Response> {
  const parsed = parsePersona(await readBody(ctx.req));
  if (!parsed.ok)
    return err(
      422,
      ErrorCode.BadRequest,
      "a preview takes a persona: platformAccount, groups, emailDomain, stores and holds, nothing that names a person",
      { fields: parsed.fields },
    );
  const { env, db, product, now } = ctx;
  const persona = parsed.persona;
  const hooks = hooksFor(env, db);
  const result = await previewPersona(env, db, product.slug, persona, now, {
    hooksFor: hooks,
  });
  const tile = result.evaluation
    ? await storefrontTileView(env, db, result.evaluation, hooks, now)
    : null;
  return adminJson({
    persona,
    visible: result.verdict.visible,
    hidden: result.hidden,
    tile,
  });
}

async function analytics(ctx: Ctx): Promise<Response> {
  const a = await storefrontAnalytics(ctx.db, ctx.product.slug, ctx.now);
  return adminJson({
    ...a,
    // Impressions are deduplicated with keys derived from the pepper; without it none is counted
    // (`recordImpressions`), so the card says why the column is empty.
    impressionsCounted: Boolean(ctx.env.KEY_HASH_PEPPER),
  });
}
