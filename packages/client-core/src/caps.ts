// Typed "unsupported here" (PARITY §2.2, P1b-10): the one engine behind every JS SDK's
// `supports(feature)`.
//
// Each SDK carries a capability table GENERATED from its parity manifest (`CAPABILITIES` in its
// `constants.generated.ts`, tools/capabilities.ts). This module reads such a table; it knows no
// feature id itself, so Node and React share it while each passes its own table, runtime and
// detectors. The answer is decided in one fixed order, the same in every SDK:
//
//   1. an id the table does not know          → `version` (a newer feature than this SDK)
//   2. a `runtime` N/A declared for this runtime (or any N/A of an `na` row) → that reason
//   3. a `planned` row                         → `version` (this SDK does not implement it yet)
//   4. an opt-in service discovery has off     → `product`
//   5. a conditional N/A (`outlet`, `dependency`, `version`) declared for this runtime whose
//      detector answers a detail               → that reason
//   6. otherwise                               → Supported
//
// `supports()` never probes by calling: the runtime is known at construction, services come from
// the client's cached discovery (or its fail-closed fallback), and a detector reads state the
// client already holds. Calling into an unsupported feature throws `UnsupportedError` with the
// same fields.

import { PolarisError } from "./errors.js";

/** Why a feature is unsupported here. Mirrors the registry's `reasons` (the generated
 *  `UnsupportedReason` constants). */
export type UnsupportedReason =
  | "runtime"
  | "outlet"
  | "product"
  | "dependency"
  | "version";

/** The error code every SDK raises for an unsupported feature (conformance/parity/errors.json). */
export const UNSUPPORTED_CODE = "unsupported";

export interface Supported {
  readonly supported: true;
  readonly feature: string;
}

export interface Unsupported {
  readonly supported: false;
  readonly feature: string;
  readonly reason: UnsupportedReason;
  /** Human text: what is missing and, where it helps, what to do instead. */
  readonly detail: string;
}

export type Support = Supported | Unsupported;

/** One declared N/A of a capability-table row. */
export interface CapabilityNaLike {
  readonly runtime: string;
  readonly reason: string;
}

/** One row of a generated capability table. */
export interface CapabilityRowLike {
  readonly status: "implemented" | "planned" | "na";
  readonly service: string;
  readonly na: readonly CapabilityNaLike[];
}

/** Answers a detail when the feature is unsupported for its reason right now, else `null`. */
export type CapabilityDetector = () => string | null;

/** Detectors keyed `"<feature> <reason>"`; see {@link detectorKey}. */
export type CapabilityDetectors = Readonly<Record<string, CapabilityDetector>>;

export const detectorKey = (feature: string, reason: string): string =>
  `${feature} ${reason}`;

export interface CapabilityContext {
  /** The generated table. */
  table: Readonly<Record<string, CapabilityRowLike>>;
  /** The registry runtime id this client runs on (`node`, `web`, `desktop-bridge`, …). */
  runtime: string;
  /** Names the SDK in a `version` detail: `@polaris-key/node 0.4.0`. */
  sdkLabel: string;
  /** The opt-in service slugs. A row owned by anything else (`core`, `sdk`) never answers
   *  `product`. */
  serviceSlugs: readonly string[];
  /** Whether the product runs a service, per the client's current capability view. */
  serviceEnabled: (slug: string) => boolean;
  detectors?: CapabilityDetectors;
}

/** The thrown form of {@link Unsupported}: code `unsupported` unless an adapter keeps an older,
 *  more specific code for the same refusal. */
export class UnsupportedError extends PolarisError {
  readonly feature: string;
  readonly reason: UnsupportedReason;
  readonly detail: string;

  constructor(unsupported: Unsupported, code: string = UNSUPPORTED_CODE) {
    super(
      code,
      `${unsupported.feature} is not supported here (${unsupported.reason}): ${unsupported.detail}`,
    );
    this.name = "UnsupportedError";
    this.feature = unsupported.feature;
    this.reason = unsupported.reason;
    this.detail = unsupported.detail;
  }

  /** The result this error carries. */
  get unsupported(): Unsupported {
    return {
      supported: false,
      feature: this.feature,
      reason: this.reason,
      detail: this.detail,
    };
  }
}

const unsupported = (
  feature: string,
  reason: string,
  detail: string,
): Unsupported => ({
  supported: false,
  feature,
  reason: reason as UnsupportedReason,
  detail,
});

const RUNTIME_DETAIL: Record<string, string> = {
  runtime: "this runtime cannot do it at all",
  outlet: "the outlet this build ships through forbids it",
  dependency: "an optional dependency is missing",
  version: "this runtime is too old",
  product: "the product does not run it",
};

/** Decide one feature (see the module header for the order). Pure: no I/O. */
export function evaluateSupport(
  ctx: CapabilityContext,
  feature: string,
): Support {
  const row = Object.prototype.hasOwnProperty.call(ctx.table, feature)
    ? ctx.table[feature]
    : undefined;
  if (!row)
    return unsupported(
      feature,
      "version",
      `${ctx.sdkLabel} does not know the feature ${feature}`,
    );
  const here = row.na.filter((n) => n.runtime === ctx.runtime);
  const fixed =
    row.status === "na" ? here[0] : here.find((n) => n.reason === "runtime");
  if (fixed)
    return unsupported(
      feature,
      fixed.reason,
      `${feature} is not available on ${ctx.runtime}: ${RUNTIME_DETAIL[fixed.reason] ?? fixed.reason}`,
    );
  if (row.status === "na")
    // An `na` row covers every runtime the manifest lists (parity rule 3); a runtime outside
    // that list is not this SDK's, so nothing about it is supported either.
    return unsupported(
      feature,
      row.na[0]?.reason ?? "runtime",
      `${feature} is not available on ${ctx.runtime}`,
    );
  if (row.status === "planned")
    return unsupported(
      feature,
      "version",
      `${ctx.sdkLabel} does not implement ${feature} yet`,
    );
  if (
    ctx.serviceSlugs.includes(row.service) &&
    !ctx.serviceEnabled(row.service)
  )
    return unsupported(
      feature,
      "product",
      `the product does not run the ${row.service} service`,
    );
  for (const na of here) {
    const detector = ctx.detectors?.[detectorKey(feature, na.reason)];
    const detail = detector ? detector() : null;
    if (detail) return unsupported(feature, na.reason, detail);
  }
  return { supported: true, feature };
}

/**
 * The feature ids `supports()` answers Supported for, in table order: the `caps` device
 * telemetry key.
 */
export function supportedFeatures(ctx: CapabilityContext): string[] {
  return Object.keys(ctx.table).filter(
    (id) => evaluateSupport(ctx, id).supported,
  );
}

/**
 * Check a client's detectors against its table, so a manifest that declares a conditional N/A
 * cannot ship without the code that decides it, and code cannot decide one the manifest does
 * not declare. Returns the problems; empty means consistent. `runtimes` is every runtime the
 * SDK's manifest lists (a detector may serve one of them only).
 */
export function detectorProblems(
  table: Readonly<Record<string, CapabilityRowLike>>,
  runtime: string,
  runtimes: readonly string[],
  detectors: CapabilityDetectors = {},
): string[] {
  const problems: string[] = [];
  const declared = new Set<string>();
  for (const [feature, row] of Object.entries(table)) {
    if (row.status === "na") continue;
    for (const na of row.na) {
      if (na.reason === "runtime" || !runtimes.includes(na.runtime)) continue;
      const key = detectorKey(feature, na.reason);
      declared.add(key);
      if (na.runtime === runtime && !detectors[key])
        problems.push(
          `${feature}: the manifest declares a ${na.reason} N/A on ${runtime}, but no detector decides it`,
        );
    }
  }
  for (const key of Object.keys(detectors))
    if (!declared.has(key))
      problems.push(
        `${key.replace(" ", ": a ")} detector exists, but the manifest declares no such N/A`,
      );
  return problems;
}
