/**
 * The manifest ingest pipeline's vocabulary (P0-26, CQW-05).
 *
 * Link and resync both write a parsed `.pkey/` into D1. Core owns the one pipeline
 * (`pipeline.ts`); Core and each service contribute through `ServiceContributions.manifest`:
 * a contributor reads and checks in `prepare`, hands back statements for ITS OWN tables and the
 * pipeline writes them all in one batch. The contract every contributor keeps:
 *
 *   - read only in `prepare` and `finalize`;
 *   - write only your own tables (`tableCrossings.test.ts` proves it);
 *   - be idempotent;
 *   - never write an operator-owned column;
 *   - put each claim guard in the SQL, never only in an earlier read.
 */

import type { ParsedManifest } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import type { ProductRow } from "../repo.js";
import type { ServicesMap, ServiceSlug } from "../services.js";
import type {
  ApplyClaims,
  BreakGlassClaim,
  ClaimKey,
} from "../settingsClaims.js";
import type {
  CreateChoices,
  CreatedDefaults,
} from "../products/createDefaults.js";
import type {
  RepoBlobLookup,
  AssetWarning,
} from "../assets/hostedAssetPulls.js";

/** `create` registers a product that does not exist yet; `apply` re-applies to a linked one. */
export type IngestMode = "create" | "apply";

/** A repository's identity as GitHub resolves it (numeric ids pin against name recycling). */
export interface RepoIdentity {
  id: number;
  ownerId: number;
  fullName: string;
}

/** The repository a manifest was read from, as the GitHub source adapter hands it down. */
export interface RepoHandle {
  owner: string;
  name: string;
  /** The App installation id (create mode: stored on `release_config`). */
  installId: number | null;
  /** Resolves the repository's numeric ids; throws when GitHub cannot answer. */
  identity(): Promise<RepoIdentity>;
  /** Whether `path` exists at the applied commit. */
  hasFile(path: string): Promise<boolean>;
  /** Git blob lookup at the applied commit (hosted-asset pulls). */
  blob: RepoBlobLookup;
}

/** Where a manifest came from. Core never reads GitHub itself; the adapter closes over it. */
export interface ManifestSource {
  origin: "link" | "resync" | "deploy-hook";
  /** The commit every document was read at. */
  sha: string | null;
  /** The raw `.pkey/` documents (the snapshot records them). */
  files: Record<string, string>;
  /** The fetch the adapter's GitHub reads use, handed on to the release truth-store sync. */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** Absent when the manifest was supplied as documents with no repository (plans/P0-26.md D8). */
  repo?: RepoHandle;
}

export interface CreateRequest {
  /** ST-42's choices; absent for a bare link. */
  choices?: CreateChoices;
  /** The console session's subject: the author of the console-owned default rows. */
  author?: string;
}

/**
 * `full` applies every owner's rows. `system` is the deploy hook's subset for the system product
 * (plans/P0-26.md D3): the release block and deliverables, the manifest-authoritative publisher
 * (an admin claim replaced, static CI tokens revoked), the row settings, Distribution's rows and
 * the ended break-glass claims; never the services, catalog, tiers, profiles, OIDC or recipes.
 */
export type IngestScope = "full" | "system";

export interface IngestInput {
  mode: IngestMode;
  /** Absent: `full`. `system` needs `mode: "apply"`. */
  scope?: IngestScope;
  product: string;
  manifest: ParsedManifest;
  now: number;
  source: ManifestSource;
  create?: CreateRequest;
  /** Reads the caller already holds (the product row, the release config), to save round trips. */
  seed?: { product?: ProductRow; releaseConfig?: unknown };
}

/** A refusal. `check` orders it (`REFUSAL_ORDER`); the pipeline reports the first. */
export interface IngestProblem {
  check: string;
  message: string;
  /** Extra fields for the failure answer (`reason`, `fields`, `codes`). */
  extra?: { reason?: string; fields?: string[]; codes?: string[] };
}

export interface RowPlanTier {
  id: string;
  profileId: string | null;
}

/**
 * The tiers and profiles an apply writes, per row (S-18 §4.5 item 3): a `manifest` row the
 * manifest still declares is upserted, a `console` row is never touched, a dropped `manifest` row
 * goes. Computed once by the pipeline because License and Config both need it.
 */
export interface RowPlan {
  applyTiers: ParsedManifest["tiers"];
  applyProfiles: ParsedManifest["profiles"];
  dropTiers: { id: string }[];
  dropProfiles: { id: string }[];
  /** Tier ids that stay after this apply (console rows, then the manifest's applied ones). */
  survivingTierProfiles: (string | null)[];
  storedTiers: import("../repo.js").TierRow[];
  storedProfiles: import("../repo.js").ProfileRow[];
}

export interface RowPlanResult {
  plan: RowPlan;
  /** Live row-setting claims, then the tier/profile rows a console claim kept. */
  claimed: string[];
  conflicts: ManifestConflict[];
}

export interface ManifestRefused {
  code: string;
  path: string;
  message: string;
}

export interface ManifestConflict {
  path: string;
  message: string;
}

/** What one contributor adds to the batch and to the answer. */
export interface ManifestContribution {
  /** In batch order, for this contributor's own tables. */
  statements: DbStatement[];
  /** After every contributor's `statements` (ST-42's defaults). */
  tail?: DbStatement[];
  /** Audit rows, written after the statements. */
  audits: DbStatement[];
  /** Section ids for the answer (`UPDATED_ORDER` sorts them). */
  updated: string[];
  claimed?: string[];
  conflicts?: ManifestConflict[];
  refused?: ManifestRefused[];
  /** Free facts the caller reads back (Release's refused release keys). */
  facts?: Record<string, unknown>;
  /** Late re-reads, as close to the batch as the old code ran them. May still refuse. */
  finalize?(): Promise<
    | { statements: DbStatement[]; audits: DbStatement[]; updated?: string[] }
    | { refusal: IngestProblem }
  >;
  /** After the batch. Never throws. */
  afterCommit?(): Promise<Partial<IngestAfterCommit>>;
}

export interface IngestAfterCommit {
  updated: string[];
  packSets: unknown;
  warnings: AssetWarning[];
}

/** What a contributor is given. */
export interface IngestContext {
  env: Env;
  db: Db;
  mode: IngestMode;
  scope: IngestScope;
  slug: string;
  manifest: ParsedManifest;
  now: number;
  source: ManifestSource;
  create?: CreateRequest;
  /** This contributor's service is on, by the set this ingest leaves (the stored set when an
   *  operator claimed it, the manifest's otherwise). Core's contributor is always `true`. */
  enabled: boolean;
  /** The whole effective set. */
  services: ServicesMap;
  /** `manifest` unless a create asked for more (ST-42): then the operator's. */
  servicesSource: "manifest" | "admin";
  /** The product row before this apply; null in create mode. */
  before: ProductRow | null;
  /** The break-glass-aware claims an apply honours (empty in create mode). Read once, lazily. */
  claims(): Promise<ApplyClaims>;
  /** The tier/profile row plan (apply mode only). Read once, lazily. */
  rows(): Promise<RowPlanResult>;
  /** The previous applied manifest's snapshot (apply mode). Read once, lazily. */
  previousSnapshot(): Promise<{ manifest_json: string } | null>;
  /** Memoised shared reads. */
  read: {
    memo<T>(key: string, load: () => Promise<T>): Promise<T>;
  };
  /** Facts one contributor leaves for the next (Core runs first). */
  shared: {
    /** Create mode: the minted signing key's public half. */
    signingPublicKeys: string[];
  };
}

/** One pre-write refusal, run lazily so a refused ingest reads no more than the old code did. */
export interface IngestCheck {
  /** Orders the check (`REFUSAL_ORDER`). */
  check: string;
  run(): Promise<IngestProblem | null>;
}

export interface ManifestContributor {
  /**
   * The refusals this contributor can raise, as lazy checks. The pipeline runs every
   * contributor's checks in `REFUSAL_ORDER`, stops at the first refusal, and only then calls
   * `prepare` (which reuses what a check memoised through `ctx.read`).
   */
  checks?(ctx: IngestContext): IngestCheck[];
  prepare(ctx: IngestContext): Promise<ManifestContribution>;
}

/** The product `ingest` mints at create. */
export interface CreatedProduct {
  kid: string;
  publicKey: string;
  defaults: CreatedDefaults;
  services: ServicesMap;
}

export interface IngestOk {
  ok: true;
  created?: CreatedProduct;
  updated: string[];
  refused?: ManifestRefused[];
  claimed?: string[];
  conflicts?: ManifestConflict[];
  packSets?: unknown;
  warnings?: AssetWarning[];
  breakGlass?: BreakGlassClaim[];
  breakGlassEnded?: { key: ClaimKey; why: "expired" | "changed" }[];
  facts: Record<string, unknown>;
}

export interface IngestFail {
  ok: false;
  error: string;
  reason?: string;
  fields?: string[];
  codes?: string[];
}

export type IngestResult = IngestOk | IngestFail;

export interface Ingest {
  /** (Not named `apply`: a plain function already has one, and would type-check as an `Ingest`.) */
  run(env: Env, db: Db, input: IngestInput): Promise<IngestResult>;
}

export type { ServiceSlug };
