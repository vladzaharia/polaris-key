/**
 * The account override layer as a store of account × product data (U-03; notes/S-17 §5.5, D21),
 * registered with Core's subject-store registry (`core/accounts/subjectHooks.ts`) so an account merge, a
 * deletion and an export reach it without Config importing Identity (rule 6).
 *
 *   merge   per key, the SURVIVING subject's value wins; keys only the absorbed side holds are
 *           copied over; secrets are compared and copied sealed, never decrypted. Every collision
 *           (both sides set the key to different values) is listed for the operator in the
 *           product's activity log (`user.overrides.merge`; non-secret values only), and the
 *           absorbed row is deleted in the same batch as the surviving row's write. The absorbed
 *           subject's migration-report rows follow it to the survivor.
 *   delete  the subject's row and its migration-report rows (per-product removal, account
 *           deletion, the console's data deletion).
 *   export  the subject's layer with every secret by name only (`configured`), and its report
 *           rows. U-12 owns the person-facing export and deletion surfaces; these hooks are what
 *           they call.
 *   size    the stored row's bytes (the console Users page's data size, I-12).
 *
 * Idempotent, as the registry requires (`merge` runs before, and outside, the merge's own batch,
 * and is retried with the same arguments): a second run finds no absorbed row and writes only the
 * report re-key, which is a no-op.
 */

import { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { DbStatement } from "../../db/types.js";
import {
  getAccountOverrides,
  parseAccountOverridePayload,
  stmtDeleteAccountOverrides,
  stmtPutAccountOverrides,
  type AccountOverridePayload,
} from "../../core/accounts/accountOverrides.js";
import { listOverrideMigrationReport } from "../../core/ops/overrideMigration.js";
import {
  registerSubjectStore,
  type SubjectStore,
} from "../../core/accounts/subjectHooks.js";
import { isSealedEnvelope } from "../../core/managedSecrets.js";
import { randomId } from "../../platform/crypto.js";
import { auditStatement, getActiveSchema } from "../../core/repo.js";

/** The registry name (stable: the export document is keyed by it). */
export const ACCOUNT_OVERRIDE_STORE = "config.accountOverrides";

const sameEntry = (a: ManagedEntry, b: ManagedEntry): boolean =>
  JSON.stringify([a?.state, a?.value]) === JSON.stringify([b?.state, b?.value]);

async function catalogOf(
  db: Parameters<SubjectStore["merge"]>[0]["db"],
  product: string,
): Promise<Catalog | null> {
  const row = await getActiveSchema(db, product);
  if (!row) return null;
  try {
    return new Catalog(JSON.parse(row.catalog_json));
  } catch {
    return null;
  }
}

/** A value an operator may read back: a non-secret config value the catalog declares. */
function showable(
  catalog: Catalog | null,
  bucket: "config" | "secrets",
  key: string,
  value: unknown,
): boolean {
  if (bucket !== "config" || !catalog || isSealedEnvelope(value)) return false;
  const entry = catalog.entryByKey(key);
  return !!entry && entry.kind === "config" && entry.secret !== true;
}

const short = (v: unknown): string => {
  const s = JSON.stringify(v) ?? "null";
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

export const accountOverrideStore: SubjectStore = {
  tables: ["account_overrides", "override_migration_report"],

  async merge({ db, now }, { product, from, to }) {
    const stmts: DbStatement[] = [];
    const absorbed = await getAccountOverrides(db, product, from);
    if (absorbed) {
      const survivor = await getAccountOverrides(db, product, to);
      const a = parseAccountOverridePayload(absorbed.payload_json);
      const s = parseAccountOverridePayload(survivor?.payload_json ?? null);
      const out: AccountOverridePayload = {
        config: { ...s.config },
        secrets: { ...s.secrets },
      };
      const catalog = await catalogOf(db, product);
      const collisions: string[] = [];
      let copied = 0;
      for (const bucket of ["config", "secrets"] as const) {
        for (const [key, entry] of Object.entries(a[bucket])) {
          const kept = s[bucket][key];
          if (!kept) {
            out[bucket][key] = entry;
            copied++;
            continue;
          }
          if (sameEntry(kept, entry)) continue;
          collisions.push(
            showable(catalog, bucket, key, kept.value) &&
              showable(catalog, bucket, key, entry.value)
              ? `${key} (kept ${short(kept.value)}, dropped ${short(entry.value)})`
              : `${key}${bucket === "secrets" ? " (secret)" : ""}`,
          );
        }
      }
      if (!survivor || copied > 0)
        stmts.push(stmtPutAccountOverrides(product, to, out, "merge", now));
      stmts.push(stmtDeleteAccountOverrides(product, from));
      if (collisions.length > 0)
        stmts.push(
          auditStatement({
            product,
            id: randomId("aud"),
            at: now,
            actor_sub: "system:account-merge",
            actor_name: null,
            actor_email: null,
            action: "user.overrides.merge",
            target_kind: "subject",
            target_id: to,
            parent_id: null,
            summary: `An account join kept ${to}'s account overrides where both accounts had set a key; ${from}'s values were dropped: ${collisions.join("; ")}`,
          }),
        );
    }
    stmts.push({
      sql: "UPDATE override_migration_report SET subject = ? WHERE product = ? AND subject = ?",
      params: [to, product, from],
    });
    await db.batch(stmts);
  },

  async delete({ db }, { product, subject }) {
    await db.batch([
      stmtDeleteAccountOverrides(product, subject),
      {
        sql: "DELETE FROM override_migration_report WHERE product = ? AND subject = ?",
        params: [product, subject],
      },
    ]);
  },

  async export({ db, now }, { product, subject }) {
    const row = await getAccountOverrides(db, product, subject);
    const p = parseAccountOverridePayload(row?.payload_json ?? null);
    const catalog = await catalogOf(db, product);
    const config: Record<
      string,
      {
        state: string;
        value?: unknown;
        configured?: boolean;
        updatedAt: number;
      }
    > = {};
    for (const [key, entry] of Object.entries(p.config)) {
      config[key] = showable(catalog, "config", key, entry.value)
        ? { state: entry.state, value: entry.value, updatedAt: entry.updatedAt }
        : {
            state: entry.state,
            configured: entry.value != null && entry.value !== "",
            updatedAt: entry.updatedAt,
          };
    }
    const secrets: Record<
      string,
      { state: string; configured: boolean; updatedAt: number }
    > = {};
    for (const [key, entry] of Object.entries(p.secrets))
      secrets[key] = {
        state: entry.state,
        configured: entry.value != null && entry.value !== "",
        updatedAt: entry.updatedAt,
      };
    const report = (
      await listOverrideMigrationReport(db, now, { product })
    ).filter((r) => r.subject === subject);
    return {
      overrides: row ? { config, secrets, updatedAt: row.updated_at } : null,
      migrationReport: report.map((r) => ({
        licenseId: r.licenseId,
        outcome: r.outcome,
        keys: r.keys,
        values: r.values,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      })),
    };
  },

  async size({ db }, { product, subject }) {
    const row = await db.first<{ n: number }>(
      "SELECT length(payload_json) AS n FROM account_overrides WHERE product = ? AND subject = ?",
      product,
      subject,
    );
    return Number(row?.n ?? 0);
  },
};

registerSubjectStore(ACCOUNT_OVERRIDE_STORE, accountOverrideStore);
