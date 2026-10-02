// The capability table every SDK's `supports()` reads (P1b-10, PARITY §2.2).
//
// One table per SDK, generated from that SDK's parity manifest into its constants module by
// `pnpm gen:constants` (tools/gen-sdk-constants.ts). The manifest is the one declaration: a
// feature the manifest calls `planned` is unsupported (`version`) and one it declares N/A on a
// runtime is unsupported there, so the code cannot drift from what the parity page shows.
//
// Each row carries:
//
//   status   the manifest's `implemented`, `planned` or `na`
//   service  the registry's owning service; an opt-in service's features answer `product`
//            while discovery says the service is off
//   na       every (runtime, reason) the manifest declares, a trait expanded to each of the
//            manifest's runtimes. A `runtime` reason holds wherever that runtime is; any other
//            reason (`outlet`, `dependency`, `version`) names a detector the SDK runs on that
//            runtime, and the SDK refuses to construct a client whose detectors and table differ.
//
// `capabilityDigest` is a SHA-256 over the canonical rows. The generator writes it into each
// constants module as `CAPABILITY_DIGEST`, and `pnpm parity:check` (rule 7) recomputes it from
// the manifest, so editing a manifest without regenerating fails the parity gate as well as
// `pnpm gen:constants -- --check`.

import { createHash } from "node:crypto";

export type CapabilityStatus = "implemented" | "planned" | "na";

export interface CapabilityNa {
  runtime: string;
  reason: string;
}

export interface CapabilityRow {
  feature: string;
  status: CapabilityStatus;
  service: string;
  na: CapabilityNa[];
}

export interface SdkCapabilities {
  sdk: string;
  runtimes: string[];
  rows: CapabilityRow[];
}

/** The parts of the registry this module reads. */
export interface CapabilityRegistry {
  features: { id: string; service: string }[];
}

/** The parts of a manifest this module reads (tools/parity-check.ts has the full shape). */
export interface CapabilityManifest {
  sdk: string;
  runtimes: string[];
  traits?: string[];
  features: Record<
    string,
    {
      status: CapabilityStatus;
      runtime?: string | string[];
      reason?: string;
      except?: { runtime: string; reason: string }[];
    }
  >;
}

/**
 * The SDK's capability table, in registry order. Throws when the manifest lacks a registry
 * feature (the parity gate's rule 1 names it first; the generator must not guess).
 */
export function capabilityTable(
  registry: CapabilityRegistry,
  manifest: CapabilityManifest,
): SdkCapabilities {
  const traits = new Set(manifest.traits ?? []);
  // A trait (`headless`) is a property of the whole SDK, so it stands for every runtime.
  const expand = (name: string): string[] =>
    traits.has(name) ? [...manifest.runtimes] : [name];
  const rows = registry.features.map((feature): CapabilityRow => {
    const entry = manifest.features[feature.id];
    if (!entry)
      throw new Error(
        `${manifest.sdk}: ${feature.id} is missing from the manifest`,
      );
    const declared: CapabilityNa[] = [];
    if (entry.status === "na") {
      const names = Array.isArray(entry.runtime)
        ? entry.runtime
        : [entry.runtime ?? ""];
      for (const name of names)
        for (const runtime of expand(name))
          declared.push({ runtime, reason: entry.reason ?? "" });
    } else {
      for (const ex of entry.except ?? [])
        for (const runtime of expand(ex.runtime))
          declared.push({ runtime, reason: ex.reason });
    }
    const seen = new Set<string>();
    const na = declared.filter((n) => {
      const key = `${n.runtime}\u0000${n.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      feature: feature.id,
      status: entry.status,
      service: feature.service,
      na,
    };
  });
  return { sdk: manifest.sdk, runtimes: [...manifest.runtimes], rows };
}

/** SHA-256 (lowercase hex) over the canonical JSON of the table. */
export function capabilityDigest(caps: SdkCapabilities): string {
  const canonical = JSON.stringify({
    sdk: caps.sdk,
    runtimes: caps.runtimes,
    rows: caps.rows.map((r) => [
      r.feature,
      r.status,
      r.service,
      r.na.map((n) => [n.runtime, n.reason]),
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
