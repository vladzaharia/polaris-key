/**
 * ST-02 (notes/S-18 §4.13 item 1): the platform inventory is generated from `Env`'s JSDoc tags,
 * and `pnpm gen:platform-inventory -- --check` fails when `Env`, the inventory and the wrangler
 * configs disagree. This suite runs the same checks, so `pnpm test` fails on drift too, and pins
 * that each kind of drift is caught.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_PATH,
  inventoryErrors,
  parseEnvInventory,
  readInputs,
  renderInventory,
  ROOT,
  wranglerNames,
} from "../scripts/gen-platform-inventory.js";
import { PLATFORM_INVENTORY } from "../src/platformInventory.generated.js";

const inputs = readInputs();

/** `env.ts` with `member` inserted just before the index signature. */
function envWith(member: string): string {
  const anchor = "  // additional platform secrets/vars resolved by name";
  expect(inputs.env).toContain(anchor);
  return inputs.env.replace(anchor, `${member}\n${anchor}`);
}

describe("the platform inventory (ST-02)", () => {
  it("has no drift: every Env member tagged, wrangler and src/ consistent", () => {
    expect(inventoryErrors(inputs).errors).toEqual([]);
  });

  it("is up to date (pnpm gen:platform-inventory)", async () => {
    const committed = readFileSync(join(ROOT, GENERATED_PATH), "utf8");
    const { entries } = parseEnvInventory(inputs.env);
    expect(committed, "run pnpm gen:platform-inventory").toBe(
      await renderInventory(entries),
    );
  });

  it("lists the 16 names S-18 §2.4 found missing, with their kinds", () => {
    const kinds = Object.fromEntries(
      PLATFORM_INVENTORY.map((e) => [e.name, e.kind]),
    );
    expect({
      PKG_ORIGIN: kinds.PKG_ORIGIN,
      EMAIL_SENDER_ADDRESS: kinds.EMAIL_SENDER_ADDRESS,
      EMAIL_PRODUCT_DAILY_CAP: kinds.EMAIL_PRODUCT_DAILY_CAP,
      EMAIL_APPLE_RELAY: kinds.EMAIL_APPLE_RELAY,
      REGISTRY_TOKEN_KEY: kinds.REGISTRY_TOKEN_KEY,
      REGISTRY_TOKEN_KEY_PREVIOUS: kinds.REGISTRY_TOKEN_KEY_PREVIOUS,
      PLATFORM_REPOSITORY: kinds.PLATFORM_REPOSITORY,
      PLATFORM_REPOSITORY_ID: kinds.PLATFORM_REPOSITORY_ID,
      PLATFORM_REPOSITORY_OWNER_ID: kinds.PLATFORM_REPOSITORY_OWNER_ID,
      PLATFORM_DEPLOY_ENVIRONMENT: kinds.PLATFORM_DEPLOY_ENVIRONMENT,
      PLATFORM_APPLE_TEAM_ID: kinds.PLATFORM_APPLE_TEAM_ID,
      PLATFORM_ASC_API_KEY: kinds.PLATFORM_ASC_API_KEY,
      PLATFORM_APP_STORE_SERVER_KEY: kinds.PLATFORM_APP_STORE_SERVER_KEY,
      PLATFORM_GOOGLE_SERVICE_ACCOUNT: kinds.PLATFORM_GOOGLE_SERVICE_ACCOUNT,
      PLATFORM_MS_PARTNER_CENTER: kinds.PLATFORM_MS_PARTNER_CENTER,
      PLATFORM_STEAM_PUBLISHER_KEY: kinds.PLATFORM_STEAM_PUBLISHER_KEY,
    }).toEqual({
      PKG_ORIGIN: "var",
      EMAIL_SENDER_ADDRESS: "var",
      EMAIL_PRODUCT_DAILY_CAP: "var",
      EMAIL_APPLE_RELAY: "var",
      REGISTRY_TOKEN_KEY: "secret",
      REGISTRY_TOKEN_KEY_PREVIOUS: "secret",
      PLATFORM_REPOSITORY: "var",
      PLATFORM_REPOSITORY_ID: "var",
      PLATFORM_REPOSITORY_OWNER_ID: "var",
      PLATFORM_DEPLOY_ENVIRONMENT: "var",
      PLATFORM_APPLE_TEAM_ID: "var",
      PLATFORM_ASC_API_KEY: "secret",
      PLATFORM_APP_STORE_SERVER_KEY: "secret",
      PLATFORM_GOOGLE_SERVICE_ACCOUNT: "secret",
      PLATFORM_MS_PARTNER_CENTER: "secret",
      PLATFORM_STEAM_PUBLISHER_KEY: "secret",
    });
  });

  it("covers the names src/ read through the index signature, and the registry-backed vars", () => {
    const byName = new Map(PLATFORM_INVENTORY.map((e) => [e.name, e]));
    for (const n of [
      "BLOBS_BUCKET_NAME",
      "R2_ACCOUNT_ID",
      "R2_PARENT_ACCESS_KEY_ID",
      "R2_PARENT_SECRET_ACCESS_KEY",
    ])
      expect(byName.has(n), n).toBe(true);
    expect(
      PLATFORM_INVENTORY.filter((e) => e.editable !== null)
        .map((e) => [e.name, e.editable])
        .sort(),
    ).toEqual([
      ["ASSET_HOSTING", "ASSET_HOSTING"],
      ["BLOB_GC_GRACE_DAYS", "BLOB_GC_GRACE_DAYS"],
      ["BLOB_GC_MODE", "BLOB_GC_MODE"],
      ["IDENTITY_RESERVED_DISPLAY_NAMES", "IDENTITY_RESERVED_DISPLAY_NAMES"],
      ["KEYENTRY_REFUSALS", "KEYENTRY_REFUSALS"],
      ["LAZY_DELTAS", "LAZY_DELTAS"],
      ["LAZY_DELTA_MAX_BYTES", "LAZY_DELTA_MAX_BYTES"],
      ["LICENSING_RESERVED_NAMES", "LICENSING_RESERVED_NAMES"],
    ]);
  });

  it("tags every credential-shaped name a secret, so the console never shows its value", () => {
    // `GET /manage/api/platform/settings` reports a `var` in clear and a `secret` as presence
    // only (THREAT-MODEL "The inventory never reveals a secret"), so a mis-tag is a leak.
    const credential =
      /(_SECRET|_PEPPER|PRIVATE_KEY|_KEY|_KEYS|_KEY_PREVIOUS|_SERVICE_ACCOUNT|_PARTNER_CENTER|_ACCESS_KEY_ID)$|^PLATFORM_KEK$/;
    // Public by design, though credential-shaped: a Turnstile site key is embedded in the page
    // the widget renders on (I-07; the portal reads it from `/api/capabilities`).
    const publicByDesign = new Set(["TURNSTILE_SITE_KEY"]);
    const shaped = PLATFORM_INVENTORY.filter(
      (e) => credential.test(e.name) && !publicByDesign.has(e.name),
    );
    for (const e of shaped) expect(e.kind, e.name).toBe("secret");
    // The two sets coincide: a new secret whose name is not credential-shaped widens the pattern.
    expect(shaped.map((e) => e.name)).toEqual(
      PLATFORM_INVENTORY.filter((e) => e.kind === "secret").map((e) => e.name),
    );
  });

  it("fails when a name is added to Env without the inventory tag", () => {
    const { errors } = inventoryErrors({
      ...inputs,
      env: envWith("  NEW_PLATFORM_SETTING?: string;"),
    });
    expect(errors).toEqual([
      expect.stringMatching(/^NEW_PLATFORM_SETTING: no @inventory tag/),
    ]);
  });

  it("fails on an unknown kind or area, and on a misplaced @editable", () => {
    const bad = (doc: string) =>
      inventoryErrors({
        ...inputs,
        env: envWith(`  /**\n   * x\n${doc}\n   */\n  NEW_X?: string;`),
      }).errors.filter((e) => e.startsWith("NEW_X"));
    expect(bad("   * @inventory knob jobs")[0]).toMatch(/kind "knob"/);
    expect(bad("   * @inventory var nowhere")[0]).toMatch(/area "nowhere"/);
    expect(
      bad("   * @inventory secret jobs\n   * @editable LAZY_DELTAS"),
    ).toContain("NEW_X: only a var can be @editable");
  });

  it("fails when a tagged var or secret is named nowhere in wrangler.toml", () => {
    const { errors } = inventoryErrors({
      ...inputs,
      env: envWith(
        "  /**\n   * A new key.\n   * @inventory secret keyring\n   */\n  NEW_SIGNING_SECRET?: string;",
      ),
    });
    expect(errors).toEqual([
      expect.stringMatching(
        /^NEW_SIGNING_SECRET: an Env secret named nowhere in packages\/worker\/wrangler\.toml/,
      ),
    ]);
  });

  it("fails when a secret is mentioned in wrangler.toml but missing from the secrets comment", () => {
    const wrangler = inputs.wrangler.replace(
      "REGISTRY_TOKEN_KEY, and REGISTRY_TOKEN_KEY_PREVIOUS during a rotation only.",
      "(see the runbook)",
    );
    expect(wrangler).not.toBe(inputs.wrangler);
    const { errors } = inventoryErrors({
      ...inputs,
      wrangler: `${wrangler}\n[env.x.vars]\n# REGISTRY_TOKEN_KEY_PREVIOUS = "commented, not the block"\n`,
    });
    expect(errors).toContain(
      "REGISTRY_TOKEN_KEY: an Env var named nowhere in packages/worker/wrangler.toml (add it to a [vars] block or the secrets comment)".replace(
        "an Env var",
        "an Env secret",
      ),
    );
    expect(errors).toContain(
      "packages/worker/wrangler.toml: [vars] REGISTRY_TOKEN_KEY_PREVIOUS is an Env secret, not a var",
    );
  });

  it("fails when the secrets comment names a secret Env no longer has", () => {
    const wrangler = inputs.wrangler.replace(
      "# Required secrets",
      "#   STALE_REMOVED_SECRET, OLD_KEY (secrets).\n# Required secrets",
    );
    expect(wrangler).not.toBe(inputs.wrangler);
    const { errors } = inventoryErrors({ ...inputs, wrangler });
    expect(errors).toEqual([
      "packages/worker/wrangler.toml: secrets comment block names OLD_KEY, which is not an Env var or secret",
      "packages/worker/wrangler.toml: secrets comment block names STALE_REMOVED_SECRET, which is not an Env var or secret",
    ]);
  });

  it("fails when a wrangler config declares a var or binding Env lacks", () => {
    const { errors } = inventoryErrors({
      ...inputs,
      wranglerDeltas: `${inputs.wranglerDeltas}\n[env.dev.vars]\nMYSTERY_KNOB = "1"\n[[env.dev.kv_namespaces]]\nbinding = "MYSTERY_KV"\n`,
    });
    expect(errors).toEqual([
      "packages/worker/wrangler.deltas.toml: [vars] MYSTERY_KNOB is not an Env member",
      "packages/worker/wrangler.deltas.toml: binding MYSTERY_KV is not an Env member",
    ]);
  });

  it("fails when src/ reads a name Env does not declare", () => {
    const { errors } = inventoryErrors({
      ...inputs,
      files: [
        ...inputs.files,
        {
          path: "packages/worker/src/x.ts",
          text: 'const a = env.UNDECLARED_ONE; const b = secret(c.env, "UNDECLARED_TWO");',
        },
      ],
    });
    expect(errors).toEqual([
      "packages/worker/src/x.ts: reads env UNDECLARED_ONE, which Env does not declare",
      "packages/worker/src/x.ts: reads env UNDECLARED_TWO, which Env does not declare",
    ]);
  });

  it("reads the wrangler shapes this repo uses", () => {
    const w = wranglerNames(inputs.wrangler);
    for (const b of [
      "DB",
      "HOT",
      "RL",
      "SINGLE_USE",
      "UPDATE_HEALTH",
      "ASSETS",
      "BLOBS",
      "DELTA_QUEUE",
      "DELTA_DLQ",
      "CF_VERSION_METADATA",
      "EMAIL",
    ])
      expect(w.bindings.has(b), b).toBe(true);
    // A commented-out [vars] entry still documents the var.
    expect(w.vars.has("EMAIL_APPLE_RELAY")).toBe(true);
    expect(w.secretsBlock.has("KEY_HASH_PEPPER")).toBe(true);
    expect(w.secretsBlock.has("LAZY_DELTAS")).toBe(false);
  });
});
