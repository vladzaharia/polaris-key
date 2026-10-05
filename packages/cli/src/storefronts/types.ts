/**
 * The shape of the CI plane as the CLI reads it (A-18h): the generated copy
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
    readonly workerStore?: string;
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

export interface CiPlaneDeclaration {
  readonly stores: readonly CiPlaneStore[];
  readonly adapters: readonly CiPlaneAdapter[];
}
