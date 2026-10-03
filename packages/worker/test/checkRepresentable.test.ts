/**
 * `pnpm --filter @polaris-key/worker check:representable` against a LOCAL D1 (wrangler's
 * miniflare-backed `--local` store), plans/P3-01.md §2.2 "The D1 check" (P3-12).
 *
 * The real migrations are applied to a throwaway store, a clean product is seeded and must
 * produce nothing, then one bad row per table is added so that every one of the 21 checked
 * columns holds a value the signer guard would trip on, and both warning columns hold a day
 * count outside 1–365. The check must flag exactly the 21 and warn on exactly the 2. Later
 * cases seed catalogs whose values are clean but whose entry keys could not be member names,
 * and day counts whose graceUntil the signer would refuse (flagged, not warned). A unit block
 * proves the day-count rule agrees with the real builder and signDoc's integer guard.
 *
 * Text columns get their lone surrogate as raw WTF-8 bytes (`CAST(X'…' AS TEXT)`), which is
 * how a storage layer that does not replace one keeps it; JSON columns get it as the ASCII
 * escape `JSON.stringify` writes. Production D1 is never touched: running the check there is
 * the operator's step in docs/RUNBOOK.md.
 */

import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — a plain ESM script with no type declarations.
import * as check from "../scripts/check-representable.mjs";
import { buildLicenseDoc } from "../src/core/documents.js";
import { assertIntegerClaims } from "../src/core/signing.js";

interface Finding {
  table: string;
  column: string;
  key: Record<string, unknown>;
  rule: string;
  value?: unknown;
}
interface CheckModule {
  CHECKED_COLUMNS: string[];
  WARNING_COLUMNS: string[];
  runCheck(query: unknown): { issues: Finding[]; warnings: Finding[] };
  wranglerQuery(opts: Record<string, unknown>): unknown;
  offlineDaysTripSigner(raw: unknown, nowSeconds: number): boolean;
}
const {
  CHECKED_COLUMNS,
  WARNING_COLUMNS,
  runCheck,
  wranglerQuery,
  offlineDaysTripSigner,
} = check as CheckModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..");
const SCRIPT = join(WORKER, "scripts", "check-representable.mjs");
const WRANGLER = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

let persistTo: string;

/** wrangler's local workerd can drop its connection while it starts on a loaded machine;
 *  that one error is retried (twice). Any other failure throws at once.
 *
 *  Asynchronous on purpose: `d1 migrations apply` alone takes several seconds idle and far longer
 *  on a CI runner, and a synchronous spawn blocks this worker's event loop for all of it, long
 *  enough for vitest's worker-to-main RPC to time out ("Timeout calling onTaskUpdate"). */
const TRANSIENT = /other side closed/;
const execFileAsync = promisify(execFile);

async function wrangler(...args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let out: string;
    try {
      const run = await execFileAsync(
        process.execPath,
        [
          WRANGLER,
          ...args,
          "--env",
          "prod",
          "--local",
          "--persist-to",
          persistTo,
        ],
        {
          cwd: WORKER,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
        },
      );
      return run.stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      if (err.stdout === undefined && err.stderr === undefined) throw e;
      out = err.stderr || err.stdout || "";
    }
    if (attempt < 2 && TRANSIENT.test(out)) continue;
    throw new Error(`wrangler ${args.join(" ")}:\n${out}`);
  }
}

async function sql(command: string): Promise<void> {
  await wrangler("d1", "execute", "polaris_key_prod", "--command", command);
}

const local = () =>
  runCheck(
    wranglerQuery({
      database: "polaris_key_prod",
      env: "prod",
      local: true,
      persistTo,
      cwd: WORKER,
    }),
  );

function cli(): {
  status: number | null;
  out: { issues: Finding[]; warnings: Finding[] };
} {
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "--local", "--persist-to", persistTo, "--json"],
    { cwd: WORKER, encoding: "utf8", env: { ...process.env, CI: "1" } },
  );
  return { status: run.status, out: JSON.parse(run.stdout) };
}

/** A lone surrogate as WTF-8 bytes (`ED A0 80` is U+D800) after an ASCII prefix. */
const wtf8 = (prefix: string): string =>
  `CAST(X'${Buffer.from(prefix).toString("hex")}EDA080' AS TEXT)`;
const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;

function nested(levels: number): unknown {
  let v: unknown = {};
  for (let k = 1; k < levels; k++) v = { x: v };
  return v;
}

const CLEAN_CATALOG = JSON.stringify({
  schemaVersion: 1,
  entries: [
    { key: "app.label", kind: "config", default: "hello 😀" },
    { key: "app.ratio", kind: "config", default: 1e-307 },
  ],
});

beforeAll(async () => {
  persistTo = mkdtempSync(join(tmpdir(), "pkey-check-representable-"));
  await wrangler("d1", "migrations", "apply", "polaris_key_prod");
  // A clean product: every checked column holds an ordinary value.
  await sql(
    [
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES ('djdl', 'DJDL', 'djdl-2026', 'pub', '0.0.0', '99.0.0', 30, 5, 1, 1)`,
      `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at)
       VALUES ('djdl', 'djdl-2026', 'Ed25519', 'pub', '{}', 'active', 1)`,
      `INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at)
       VALUES ('djdl', 1, ${lit(CLEAN_CATALOG)}, 1, 1)`,
      `INSERT INTO tiers (product, id, label, channels_json, min_version, max_version,
         policy_device_limit, modified_at)
       VALUES ('djdl', 'pro', 'Pro 😀', '["stable","beta"]', '1.0.0', '2.0.0', 5, 1)`,
      `INSERT INTO licenses (product, id, status, name, email, tier_id, activated_at,
         max_offline_days, overrides_json, channels_json, min_version, max_version, modified_at)
       VALUES ('djdl', 'lic_ok', 'active', 'Ada Lovelace', 'ada@x.io', 'pro', 1, 30,
         ${lit(JSON.stringify({ config: { "app.label": { state: "enforced", value: "x\u0000y", updatedAt: 1 } }, secrets: {}, entitlements: {} }))},
         '["stable"]', '1.0.0', '9.0.0', 1)`,
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, overrides_json)
       VALUES ('djdl', 'dev_ok', 'lic_ok', 'authorized', 1, 1, '{"config":{}}')`,
      `INSERT INTO profiles (product, id, name, payload_json, modified_at)
       VALUES ('djdl', 'base', 'Base', ${lit(JSON.stringify({ config: { "app.label": { value: { é: 1 } } } }))}, 1)`,
      `INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json)
       VALUES ('djdl', 'vpn', 'vpn', ${lit(JSON.stringify(nested(32)))})`,
      `INSERT INTO edge_mint_config (product, id, alg, signing_key_secret, kid, claims_template_json,
         ttl_seconds, audience)
       VALUES ('djdl', 'svc', 'EdDSA', 'KEY', 'svc-1', '{"iss":"team"}', 600, 'https://svc.example')`,
    ].join(";\n"),
  );
}, 120_000);

afterAll(() => {
  if (persistTo) rmSync(persistTo, { recursive: true, force: true });
});

describe("check:representable's day-count rule", () => {
  // The check must flag exactly the stored day counts that make the real builder's graceUntil
  // trip signDoc's integer guard, and no others (a fractional count is floored and signs).
  const NOW_S = 1_790_000_000;
  const guardRefuses = (days: number): boolean => {
    const doc = buildLicenseDoc({
      aud: "djdl",
      deviceId: "dev",
      licenseId: "lic",
      now: NOW_S,
      maxOfflineDays: days,
      profile: {} as never,
      entitlements: {},
    });
    try {
      assertIntegerClaims(doc, "pkey-license+jws");
      return false;
    } catch {
      return true;
    }
  };
  it.each([
    30,
    1.5,
    0,
    365,
    366,
    -1,
    -20_000,
    -20_800,
    -1e6,
    1e9,
    1.04e11,
    1.05e11,
    1e20,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("agrees with the builder and signDoc's guard for %s days", (days) => {
    expect(offlineDaysTripSigner(days, NOW_S)).toBe(guardRefuses(days));
  });
  it("lets a null count through (licence falls back, product reads 0 days)", () => {
    expect(offlineDaysTripSigner(null, NOW_S)).toBe(false);
  });
});

describe("check:representable on a local D1", () => {
  it("names 21 checked columns and 2 warning columns", () => {
    expect(CHECKED_COLUMNS).toHaveLength(21);
    expect(WARNING_COLUMNS).toEqual([
      "licenses.max_offline_days",
      "products.default_max_offline_days",
    ]);
  });

  it("reports nothing on a clean store, and the CLI exits 0", () => {
    expect(local()).toEqual({ issues: [], warnings: [] });
    const run = cli();
    expect(run.status).toBe(0);
    expect(run.out).toEqual({ issues: [], warnings: [] });
  }, 60_000);

  it("flags a seeded bad value in each of the 21 columns and warns on both day counts", async () => {
    const tierId = wtf8("p");
    await sql(
      [
        `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
           default_max_offline_days, default_device_limit, created_at, modified_at)
         VALUES ('bad', 'Bad', ${wtf8("k")}, 'pub', '0.0.0', '99.0.0', 0, 5, 1, 1)`,
        `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at)
         VALUES ('djdl', ${wtf8("kid")}, 'Ed25519', 'pub', '{}', 'retired', 1)`,
        `INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at)
         VALUES ('bad', 1, '{"schemaVersion":1,"entries":[{"key":"k","default":1e-320}]}', 1, 1)`,
        `INSERT INTO tiers (product, id, label, channels_json, min_version, max_version,
           policy_device_limit, modified_at)
         VALUES ('djdl', ${tierId}, ${wtf8("Pro")}, '["\\ud800"]', ${wtf8("1.")}, ${wtf8("2.")}, 1e308, 1)`,
        `INSERT INTO licenses (product, id, status, name, email, tier_id, activated_at,
           max_offline_days, overrides_json, channels_json, min_version, max_version, modified_at)
         VALUES ('djdl', 'lic_bad', 'active', ${wtf8("Ada")}, ${wtf8("a@")}, ${tierId}, 1, 1.5,
           '{"config":{"app.label":{"state":"enforced","value":"\\ud800","updatedAt":1}}}',
           '["\\udc00"]', ${wtf8("1.")}, ${wtf8("9.")}, 1)`,
        `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, overrides_json)
         VALUES ('djdl', 'dev_bad', 'lic_bad', 'authorized', 1, 1, '{"config":{"a\\u0000b":1}}')`,
        `INSERT INTO profiles (product, id, name, payload_json, modified_at)
         VALUES ('djdl', 'bad', 'Bad', '{"config":{"\\u00e9":1,"e\\u0301":2}}', 1)`,
        `INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json)
         VALUES ('djdl', 'deep', 'deep', ${lit(JSON.stringify(nested(33)))})`,
        `INSERT INTO edge_mint_config (product, id, alg, signing_key_secret, kid, claims_template_json,
           ttl_seconds, audience)
         VALUES ('djdl', 'bad', 'EdDSA', 'KEY', 'svc-1', '{"sub":"\\ud800"}', 600, ${wtf8("aud")})`,
      ].join(";\n"),
    );

    const { issues, warnings } = local();
    const flagged = issues.map((i) => `${i.table}.${i.column}`).sort();
    expect(flagged).toEqual([...CHECKED_COLUMNS].sort());
    // The clean product's rows never appear: only the bad row of each table is reported.
    expect(
      issues.every((i) => JSON.stringify(i.key).includes("ok") === false),
    ).toBe(true);
    const rules = Object.fromEntries(
      issues.map((i) => [`${i.table}.${i.column}`, i.rule]),
    );
    expect(rules).toMatchObject({
      "licenses.overrides_json": "lone-surrogate",
      "devices.overrides_json": "nul-in-member-name",
      "profiles.payload_json": "equivalent-member-names",
      "product_schema.catalog_json": "number-out-of-range",
      "provisioning_config.entitlement_value_json": "too-deep",
      "tiers.policy_device_limit": "number-out-of-range",
      "products.signing_kid": "lone-surrogate",
    });
    expect(warnings.map((w) => `${w.table}.${w.column}`).sort()).toEqual(
      [...WARNING_COLUMNS].sort(),
    );

    const run = cli();
    expect(run.status).toBe(1);
    expect(run.out.issues).toHaveLength(21);
    expect(run.out.warnings).toHaveLength(2);
  }, 60_000);

  it("flags a catalog whose entry keys could not be member names, though every value is clean", async () => {
    // A catalog key is a string VALUE in catalog_json but a MEMBER NAME in `config.<key>`, so a
    // walk of the catalog as a value would pass both of these rows.
    const product = (slug: string) =>
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES ('${slug}', '${slug}', '${slug}-1', 'pub', '0.0.0', '99.0.0', 30, 5, 1, 1)`;
    const schema = (slug: string, keys: string[]) =>
      `INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at)
       VALUES ('${slug}', 1, '{"schemaVersion":1,"entries":[${keys
         .map((k, i) => `{"key":"${k}","kind":"config","default":${i}}`)
         .join(",")}]}', 1, 1)`;
    await sql(
      [
        product("nfcpair"),
        schema("nfcpair", ["\\u00e9", "e\\u0301"]),
        product("nulkey"),
        schema("nulkey", ["app.ok", "a\\u0000b"]),
      ].join(";\n"),
    );

    const keyed = local().issues.filter(
      (i) =>
        i.table === "product_schema" &&
        ["nfcpair", "nulkey"].includes(String(i.key.product)),
    );
    expect(
      keyed.map((i) => ({
        product: i.key.product,
        rule: i.rule,
        path: (i as Finding & { path: string }).path,
      })),
    ).toEqual([
      {
        product: "nfcpair",
        rule: "equivalent-member-names",
        path: "/entries/1/key",
      },
      { product: "nulkey", rule: "nul-in-member-name", path: "/entries/1/key" },
    ]);
  }, 60_000);
  it("flags a day count whose graceUntil the signer would refuse, and still only warns on a fractional one", async () => {
    await sql(
      [
        `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
           default_max_offline_days, default_device_limit, created_at, modified_at)
         VALUES ('farpast', 'Far past', 'farpast-1', 'pub', '0.0.0', '99.0.0', -1e6, 5, 1, 1)`,
        `INSERT INTO licenses (product, id, status, name, email, tier_id, activated_at,
           max_offline_days, overrides_json, channels_json, min_version, max_version, modified_at)
         VALUES ('djdl', 'lic_forever', 'active', 'Ada', 'a@x.io', 'pro', 1, 1e20,
           '{}', '["stable"]', '1.0.0', '9.0.0', 1),
                ('djdl', 'lic_half', 'active', 'Ada', 'a@x.io', 'pro', 1, 2.5,
           '{}', '["stable"]', '1.0.0', '9.0.0', 1)`,
      ].join(";\n"),
    );

    const { issues, warnings } = local();
    const grace = issues
      .filter((i) => i.rule === "grace-until-out-of-range")
      .map((i) => ({
        column: `${i.table}.${i.column}`,
        key: i.key,
        value: i.value,
      }));
    expect(grace).toEqual([
      {
        column: "licenses.max_offline_days",
        key: { product: "djdl", id: "lic_forever" },
        value: 1e20,
      },
      {
        column: "products.default_max_offline_days",
        key: { slug: "farpast" },
        value: -1e6,
      },
    ]);
    // A fractional count is floored by the builders and signs: a warning, not a flag.
    expect(
      warnings.filter((w) => w.key.id === "lic_half").map((w) => w.rule),
    ).toEqual(["offline-days-not-integer-1-365"]);
    expect(issues.some((i) => i.key.id === "lic_half")).toBe(false);
    expect(cli().status).toBe(1);
  }, 60_000);
});
