/**
 * A resync whose `.pkey/schema` failed validation (docs/design/mockups config.catalog-invalid;
 * admin-2-20). The Worker keeps serving the last good catalog and records the commit and each
 * error as `<file>/<pointer>: <message>`; this reads the schema ones and ties each to an entry.
 */

import type { ConfigEntry, ProductSyncState } from "../../../../api.js";

export interface SchemaProblem {
  /** The entry's position in the document that failed (`/entries/<n>/…`), when it names one. */
  index: number | null;
  /** The entry in the served catalog it is read against, when there is one. */
  key: string | null;
  message: string;
}

export interface InvalidResync {
  commit: string | null;
  problems: SchemaProblem[];
}

const LINE = /^schema(\/[^:]*)?: ([\s\S]+)$/;

/** The failed resync's schema problems, or `null` when the last resync was fine. */
export function invalidResync(
  sync: ProductSyncState | null | undefined,
  served: readonly ConfigEntry[],
): InvalidResync | null {
  if (!sync || sync.status !== "error") return null;
  const problems: SchemaProblem[] = [];
  for (const line of sync.errors ?? []) {
    const m = line.match(LINE);
    if (!m) continue;
    const at = m[1]?.match(/^\/entries\/(\d+)/);
    const index = at ? Number(at[1]) : null;
    // The failed document is not served, so a position is read against the served catalog; an
    // error that names a key says so itself.
    const named = served.find((e) => m[2]!.includes(e.key));
    problems.push({
      index,
      key: named?.key ?? (index !== null ? (served[index]?.key ?? null) : null),
      message: m[2]!,
    });
  }
  if (problems.length === 0) return null;
  return { commit: sync.commitSha ?? null, problems };
}
