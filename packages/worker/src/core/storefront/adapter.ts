/**
 * THE STOREFRONT ADAPTER CONTRACT AND REGISTRY (A-18a; notes/S-15 §6.1, owner requirement of
 * 2026-10-04: one modular layer that abstracts each store's responsibilities and capabilities, so
 * adding a storefront is easy, in the same pattern as the package feeds).
 *
 * `StorefrontAdapter` extends `Adapter<Id, Op>` from `core/adapters/contract.ts`, exactly as the
 * feeds' `FeedAdapter` (`services/distribution/registry/adapter.ts`) does: one interface, one
 * capability declaration (a `Support` per operation, which the console renders and never
 * second-guesses), and a shared gate and ledger the adapter cannot bypass. For a store those are:
 *
 *   - the store-agnostic write gate (`gate.ts`) with the adapter's rule table (`rules/<store>.ts`);
 *   - the ledger `store_operations`, written only through `performStoreWrite` (`ledger.ts`);
 *   - the budget meter, driven by the adapter's `RateSpec` (`budget.ts`);
 *   - the audit projection, keyed by (store, resource type) (`audit.ts`);
 *   - typed confirmation, with the adapter's phrase (`confirm.ts`);
 *   - the deep-link table (`deeplinks.ts`) and, for the CI plane, the command allow-list (`ci.ts`).
 *
 * ADDING A STOREFRONT is one declaration (`stores/<store>.ts`), one rule table, and ONE LINE in
 * `STOREFRONT_ADAPTERS` below; the conformance suite (`test/storefront/conformance.test.ts`) then
 * holds it to the contract, and the console renders it from the declaration with no store code.
 * An adapter maps onto existing outlet kinds; a store that needs a new wire outlet kind is a
 * plan-mode change, not an adapter (S-15 §4.4, owner decision 8).
 *
 * WHERE THE CLI READS IT (S-15 §6.1 left the choice to A-18a): the declarations here are plain,
 * dependency-free data (`test/boundaries.test.ts` keeps `core/adapters` and `core/storefront` free
 * of service imports, and the capability, CI and deep-link parts free of any import but each
 * other), so the CLI's copy is GENERATED: `packages/cli/src/storefronts/ciPlane.generated.ts`
 * (A-18h, `pnpm gen:storefront-ci`), a straight serialise of the CI plane and the CI-plane
 * adapters. No new package and nothing in `shared-protocol`, which is wire.
 *
 * Runtime behaviour (`connect`, `listApps`, `readListing`, `plan`, `runStep`, `status`) is
 * `StorefrontRuntime`, implemented per plane beside the existing connector
 * (`services/distribution/connectors/<store>/`); A-18c and A-18j add the first implementations.
 */

import type { OutletKind } from "@polaris-key/manifest";
import type { Adapter } from "../adapters/contract.js";
import type { CiAllowList } from "./ci.js";
import type { ConfirmationPhrase } from "./confirm.js";
import type { CompiledGate, GateRule } from "./gate.js";
import type { ListingProfile } from "./listing.js";
import { APP_STORE_ADAPTER } from "./stores/appStore.js";
import { GOOGLE_PLAY_ADAPTER } from "./stores/googlePlay.js";
import { MICROSOFT_STORE_ADAPTER } from "./stores/microsoftStore.js";
import { ITCH_ADAPTER } from "./stores/itch.js";
import { SNAP_ADAPTER } from "./stores/snap.js";

export type { ListingProfile } from "./listing.js";

/** The storefront adapters. Worker-internal ids; each maps onto existing outlet kinds. */
export type StorefrontId =
  | "app-store"
  | "google-play"
  | "microsoft-store"
  | "itch"
  | "snap";

/** The operations a storefront declares support for (S-15 §6.1). */
export const STOREFRONT_OPS = [
  "connect",
  "listApps",
  /** Register an identifier the store needs before an app record exists (Apple bundle ids). */
  "identifiers",
  "createApp",
  "readListing",
  "writeListingText",
  "writeListingAssets",
  "category",
  "contentRating",
  "privacyDeclarations",
  "pricing",
  "iap",
  "testers",
  "uploadBuild",
  "notificationsUrl",
  "submit",
  "release",
  "rollout",
  "status",
] as const;
export type StorefrontOp = (typeof STOREFRONT_OPS)[number];

/** Operations that only read: an `api` declaration needs no allow rule (reads pass the gate). */
export const READ_OPS: readonly StorefrontOp[] = [
  "connect",
  "listApps",
  "readListing",
  "status",
];

/**
 * Operations whose writes are typed on every store (owner rule; S-15 §6.4): submit for review,
 * release, and price changes. The conformance suite requires each adapter's `api` declaration of
 * these to have a typed write that the gate refuses without the confirmation.
 */
export const TYPED_OPS: readonly StorefrontOp[] = [
  "submit",
  "release",
  "pricing",
];

/**
 * What must never be reachable, by category (owner rules: never delete, never manage users or
 * permissions, never touch signing keys or payments). Each entry is a `"<METHOD> <template>"` of
 * the store's spec (`*` for every method); the conformance suite asserts the gate refuses each,
 * that no allow rule is one, and that no CI command spells one of `ciTokens`.
 */
export interface NeverList {
  readonly delete: readonly string[];
  readonly users: readonly string[];
  readonly signingKeys: readonly string[];
  readonly payments: readonly string[];
  /** Tokens no CI command may contain (`delete`, `users`…). */
  readonly ciTokens: readonly string[];
}

/** One storefront. See the file comment for what is the adapter's and what is shared. */
export interface StorefrontAdapter extends Adapter<StorefrontId, StorefrontOp> {
  /** The name the console and audit summaries use. */
  readonly label: string;
  /** The outlet kinds it serves; never a new wire kind. */
  readonly outletKinds: readonly OutletKind[];
  /**
   * The A-16 team credential slot (a `PLATFORM_CREDENTIALS` id, which the conformance suite
   * checks); null for a keyless outlet. A plain string so this module never imports the credential
   * custody module (`test/outletCredentialReach.test.ts`).
   */
  readonly credential: string | null;
  /** The Worker-plane gate; null when the adapter has no Worker plane. */
  readonly gate: CompiledGate<GateRule> | null;
  readonly never: NeverList;
  /** The CI-plane command allow-list (`ciPlane.ts`); null when it has no CI plane. */
  readonly ci: CiAllowList | null;
  readonly listing: ListingProfile;
  readonly confirmation: ConfirmationPhrase;
  /**
   * The audit row's action segment (`distribution.<action>.<op>`, `platform.<action>.<op>`) and
   * the before-and-after projection: per resource type, the attributes kept. A type not listed
   * keeps only `{type, id}`.
   */
  readonly audit: {
    readonly action: string;
    readonly projection: Readonly<Record<string, readonly string[]>>;
  };
}

/** The runtime half, implemented per plane (A-18c, A-18j). Declared here so every store has one shape. */
export interface StorefrontRuntime<Ctx, PinnedCtx> {
  readonly id: StorefrontId;
  connect(ctx: Ctx): Promise<unknown>;
  listApps(ctx: Ctx): Promise<unknown>;
  readListing(ctx: PinnedCtx, locales?: readonly string[]): Promise<unknown>;
  plan(ctx: PinnedCtx, listing: unknown): Promise<unknown>;
  runStep(ctx: PinnedCtx, step: unknown): Promise<unknown>;
  status(ctx: PinnedCtx): Promise<unknown>;
}

/** THE REGISTRY: one line per storefront. */
export const STOREFRONT_ADAPTERS: readonly StorefrontAdapter[] = [
  APP_STORE_ADAPTER,
  GOOGLE_PLAY_ADAPTER,
  MICROSOFT_STORE_ADAPTER,
  ITCH_ADAPTER,
  SNAP_ADAPTER,
];

/** An adapter by id, or null. */
export function storefrontAdapter(id: string): StorefrontAdapter | null {
  return STOREFRONT_ADAPTERS.find((a) => a.id === id) ?? null;
}
