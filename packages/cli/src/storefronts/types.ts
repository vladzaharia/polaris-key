/**
 * The shape of the CI and PR planes as the CLI reads it (A-18h, A-18i): the generated copy
 * (`ciPlane.generated.ts`) of the Worker's declaration (`packages/worker/src/core/storefront/
 * ciPlane.ts` and `ci.ts`). These types mirror the Worker's; the generator and the worker suite's
 * freshness test keep the data identical, and `test/storefronts.test.ts` runs the same
 * conformance over this copy.
 */

export interface CiIdentityBinding {
  readonly field: string;
  readonly match: "equal" | "prefix" | "each";
  readonly separator?: string;
}

export interface CiParam {
  readonly param: string;
  readonly pattern: string;
  readonly prefix?: string;
  readonly identity?: CiIdentityBinding;
}

export type CiArg = string | CiParam;

export type CiFileCheck = "steam-vdf-setlive-named";

export interface CiCommandRule {
  readonly argv: readonly CiArg[];
  readonly confirm: string;
  readonly why: string;
  readonly unlessWorkerStaged?: {
    readonly opens: readonly string[];
    readonly closes: readonly string[];
  };
  readonly fileChecks?: readonly {
    readonly param: string;
    readonly check: CiFileCheck;
  }[];
}

export interface CiAllowList {
  readonly tool: string;
  readonly commands: Readonly<Record<string, CiCommandRule>>;
}

export interface CiPlaneStore {
  readonly store: string;
  readonly label: string;
  readonly outletKinds: readonly string[];
  readonly list: CiAllowList;
  readonly never: readonly (readonly string[])[];
  readonly neverTokens: readonly string[];
}

export interface CiPlaneAdapter {
  readonly id: string;
  readonly label: string;
  readonly outletKinds: readonly string[];
  /** Storefront operation → the commands it runs. */
  readonly ciOps: Readonly<Record<string, readonly string[]>>;
}

/** A file a PR may write (A-18i): a path template over the pull-request command's parameters. */
export interface PrPathRule {
  readonly template: string;
  readonly why: string;
}

/** A PR-plane store (A-18i; the Worker's `core/storefront/prPlane.ts`). */
export interface PrPlaneStore {
  readonly store: string;
  readonly label: string;
  readonly outletKinds: readonly string[];
  /** How the console names the repository (`{field}`: the outlet identity's). */
  readonly repo: string;
  /** True: the PR comes from a fork in the token's account (winget). */
  readonly fork: boolean;
  readonly list: CiAllowList;
  readonly commandOps: Readonly<Record<string, readonly string[]>>;
  readonly paths: readonly PrPathRule[];
  readonly naturalKey: readonly string[];
  readonly labels: {
    readonly needsAuthor: readonly string[];
    readonly validationPrefix: string | null;
    readonly validationOk: readonly string[];
  };
  readonly never: readonly (readonly string[])[];
  readonly neverTokens: readonly string[];
}

export interface CiPlaneDeclaration {
  readonly stores: readonly CiPlaneStore[];
  readonly adapters: readonly CiPlaneAdapter[];
  readonly prStores: readonly PrPlaneStore[];
}
