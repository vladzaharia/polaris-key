/**
 * The generated `SHA256SUMS` of one release (DC-15): `files/<releaseId>/SHA256SUMS`, on the bytes
 * host and the console host alike (the `file` byte route, so the same access decision, the same
 * rate lane and the same hardening as the files it lists).
 *
 * The body is DERIVED from the release's artifact rows (`release_artifacts`, through
 * `releaseCatalog.artifacts`), never uploaded: it cannot disagree with the digests Release
 * recorded and the signed release record pins. A developer-published file of the same name is
 * not served in its place; the generated file wins.
 *
 * One line per file in `sha256sum`'s text format (`<64 hex>  <name>\n`), sorted by name, so
 * `sha256sum --check SHA256SUMS` verifies a directory of downloads as they were fetched. Only
 * files the `files` route can actually serve are listed (a store-only location carries no bytes;
 * a `gated/` object is never served here), and a name `sha256sum` could not read back (a path
 * separator, a backslash, a control character) is left out rather than written wrongly.
 *
 * MD5 is refused, not offered: it is collision-broken and adds nothing a SHA-256 does not, so no
 * `MD5SUMS` exists and the sidecar filter keeps a developer's own `.md5` out of the downloads.
 * (Maven's MD5 and SHA-1 sidecars stay, because Maven requires them.)
 */

import { parseKey } from "../../core/blobs.js";
import type { CatalogSourceArtifact } from "../../core/hooks.js";

/** The one file name this module answers to. */
export const SHA256SUMS_NAME = "SHA256SUMS";

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A name `sha256sum -c` reads back unchanged. */
const SAFE_NAME = /^[^\u0000-\u001f\u007f\\/]{1,256}$/;

function servable(a: CatalogSourceArtifact): boolean {
  return a.locations.some((l) => {
    if (l.provider === "store") return false;
    if (l.provider === "r2") {
      const parsed = l.key ? parseKey(l.key) : null;
      return !(parsed?.area === "locked" && parsed.gated);
    }
    return true;
  });
}

function compareBytes(x: Uint8Array, y: Uint8Array): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** The `SHA256SUMS` text for `artifacts`, or `null` when no file qualifies. */
export function sha256sumsBody(
  artifacts: readonly CatalogSourceArtifact[],
): string | null {
  // name -> the distinct digests it carries. A name with two digests cannot be verified (which
  // file does it mean?), so the whole name is left out rather than written twice.
  const byName = new Map<string, Set<string>>();
  for (const a of artifacts) {
    if (
      a.name === SHA256SUMS_NAME ||
      !a.sha256 ||
      !SHA256_HEX.test(a.sha256) ||
      !SAFE_NAME.test(a.name) ||
      !servable(a)
    )
      continue;
    const set = byName.get(a.name) ?? new Set<string>();
    set.add(a.sha256);
    byName.set(a.name, set);
  }
  const enc = new TextEncoder();
  const rows = [...byName]
    .filter(([, digests]) => digests.size === 1)
    .map(([name, digests]) => ({
      key: enc.encode(name),
      line: `${[...digests][0]}  ${name}\n`,
    }));
  if (rows.length === 0) return null;
  // Sorted by the name's UTF-8 bytes, so the file is the same wherever it is generated.
  return rows
    .sort((x, y) => compareBytes(x.key, y.key))
    .map((r) => r.line)
    .join("");
}
