// Typed "unsupported here" for the React SDK (P1b-10, PARITY §2.2).
//
// Both adapters answer `supports(feature)` from the same generated table (`CAPABILITIES`, from
// packages/sdk-react/parity.json) through `@polaris-key/client-core`'s engine; they differ only in
// the runtime they pass: `web` for the browser adapter, `desktop-bridge` for the desktop one. A
// verb whose feature the table marks unsupported here throws `UnsupportedError`, which is this
// package's `PolarisError` (so `.code` branching keeps working) carrying `feature`, `reason` and
// `detail`.

import {
  detectorProblems,
  evaluateSupport,
  supportedFeatures,
  type CapabilityContext,
  type CapabilityDetectors,
  type Support,
  type Unsupported,
  type UnsupportedReason,
} from "@polaris-key/client-core";
import { CAPABILITIES, CAPABILITY_RUNTIMES } from "../constants.generated.js";
import { SDK_NAME, SDK_VERSION } from "../version.js";
import { SERVICE_SLUGS, type ServicesMap } from "./services.js";
import { PolarisError, type PolarisErrorCode } from "./types.js";

export type { Support, Supported, Unsupported } from "@polaris-key/client-core";

/** The registry runtime ids the two adapters run on (packages/sdk-react/parity.json). */
export type ReactRuntime = "web" | "desktop-bridge";

/** The thrown form of {@link Unsupported}. `code` is `unsupported`, except where a verb already
 *  refused with a more specific code before P1b-10 (`report-unsupported`,
 *  `device-management-unsupported`), which it keeps so existing `.code` checks still match. */
export class UnsupportedError extends PolarisError {
  readonly feature: string;
  readonly reason: UnsupportedReason;
  override readonly detail: string;

  constructor(
    unsupported: Unsupported,
    code: PolarisErrorCode = "unsupported",
    message?: string,
  ) {
    super(
      code,
      message ??
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

/** The React SDK declares no conditional N/A (every row is `runtime`), so no detectors. */
const DETECTORS: CapabilityDetectors = {};

/**
 * The capability context an adapter evaluates against. `services` reads the adapter's current
 * capability map (discovery, or the host's `expectServices` fallback), so `product` follows it.
 */
export function capabilityContext(
  runtime: ReactRuntime,
  services: () => ServicesMap,
): CapabilityContext {
  const problems = detectorProblems(
    CAPABILITIES,
    runtime,
    CAPABILITY_RUNTIMES,
    DETECTORS,
  );
  if (problems.length > 0)
    throw new Error(
      `capability table and detectors disagree: ${problems.join("; ")}`,
    );
  return {
    table: CAPABILITIES,
    runtime,
    sdkLabel: `${SDK_NAME} ${SDK_VERSION}`,
    serviceSlugs: SERVICE_SLUGS,
    serviceEnabled: (slug) =>
      services()[slug as keyof ServicesMap]?.enabled === true,
    detectors: DETECTORS,
  };
}

export function supportsIn(ctx: CapabilityContext, feature: string): Support {
  return evaluateSupport(ctx, feature);
}

export function capsIn(ctx: CapabilityContext): string[] {
  return supportedFeatures(ctx);
}

/**
 * Throw for a verb this transport never serves. The refusal is the table's own answer for this
 * runtime; a table that calls the feature supported here disagrees with the adapter, which is a
 * programming error and throws as one rather than letting the verb fall through.
 */
export function refuse(
  ctx: CapabilityContext,
  feature: string,
  opts: { code?: PolarisErrorCode; detail?: string } = {},
): never {
  const s = evaluateSupport(ctx, feature);
  // A verb may say more precisely than the table why it cannot run here; that sentence is both
  // the `detail` and the message a component renders.
  if (!s.supported)
    throw new UnsupportedError(
      opts.detail !== undefined ? { ...s, detail: opts.detail } : s,
      opts.code,
      opts.detail,
    );
  throw new Error(
    `${feature}: the capability table says it is supported on ${ctx.runtime}, but this adapter cannot serve it`,
  );
}

/** Throw `UnsupportedError` unless `feature` is supported here. */
export function requireSupported(
  ctx: CapabilityContext,
  feature: string,
  code?: PolarisErrorCode,
): void {
  const s = evaluateSupport(ctx, feature);
  if (!s.supported) throw new UnsupportedError(s, code);
}
