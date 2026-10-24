/**
 * The update slice of the console API (P0-32.22): settings, the simulator and update health.
 * Types and the `updateApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type { Rollout } from "./distribution.js";
import {
  UPDATE_ACCESS_KEY,
  UPDATE_COMPAT_KEY,
  UPDATE_KEYS,
  UPDATE_POLICY_KEY,
  getSettings,
  updateSettingsOf,
  writeSetting,
} from "./settings.js";
import { call, p } from "./transport.js";

// ── update settings (feed access + compat window) ─────────────────────────────
export type ReleaseAccess =
  | "public"
  | "authenticated"
  | "licensed"
  | "entitled";

/** Who owns a block a resync can also write: `admin` once an operator saved it here (resync then
 *  skips it), `manifest` otherwise (P0-01). */
export type SettingsSource = "manifest" | "admin";

export interface UpdateSettings {
  /** Who may read the changelog, the version check and the installer. */
  metadataAccess: ReleaseAccess;
  /** Who owns the metadata mode. (The artifacts mode is Distribution's since P2b-04:
   *  `DeliveryAccess`.) */
  accessSource: SettingsSource;
  compatMin: string;
  compatMax: string;
  compatSource: SettingsSource;
  /** Operator-only `sparkle:minimumSystemVersion`; `null` when unset. No manifest writes it. */
  minimumSystemVersion: string | null;
  /** Operator-only; `true` unless an operator explicitly turned it off (R6-03). */
  requireSparkleSignature: boolean;
  /** False when the product has no release configuration: the access modes and artifact policy
   *  are defaults and a PATCH of them has nothing to write to (the server 422s). */
  configured: boolean;
  /** The caller may not see the access mode (its area is Settings), so `metadataAccess` is a
   *  placeholder and no page should show it. */
  hidden?: true;
  /** The row version of each key as this view read it: a write names it as `expectedVersion`, so
   *  a page that went stale gets the 409 and the conflict UI rather than overwriting. */
  versions: { access: number; compat: number; policy: number };
}

export type UpdateSettingsBody = Partial<
  Pick<
    UpdateSettings,
    | "metadataAccess"
    | "compatMin"
    | "compatMax"
    | "minimumSystemVersion"
    | "requireSparkleSignature"
  >
>;

/** The blocks of the update settings Revert can hand back to the manifest (the settings `update.metadataAccess` and `release.compatWindow`). */
export type UpdateSettingsBlock = "access" | "compat";

// ── distribution: update health (P6-03) ───────────────────────────────────────
/** The seven update outcome events (`updateEvent` in conformance/parity/enums.json). */
export type UpdateEventName =
  | "update_offered"
  | "update_downloaded"
  | "update_applied"
  | "update_confirmed"
  | "update_reverted"
  | "pack_failed"
  | "boot_rolled_back";

export type UpdateEventCounts = Record<UpdateEventName, number>;

/** The operator-owned telemetry auto-halt (worker `services/distribution/autoHalt.ts`). */
export interface AutoHaltSettings {
  enabled: boolean;
  windowHours: number;
  minSample: number;
  maxRevertRate: number;
  maxBootRollbackRate: number;
}

/** A tracked object of the auto-halt or the Sentry hook (worker `connectors/state.ts`). */
export interface UpdateHealthObject {
  type: string;
  id: string;
  outletId: string | null;
  releaseId: string | null;
  state: string | null;
  ref: Record<string, unknown>;
  detail: Record<string, unknown>;
  terminal: boolean;
  updatedAt: number;
}

/** `GET …/distribution/update-health` (worker `services/distribution/updateHealthAdmin.ts`). */
export interface UpdateHealthResponse {
  windowHours: number;
  /** Whether this deployment has the counters bound at all. */
  counting: boolean;
  events: UpdateEventName[];
  rollouts: Array<{
    rollout: Rollout;
    /** Distinct devices per event; `null` when the counters could not be read. */
    devices: UpdateEventCounts | null;
    events: UpdateEventCounts | null;
    truncated: boolean;
    verdict: {
      revertRate: number | null;
      bootRollbackRate: number | null;
      trips: string[];
    } | null;
  }>;
  unknown: Array<{
    deliverable: string;
    releaseId: string;
    outlet: "unknown";
    devices: UpdateEventCounts;
  }>;
  autoHalt: {
    settings: AutoHaltSettings & {
      updatedAt: number | null;
      updatedBy: string | null;
    };
    defaults: AutoHaltSettings;
    maxWindowHours: number;
    lastReading: UpdateHealthObject | null;
    trips: UpdateHealthObject[];
    alerts: UpdateHealthObject[];
  };
  sentry: { configured: boolean; candidates: UpdateHealthObject[] };
}

// ── update: the simulator (P4-15; worker `update/simulate.ts`) ──────────────────
export interface SimulateParams {
  appRelease: string;
  platform: string;
  outlet?: string;
  /** `axis=value;axis=value` (a value may be a `,` preference list). */
  variant?: string;
  channel?: string;
  /** A device id, for the rollout buckets. */
  device?: string;
  /** A device's reported packSetId, to compare. */
  packSetId?: string;
  /** The binary update methods the device supports (`BINARY_METHODS`, `,`-separated). */
  methods?: string;
}

export interface SimulatedReleaseDto {
  sha256: string;
  version: string;
  seq: number;
}

export interface SimulatedPackDto {
  pack: string;
  declared: { binding: string; required: boolean; delivery: string } | null;
  expected: { required: boolean; delivery: string } | null;
  effectiveBinding: string | null;
  reason: {
    kind: "app-pin" | "app-hold" | "transport" | "declared" | "undeclared";
    detail: string;
    transport?: string;
  };
  feedTarget: SimulatedReleaseDto | null;
  gate: {
    halted: boolean;
    rollout: { bp: number; salt: string } | null;
    bucket: number | null;
    takesTarget: boolean;
    fallback: SimulatedReleaseDto | null;
  } | null;
  floor: { minVersion: string; versionScheme: string } | null;
  unsatisfied: { reason: string; detail: string; variant: string }[];
  revocations: {
    kind: "record" | "delegation";
    record: string;
    target: string;
    version: string;
    replacement: { releaseId: string; sha256: string } | null;
    reason: string;
  }[];
  active: SimulatedReleaseDto | null;
  install: SimulatedReleaseDto | null;
  revoke: boolean;
  runs: SimulatedReleaseDto | null;
}

/** `GET …/update/simulate`: the decision is client-core's `UpdateDecision`, as the worker ran it. */
export interface SimulateResponse {
  selector: {
    appRelease: string;
    version: string;
    channel: string;
    platform: string;
    outlet: { id: string; kind: string; servesPlatform: boolean } | null;
    axes: Record<string, string[]>;
    engine: string | null;
    contentApi: number | null;
    build: { id: string; arch: string; format: string } | null;
    device: string | null;
    methods: string[];
  };
  feed: {
    composable: boolean;
    selector: Record<string, string>;
    omitted: string[];
    /** Entries the document's delta menu lists (P4-29); 0: none. */
    deltas: number;
    target: SimulatedReleaseDto | null;
    appRollout: {
      halted: boolean;
      rollout: { bp: number; salt: string } | null;
      bucket: number | null;
    } | null;
  };
  decision: ({ action: string } & Record<string, unknown>) | null;
  boot: string | null;
  errors: { code: string; detail: string | null }[];
  set: { pack: string; sha256: string; version: string; seq: number }[];
  packSetId: string | null;
  activePackSetId: string | null;
  reported: { packSetId: string; matches: boolean } | null;
  block: string | null;
  packs: SimulatedPackDto[];
  notes: string[];
}

export const updateApi = {
  /** P4-15: what a fresh device running one app release gets on one outlet (read-only). */
  simulateUpdate: (slug: string, params: SimulateParams) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (typeof v === "string" && v !== "") q.set(k, v);
    return call<SimulateResponse>(`${p(slug)}/update/simulate?${q.toString()}`);
  },
  // ── update settings (the generic settings API: `update.metadataAccess`,
  //    `release.compatWindow`, `update.operatorPolicy`) ────────────────────────
  updateSettings: async (slug: string): Promise<UpdateSettings> =>
    updateSettingsOf(await getSettings(slug, UPDATE_KEYS)),
  /**
   * Each key the body names is one write, carrying the version the page loaded (`versions`, from
   * the `UpdateSettings` it shows). The three blocks are three registry keys and the generic API
   * writes one key per request, so a save that spans blocks is several requests; the pages each
   * save one block, so in practice it is one. The merge base for a partial compat window or
   * operator policy is the view the page loaded too.
   */
  saveUpdateSettings: async (
    slug: string,
    body: UpdateSettingsBody,
    cur: UpdateSettings,
  ): Promise<UpdateSettings> => {
    if (body.metadataAccess !== undefined)
      await writeSetting(slug, UPDATE_ACCESS_KEY, "PATCH", {
        value: body.metadataAccess,
        expectedVersion: cur.versions.access,
      });
    if (body.compatMin !== undefined || body.compatMax !== undefined)
      await writeSetting(slug, UPDATE_COMPAT_KEY, "PATCH", {
        value: {
          min: body.compatMin ?? cur.compatMin,
          max: body.compatMax ?? cur.compatMax,
        },
        expectedVersion: cur.versions.compat,
      });
    if (
      body.minimumSystemVersion !== undefined ||
      body.requireSparkleSignature !== undefined
    ) {
      const min =
        body.minimumSystemVersion === undefined
          ? cur.minimumSystemVersion
          : body.minimumSystemVersion;
      await writeSetting(slug, UPDATE_POLICY_KEY, "PATCH", {
        value: {
          requireSparkleSignature:
            body.requireSparkleSignature ?? cur.requireSparkleSignature,
          ...(min === null ? {} : { minimumSystemVersion: min }),
        },
        expectedVersion: cur.versions.policy,
      });
    }
    return updateSettingsOf(await getSettings(slug, UPDATE_KEYS));
  },
  /** Hand the named blocks back to the manifest. Changes nothing live — the manifest re-applies
   *  on the NEXT resync (worker `core/settings/columns.ts`). */
  revertUpdateSettings: async (
    slug: string,
    fields: UpdateSettingsBlock[],
    cur: UpdateSettings,
  ): Promise<UpdateSettings> => {
    for (const block of fields)
      await writeSetting(
        slug,
        block === "access" ? UPDATE_ACCESS_KEY : UPDATE_COMPAT_KEY,
        "DELETE",
        {
          expectedVersion:
            block === "access" ? cur.versions.access : cur.versions.compat,
        },
      );
    return updateSettingsOf(await getSettings(slug, UPDATE_KEYS));
  },
  // ── distribution: update health (P6-03) ─────────────────────────────────────
  updateHealth: (slug: string, windowHours?: number) =>
    call<UpdateHealthResponse>(
      `${p(slug)}/distribution/update-health${
        windowHours !== undefined ? `?windowHours=${windowHours}` : ""
      }`,
    ),
  /** The auto-halt settings — the ONE writer, audited by the worker. */
  saveAutoHalt: (slug: string, body: Partial<AutoHaltSettings>) =>
    call<{ settings: UpdateHealthResponse["autoHalt"]["settings"] }>(
      `${p(slug)}/distribution/update-health/settings`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Confirm (halts the rollout, as you) or dismiss a Sentry halt candidate. */
  decideCandidate: (
    slug: string,
    id: string,
    decision: "confirm" | "dismiss",
  ) =>
    call<{ candidate: UpdateHealthObject }>(
      `${p(slug)}/distribution/update-health/candidates/${encodeURIComponent(id)}/${decision}`,
      { method: "POST", body: JSON.stringify({}) },
    ),
};
