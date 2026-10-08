/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /manage/api/products/<slug>/bundles` — the offline activation bundle MINT
 * (WIRE-CONTRACT-V3 §7, spec §7.2, plan §R4).
 *
 * The server half of the classic request-code flow. An air-gapped install shows its request
 * code (product + `deviceId`); an operator pastes it here; this endpoint signs the documents
 * that install would have fetched over the network, wraps them with the trust manifest needed
 * to verify them, and hands back one `pkey-bundle+jws` file to carry across on a USB stick.
 * `@polaris-key/client-core`'s `inspectBundle` is the verifier every SDK runs against what this emits,
 * so it — not this file — is the contract; everything below exists to satisfy it.
 *
 * ── WHY THIS LIVES IN CORE ──────────────────────────────────────────────────────────────────
 *
 * A bundle is not a License artifact and not a Config artifact: it is the two of them plus the
 * trust manifest, in one envelope, and either half may be absent. A config-only product (D-08)
 * air-gaps with a bundle carrying only `docs.config` — so putting the mint inside License would
 * make the offline path require a service the product does not run, and putting it inside
 * Config would do the mirror. Core already owns signing (`core/signing.ts`), trust
 * (`core/trust.ts`) and the service registry, which is exactly the set a bundle is assembled
 * from. A service may not import a sibling; Core may compose both.
 *
 * The INNER documents are built by the SAME assembly the network routes use — `buildLicenseDoc`
 * and `buildConfigDoc` in `core/documents.ts`, over the same `resolveEntitlements` and the same
 * payload merge. (Those two moved into Core for this endpoint; the services re-export them, so
 * `/license/document` and `/config/document` are byte-identical to what they were.) Nothing here
 * re-derives a grant. If it did, a bundle-activated install would be entitled to something
 * subtly different from the same install online, and the difference would only ever be
 * discovered by a customer.
 *
 * ── THE THREE TIME BOUNDS, AND WHY THEY DIFFER ──────────────────────────────────────────────
 *
 *   inner `expiresAt`   `issuedAt + DOC_EXPIRY_SECONDS` — one hour, exactly as online.
 *   inner `graceUntil`  `issuedAt + graceDays × 86 400` — the operator's offline window, ended
 *                       no later than the licence's expiry when the product clamps grace (LX-07,
 *                       `core/graceClamp.ts`): an air-gapped install is exactly the one for which
 *                       the grace bound is the only revocation lever.
 *   bundle `expiresAt`  `issuedAt + BUNDLE_IMPORT_WINDOW_SECONDS` — the IMPORT deadline.
 *
 * The first two are not a mistake. §7 step 4 verifies inner documents on the RELOAD profile
 * (`checkFreshness: false`), which is the same profile a cached document gets: a document
 * arriving on a machine weeks after it was signed is expected to be past `expiresAt`, and its
 * real outer bound is `graceUntil`. Minting an hour-long `expiresAt` is therefore correct and
 * deliberate — it is what makes an imported bundle indistinguishable from a cache written by a
 * device that went offline the moment it synced, so the client gate needs no bundle-specific
 * branch at all. Stretching `expiresAt` instead would create a document that passes the NETWORK
 * profile for a year, i.e. one that a replay could present to a freshness-checking call site.
 *
 * The bundle's own `expiresAt` is checked on the network profile (§7 step 2) and means
 * something different again: how long this file may sit on a USB stick before it is refused.
 *
 * ── RATE LIMITING ───────────────────────────────────────────────────────────────────────────
 *
 * The admin bucket, applied in `admin/api.ts` to the whole surface before any handler runs
 * (`adminApi`, per verified session subject). Nothing bucket-specific is added here: this route
 * is reached only by an authenticated platform admin who has already passed session, CSRF and
 * group gates, and a second budget on top of that would protect nothing the first does not.
 */

import { SECONDS_PER_DAY } from "@polaris-key/protocol";
import type { BundleDoc } from "@polaris-key/protocol/core";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { AdminSession } from "../admin/session.js";
import { audit } from "../admin/audit.js";
import { adminJson, err, notFound, readBody } from "../admin/lib/respond.js";
import { ErrorCode } from "./errors.js";
import { getDevice, getLicense } from "../repo.js";
import type { LicenseRow } from "./data.js";
import { licenseUsable } from "./devices.js";
import { docProfile, resolveEntitlements } from "./authz.js";
import { loadProduct } from "./products.js";
import { isStrictJsonError, signDoc } from "./signing.js";
import { signTrustManifest } from "./trust.js";
import {
  buildLicenseDoc,
  buildConfigDoc,
  resolveConfigPayload,
} from "./documents.js";
import { graceClampFor } from "./graceClamp.js";
import type { SettingsRegistry } from "./settings/registry.js";
import { randomBytes } from "../platform/random.js";

/**
 * How long a minted bundle may wait before it is imported: 30 days.
 *
 * §7 does NOT fix this value — it pins the CLAIM (`expiresAt` is "the import window for the
 * bundle itself", checked on the network profile at step 2) and leaves the number to the
 * server. This is where it is chosen, so it is stated once, here, rather than being an
 * arithmetic expression at the call site.
 *
 * 30 days is the shortest window that survives the physical process the artifact exists for: a
 * bundle is minted by an operator, attached to a ticket or written to media, and hand-carried
 * to a machine that by definition cannot ask for a fresh one. Days would strand exactly that
 * workflow. It is deliberately DECOUPLED from `graceDays` and much shorter: the import window
 * bounds how long a stolen bundle file is useful to an attacker who did not have it at mint
 * time, while `graceUntil` bounds how long the install it creates keeps working. Making the
 * two equal would mean a 365-day grace also handed out a 365-day replay window for the file.
 *
 * The corpus's `bundleCases` fixtures use the same 30-day window (`BUNDLE_EXPIRES = issued +
 * 30 d`), so a client tested against them sees the window this server actually mints.
 */
export const BUNDLE_IMPORT_WINDOW_SECONDS = 30 * SECONDS_PER_DAY;

/** The device id a bundle may be bound to: 32 base64url characters, the shape wire v3 §6
 *  states and `core/register.ts` already enforces on the registration path. Operators paste
 *  this out of the app's offline screen, so a typo has to be a 400 rather than a bundle that
 *  no machine can import. */
const DEVICE_ID = /^[A-Za-z0-9_-]{32}$/;

/**
 * The grace ceiling, in DAYS (§3.3, D-22).
 *
 * The same bound as `@polaris-key/client-core`'s `MAX_GRACE_SECONDS` (365 × 86 400), expressed in the
 * unit this endpoint takes. It is restated rather than imported because client-core is a
 * TEST-only dependency of the worker — the server must not take a runtime dependency on the
 * reference client — and because §3.3 makes the point that the ceiling is enforced at BOTH ends:
 * a mint that exceeded it would produce a bundle the importing client refuses at verify time,
 * which is a silent failure discovered on an air-gapped machine. Refusing here means the
 * operator finds out while they can still do something about it.
 */
const MAX_GRACE_DAYS = 365;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID for `bundleId` — 48-bit millisecond timestamp + 80 bits of randomness, Crockford
 * base32. §7 calls the field a ULID and uses it as the audit anchor: the mint is recorded under
 * it, the importing client records it as `importedBundle.bundleId`, and an operator correlating
 * a support ticket to an audit row has only this string to do it with. Lexicographic ordering
 * by mint time is what makes that correlation cheap, which is the whole reason it is a ULID
 * rather than the `randomId()` prefix scheme the D1 rows use.
 */
function ulid(nowSeconds: number): string {
  let ms = Math.floor(nowSeconds * 1000);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  const bytes = randomBytes(16);
  // `b & 31` over a uniform byte is uniform over 0…31, so each character carries a full 5 bits.
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

function badRequest(message: string, fields?: string[]): Response {
  return err(
    400,
    ErrorCode.BadRequest,
    message,
    fields ? { fields } : undefined,
  );
}

/**
 * `POST /manage/api/products/<slug>/bundles` — mint one offline activation bundle.
 *
 * Which documents ride inside is decided by ENABLEMENT, not by the caller alone:
 *
 *   license   included iff the License service is on. When it is on, `licenseId` is REQUIRED —
 *             there is no authenticated device here to infer a licence from, and guessing
 *             (say, "the product's only licence") would silently mint the wrong grant on the
 *             day a second licence exists.
 *   config    included iff the Config service is on AND `includeConfig` is not false. Asking
 *             for config on a product that does not run it is not an error — the answer is a
 *             bundle without it — because the console offers the checkbox from a product view
 *             that may be a moment stale, and refusing would be a worse outcome than honouring
 *             the enablement.
 *
 * A request that resolves to NO documents is refused. §7 makes such a bundle vacuous at
 * IMPORT ("refused at step 2"), so minting one would produce a file whose only possible
 * outcome is an error on a machine with no way to report it.
 */
export async function handleBundleMint(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  action: string | undefined,
  now: number,
  /** ST-04's settings registry: LX-07's grace clamp is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  if (action !== undefined) return notFound();
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  // The full product, not the row: minting needs the opened signing key, and `loadProduct`
  // fails closed when there is no active key or it cannot be decrypted. A product that cannot
  // sign cannot mint, and saying so as a 404 keeps this identical to every other signing path.
  const product = await loadProduct(env, db, slug);
  if (!product) return notFound();

  const body = await readBody(req);
  const fields: string[] = [];

  // Narrow while validating, so the rest of this function works with real `string`/`number`
  // locals instead of casting `unknown` back out of the body after the guard below.
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (!DEVICE_ID.test(deviceId)) fields.push("deviceId");

  const graceDays = typeof body.graceDays === "number" ? body.graceDays : NaN;
  if (
    !Number.isInteger(graceDays) ||
    graceDays < 1 ||
    graceDays > MAX_GRACE_DAYS
  ) {
    fields.push("graceDays");
  }

  if (
    body.includeConfig !== undefined &&
    typeof body.includeConfig !== "boolean"
  )
    fields.push("includeConfig");

  if (body.licenseId !== undefined && typeof body.licenseId !== "string")
    fields.push("licenseId");

  if (fields.length > 0) return badRequest("invalid bundle request", fields);

  const licenseEnabled = product.services.license.enabled;
  const configEnabled = product.services.config.enabled;
  // Requested-and-available, in that order. `includeConfig` defaults to true because the
  // overwhelmingly common shape is "give this machine everything it would have fetched".
  const includeConfig = (body.includeConfig ?? true) === true && configEnabled;

  if (!licenseEnabled && !includeConfig) {
    return badRequest(
      "a bundle must carry at least one document; this product has neither License nor Config to put in one",
    );
  }

  let license: LicenseRow | null = null;
  if (licenseEnabled) {
    if (typeof body.licenseId !== "string" || body.licenseId === "") {
      return badRequest(
        "licenseId is required when the License service is enabled",
        ["licenseId"],
      );
    }
    license = await getLicense(db, slug, body.licenseId);
    // Unknown and unusable collapse into one refusal on purpose: both mean "no grant can be
    // minted for this id", and an operator pasting a licence id from a ticket is better served
    // by one clear sentence than by a distinction that only matters to an enumerator.
    if (!licenseUsable(license, now)) {
      return badRequest("no active licence with that id", ["licenseId"]);
    }
  }

  // NO device row is created, and none is required. A bundle-activated machine may never touch
  // the network, so inventing a `devices` row for it would put a seat holder in the console
  // that nothing can ever reconcile, deactivate or hear from again. Fingerprint enforcement is
  // skipped for the same reason §7 skips it at import: there is no server to dedupe against.
  //
  // An EXISTING row is still read, because a device that registered before going dark may carry
  // device-level overrides, and `/license/document` would have applied them. Absent ⇒ `null`,
  // which every payload layer already tolerates.
  const device = await getDevice(db, slug, deviceId);

  // LX-07: both inner documents end no later than the licence when the product clamps grace
  // (a config-only bundle has no licence and is never clamped). `null` = the operator's window.
  const clampGraceTo = await graceClampFor(
    { env, db, registry: settings },
    slug,
    license,
    now,
    graceDays,
  );

  const docs: BundleDoc["docs"] = {};
  const bundleId = ulid(now);
  // The three `signDoc` calls and the `signTrustManifest` call are caught together: a guard
  // refusal on any of them (a stored value no v4 verifier would accept, plans/P3-01.md §2.2)
  // answers `500 document_not_representable` in the console's body shape, never a throw.
  let typ = "pkey-license+jws";
  let jws: string;
  try {
    if (license) {
      const entitlements = await resolveEntitlements(
        db,
        slug,
        license,
        device,
        now,
      );
      // No build gate. `/license/document` gates on the CLIENT's version/channel headers, and
      // there is no client here — the machine this is for has never spoken to us. Minting is an
      // operator decision; the window still rides along as enforced entitlements, so the gate
      // that matters (the client's) still applies to whatever build eventually imports this.
      const doc = buildLicenseDoc({
        aud: slug,
        deviceId,
        licenseId: license.id,
        now,
        maxOfflineDays: graceDays,
        clampGraceTo,
        profile: docProfile(license),
        entitlements,
      });
      docs.license = await signDoc(
        doc,
        product.signingKeyPem,
        product.signingKid,
        "pkey-license+jws",
      );
    }

    if (includeConfig) {
      typ = "pkey-config+jws";
      const payload = await resolveConfigPayload(
        db,
        env,
        slug,
        license,
        device,
        now,
      );
      // Fail closed, exactly as `/config/document` does: a catalog that cannot validate its own
      // payload must not produce a signed document, least of all one destined for a machine that
      // cannot be corrected afterwards.
      if (!payload) {
        return err(
          500,
          "catalog_unavailable",
          "the active catalog could not validate the config payload",
        );
      }
      const doc = buildConfigDoc({
        aud: slug,
        deviceId,
        now,
        maxOfflineDays: graceDays,
        clampGraceTo,
        schemaVersion: product.schemaVersion,
        payload,
      });
      docs.config = await signDoc(
        doc,
        product.signingKeyPem,
        product.signingKid,
        "pkey-config+jws",
      );
    }

    typ = "pkey-trust+jws";
    // The manifest the SERVED route would emit, byte-identical (`signTrustManifest` is shared).
    // It is verified against PINS at import, so this cannot introduce a key the host app has
    // not already agreed to trust — it only saves the air-gapped machine a fetch it can never
    // make.
    const trust = await signTrustManifest(
      db,
      product,
      now,
      new URL(req.url).origin,
    );
    typ = "pkey-bundle+jws";
    const bundle: BundleDoc = {
      bundleId,
      aud: slug,
      deviceId,
      issuedAt: now,
      expiresAt: now + BUNDLE_IMPORT_WINDOW_SECONDS,
      docs,
      trust,
    };
    jws = await signDoc(
      bundle,
      product.signingKeyPem,
      product.signingKid,
      "pkey-bundle+jws",
    );
  } catch (e) {
    if (!isStrictJsonError(e)) throw e;
    return err(
      500,
      ErrorCode.DocumentNotRepresentable,
      `the ${typ} document could not be signed: a stored value breaks the wire contract's strict JSON or integer rules; run check:representable`,
    );
  }

  const carried = [
    docs.license ? "license" : null,
    docs.config ? "config" : null,
  ].filter(Boolean);
  await audit(
    db,
    slug,
    session,
    now,
    "bundle.minted",
    // The licence is the grant that was handed out, so it is the target when there is one; a
    // config-only bundle has no licence to point at and the device it was bound to is the only
    // thing worth indexing. Both ids appear in the summary either way.
    license
      ? { kind: "license", id: license.id }
      : { kind: "device", id: deviceId },
    // The artifact itself is not stored anywhere — this row is the ONLY record that the mint
    // happened, so it names the bundle, the machine, what went in it and for how long.
    `Minted offline bundle ${bundleId} for device ${deviceId}` +
      `${license ? ` on licence ${license.id}` : ""}: ` +
      `${carried.join(" + ")}, ${graceDays}-day grace` +
      (clampGraceTo !== null
        ? `, clamped to the licence's expiry (${new Date(clampGraceTo * 1000).toISOString()})`
        : ""),
  );

  return adminJson({ bundleId, bundle: jws });
}
