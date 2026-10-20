/**
 * The manifest ingest pipeline (P0-26, CQW-05): one place that plans and applies a parsed
 * `.pkey/` to a product, for link (`create`) and resync (`apply`).
 *
 * Core and each mounted service contribute through `contributes.manifest`
 * (`ManifestContributor`). The phases:
 *
 *   1. Read    the product row (or the caller's), the effective service set.
 *   2. Refuse  every contributor's lazy checks, in `REFUSAL_ORDER`, stopping at the first. Nothing
 *              is written, and a refused ingest reads no more than the old per-path code did.
 *   3. Sweep   (apply) an edge-mint approval the product has WIDENED is deleted before the batch.
 *   4. Prepare each contributor builds its statements: Core first, then each mounted service in
 *              canonical `SERVICE_SLUGS` order, WHATEVER its enablement (it reads `ctx.enabled`).
 *   5. Finalize late re-reads, as close to the batch as the old code ran them; may still refuse.
 *   6. Batch   Core's statements, each service's, ST-42's tail, every audit row, the snapshot: ONE
 *              `db.batch`.
 *   7. After   service steps (store sync, generation bump, pack sets, mirrors) then Core's
 *              (service transitions, hosted assets). They never throw.
 *
 * The final widening sweep (`finally`) stays with the apply's caller, as it always has: it must
 * also run when the manifest could not be read.
 */

import {
  parseServices,
  serializeServices,
  SERVICE_SLUGS,
} from "../services.js";
import type { ServicesMap } from "../services.js";
import type { Db, DbStatement } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { Catalog } from "@polaris-key/catalog";
import { getActiveSchema, getProduct } from "../products/store.js";
import {
  managedSecretKeyPredicate,
  parseStoredCatalog,
} from "./manifestSecrets.js";
import { claimsForApply } from "../settingsClaims.js";
import {
  getManifestSnapshot,
  manifestSnapshotStatement,
} from "../manifestSnapshot.js";
import { invalidateWidenedEdgeMintApprovals } from "../edgeMintApproval.js";
import type { ServiceRegistry } from "../registry.js";
import { resolveServices } from "../products/createDefaults.js";
import { coreContributor } from "./core.js";
import { planRows } from "./rows.js";
import { planManifest } from "./plan.js";
import type {
  Ingest,
  IngestCheck,
  IngestContext,
  IngestInput,
  IngestOk,
  IngestPlan,
  IngestProblem,
  IngestResult,
  ManifestContribution,
  ManifestContributor,
  RowPlanResult,
} from "./types.js";

/**
 * The order a refusal is reported in when more than one applies (the order the old paths ran
 * their checks in). `services`/`starter`/`trust` are create-only.
 */
export const REFUSAL_ORDER = {
  apply: [
    "issuer",
    "publisher",
    "catalog",
    "declassify",
    "binary",
    "sparkle",
    "tier-drop",
    "profile-drop",
  ],
  create: [
    "binary",
    "issuer",
    "catalog",
    "seal",
    "publisher",
    "services",
    "starter",
    "trust",
  ],
} as const;

/** The order the `updated` ids are reported in; service slugs follow `deliverables`. */
const UPDATED_ORDER = [
  "product",
  "fingerprint",
  "autoIssue",
  "services",
  "schema",
  "release",
  "oidc",
  "profiles",
  "tiers",
  "provisioning",
  "edgeMint",
  "publisher",
  "deliverables",
  ...SERVICE_SLUGS.filter((s) => s !== "release"),
  "releases",
  "assets",
  "edgeMintApprovals",
];

const rank = (id: string): number => {
  const i = UPDATED_ORDER.indexOf(id);
  return i < 0 ? UPDATED_ORDER.length : i;
};

/** Contributors in run order: Core, then each mounted service that has the facet. */
function contributorsOf(
  registry: ServiceRegistry,
): { slug: string | null; contributor: ManifestContributor }[] {
  const out: { slug: string | null; contributor: ManifestContributor }[] = [
    { slug: null, contributor: coreContributor },
  ];
  for (const slug of SERVICE_SLUGS) {
    const contributor = registry.get(slug)?.contributes?.manifest;
    if (contributor) out.push({ slug, contributor });
  }
  return out;
}

export function ingestFor(registry: ServiceRegistry): Ingest {
  return {
    run: (env, db, input) => run(registry, env, db, input),
    plan: (env, db, input, opts) => plan(registry, env, db, input, opts),
  };
}

/** Phase 1: the product row, the effective service set and the contributors' contexts. */
async function setup(
  registry: ServiceRegistry,
  env: Env,
  db: Db,
  input: IngestInput,
) {
  const { mode, manifest, now, source } = input;
  const scope = input.scope ?? "full";
  const slug = input.product;

  // ── 1. Read ──────────────────────────────────────────────────────────────────
  const before =
    mode === "apply"
      ? (input.seed?.product ?? (await getProduct(db, slug)))
      : null;
  if (mode === "apply" && !before)
    return { fail: { ok: false as const, error: "unknown product" } };

  let services: ServicesMap = manifest.services;
  let servicesSource: "manifest" | "admin" = "manifest";
  let servicesProblem: IngestProblem | null = null;
  if (mode === "create") {
    // ST-42: a `services` list adds to what `.pkey/` enables, through the requirement rule. The
    // set then differs from the manifest's, so it is the operator's (`admin`).
    const asked = input.create?.choices?.services;
    if (asked) {
      // A manifest can not say "no services" (an empty `modules:` is the defaults), so with no
      // repository the list is taken as it is, over nothing.
      const resolved = resolveServices(
        asked,
        source.repo ? manifest.services : null,
      );
      if (!resolved.ok)
        servicesProblem = {
          check: "services",
          message: resolved.message,
          extra: {
            reason: resolved.reason,
            fields: resolved.fields,
            codes: resolved.codes,
          },
        };
      else {
        services = resolved.services;
        // With no repository (documents only, D8) nothing will ever push a manifest set, so a
        // list is the operator's.
        if (
          !source.repo ||
          JSON.stringify(services) !== JSON.stringify(manifest.services)
        )
          servicesSource = "admin";
      }
    }
  } else if (before) {
    // The set this ingest leaves: the stored one when an operator claimed it, the manifest's
    // otherwise, so a service an operator turned off live is not rewritten by a push.
    services = parseServices(
      before.services_source === "admin" || scope === "system"
        ? before.services_json
        : serializeServices({ services: manifest.services }),
    ).services;
    servicesSource = before.services_source === "admin" ? "admin" : "manifest";
  }

  const memo = new Map<string, Promise<unknown>>();
  const lazy = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let hit = memo.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      memo.set(key, hit);
    }
    return hit;
  };
  if (input.seed?.releaseConfig !== undefined)
    memo.set("release.cfg", Promise.resolve(input.seed.releaseConfig));
  const shared: IngestContext["shared"] & {
    servicesProblem?: IngestProblem | null;
  } = { signingPublicKeys: [], servicesProblem };

  const emptyClaims = { claimed: new Set(), live: [], ended: [] } as Awaited<
    ReturnType<typeof claimsForApply>
  >;
  const base: Omit<IngestContext, "enabled"> = {
    env,
    db,
    mode,
    scope,
    slug,
    manifest,
    now,
    source,
    ...(input.create ? { create: input.create } : {}),
    services,
    servicesSource,
    before,
    claims: () =>
      mode === "apply"
        ? lazy("claims", () => claimsForApply(db, slug, manifest, now))
        : Promise.resolve(emptyClaims),
    previousSnapshot: () =>
      lazy("previousSnapshot", () => getManifestSnapshot(db, slug)),
    rows: undefined as never,
    read: { memo: lazy },
    shared,
  };
  // The snapshot is read once: `rows` and `previousSnapshot` share the memo.
  base.rows = (): Promise<RowPlanResult> =>
    lazy("rows", async () =>
      planRows(
        db,
        slug,
        manifest,
        (await base.previousSnapshot())?.manifest_json,
        now,
      ),
    );

  const active = contributorsOf(registry).map(({ slug: svc, contributor }) => ({
    svc,
    contributor,
    ctx: {
      ...base,
      enabled:
        svc === null
          ? true
          : (services[svc as keyof ServicesMap]?.enabled ?? false),
    } as IngestContext,
  }));

  return {
    fail: null,
    mode,
    scope,
    slug,
    manifest,
    now,
    source,
    services,
    base,
    active,
    emptyClaims,
    lazy,
  };
}

/** The order the dry run lists refusals in (the old policy order, then the publisher lookup). */
const PLAN_ORDER = {
  apply: [
    "binary",
    "issuer",
    "catalog",
    "declassify",
    "sparkle",
    "seal",
    "publisher",
  ],
  // The same checks the create refuses on (`REFUSAL_ORDER.create`), so a dry run cannot pass
  // where the create refuses (the P0-26b security review: `seal` was missing).
  create: [
    "binary",
    "issuer",
    "catalog",
    "seal",
    "publisher",
    "services",
    "starter",
    "trust",
  ],
} as const;

/**
 * The dry run (`plan`): every refusal that applies (unlike `run`, which stops at the first), and
 * in apply mode what the apply would write, keep and delete. Writes nothing.
 */
async function plan(
  registry: ServiceRegistry,
  env: Env,
  db: Db,
  input: IngestInput,
  opts: { skip?: readonly string[] } = {},
): Promise<IngestPlan> {
  const s = await setup(registry, env, db, input);
  if (s.fail)
    return {
      problems: [{ check: "product", message: s.fail.error }],
      plan: null,
      breakGlass: [],
    };
  const order: readonly string[] = PLAN_ORDER[s.mode];
  const checks = s.active
    .flatMap(({ contributor, ctx }) =>
      contributor.checks ? contributor.checks(ctx) : [],
    )
    .filter(
      (c) =>
        !c.applyOnly &&
        order.includes(c.check) &&
        !opts.skip?.includes(c.check),
    )
    .map((c, i) => ({ c, i, r: order.indexOf(c.check) }))
    .sort((a, b) => a.r - b.r || a.i - b.i);
  const problems: IngestProblem[] = [];
  for (const { c } of checks) {
    const p = await c.run();
    if (p) problems.push(p);
  }
  if (s.mode !== "apply") return { problems, plan: null, breakGlass: [] };
  return {
    problems,
    plan: await planManifest(db, s.slug, s.manifest, s.now),
    breakGlass: (await s.base.claims()).live,
  };
}

async function run(
  registry: ServiceRegistry,
  env: Env,
  db: Db,
  input: IngestInput,
): Promise<IngestResult> {
  const s = await setup(registry, env, db, input);
  if (s.fail) return s.fail;
  const { mode, scope, slug, manifest, now, source, services, base, active } =
    s;
  const { emptyClaims, lazy } = s;
  void services;

  // ── 2. Refuse ────────────────────────────────────────────────────────────────
  // The deploy hook's subset runs no checks: its caller refused a wrong manifest already.
  const checks: IngestCheck[] =
    scope === "system"
      ? []
      : active.flatMap(({ contributor, ctx }) =>
          (contributor.checks ? contributor.checks(ctx) : []).filter(
            (c) => !c.planOnly,
          ),
        );
  const order: readonly string[] = REFUSAL_ORDER[mode];
  const ranked = checks
    .map((c, i) => ({ c, i, r: order.indexOf(c.check) }))
    .sort((a, b) => (a.r < 0 ? 99 : a.r) - (b.r < 0 ? 99 : b.r) || a.i - b.i);
  for (const { c } of ranked) {
    const problem = await c.run();
    if (problem) return failure(problem);
  }

  // ── 3. Sweep ─────────────────────────────────────────────────────────────────
  // P0-12 — an edge-mint approval the product has WIDENED is deleted by the ingest, not merely
  // skipped by the mint, so a revert cannot bring it back while credentials issued in between
  // keep working. Swept once here, after the checks and before the batch, against the state the
  // previous ingest left; once more after the batch by the caller.
  const droppedBefore =
    mode === "apply" && scope === "full"
      ? await invalidateWidenedEdgeMintApprovals(
          db,
          slug,
          now,
          "found widened at resync",
        )
      : [];

  // ── 4. Prepare ───────────────────────────────────────────────────────────────
  const parts: { svc: string | null; part: ManifestContribution }[] = [];
  for (const { svc, contributor, ctx } of active)
    parts.push({ svc, part: await contributor.prepare(ctx) });

  // ── 5. Finalize ──────────────────────────────────────────────────────────────
  const late: { statements: DbStatement[]; audits: DbStatement[] }[] = [];
  const lateUpdated: string[] = [];
  for (const { part } of parts) {
    if (!part.finalize) continue;
    const f = await part.finalize();
    if ("refusal" in f) return failure(f.refusal);
    late.push(f);
    if (f.updated) lateUpdated.push(...f.updated);
  }

  // ── 6. Batch ─────────────────────────────────────────────────────────────────
  // The snapshot records the parsed (pre-seal) manifest, so it is scrubbed of secret values: by
  // the UNION of the incoming and the stored catalog on apply (kept even when `config.catalog`
  // is claimed, as sealing does), by the manifest's own on create.
  const catalogs: Catalog[] = [];
  try {
    catalogs.push(new Catalog(manifest.catalog as never));
  } catch {
    /* a catalog that does not build was refused by Config's check */
  }
  if (mode === "apply") {
    const stored = parseStoredCatalog(
      (await lazy("activeSchema", () => getActiveSchema(db, slug)))
        ?.catalog_json,
    );
    if (stored) catalogs.push(stored);
  }
  const isSecretKey = managedSecretKeyPredicate(catalogs);

  const statements: DbStatement[] = [
    ...parts.flatMap(({ part }) => part.statements),
    ...late.flatMap((f) => f.statements),
    ...parts.flatMap(({ part }) => part.tail ?? []),
    ...parts.flatMap(({ part }) => part.audits),
    ...late.flatMap((f) => f.audits),
    await manifestSnapshotStatement(
      slug,
      source.origin === "link"
        ? "link"
        : source.origin === "deploy-hook"
          ? "deploy-hook"
          : "resync",
      source.sha,
      source.files,
      manifest,
      now,
      isSecretKey,
    ),
  ];
  await db.batch(statements);

  // ── 7. After commit ──────────────────────────────────────────────────────────
  const after: Partial<{
    updated: string[];
    packSets: unknown;
    warnings: IngestOk["warnings"];
  }>[] = [];
  const afterOrder = [
    ...parts.filter((p) => p.svc !== null),
    ...parts.filter((p) => p.svc === null),
  ];
  for (const { part } of afterOrder)
    if (part.afterCommit && scope === "full")
      after.push(await part.afterCommit());

  // ── the answer ───────────────────────────────────────────────────────────────
  const updated = [
    ...parts.flatMap(({ part }) => part.updated),
    ...lateUpdated,
    ...after.flatMap((a) => a.updated ?? []),
    ...(droppedBefore.length > 0 ? ["edgeMintApprovals"] : []),
  ].sort((a, b) => rank(a) - rank(b));
  const claimed = parts.flatMap(({ part }) => part.claimed ?? []);
  const conflicts = parts.flatMap(({ part }) => part.conflicts ?? []);
  const refused = parts.flatMap(({ part }) => part.refused ?? []);
  const packSets = after.map((a) => a.packSets).find((p) => p !== undefined);
  const warnings = after.flatMap((a) => a.warnings ?? []);
  const facts = Object.assign({}, ...parts.map(({ part }) => part.facts ?? {}));
  const claims = mode === "apply" ? await base.claims() : emptyClaims;
  return {
    ok: true,
    updated,
    ...(facts.created ? { created: facts.created as IngestOk["created"] } : {}),
    ...(refused.length > 0 ? { refused } : {}),
    ...(claimed.length > 0 ? { claimed } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(packSets !== undefined ? { packSets } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(claims.live.length > 0 ? { breakGlass: claims.live } : {}),
    ...(claims.ended.length > 0
      ? {
          breakGlassEnded: claims.ended.map((e) => ({
            key: e.key,
            why: e.why,
          })),
        }
      : {}),
    facts,
  };
}

function failure(problem: IngestProblem): IngestResult {
  return { ok: false, error: problem.message, ...problem.extra };
}
