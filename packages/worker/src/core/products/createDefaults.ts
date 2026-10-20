/**
 * Create with defaults (ST-42, FLOWS W25): the choices both create routes (`POST /api/products`
 * and `POST /api/products/link-repo`) accept, and the rows they add to the create batch so a new
 * product is ready for an SDK in one call.
 *
 *   services               the slugs the product runs, through the requirement rule (a service
 *                          on needs what it requires on; nothing is pulled on with it). Omitted:
 *                          the defaults for a manual product, the manifest's own set for a link.
 *                          The console resolves a feature to its slugs (`FEATURES`) before it
 *                          calls; the Worker takes slugs, the one vocabulary it routes on.
 *   intendedPlatforms      `distribution.intendedPlatforms` (SETUP W5), console-owned.
 *   starterTier            `"free"` or `"none"`. Omitted: Free when Licensing is on and nothing
 *                          else declares a tier.
 *   trustReleaseWorkflow   link only: trust `.github/workflows/release.yml` as the product's CI
 *                          publisher (F9).
 *
 * Always, whatever was asked: the Default profile (`DEFAULT_PROFILE_ID`, empty; Config writes it),
 * so a tier and the config chain have something to point at. Every row is `source = 'console'`, so a resync never
 * rewrites or deletes it; a manifest that declares the same id owns it instead and the default
 * is skipped. The caller puts the statements in its own create batch: one `db.batch`, rolled
 * back whole.
 */

import { RELEASE_PLATFORMS } from "@polaris-key/manifest";
import type { DbStatement } from "../../db/types.js";
import { stmtInsertConsoleTier } from "../licensing/store.js";
import {
  applyRequirementRule,
  DEFAULT_SERVICES,
  SERVICE_SLUGS,
  type ServiceSlug,
  type ServicesMap,
} from "../services.js";
import {
  DEFAULT_CI_SCOPES,
  DEFAULT_PUBLISH_ENVIRONMENT,
} from "../publisher.js";

/** The reserved id of the profile every created product starts with (U-28 reads it). */
export const DEFAULT_PROFILE_ID = "default";
/** The id and label of the starter tier. */
export const FREE_TIER_ID = "free";
export const FREE_TIER_LABEL = "Free";
/** The registry key the planned platforms are stored under. */
export const INTENDED_PLATFORMS_KEY = "distribution.intendedPlatforms";

export interface CreateChoices {
  /** The slugs asked for; `null` when the body did not say. Resolve with `resolveServices`. */
  services: ServiceSlug[] | null;
  intendedPlatforms: string[];
  /** `null` when the body did not say. */
  starterTier: "free" | "none" | null;
  trustReleaseWorkflow: boolean;
}

export interface CreateRefusal {
  ok: false;
  message: string;
  fields: string[];
  /** Stable machine code, the requirement codes included. */
  reason: string;
  /** Every requirement code when more than one. */
  codes?: string[];
}

/**
 * The requested slugs over `keep` (a link keeps the manifest's set on and adds to it; a manual
 * create passes `null` and gets exactly the list), through the requirement rule: a service on
 * needs what it requires on, and nothing is pulled on with it.
 */
export function resolveServices(
  requested: readonly ServiceSlug[],
  keep: ServicesMap | null,
): { ok: true; services: ServicesMap } | CreateRefusal {
  const wanted = new Set<string>(requested);
  const patch: Partial<Record<ServiceSlug, boolean>> = {};
  for (const slug of SERVICE_SLUGS)
    patch[slug] = wanted.has(slug) || (keep?.[slug].enabled ?? false);
  const outcome = applyRequirementRule(keep ?? DEFAULT_SERVICES, patch);
  if (outcome.errors.length > 0)
    return {
      ok: false,
      message: `a service needs the service it requires: ${outcome.errors.join(", ")}`,
      fields: ["services"],
      reason: outcome.errors[0]!,
      codes: outcome.errors,
    };
  return { ok: true, services: outcome.services };
}

/** Read the four choices from a request body (shape only; `resolveServices` does the rule). */
export function parseCreateChoices(
  body: Record<string, unknown>,
): { ok: true; choices: CreateChoices } | CreateRefusal {
  let services: ServiceSlug[] | null = null;
  if (body.services !== undefined) {
    const list = body.services;
    if (
      !Array.isArray(list) ||
      list.length > SERVICE_SLUGS.length ||
      !list.every((s) => typeof s === "string")
    )
      return refuse("services must be a list of service slugs", "services");
    const unknown = list.filter(
      (s) => !(SERVICE_SLUGS as readonly string[]).includes(s as string),
    );
    if (unknown.length > 0)
      return refuse(
        `unknown service: ${unknown[0]}`,
        "services",
        "unknown_service",
      );
    services = list as ServiceSlug[];
  }

  let intendedPlatforms: string[] = [];
  if (body.intendedPlatforms !== undefined) {
    const list = body.intendedPlatforms;
    if (
      !Array.isArray(list) ||
      list.length > RELEASE_PLATFORMS.length ||
      !list.every(
        (p) =>
          typeof p === "string" &&
          (RELEASE_PLATFORMS as readonly string[]).includes(p),
      ) ||
      new Set(list).size !== list.length
    )
      return refuse(
        `intendedPlatforms must be a list of distinct platforms: ${RELEASE_PLATFORMS.join(", ")}`,
        "intendedPlatforms",
        "invalid_platforms",
      );
    intendedPlatforms = list as string[];
  }

  let starterTier: "free" | "none" | null = null;
  if (body.starterTier !== undefined) {
    if (body.starterTier !== "free" && body.starterTier !== "none")
      return refuse(
        'starterTier must be "free" or "none"',
        "starterTier",
        "invalid_starter_tier",
      );
    starterTier = body.starterTier;
  }

  if (
    body.trustReleaseWorkflow !== undefined &&
    typeof body.trustReleaseWorkflow !== "boolean"
  )
    return refuse(
      "trustReleaseWorkflow must be true or false",
      "trustReleaseWorkflow",
    );

  return {
    ok: true,
    choices: {
      services,
      intendedPlatforms,
      starterTier,
      trustReleaseWorkflow: body.trustReleaseWorkflow === true,
    },
  };
}

function refuse(
  message: string,
  field: string,
  reason = "invalid_create_choice",
): CreateRefusal {
  return { ok: false, message, fields: [field], reason };
}

/** What a create wrote beyond the product, key and catalog: the response's `defaults`. */
export interface CreatedDefaults {
  services: ServiceSlug[];
  profile: string | null;
  tier: string | null;
  intendedPlatforms: string[];
  /** The trusted workflow, or null. */
  trustedWorkflow: string | null;
}

/** The rows a create adds, and the summary that goes in its response. */
export interface DefaultsPlan {
  statements: DbStatement[];
  created: CreatedDefaults;
}

export interface PlanInput {
  product: string;
  now: number;
  /** The enablement the product is created with. */
  services: ServicesMap;
  choices: CreateChoices;
  /** Profile and tier ids a manifest declares: those win, our default is skipped. */
  declaredProfiles?: readonly string[];
  declaredTiers?: readonly string[];
  /** A `.pkey/` that declares a trusted publisher already owns the policy. */
  manifestHasPublisher?: boolean;
  /** Set when a repository is linked and the workflow file exists: the policy to write. */
  publisher?: {
    repositoryId: number;
    repositoryOwnerId: number;
    repository: string;
    workflow: string;
  } | null;
  /** Who is creating: the audit author of the console-owned rows. */
  author: string;
}

/** The default profile, starter tier, planned platforms and trust policy, as batch statements. */
export function planCreateDefaults(input: PlanInput): DefaultsPlan {
  const { product, now, choices } = input;
  const statements: DbStatement[] = [];
  const created: CreatedDefaults = {
    services: SERVICE_SLUGS.filter((s) => input.services[s].enabled),
    profile: null,
    tier: null,
    intendedPlatforms: [],
    trustedWorkflow: null,
  };

  // The row itself is Config's: it owns `profiles` and writes it in its create contribution
  // (`services/config/ingest.ts`), by the same rule (a manifest that declares the id owns it).
  if (!input.declaredProfiles?.includes(DEFAULT_PROFILE_ID))
    created.profile = DEFAULT_PROFILE_ID;

  const wantsFree =
    choices.starterTier === "free" ||
    (choices.starterTier === null && (input.declaredTiers?.length ?? 0) === 0);
  if (
    wantsFree &&
    input.services.license.enabled &&
    !input.declaredTiers?.includes(FREE_TIER_ID)
  ) {
    statements.push(
      stmtInsertConsoleTier({
        product,
        id: FREE_TIER_ID,
        label: FREE_TIER_LABEL,
        profileId: DEFAULT_PROFILE_ID,
        author: input.author,
        now,
      }),
    );
    created.tier = FREE_TIER_ID;
  }

  if (choices.intendedPlatforms.length > 0) {
    statements.push({
      sql: `INSERT INTO product_settings
              (product, key, value_json, source, version, updated_at, updated_by, reason, expires_at)
            VALUES (?, ?, ?, 'console', 1, ?, ?, NULL, NULL)
            ON CONFLICT(product, key) DO UPDATE SET
              value_json = excluded.value_json, source = 'console', version = 1,
              updated_at = excluded.updated_at, updated_by = excluded.updated_by,
              reason = NULL, expires_at = NULL`,
      params: [
        product,
        INTENDED_PLATFORMS_KEY,
        JSON.stringify(choices.intendedPlatforms),
        now,
        input.author,
      ],
    });
    created.intendedPlatforms = [...choices.intendedPlatforms];
  }

  if (input.publisher && !input.manifestHasPublisher) {
    const p = input.publisher;
    statements.push({
      sql: `INSERT INTO ci_publishers
              (product, provider, repository_id, repository_owner_id, repository, workflow,
               environment, scopes_json, source, created_at, modified_at, modified_by)
            VALUES (?, 'github', ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
      params: [
        product,
        p.repositoryId,
        p.repositoryOwnerId,
        p.repository,
        p.workflow,
        DEFAULT_PUBLISH_ENVIRONMENT,
        JSON.stringify([...DEFAULT_CI_SCOPES].sort()),
        now,
        now,
        input.author,
      ],
    });
    created.trustedWorkflow = p.workflow;
  }

  return { statements, created };
}
