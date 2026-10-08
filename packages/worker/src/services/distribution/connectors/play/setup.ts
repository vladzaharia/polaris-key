/**
 * Whether — and how — the Google Play connector runs for one product (P5-03).
 *
 * It runs when the product declares a live `play` or `play-testing` outlet in
 * `.pkey/distribution` whose identity names the Android `packageName` and a `tracks` map
 * (declared channel → Play track id, e.g. `{ stable: "production", beta: "beta" }`), AND an
 * operator has stored an active `google-service-account` outlet credential (P5-01), AND that
 * credential is PINNED to the same `packageName` (`OUTLET_CREDENTIAL_PINS`, the P5-02f pin).
 * Without all three the poller skips the product before any call, every control is refused, and
 * the console's `GET …/distribution/connectors/play` says why (`inert`).
 *
 * **Why the pin.** The `packageName` is manifest-owned — every resync rewrites `dist_outlets`
 * from the repo — while the service account is the operator's, and one account can be invited to
 * every app of a Play developer account. Without the pin a repo writer could aim the operator's
 * account, and the console's controls (rollout fraction, halt, resume, complete, update
 * priority) and the vitals auto-halt, at any app it can see (THREAT-MODEL.md, "Who picks the
 * outlet's app"). With it, the manifest can only name the app the operator already chose; a
 * manifest that changes its `packageName` makes the connector inert until a platform admin
 * re-pins (`PUT …/outlet-credentials/<id>` with `{kind, pin}`, audited `outlet_credential.pin`).
 * A missing pin is refused like a wrong one, so a credential stored before the pin existed does
 * nothing.
 *
 * **One app per product.** Every Play outlet of the product that names the same package is part
 * of the setup (a `play` outlet for production and beta, a `play-testing` one for an internal
 * track, say); an outlet naming another package is not this connector's. The `play` kind wins the
 * tie for which package the manifest names, then the lowest outlet id; the pin is then checked
 * against that package — another outlet's matching package never stands in for it.
 *
 * **The platform fallback (A-16).** A product with NO active `google-service-account` of its own
 * falls back to the platform's developer-account service account (`google-play.service-account`:
 * the console credential, else `PLATFORM_GOOGLE_SERVICE_ACCOUNT`), only for the package a platform
 * admin assigned to the product (its platform pin); `credentialId` is then the handle
 * `platform:google-play.service-account` and the token comes from `platformGoogleAccessToken`,
 * which re-checks the pin. An own credential always wins and never falls through.
 *
 * **Track ids are data.** The map comes from the manifest and the track list from Play's own
 * `edits.tracks.list`; nothing here knows that the internal-testing track is `internal` or `qa`
 * (notes/E2 §A1 "Tracks"), and a track Play lists that no outlet maps is shown, never written.
 *
 * Credential choice: a credential bound to one of the product's Play outlets (`outletId`) wins
 * over an unbound one; ties go to the lowest id. The pin is checked on the credential chosen —
 * another credential's matching pin never stands in for it. Only metadata is read here — listing
 * never selects the sealed column — so resolving the setup opens nothing.
 */

import {
  parseJsonColumn,
  type Db,
  type Env,
} from "../../../../core/platform.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../../../core/outletCredentials.js";
import { listOutlets } from "../../outlets.js";
import {
  platformFallback,
  platformFallbackMessage,
} from "../platformFallback.js";

/** The platform credential the fallback uses (A-16). */
export const PLAY_PLATFORM_CREDENTIAL = "google-play.service-account" as const;

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
  /** The `google-service-account` credential id, or the platform handle
   *  `platform:google-play.service-account` (A-16). */
  credentialId: string;
}

/** Why the connector does not run for a product. The pin reasons are the operator's to fix. */
export type PlayInertReason =
  | "no_outlet"
  | "no_credential"
  | "pin_missing"
  | "pin_mismatch";

export interface PlayInert {
  reason: PlayInertReason;
  /** A sentence for the console: what is missing and who fixes it. */
  message: string;
  /** The package the manifest's outlet names, when it names one. */
  manifestPackageName: string | null;
  /** The `google-service-account` credential the setup chose, when there is one. */
  credential: string | null;
  /** The package that credential is pinned to (`null`: not pinned). */
  pinnedPackageName: string | null;
  /** Whose credential the setup chose: the product's, the platform's (A-16), or none. */
  credentialSource: "product" | "platform" | null;
}

export type PlaySetupResolution =
  | { setup: PlaySetup; inert: null }
  | { setup: null; inert: PlayInert };

/** Whether an inert reason is the operator's pin (refused 409 by the controls). */
export function isPinReason(
  reason: PlayInertReason,
): reason is "pin_missing" | "pin_mismatch" {
  return reason === "pin_missing" || reason === "pin_mismatch";
}

const inert = (
  reason: PlayInertReason,
  message: string,
  rest: Partial<Omit<PlayInert, "reason" | "message">> = {},
): PlaySetupResolution => ({
  setup: null,
  inert: {
    reason,
    message,
    manifestPackageName: rest.manifestPackageName ?? null,
    credential: rest.credential ?? null,
    pinnedPackageName: rest.pinnedPackageName ?? null,
    credentialSource: rest.credentialSource ?? null,
  },
});

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
  env: Env,
  db: Db,
  product: string,
): Promise<PlaySetup | null> {
  return (await resolvePlaySetup(env, db, product)).setup;
}

/** The product's Play setup, or why the connector does not run for it. */
export async function resolvePlaySetup(
  env: Env,
  db: Db,
  product: string,
): Promise<PlaySetupResolution> {
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
  if (!primary)
    return inert(
      "no_outlet",
      "declare a play or play-testing outlet with a packageName and tracks in .pkey/distribution",
    );
  const packageName = primary.packageName!;
  const outlets = candidates
    .filter((o) => o.packageName === packageName)
    .map(({ outletId, kind, tracks }) => ({ outletId, kind, tracks }));

  const playOutlets = new Set(outlets.map((o) => o.outletId));
  const creds = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === "google-service-account",
  );
  const credential =
    creds.find((c) => c.outletId !== null && playOutlets.has(c.outletId)) ??
    creds.find((c) => c.outletId === null);
  const routesOf = () => {
    const routes = new Map<string, PlayOutletRoute[]>();
    for (const o of outlets)
      for (const [channel, track] of Object.entries(o.tracks)) {
        const list = routes.get(track) ?? [];
        list.push({ outletId: o.outletId, channel });
        routes.set(track, list);
      }
    return routes;
  };
  if (creds.length === 0) {
    // A-16: no credential of the product's own — the platform service account, pin required.
    const f = await platformFallback(
      env,
      db,
      product,
      PLAY_PLATFORM_CREDENTIAL,
      packageName,
    );
    if (!f.ok)
      return inert(
        f.reason,
        platformFallbackMessage(
          "Google Play",
          "google-play",
          "package",
          packageName,
          product,
          f,
        ),
        {
          manifestPackageName: packageName,
          pinnedPackageName: f.pinned,
          credentialSource: f.reason === "no_credential" ? null : "platform",
        },
      );
    return {
      setup: {
        product,
        packageName,
        outlets,
        routes: routesOf(),
        credentialId: f.handle,
      },
      inert: null,
    };
  }
  if (!credential)
    return inert(
      "no_credential",
      "a platform admin must store a google-service-account outlet credential pinned to this app",
      { manifestPackageName: packageName },
    );
  const pin = checkOutletCredentialPin(credential, packageName);
  if (!pin.ok)
    return inert(
      pin.reason,
      pin.reason === "pin_missing"
        ? `the google-service-account credential ${credential.id} is not pinned to an app: a platform admin must pin it to ${packageName} (PUT …/outlet-credentials/${credential.id} with {"kind":"google-service-account","pin":"${packageName}"}) after checking that this is the product's app`
        : `.pkey/distribution names package ${packageName}, but the google-service-account credential ${credential.id} is pinned to package ${pin.pinned}: nothing is read or changed until the manifest names the pinned package again, or a platform admin re-pins the credential to ${packageName} after checking that this is the product's app`,
      {
        manifestPackageName: packageName,
        credential: credential.id,
        pinnedPackageName: pin.pinned,
        credentialSource: "product",
      },
    );

  return {
    setup: {
      product,
      packageName,
      outlets,
      routes: routesOf(),
      credentialId: credential.id,
    },
    inert: null,
  };
}
