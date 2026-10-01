/**
 * Whether — and how — the Google Play connector runs for one product (P5-03).
 *
 * It runs when the product declares a live `play` or `play-testing` outlet in
 * `.pkey/distribution` whose identity names the Android `packageName` and a `tracks` map
 * (declared channel → Play track id, e.g. `{ stable: "production", beta: "beta" }`), AND an
 * operator has stored an active `google-service-account` outlet credential (P5-01). Without both
 * the poller skips the product before any call and every control answers `not_configured`.
 *
 * **One app per product.** Every Play outlet of the product that names the same package is part
 * of the setup (a `play` outlet for production and beta, a `play-testing` one for an internal
 * track, say); an outlet naming another package is not this connector's — the service account is
 * invited to one app, and the brief's threat model keeps it there. The `play` kind wins the tie
 * for which package that is, then the lowest outlet id.
 *
 * **Track ids are data.** The map comes from the manifest and the track list from Play's own
 * `edits.tracks.list`; nothing here knows that the internal-testing track is `internal` or `qa`
 * (notes/E2 §A1 "Tracks"), and a track Play lists that no outlet maps is shown, never written.
 *
 * Credential choice: a credential bound to one of the product's Play outlets (`outletId`) wins
 * over an unbound one; ties go to the lowest id. Only metadata is read here — listing never
 * selects the sealed column — so resolving the setup opens nothing.
 */

import type { Db } from "../../../../core/platform.js";
import { listOutletCredentials } from "../../../../core/outletCredentials.js";
import { listOutlets, parseJsonColumn } from "../../outlets.js";

export const PLAY_CONNECTOR = "play";
export const PLAY_LABEL = "Google Play";
export const PLAY_OUTLET_KINDS = ["play", "play-testing"] as const;

/** The audit actor kind of a vitals auto-halt (`connector:play-vitals`). */
export const PLAY_VITALS_SOURCE = "play-vitals";
export const PLAY_VITALS_LABEL = "Google Play vitals auto-halt";

/** An Android package name (the manifest's own rule, re-checked: it becomes a URL segment). */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_PACKAGE_NAME = 255;
/** A Play track id (the manifest's rule): `production`, `qa`, `wear:beta`, a custom name. */
export const PLAY_TRACK = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,99}$/;
/** A channel name as `dist_rollouts` keys it. */
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PlayOutletRoute {
  outletId: string;
  channel: string;
}

export interface PlaySetup {
  product: string;
  packageName: string;
  /** The live Play outlets of that package, with their declared channel → track maps. */
  outlets: Array<{
    outletId: string;
    kind: string;
    tracks: Record<string, string>;
  }>;
  /** Play track id → every (outlet, channel) that declares it. */
  routes: Map<string, PlayOutletRoute[]>;
  /** The `google-service-account` credential id. */
  credentialId: string;
}

function identityOf(json: string): Record<string, unknown> {
  const v = parseJsonColumn(json);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function tracksOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [channel, track] of Object.entries(v as Record<string, unknown>))
    if (
      CHANNEL.test(channel) &&
      typeof track === "string" &&
      PLAY_TRACK.test(track)
    )
      out[channel] = track;
  return out;
}

/** The product's Play setup, or `null` when the connector does not run for it. */
export async function playSetup(
  db: Db,
  product: string,
): Promise<PlaySetup | null> {
  const candidates = (await listOutlets(db, product))
    .filter(
      (o) =>
        o.removed_at === null &&
        (PLAY_OUTLET_KINDS as readonly string[]).includes(o.kind),
    )
    .map((o) => {
      const identity = identityOf(o.identity_json);
      const packageName =
        typeof identity.packageName === "string" &&
        identity.packageName.length <= MAX_PACKAGE_NAME &&
        PACKAGE_NAME.test(identity.packageName)
          ? identity.packageName
          : null;
      return {
        outletId: o.outlet_id,
        kind: o.kind,
        packageName,
        tracks: tracksOf(identity.tracks),
      };
    })
    .filter((o) => o.packageName !== null);
  // `listOutlets` orders by id; the `play` kind names the app when both kinds are declared.
  const primary =
    candidates.find((o) => o.kind === "play") ?? candidates[0] ?? null;
  if (!primary) return null;
  const outlets = candidates
    .filter((o) => o.packageName === primary.packageName)
    .map(({ outletId, kind, tracks }) => ({ outletId, kind, tracks }));

  const playOutlets = new Set(outlets.map((o) => o.outletId));
  const creds = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === "google-service-account",
  );
  const credential =
    creds.find((c) => c.outletId !== null && playOutlets.has(c.outletId)) ??
    creds.find((c) => c.outletId === null);
  if (!credential) return null;

  const routes = new Map<string, PlayOutletRoute[]>();
  for (const o of outlets)
    for (const [channel, track] of Object.entries(o.tracks)) {
      const list = routes.get(track) ?? [];
      list.push({ outletId: o.outletId, channel });
      routes.set(track, list);
    }
  return {
    product,
    packageName: primary.packageName!,
    outlets,
    routes,
    credentialId: credential.id,
  };
}
