import { describe, expect, it } from "vitest";
import { configProblems } from "../src/core/configGuard.js";
import { check } from "../scripts/check-config.mjs";
import { hashKey } from "../src/platform/crypto.js";
import type { Env } from "../src/platform/env.js";

const S = "s".repeat(32);
const good = {
  PKEY_ENVIRONMENT: "prod",
  KEY_HASH_PEPPER: S,
  ADMIN_SESSION_SECRET: S + "a",
  PORTAL_SESSION_SECRET: S + "b",
  BLOB_ORIGIN: "https://dl.example.test",
} as unknown as Env;

describe("config guard", () => {
  it("accepts a complete deployed config and exempts test envs", () => {
    expect(configProblems(good)).toEqual([]);
    expect(configProblems({} as Env)).toEqual([]);
  });
  it("names a missing pepper, weak secret and portal fallback", () => {
    const bad = {
      ...good,
      KEY_HASH_PEPPER: undefined,
      ADMIN_SESSION_SECRET: "short",
      PORTAL_SESSION_SECRET: undefined,
      DOWNLOAD_TICKET_KEY: "weak",
    } as unknown as Env;
    expect(configProblems(bad).sort()).toEqual([
      "ADMIN_SESSION_SECRET",
      "DOWNLOAD_TICKET_KEY",
      "KEY_HASH_PEPPER",
      "PORTAL_SESSION_SECRET",
    ]);
  });
  it("rejects a bare-hostname origin", () => {
    expect(
      configProblems({ ...good, PKG_ORIGIN: "pkg.plrs.im" } as unknown as Env),
    ).toEqual(["PKG_ORIGIN"]);
  });
  it("deploy check reports missing secrets and bad origins without values", () => {
    const toml = '[env.prod.vars]\nBLOB_ORIGIN = "dl.plrs.im"\n';
    const p = check("prod", ["KEY_HASH_PEPPER", "PLATFORM_KEK"], toml);
    expect(p).toContain("secret ADMIN_SESSION_SECRET is not set");
    expect(p).toContain("secret PORTAL_SESSION_SECRET is not set");
    expect(p).toContain("BLOB_ORIGIN is not an absolute https URL");
  });
  it("hashKey with a pepper differs from unpeppered", async () => {
    expect(await hashKey("x", S)).not.toBe(await hashKey("x"));
  });
});

describe("portal session has no admin fallback", () => {
  it("refuses to sign without PORTAL_SESSION_SECRET even when ADMIN_SESSION_SECRET is set", async () => {
    const { issuePortalSession } =
      await import("../src/services/identity/portal/session.js");
    await expect(
      issuePortalSession(
        { ADMIN_SESSION_SECRET: S } as unknown as Env,
        { accountId: "a" } as never,
        1000,
      ),
    ).rejects.toThrow("PORTAL_SESSION_SECRET is required");
  });
});

describe("webhook secret rotation", () => {
  async function sig(secret: string, body: string) {
    const { hmacSha256, importHmacKey } =
      await import("../src/platform/hash.js");
    const mac = await hmacSha256(
      await importHmacKey(secret),
      new TextEncoder().encode(body),
    );
    return (
      "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("")
    );
  }
  async function status(env: Record<string, string>, secret: string) {
    const { handleGithubWebhook } = await import("../src/githubWebhook.js");
    const body = "{}";
    const req = new Request("https://x.test/webhooks/github", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": await sig(secret, body) },
    });
    // 400 (missing delivery id) is reached only after the signature verified.
    return (
      await handleGithubWebhook(req, env as unknown as Env, {} as never, 1)
    ).status;
  }
  it("accepts the previous secret, still refuses an unknown one", async () => {
    const env = {
      GITHUB_WEBHOOK_SECRET: "new-secret",
      GITHUB_WEBHOOK_SECRET_PREVIOUS: "old-secret",
    };
    expect(await status(env, "old-secret")).toBe(400);
    expect(await status(env, "new-secret")).toBe(400);
    expect(await status(env, "other")).toBe(401);
    expect(
      await status({ GITHUB_WEBHOOK_SECRET: "new-secret" }, "old-secret"),
    ).toBe(401);
  });
});
