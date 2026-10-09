/**
 * Catalog delivery rules shared by the console PUT and the manifest resync.
 *
 * - `delivery` only means something on a secret, and a secret carries no `default`/`examples`
 *   (the public `/config/schema` and the editor show them).
 * - Moving a stored `serverOnly`/`edgeMint` secret to a delivered mode silently declassifies a
 *   sealed value: refused while any layer still stores a value for the key.
 */
import type { Db } from "../db/types.js";

type Entry = Record<string, unknown>;

const HELD = new Set(["serverOnly", "edgeMint"]);

function entriesOf(json: string | null | undefined): Entry[] {
  if (!json) return [];
  try {
    const e = (JSON.parse(json) as { entries?: unknown }).entries;
    return Array.isArray(e)
      ? e.filter((x): x is Entry => x !== null && typeof x === "object")
      : [];
  } catch {
    return [];
  }
}

/** Structural issues, as human strings; empty when fine. */
export function catalogDeliveryIssues(entries: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    if (raw === null || typeof raw !== "object") continue;
    const e = raw as Entry;
    const isSecret = e.kind === "secret" || e.secret === true;
    if (e.delivery !== undefined && e.kind !== "secret")
      out.push(`${String(e.key)}: delivery is only valid for secret entries`);
    if (isSecret && (e.default !== undefined || e.examples !== undefined))
      out.push(
        `${String(e.key)}: a secret entry cannot carry default or examples`,
      );
  }
  return out;
}

/** Keys whose hold (serverOnly/edgeMint) the next catalog drops. */
export function declassifiedKeys(
  prevJson: string | null | undefined,
  next: readonly unknown[],
): string[] {
  const nextBy = new Map<string, Entry>();
  for (const n of next)
    if (n !== null && typeof n === "object")
      nextBy.set(String((n as Entry).key), n as Entry);
  const out: string[] = [];
  for (const p of entriesOf(prevJson)) {
    if (p.kind !== "secret" || !HELD.has(String(p.delivery))) continue;
    const n = nextBy.get(String(p.key));
    if (!n) continue; // removal: the prune drops unknown keys
    if (n.kind !== "secret" || !HELD.has(String(n.delivery)))
      out.push(String(p.key));
  }
  return out;
}

/** The subset of `keys` for which some layer stores a value. */
export async function storedKeys(
  db: Db,
  product: string,
  keys: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const key of keys) {
    const needle = JSON.stringify(key);
    const hit = await db.first<{ one: number }>(
      `SELECT 1 AS one WHERE
         EXISTS (SELECT 1 FROM profiles WHERE product = ? AND instr(payload_json, ?) > 0)
      OR EXISTS (SELECT 1 FROM licenses WHERE product = ? AND instr(COALESCE(overrides_json,''), ?) > 0)
      OR EXISTS (SELECT 1 FROM devices WHERE product = ? AND instr(COALESCE(overrides_json,''), ?) > 0)
      OR EXISTS (SELECT 1 FROM account_overrides WHERE product = ? AND instr(payload_json, ?) > 0)`,
      product,
      needle,
      product,
      needle,
      product,
      needle,
      product,
      needle,
    );
    if (hit) out.push(key);
  }
  return out;
}

/** Refusal text when the swap would declassify a stored secret, else null. */
export async function declassifyRefusal(
  db: Db,
  product: string,
  prevJson: string | null | undefined,
  next: readonly unknown[],
): Promise<string | null> {
  const keys = declassifiedKeys(prevJson, next);
  if (keys.length === 0) return null;
  const stored = await storedKeys(db, product, keys);
  return stored.length === 0
    ? null
    : `would declassify stored server-only secret(s): ${stored.join(", ")}; clear the stored values first`;
}
