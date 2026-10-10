/**
 * U-02: the registry guard over account × product data (plans/U-01.md §6.1, plans/I-04.md §6.2;
 * S-17 §7.1 risk 8).
 *
 * An account merge re-keys data and an account deletion removes it, and both reach a store only
 * through `registerSubjectStore` (`core/accounts/subjectHooks.ts`). A store that forgets to register is
 * not an error anyone sees: its rows simply survive a deletion or stay with the absorbed subject
 * after a merge. So this suite makes forgetting impossible to merge:
 *
 *   1. Every D1 table with a `subject` (or `*_subject`) column is either claimed by a registered
 *      store's `tables` or listed below as Identity's own, with the reason.
 *   2. Every Durable Object class in `wrangler.toml` is either claimed by a store's
 *      `durableObjects` or listed below as not named by subject.
 *   3. Every registered store has `merge`, `delete` and `export`, claims only tables that exist
 *      and carry a subject column, and no claimed table holds an `account_id` column: an S-17 row
 *      is keyed by the pairwise subject, never by the account id (S-16 §5.1).
 *   4. Cloud Sync code never asks for the licence owner: it has no owner fallback.
 *
 * Registrations happen at module load, so the suite imports the Worker's entry point first: every
 * service module that can register has then registered.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import {
  registerSubjectStore,
  subjectStores,
  unregisterSubjectStore,
  type SubjectStore,
} from "../src/core/accounts/subjectHooks.js";
import { makeTestDb } from "./helpers.js";
import type { Db } from "../src/db/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");

/**
 * Tables with a subject column that are NOT account × product data a store must merge and
 * delete. Each is Identity's own bookkeeping (Identity's merge and deletion handle it directly)
 * or holds a subject that is not a pairwise subject at all.
 */
const NOT_A_SUBJECT_STORE: Record<string, string> = {
  account_product_subjects:
    "the pairwise subject table itself; Identity's merge aliases it and its deletion removes it",
  account_product_subject_aliases:
    "merge aliases (D21); written and expired by Identity's merge",
  subject_events:
    "the developer-facing subject.merged / subject.deleted feed; written by Identity, carries subjects only",
  devices:
    "the device binding (devices.subject); dropped by Core's clearing hook, not a data store",
  account_links:
    "a sign-in method's provider subject (issuer, tenant scope, subject), not a pairwise subject",
  portal_account_identities:
    "the pre-I-05 portal's provider subject (kept for rollback), not a pairwise subject",
  ci_tokens:
    "a CI publisher's OIDC subject (repository identity), not a person",
  license_relinks:
    "Identity's own relink history (I-12): the console's audit of which subject a licence moved from and to, with its undo window; not a data store",
};

/** Durable Object classes that are not named by subject. */
const DO_NOT_NAMED_BY_SUBJECT: Record<string, string> = {
  RateLimitDO:
    "rate-limit buckets named by product, route or hash shard, never by a subject alone",
  UpdateHealthDO: "update-health counters per (product, deliverable, release)",
  SingleUseDO: "single-use sign-in, magic-link and code records by nonce",
};

const isSubjectColumn = (name: string) =>
  name === "subject" || name.endsWith("_subject");

interface Schema {
  /** table → its column names */
  tables: Map<string, string[]>;
}

async function readSchema(db: Db): Promise<Schema> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const tables = new Map<string, string[]>();
  for (const { name } of rows) {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${name})`);
    tables.set(
      name,
      cols.map((c) => c.name),
    );
  }
  return { tables };
}

/** The Durable Object class names bound in `wrangler.toml` (every environment). */
function durableObjectClasses(): string[] {
  const toml = readFileSync(join(WORKER_ROOT, "wrangler.toml"), "utf8");
  return [
    ...new Set(
      [...toml.matchAll(/^\s*class_name\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!),
    ),
  ].sort();
}

/**
 * The guard itself, pure over its inputs so the suite can also prove it FAILS: every finding is
 * one sentence naming the table, class or store and what is missing.
 */
function guardFindings(input: {
  schema: Schema;
  doClasses: readonly string[];
  stores: ReadonlyArray<readonly [string, SubjectStore]>;
}): string[] {
  const findings: string[] = [];
  const claimedTables = new Map<string, string>();
  const claimedDos = new Map<string, string>();

  for (const [name, store] of input.stores) {
    for (const hook of ["merge", "delete", "export"] as const) {
      if (typeof store[hook] !== "function")
        findings.push(`store "${name}" has no ${hook} hook`);
    }
    for (const table of store.tables ?? []) {
      claimedTables.set(table, name);
      const cols = input.schema.tables.get(table);
      if (!cols) {
        findings.push(
          `store "${name}" claims table "${table}", which does not exist`,
        );
        continue;
      }
      if (!cols.some(isSubjectColumn))
        findings.push(
          `store "${name}" claims table "${table}", which has no subject column`,
        );
      if (cols.includes("account_id"))
        findings.push(
          `table "${table}" (store "${name}") holds account_id: account × product data is keyed by the pairwise subject only`,
        );
    }
    for (const cls of store.durableObjects ?? []) {
      claimedDos.set(cls, name);
      if (!input.doClasses.includes(cls))
        findings.push(
          `store "${name}" claims Durable Object class "${cls}", which is not bound`,
        );
    }
  }

  for (const [table, cols] of input.schema.tables) {
    if (!cols.some(isSubjectColumn)) continue;
    if (claimedTables.has(table) || table in NOT_A_SUBJECT_STORE) continue;
    findings.push(
      `table "${table}" is keyed by subject but no registered store claims it (registerSubjectStore with merge, delete, export and tables: ["${table}"])`,
    );
  }
  for (const table of Object.keys(NOT_A_SUBJECT_STORE)) {
    const cols = input.schema.tables.get(table);
    if (!cols || !cols.some(isSubjectColumn))
      findings.push(
        `exemption for "${table}" is stale: no such table with a subject column`,
      );
  }
  for (const cls of input.doClasses) {
    if (claimedDos.has(cls) || cls in DO_NOT_NAMED_BY_SUBJECT) continue;
    findings.push(
      `Durable Object class "${cls}" is unclassified: claim it in a subject store's durableObjects, or list it as not named by subject`,
    );
  }
  for (const cls of Object.keys(DO_NOT_NAMED_BY_SUBJECT)) {
    if (!input.doClasses.includes(cls))
      findings.push(
        `exemption for Durable Object class "${cls}" is stale: not bound`,
      );
  }
  return findings;
}

const noop = async () => {};

describe("the subject store registry guard", () => {
  afterEach(() => unregisterSubjectStore("guard-fixture"));

  it("every subject-keyed table and Durable Object class has a store with merge, delete and export", async () => {
    const schema = await readSchema(makeTestDb());
    expect(
      guardFindings({
        schema,
        doClasses: durableObjectClasses(),
        stores: subjectStores(),
      }),
    ).toEqual([]);
  });

  it("fails on a subject-keyed table that no store claims", async () => {
    const db = makeTestDb();
    await db.run(
      "CREATE TABLE fixture_sync_rows (product TEXT NOT NULL, subject TEXT NOT NULL, body TEXT, PRIMARY KEY (product, subject))",
    );
    const findings = guardFindings({
      schema: await readSchema(db),
      doClasses: durableObjectClasses(),
      stores: subjectStores(),
    });
    expect(findings).toEqual([
      expect.stringContaining(`table "fixture_sync_rows" is keyed by subject`),
    ]);
  });

  it("fails on a store without merge, delete or export hooks, and on one keyed by account id", async () => {
    const db = makeTestDb();
    await db.run(
      "CREATE TABLE fixture_sync_rows (product TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT, PRIMARY KEY (product, subject))",
    );
    registerSubjectStore("guard-fixture", {
      merge: noop,
      tables: ["fixture_sync_rows"],
    } as unknown as SubjectStore);
    const findings = guardFindings({
      schema: await readSchema(db),
      doClasses: durableObjectClasses(),
      stores: subjectStores(),
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        'store "guard-fixture" has no delete hook',
        'store "guard-fixture" has no export hook',
        expect.stringContaining(
          'table "fixture_sync_rows" (store "guard-fixture") holds account_id',
        ),
      ]),
    );
    expect(findings).not.toContain('store "guard-fixture" has no merge hook');
    expect(findings.some((f) => f.includes("no registered store claims"))).toBe(
      false,
    );
  });

  it("fails on an unclassified Durable Object class and passes once a complete store claims it", async () => {
    const schema = await readSchema(makeTestDb());
    const doClasses = [...durableObjectClasses(), "CloudSyncDO"];
    expect(
      guardFindings({ schema, doClasses, stores: subjectStores() }),
    ).toEqual([expect.stringContaining('class "CloudSyncDO" is unclassified')]);
    registerSubjectStore("guard-fixture", {
      merge: noop,
      delete: noop,
      export: async () => null,
      durableObjects: ["CloudSyncDO"],
    });
    expect(
      guardFindings({ schema, doClasses, stores: subjectStores() }),
    ).toEqual([]);
  });
});

// ── Cloud Sync never asks for the licence owner ───────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(sourceFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("Cloud Sync's principal has no owner fallback", () => {
  it("no Cloud Sync source calls subjectFor, licenseOwnerSubject or reads an account id", () => {
    const files = [
      join(WORKER_ROOT, "src", "core", "syncAccess.ts"),
      ...sourceFiles(join(WORKER_ROOT, "src", "services", "sync")),
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const banned of [
        /\bsubjectFor\b/,
        /\bexistingSubjectFor\b/,
        /\blicenseOwnerSubject\b/,
        /\blicenseAccountId\b/,
        /\baccountForSubject\b/,
        /\baccount_id\b/,
        /\baccountId\b/,
      ]) {
        if (banned.test(code))
          offenders.push(`${relative(WORKER_ROOT, f)}: ${banned.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
