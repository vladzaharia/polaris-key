// I-49.6: whether silent restore is served: the launch gate (off by default) AND the product
// setting `identity.restore` (on by default, seeded from the manifest, omit-clears). The gate is
// read first.
import { describe, expect, it } from "vitest";
import type { ParsedManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import { identityHookStatements } from "../../../src/services/identity/ingest.js";
import { restoreServed } from "../../../src/services/identity/restore/gate.js";

/** The only member these statements read is `identity`. */
const parsed = (identity?: unknown): ParsedManifest =>
  ({ identity }) as unknown as ParsedManifest;

async function setup() {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["acme"]);
  await seedProduct(db, "acme");
  const ingest = (m: ParsedManifest, at = NOW) =>
    db.batch(
      identityHookStatements({
        manifest: m,
        slug: "acme",
        now: at,
        enabled: true,
      }),
    );
  const gate = (v: string | undefined) => {
    (env as unknown as Record<string, unknown>).LAUNCH_IDENTITY_RESTORE = v;
  };
  return { db, env, ingest, gate };
}

describe("restoreServed", () => {
  it("is on by default once the gate is on, and the manifest can opt out", async () => {
    const { db, env, ingest } = await setup();
    expect(await restoreServed(env, db, "acme")).toBe(true);
    await ingest(parsed({ restore: false }));
    expect(await restoreServed(env, db, "acme")).toBe(false);
    await ingest(parsed({ restore: true }), NOW + 1);
    expect(await restoreServed(env, db, "acme")).toBe(true);
    // Omitting the member clears the opt-out (omit-clears).
    await ingest(parsed({ restore: false }), NOW + 2);
    await ingest(parsed(), NOW + 3);
    expect(await restoreServed(env, db, "acme")).toBe(true);
  });

  it("is off with the launch gate unset, runtime-unset or hard off, whatever the setting says", async () => {
    const { db, env, gate } = await setup();
    for (const v of [undefined, "runtime", "off"]) {
      gate(v);
      expect(await restoreServed(env, db, "acme"), String(v)).toBe(false);
    }
    gate("on");
    expect(await restoreServed(env, db, "acme")).toBe(true);
  });

  it("is off for an unknown product", async () => {
    const { db, env } = await setup();
    expect(await restoreServed(env, db, "nobody")).toBe(false);
  });
});
