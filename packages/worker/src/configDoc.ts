// Build and ETag the managed-config document. `aud`/`iss` bind it to the product as
// defense-in-depth; the per-product `kid` + key that scope each doc to one tenant are applied
// by `core/signing.ts`, which now owns the signing step for every Polaris document.
//
// What remains here is document ASSEMBLY, and it is config-document-shaped on purpose — it
// moves to `services/config/document.ts` when the documents split (plan Task 1.4).

import { sha256Base64Url } from "@plrs/jws";
import type { Catalog } from "@plrs/catalog";
import {
  DOC_EXPIRY_SECONDS,
  ISSUER,
  SECONDS_PER_DAY,
  type DocProfile,
  type ManagedConfigDoc,
  type ManagedEntry,
  type ManagedPayload,
} from "@plrs/protocol";

export interface BuildDocInput {
  schemaVersion: number;
  aud: string;
  licenseId: string;
  deviceId: string;
  now: number;
  maxOfflineDays: number;
  profile: DocProfile;
  payload: ManagedPayload;
}

/** Defense-in-depth: drop any config/secret entry whose key is unknown to the active
 *  catalog, sits in the wrong payload bucket, or whose value fails the catalog schema,
 *  BEFORE signing. A misconfigured or stale override must never be minted into a signed
 *  doc. Entitlements pass through because server-side gates may be policy-only and not
 *  declared as user-facing catalog flags.
 *
 *  This runs on the `/config` hot path, so it must not depend on runtime code generation:
 *  `Catalog` interprets each schema fragment rather than compiling one, because workerd
 *  forbids `Function(string)` inside a request and catalogs only ever load mid-request
 *  (R10-01). A fragment the validator cannot interpret marks its value invalid, so this
 *  prune fails CLOSED — an unenforceable constraint drops the value instead of signing it. */
export function validatePayload(
  payload: ManagedPayload,
  catalog: Catalog,
): ManagedPayload {
  const prune = (
    entries: Record<string, ManagedEntry>,
    kind: "config" | "secret" | "flag",
  ): Record<string, ManagedEntry> => {
    const out: Record<string, ManagedEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      const catalogEntry = catalog.entryByKey(key);
      if (!catalogEntry || catalogEntry.kind !== kind) continue;
      if (!catalog.validateKeyValue(key, entry.value).ok) continue;
      out[key] = entry;
    }
    return out;
  };
  return {
    config: prune(payload.config ?? {}, "config"),
    secrets: prune(payload.secrets ?? {}, "secret"),
    entitlements: payload.entitlements ?? {},
  };
}

/** Stamp the time-bound fields into a doc (field order matches the conformance corpus). */
export function buildDoc(input: BuildDocInput): ManagedConfigDoc {
  return {
    schemaVersion: input.schemaVersion,
    aud: input.aud,
    iss: ISSUER,
    licenseId: input.licenseId,
    deviceId: input.deviceId,
    issuedAt: input.now,
    expiresAt: input.now + DOC_EXPIRY_SECONDS,
    graceUntil: input.now + input.maxOfflineDays * SECONDS_PER_DAY,
    profile: input.profile,
    payload: input.payload,
  };
}

/** A strong ETag over the doc content, excluding the per-request timestamps so an
 *  unchanged config collapses to the same ETag → If-None-Match 304. */
export async function computeETag(doc: ManagedConfigDoc): Promise<string> {
  const material = JSON.stringify({
    schemaVersion: doc.schemaVersion,
    aud: doc.aud,
    iss: doc.iss,
    licenseId: doc.licenseId,
    deviceId: doc.deviceId,
    profile: doc.profile,
    payload: doc.payload,
  });
  const tag = await sha256Base64Url(new TextEncoder().encode(material));
  return `"${tag}"`;
}
