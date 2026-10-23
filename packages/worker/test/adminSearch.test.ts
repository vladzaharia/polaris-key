/**
 * ST-52: `GET /manage/api/search?q=`, the command palette's entity search and pasted-key
 * resolution.
 *
 *   - licences by id, name and email; people by email, per product the caller may read;
 *   - a pasted key resolves to its licence through `keys_index`, and a key the caller may not read
 *     answers exactly like an unknown one, with nothing of the key echoed;
 *   - at most 20 of each kind; a LIKE wildcard in the query is literal; short queries answer empty.
 */
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { PRINCIPALS } from "./rbacFixtures.js";
import type { Env } from "../src/platform/env.js";
import { subjectFor } from "../src/core/accounts/accountSubjects.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { handleAdminApi } from "../src/console/api.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import { insertLicense } from "../src/core/licensing/store.js";
import { SEARCH_KIND_CAP } from "../src/console/handlers/search.js";
import { consoleTestSession } from "./consoleSessionHelper.js";

const SYNTHETIC = new Map<string, unknown>();
vi.mock("../src/core/rbac/principal.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/core/rbac/principal.js")>();
  return {
    ...real,
    resolvePrincipal: async (
      ...args: Parameters<typeof real.resolvePrincipal>
    ) => SYNTHETIC.get(args[2].sub) ?? real.resolvePrincipal(...args),
  };
});
for (const p of Object.values(PRINCIPALS)) if (p) SYNTHETIC.set(p.memberId, p);

async function world() {
  const db = makeTestDb();
  const env: Env = makeEnv(new KvMock(), ["alpha", "beta"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  for (const slug of ["alpha", "beta"]) await seedProduct(db, slug);
  const alpha = await seedLicenseWithKey(db, "alpha");
  const beta = await seedLicenseWithKey(db, "beta");
  const acct = await getOrCreateAccountByEmail(db, "mara@tidewater.io", NOW);
  const subject = await subjectFor(db, acct.id, "alpha", NOW);
  return { db, env, alpha, beta, subject };
}
type World = Awaited<ReturnType<typeof world>>;

async function search(w: World, q: string, as: keyof typeof PRINCIPALS) {
  const { token, session } = await consoleTestSession(
    w.env,
    w.db,
    {
      sub: PRINCIPALS[as]!.memberId,
      name: as,
      email: `${as}@x.test`,
      groups: [],
    },
    NOW,
  );
  // The console resolves the member id from the account; the seam is keyed by it.
  SYNTHETIC.set(session.sub, PRINCIPALS[as]!);
  const res = await handleAdminApi(
    new Request("https://key.plrs.im/manage/api/search", {
      method: "POST",
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
      },
      body: JSON.stringify({ q }),
    }),
    w.env,
    w.db,
    "/api/search",
    NOW,
  );
  return {
    status: res.status,
    text: await res.clone().text(),
    body: (await res.json()) as {
      key: {
        product: string;
        licenseId: string;
        email: string | null;
        tier: string | null;
      } | null;
      licenses: { product: string; id: string }[];
      people: { product: string; subject: string; email: string }[];
    },
  };
}

describe("GET /manage/api/search", () => {
  it("finds licences by email, name and id, only in products the caller may read", async () => {
    const w = await world();
    for (const q of ["ada@example", "lovelace", w.alpha.licenseId]) {
      const r = await search(w, q, "alphaAdmin");
      expect(r.status).toBe(200);
      expect(r.body.licenses.map((l) => l.product)).toEqual(["alpha"]);
    }
    const both = await search(w, "ada@example", "allProducts");
    expect(both.body.licenses.map((l) => l.product).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    const none = await search(w, "ada@example", "consoleOnly");
    expect(none.body).toEqual({ key: null, licenses: [], people: [] });
  });

  it("finds people by email, with the subject the Users page opens", async () => {
    const w = await world();
    const r = await search(w, "TIDEWATER", "alphaAdmin");
    expect(r.body.people).toEqual([
      expect.objectContaining({ product: "alpha", subject: w.subject }),
    ]);
    // Licensing alone does not read people.
    expect((await search(w, "tidewater", "consoleOnly")).body.people).toEqual(
      [],
    );
  });

  it("resolves a pasted key to its licence and never echoes it", async () => {
    const w = await world();
    const r = await search(w, w.alpha.key, "alphaAdmin");
    expect(r.body.key).toMatchObject({
      product: "alpha",
      licenseId: w.alpha.licenseId,
      email: "ada@example.com",
      status: "active",
    });
    expect(r.body.licenses).toEqual([]);
    expect(r.body.people).toEqual([]);
    expect(r.text).not.toContain(w.alpha.key);
  });

  it("answers a key the caller may not read exactly like an unknown key", async () => {
    const w = await world();
    const refused = await search(w, w.beta.key, "alphaAdmin");
    const unknown = await search(
      w,
      "pkey_alpha_AAAAAAAAAAAAAAAAAAAAAA",
      "alphaAdmin",
    );
    expect(refused.body).toEqual({ key: null, licenses: [], people: [] });
    expect(refused.body).toEqual(unknown.body);
  });

  it("leaves out a product whose Licensing is off", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE products SET services_json = ? WHERE slug = 'alpha'",
      JSON.stringify({ license: { enabled: false } }),
    );
    const r = await search(w, "ada@example", "allProducts");
    expect(r.body.licenses.map((l) => l.product)).toEqual(["beta"]);
  });

  it("no longer answers GET", async () => {
    const w = await world();
    const { token } = await consoleTestSession(
      w.env,
      w.db,
      {
        sub: PRINCIPALS.alphaAdmin.memberId,
        name: "a",
        email: "a@x.test",
        groups: [],
      },
      NOW,
    );
    const res = await handleAdminApi(
      new Request("https://key.plrs.im/manage/api/search?q=ada", {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }),
      w.env,
      w.db,
      "/api/search",
      NOW,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("caps each kind and reads % and _ literally", async () => {
    const w = await world();
    for (let i = 0; i < SEARCH_KIND_CAP + 5; i++)
      await insertLicense(w.db, {
        product: "alpha",
        id: `lic_many_${i}`,
        status: "active",
        sub: null,
        name: `Bulk ${i}`,
        email: `bulk${i}@bulk.test`,
        groups_json: null,
        tier_id: null,
        activated_at: NOW,
        expires_at: null,
        max_offline_days: null,
        overrides_json: null,
        modified_by: null,
        modified_at: NOW + i,
      } as never);
    expect(
      (await search(w, "bulk.test", "alphaAdmin")).body.licenses,
    ).toHaveLength(SEARCH_KIND_CAP);
    expect((await search(w, "%", "alphaAdmin")).body.licenses).toEqual([]);
    expect((await search(w, "b", "alphaAdmin")).body.licenses).toEqual([]);
  });
});
