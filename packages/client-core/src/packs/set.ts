// `packSetId` (plans/P4-01.md §2.9; WIRE-CONTRACT-V4 §8): one identifier for a set of pack
// releases, the same function for a device's active set and for P4-12's resolved sets.
// `content/cases.json#packSetIdCases` pins it.

import { SHA256_RE, isPackId } from "./claims.js";
import { sha256Hex } from "./files.js";
import { compareBytes } from "./variant.js";

/** One member of a pack set: the pack id and P3-01's record hash of its release. */
export interface PackSetEntry {
  packId: string;
  releaseSha256: string;
}

/**
 * The lowercase hex SHA-256 of the UTF-8 lines `<packId> <releaseSha256>\n`, sorted by pack-id
 * bytes. Null when a pack id is invalid (`isPackId`), a release is not 64 lowercase hex, or a
 * pack is listed twice. The empty set hashes the empty string. A device reports the id of its
 * active set: the pack releases activated in the running process, embedded baselines included.
 * Never throws.
 */
export async function packSetId(
  entries: readonly PackSetEntry[],
): Promise<string | null> {
  if (!Array.isArray(entries)) return null;
  const seen = new Set<string>();
  for (const e of entries) {
    if (typeof e !== "object" || e === null) return null;
    if (!isPackId(e.packId)) return null;
    if (typeof e.releaseSha256 !== "string" || !SHA256_RE.test(e.releaseSha256))
      return null;
    if (seen.has(e.packId)) return null;
    seen.add(e.packId);
  }
  const text = [...entries]
    .sort((a, b) => compareBytes(a.packId, b.packId))
    .map((e) => `${e.packId} ${e.releaseSha256}\n`)
    .join("");
  return sha256Hex(new TextEncoder().encode(text));
}
