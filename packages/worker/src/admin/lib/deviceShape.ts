// Device fingerprint + software-facts projections for the admin API.
//
// Shared by the license-detail endpoint and the devices endpoint so the two can't drift:
// both render into the same admin panel, and a field present in one but not the other
// shows up as data that mysteriously appears and disappears depending on the route.

import type { DeviceFactsRow, FingerprintRow } from "../../repo.js";

/** Component digests are opaque, but still hardware-derived — show only a short prefix so a
 *  screenshot of this panel can't be used to correlate a device across products. */
export function shapeFingerprint(row: FingerprintRow | null): unknown {
  if (!row) return null;
  let components: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.components_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      components = Object.fromEntries(
        Object.entries(parsed as Record<string, string>).map(([k, v]) => [
          k,
          typeof v === "string" ? v.slice(0, 8) : "",
        ]),
      );
    }
  } catch {
    components = {};
  }
  return {
    status: row.status,
    hwid: row.hwid ? row.hwid.slice(0, 12) : null,
    components,
    componentCount: Object.keys(components).length,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastDriftAt: row.last_drift_at ?? undefined,
    lastDriftCount: row.last_drift_count ?? undefined,
  };
}

export function shapeFacts(row: DeviceFactsRow | null): unknown {
  if (!row) return null;
  let probes: unknown = undefined;
  if (row.probes_json) {
    try {
      probes = JSON.parse(row.probes_json);
    } catch {
      probes = undefined;
    }
  }
  return {
    os: {
      name: row.os_name ?? undefined,
      version: row.os_version ?? undefined,
      build: row.os_build ?? undefined,
      kernel: row.kernel ?? undefined,
    },
    hardware: {
      cpuModel: row.cpu_model ?? undefined,
      cpuCores: row.cpu_cores ?? undefined,
      ramMb: row.ram_mb ?? undefined,
      machineModel: row.machine_model ?? undefined,
    },
    runtime: {
      name: row.runtime_name ?? undefined,
      version: row.runtime_version ?? undefined,
    },
    locale: row.locale ?? undefined,
    timezone: row.timezone ?? undefined,
    probes,
    updatedAt: row.updated_at,
  };
}
