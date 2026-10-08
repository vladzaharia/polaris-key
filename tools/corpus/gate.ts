// `gate-matrix.json` v2 (§5): the rows carried from corpus v1, the channel rows (P0-04) and
// SP-00's `entitlementRows`.

import { isUsable, licenseState } from "@polaris-key/client-core/gate";
import type { ManagedEntry } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { AUD_V3, ISSUER_V3 } from "./common.js";

// ── gate-matrix v2 (§5) ──────────────────────────────────────────────────────
// The matrix is hand-authored and frozen. Its first rows are corpus v1's fifteen, inlined
// verbatim below when v1 was deleted, less the one P0-04 retired (`RETIRED_CARRIED_ROWS`); the
// rows v1 could not express are appended in `buildGateMatrixV2`.

/**
 * The fifteen rows corpus v1's hand-authored matrix carried, INLINED here when corpus v1 was
 * deleted (Task 8.14). They arrive already shimmed into the v3 shape — every v1 product was
 * licensed (`licenseServiceEnabled: true`) and v1's `hasToken` boolean became v3's tri-state
 * `activation` — so a v3 gate that changes any decision v2 made goes red below.
 *
 * Frozen: nothing may be edited here to make a gate change pass. A genuinely new decision is a
 * NEW row appended in `buildGateMatrixV2`, so the diff shows what changed. A carried row can be
 * retired only by an approved plan, through `RETIRED_CARRIED_ROWS`, with a named successor row.
 */
const CARRIED_MATRIX_ROWS = [
  {
    name: "ok — stable build inside window, valid doc",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
      lastVerifiedAt: 1490,
    },
    expect: {
      status: "ok",
      ok: true,
    },
  },
  {
    name: "ok — staging build permitted by channels entitlement",
    gate: {
      version: "2.0.0",
      channel: "staging",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      entitlements: {
        channels: {
          state: "enforced",
          value: ["stable", "staging"],
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "ok",
      ok: true,
    },
  },
  {
    name: "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel",
    gate: {
      version: "0.0.0-dev+abc123",
      channel: "staging",
      compatMin: "5.0.0",
      compatMax: "6.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "ok",
      ok: true,
    },
  },
  {
    name: "grace — doc past expiresAt but within graceUntil (offline grace)",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 5000,
      lastVerifiedAt: 4600,
    },
    expect: {
      status: "grace",
      ok: true,
    },
  },
  {
    name: "expired — doc past graceUntil",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 2593001,
    },
    expect: {
      status: "expired",
      ok: false,
    },
  },
  {
    name: "revoked — hard 401 on the last sync even with a valid doc",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
      lastSyncUnauthorized: true,
    },
    expect: {
      status: "revoked",
      ok: false,
    },
  },
  {
    name: "needs-activation — no token (no credential stored)",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: null,
      now: 1500,
    },
    expect: {
      status: "needs-activation",
      ok: false,
    },
  },
  {
    name: "needs-activation — token present but no cached doc yet",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      now: 1500,
    },
    expect: {
      status: "needs-activation",
      ok: false,
    },
  },
  {
    name: "version-too-old — build below the product compat min",
    gate: {
      version: "0.9.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-old",
      ok: false,
      reason: "version-too-old",
      allowedRange: {
        min: "1.0.0",
        max: "3.0.0",
      },
    },
  },
  {
    name: "version-too-old — per-key app.minVersion tighter than product min wins",
    gate: {
      version: "1.5.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {
        "app.minVersion": {
          state: "enforced",
          value: "2.0.0",
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-old",
      ok: false,
      reason: "version-too-old",
      allowedRange: {
        min: "2.0.0",
        max: "3.0.0",
      },
    },
  },
  {
    name: "version-too-new — build above the product compat max",
    gate: {
      version: "4.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-new",
      ok: false,
      reason: "version-too-new",
      allowedRange: {
        min: "1.0.0",
        max: "3.0.0",
      },
    },
  },
  {
    name: "version-too-new — per-key app.maxVersion tighter than product max wins",
    gate: {
      version: "2.5.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {
        "app.maxVersion": {
          state: "enforced",
          value: "2.0.0",
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-new",
      ok: false,
      reason: "version-too-new",
      allowedRange: {
        min: "1.0.0",
        max: "2.0.0",
      },
    },
  },
  {
    name: "channel-not-entitled — staging build without the channels entitlement",
    gate: {
      version: "2.0.0",
      channel: "staging",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "channel-not-entitled",
      ok: false,
      reason: "channel-not-entitled",
    },
  },
  {
    name: "channel-not-entitled — pr build, channels grants only staging",
    gate: {
      version: "1.0.0",
      channel: "pr-42",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      entitlements: {
        channels: {
          state: "enforced",
          value: ["staging"],
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "channel-not-entitled",
      ok: false,
      reason: "channel-not-entitled",
    },
  },
  {
    name: "precedence — a build block wins even over a doc that would otherwise be ok",
    gate: {
      version: "4.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
      lastVerifiedAt: 1490,
    },
    expect: {
      status: "version-too-new",
      ok: false,
      reason: "version-too-new",
      allowedRange: {
        min: "1.0.0",
        max: "3.0.0",
      },
    },
  },
] as const;

/**
 * Carried rows an approved plan retired, keyed by exact row name. The frozen array above stays
 * byte-for-byte as it was; `buildGateMatrixV2` filters these out, and refuses to generate if a
 * key names no carried row or its successor is missing from the output.
 */
const RETIRED_CARRIED_ROWS: Record<
  string,
  { retiredBy: string; why: string; successor: string }
> = {
  "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel":
    {
      retiredBy: "P0-04",
      why: "It pins the unconditional dev-build bypass that R3-01 removed: today's server answers `version-too-old` for its inputs, and R3 calls the row defensible only for a client-side build gate, which no SDK has.",
      successor:
        "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
    },
};

/** The standard in-window build gate, for rows whose subject is the license half. */
const PASSING_GATE = {
  version: "2.0.0",
  compatMin: "1.0.0",
  compatMax: "3.0.0",
  entitlements: {},
};
/** A build gate that BLOCKS: 4.0.0 is above the compat max. */
const BLOCKING_GATE = {
  version: "4.0.0",
  compatMin: "1.0.0",
  compatMax: "3.0.0",
  entitlements: {},
};
/** The v1 matrix's document window, reused so the new rows sit on the same timeline. */
const MATRIX_DOC = { issuedAt: 1000, expiresAt: 4600, graceUntil: 2593000 };

// ── The channel rows (P0-04, WIRE-CONTRACT-V3 §5.1) ──────────────────────────

/** A `channels` entitlement granting `names`; no names means no entitlement at all. */
function grant(...names: string[]): Record<string, unknown> {
  if (names.length === 0) return {};
  return {
    channels: { state: "enforced", value: names, updatedAt: 1699990000 },
  };
}
/** The header rows' window: wide, with a floor that refuses every `0.0.0-*` build. */
const HEADER_WINDOW = { compatMin: "0.0.0", compatMax: "99.0.0" };
/** `0.0.0-0` sorts below every `0.0.0-<word>` build, so those builds reach the channel check. */
const PRERELEASE_WINDOW = { compatMin: "0.0.0-0", compatMax: "99.0.0" };
/** The licence half of every channel row: an activated, in-window document. */
const CHANNEL_LICENSE = {
  licenseServiceEnabled: true,
  activation: "token",
  ...MATRIX_DOC,
  now: 1500,
};
const CHANNEL_OK = { status: "ok", ok: true };
const CHANNEL_NOT_ENTITLED = {
  status: "channel-not-entitled",
  ok: false,
  reason: "channel-not-entitled",
};

function channelRow(
  name: string,
  version: string,
  channel: string | null,
  window: { compatMin: string; compatMax: string },
  entitlements: Record<string, unknown>,
  expect: Record<string, unknown>,
): unknown {
  return {
    name,
    gate: {
      version,
      ...(channel === null ? {} : { channel }),
      ...window,
      entitlements,
    },
    license: CHANNEL_LICENSE,
    expect,
  };
}

/** The channel vocabulary, pinned (P0-04 plan §4). Rows 1–8 are the brief's minimum set. */
function channelRows(): unknown[] {
  const H = HEADER_WINDOW;
  const P = PRERELEASE_WINDOW;
  const DEV_WINDOW = { compatMin: "5.0.0", compatMax: "6.0.0" };
  return [
    channelRow(
      "ok — beta header, channels [stable, beta]",
      "2.0.0",
      "beta",
      H,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — beta header, channels [stable, staging] (alias)",
      "2.0.0",
      "beta",
      H,
      grant("stable", "staging"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — staging header, channels [stable, beta] (alias)",
      "2.0.0",
      "staging",
      H,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — beta header, channels [stable]",
      "2.0.0",
      "beta",
      H,
      grant("stable"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "ok — manual channel header, entitled by name",
      "2.0.0",
      "nightly",
      H,
      grant("stable", "nightly"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — manual channel header, not entitled",
      "2.0.0",
      "nightly",
      H,
      grant("stable", "beta"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "channel-not-entitled — malformed channel header",
      "2.0.0",
      "STAGING",
      H,
      grant("stable", "staging", "beta"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "ok — 0.0.0-beta build with beta entitlement",
      "0.0.0-beta.3",
      null,
      P,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — 0.0.0-beta build without a beta entitlement",
      "0.0.0-beta.3",
      null,
      P,
      grant("stable"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "ok — 0.0.0-staging build is the beta channel, channels [stable, beta]",
      "0.0.0-staging.1",
      null,
      P,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — latest header is the stable channel",
      "2.0.0",
      "latest",
      H,
      grant(),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — pr-42 header, channels grant the pr family",
      "2.0.0",
      "pr-42",
      H,
      grant("stable", "pr"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — pr header on a 0.0.0-pr-42 build, channels [stable, pr-42]",
      "0.0.0-pr-42+sha",
      "pr",
      P,
      grant("stable", "pr-42"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — pr-7 header, channels grant only pr-42",
      "2.0.0",
      "pr-7",
      H,
      grant("stable", "pr-42"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "channel-not-entitled — stable header cannot loosen a 0.0.0-pr-42 build",
      "0.0.0-pr-42+sha",
      "stable",
      P,
      grant(),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "channel-not-entitled — dev header without the dev entitlement",
      "2.0.0",
      "dev",
      H,
      grant("stable", "beta"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
      "0.0.0-dev+abc123",
      "staging",
      DEV_WINDOW,
      grant(),
      {
        status: "version-too-old",
        ok: false,
        reason: "version-too-old",
        allowedRange: { min: "5.0.0", max: "6.0.0" },
      },
    ),
    channelRow(
      "ok — dev build with the dev entitlement bypasses the window (R3-01)",
      "0.0.0-dev+abc123",
      "staging",
      DEV_WINDOW,
      grant("stable", "dev"),
      CHANNEL_OK,
    ),
  ];
}

/** The carried rows still emitted, after `RETIRED_CARRIED_ROWS`. */
function carriedRows(): readonly unknown[] {
  const names = new Set<string>(CARRIED_MATRIX_ROWS.map((r) => r.name));
  for (const retired of Object.keys(RETIRED_CARRIED_ROWS))
    if (!names.has(retired))
      throw new Error(`RETIRED_CARRIED_ROWS names no carried row: ${retired}`);
  return CARRIED_MATRIX_ROWS.filter((r) => !(r.name in RETIRED_CARRIED_ROWS));
}

export function buildGateMatrixV2(): unknown {
  const matrix = gateMatrixV2();
  const emitted = new Set(matrix.rows.map((r) => (r as { name: string }).name));
  if (emitted.size !== matrix.rows.length)
    throw new Error("gate-matrix v2 has two rows with one name");
  for (const [name, { successor }] of Object.entries(RETIRED_CARRIED_ROWS))
    if (!emitted.has(successor))
      throw new Error(
        `retired carried row "${name}" names a successor that is not emitted: ${successor}`,
      );
  return matrix;
}

function gateMatrixV2(): {
  gateMatrixVersion: number;
  description: string;
  rows: unknown[];
  entitlementRows: EntitlementRow[];
} {
  return {
    gateMatrixVersion: 2,
    description:
      'Cross-SDK gate decision matrix for wire contract v3 §5. Each row carries the build-gate inputs (version/channel/compat window/entitlements) AND the license-state inputs, paired with the single expected decision. The first fourteen rows are corpus v1\'s matrix, carried verbatim under the smallest possible shim — `licenseServiceEnabled: true` (every v1 product was licensed) and `hasToken` → `activation: "token" | null` — and inlined here when corpus v1 was deleted, so a v3 gate that changes any decision v2 made goes red here; a fifteenth carried row, the pre-R3-01 dev-build bypass, was retired by P0-04 and its successor row appended. The next rows pin what v1 could not express: `not-applicable` for a product that does not enable the license service (D-08), `activation: "bundle"` for an air-gapped install (§7), and the ONE ordering v3 changed — the activation guard runs BEFORE the unsigned `blocked` hint. `expect.reason` names the build-gate hint that was derived, which on the activation-precedes-blocked row is deliberately NOT the status. The channel rows that follow pin the channel vocabulary of §5.1 (P0-04): header normalisation, the `staging`/`beta` alias, the `pr` family, manual names, `dev`, and the build-implied channel. Times are epoch SECONDS. ManagedEntry values use the {state, value, updatedAt} shape. `entitlementRows` (SP-00, plans/SP-00.md D4) is a separate family over the same `gate` and `license` inputs, so a runner evaluates the status exactly as for `rows`: `entitlement.entry` is what the cached licence document carries at `entitlements[entitlement.key]` (null when it carries nothing, and always null without a document), and `expect.isEntitled` is `isUsable(status) && entry.value === true` — the entitlement answer follows the gate, so a revoked, expired or unactivated licence entitles nothing even while its cached document still says `true` (S-19 G11). The documents are today\'s licence shape (S-19 `legacy` mode): no new member and no per-entry expiry.',
    rows: [
      ...carriedRows(),
      {
        name: "not-applicable — license service disabled, nothing cached",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: false,
          activation: null,
          now: 1500,
        },
        expect: { status: "not-applicable", ok: true },
      },
      {
        name: "not-applicable — license service disabled even with a valid document cached",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: false,
          activation: "token",
          ...MATRIX_DOC,
          now: 1500,
          lastVerifiedAt: 1490,
        },
        expect: { status: "not-applicable", ok: true },
      },
      {
        name: "ok — bundle activation inside the document window",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "bundle",
          ...MATRIX_DOC,
          now: 1500,
        },
        expect: { status: "ok", ok: true },
      },
      {
        name: "grace — bundle activation past expiresAt, inside graceUntil",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "bundle",
          ...MATRIX_DOC,
          now: 5000,
        },
        expect: { status: "grace", ok: true },
      },
      {
        name: "expired — bundle activation past graceUntil (the air-gapped install runs out)",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "bundle",
          ...MATRIX_DOC,
          now: 2593001,
        },
        expect: { status: "expired", ok: false },
      },
      {
        name: "needs-activation — unactivated device with a build block (activation precedes blocked)",
        gate: BLOCKING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: null,
          now: 1500,
        },
        // The build gate DOES derive `version-too-new` here; the decision is still
        // `needs-activation`, and no allowedRange is surfaced. Corpus v1 has no row where
        // the hint and the status disagree, which is why v3's ordering needed a new one.
        expect: {
          status: "needs-activation",
          ok: false,
          reason: "version-too-new",
        },
      },
      ...channelRows(),
    ],
    entitlementRows: entitlementRows(),
  };
}

// ── gate-matrix v2 `entitlementRows` (SP-00, plans/SP-00.md §4 and D4) ───────
// `isEntitled(key)` answers from the gate, not from the cached document alone: an SDK that reads
// `doc.entitlements[key].value` without asking the gate keeps entitling a revoked or expired
// licence (S-19 G11). Each row is evaluated here through client-core's own `licenseState` and
// `isUsable`, so a hand-authored `expect` that disagrees with the reference gate fails the run.

interface EntitlementRow {
  name: string;
  gate: typeof PASSING_GATE;
  license: {
    licenseServiceEnabled: boolean;
    activation: "token" | "bundle" | null;
    now: number;
    issuedAt?: number;
    expiresAt?: number;
    graceUntil?: number;
    lastSyncUnauthorized?: boolean;
    lastVerifiedAt?: number;
  };
  entitlement: { key: string; entry: ManagedEntry | null };
  expect: { status: string; isEntitled: boolean };
}

/** The entitlement every G11 row asks about: a DLC flag the admin enforces `true`. */
const DLC_ENFORCED_TRUE: ManagedEntry = {
  state: "enforced",
  value: true,
  updatedAt: 1699990000,
};

function entitlementRows(): EntitlementRow[] {
  const dlc = { key: "dlc", entry: DLC_ENFORCED_TRUE };
  const rows: EntitlementRow[] = [
    {
      name: "ok — dlc enforced true is entitled",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 1500,
        lastVerifiedAt: 1490,
      },
      entitlement: dlc,
      expect: { status: "ok", isEntitled: true },
    },
    {
      name: "grace — dlc enforced true is still entitled past expiresAt, inside graceUntil",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 5000,
      },
      entitlement: dlc,
      expect: { status: "grace", isEntitled: true },
    },
    {
      name: "expired — dlc enforced true in a document past graceUntil is not entitled",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 2593001,
      },
      entitlement: dlc,
      expect: { status: "expired", isEntitled: false },
    },
    {
      name: "revoked — hard 401 on the last sync: dlc enforced true in the cached document is not entitled (G11)",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 1500,
        lastSyncUnauthorized: true,
      },
      entitlement: dlc,
      expect: { status: "revoked", isEntitled: false },
    },
    {
      name: "needs-activation — an unactivated device is not entitled even with a cached dlc document",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: null,
        ...MATRIX_DOC,
        now: 1500,
      },
      entitlement: dlc,
      expect: { status: "needs-activation", isEntitled: false },
    },
    {
      name: "not-applicable — usable, but no document means no entitlement",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: false,
        activation: null,
        now: 1500,
      },
      entitlement: { key: "dlc", entry: null },
      expect: { status: "not-applicable", isEntitled: false },
    },
  ];
  for (const row of rows) assertEntitlementRow(row);
  if (new Set(rows.map((r) => r.name)).size !== rows.length)
    throw new Error("gate-matrix entitlementRows has two rows with one name");
  return rows;
}

/** The row's status through client-core's gate, and `isEntitled` through `isUsable`. */
function assertEntitlementRow(row: EntitlementRow): void {
  const l = row.license;
  const hasDoc =
    l.issuedAt !== undefined &&
    l.expiresAt !== undefined &&
    l.graceUntil !== undefined;
  if (!hasDoc && row.entitlement.entry !== null)
    throw new Error(`${row.name}: an entry without a cached document`);
  const doc: LicenseDoc | null = hasDoc
    ? {
        aud: AUD_V3,
        iss: ISSUER_V3,
        licenseId: "lic_matrix",
        deviceId: "dev_matrix",
        issuedAt: l.issuedAt as number,
        expiresAt: l.expiresAt as number,
        graceUntil: l.graceUntil as number,
        entitlements:
          row.entitlement.entry === null
            ? {}
            : { [row.entitlement.key]: row.entitlement.entry },
      }
    : null;
  // PASSING_GATE derives no build-gate hint, so nothing is `blocked`.
  const state = licenseState({
    licenseServiceEnabled: l.licenseServiceEnabled,
    activation: l.activation,
    doc,
    now: l.now,
    lastSyncUnauthorized: l.lastSyncUnauthorized,
    lastVerifiedAt: l.lastVerifiedAt,
  });
  if (state.status !== row.expect.status)
    throw new Error(
      `${row.name}: client-core's gate says ${state.status}, the row says ${row.expect.status}`,
    );
  const entitled =
    isUsable(state.status) &&
    doc?.entitlements[row.entitlement.key]?.value === true;
  if (entitled !== row.expect.isEntitled)
    throw new Error(
      `${row.name}: isUsable(status) && value === true is ${entitled}, the row says ${row.expect.isEntitled}`,
    );
}
