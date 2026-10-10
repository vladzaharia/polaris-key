// I-09: a product's terms (`identity.terms`, the manifest's `identity:` block) and the product
// context of a sign-in the card starts for a product (`/signin?product=<slug>`, the `signInUrl` of
// `license_owned`): the provider flow carries the product, and the callback hands the email gate
// that product and its terms.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieFrom,
  googleClaims,
  makeProviderHarness,
  nonceOf,
  ORIGIN,
  type ProviderHarness,
} from "./identityProviderHarness.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { SETTINGS } from "../src/mount.js";
import { setServices } from "../src/core/repo.js";
import { EMAIL_GATE_COOKIE } from "../src/core/accounts/accountCookies.js";
import { getArtefact } from "../src/core/singleUse.js";
import { SERVICE_SLUGS } from "../src/core/services.js";
import type { Db } from "../src/db/types.js";
import {
  SIGNIN_BIND_COOKIE,
  signInFlowKey,
  type SignInFlowRecord,
} from "../src/services/identity/providers/flow.js";
import {
  productTerms,
  termsRequirementOf,
} from "../src/services/identity/productTerms.js";
import { resetProviderCaches } from "../src/services/identity/providers/discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderCaches();
});

const TERMS = { version: "2026-10", url: "https://acme.example/terms" };

async function identityOn(db: Db, slug: string, on = true): Promise<void> {
  await setServices(
    db,
    slug,
    JSON.stringify(
      Object.fromEntries(
        SERVICE_SLUGS.map((s) => [
          s,
          { enabled: s === "license" || (on && s === "identity") },
        ]),
      ),
    ),
    "manifest",
    NOW,
  );
}

/** The row link and resync write for `identity.terms` (`manifestIngestAlways`). */
async function declareTerms(db: Db, slug: string, value: unknown) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.terms', ?, 'manifest', ?, 'resync')`,
    slug,
    JSON.stringify(value),
    NOW,
  );
}

describe("termsRequirementOf", () => {
  it("answers a requirement only for a valid version and an https URL", () => {
    expect(termsRequirementOf(TERMS)).toEqual(TERMS);
    for (const bad of [
      null,
      "2026-10",
      [TERMS],
      { version: "2026-10" },
      { url: TERMS.url },
      { ...TERMS, version: "2026 10" },
      { ...TERMS, url: "http://acme.example/terms" },
      { ...TERMS, url: "https://u:p@acme.example/terms" },
      { ...TERMS, url: "javascript:alert(1)" },
    ])
      expect(termsRequirementOf(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("productTerms (identity.terms through the resolver)", () => {
  it("resolves the declared terms, and nothing when none are declared", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["acme"]);
    await seedProduct(db, "acme");
    expect(
      await productTerms({ env, db, registry: SETTINGS }, "acme"),
    ).toBeNull();
    await declareTerms(db, "acme", TERMS);
    expect(await productTerms({ env, db, registry: SETTINGS }, "acme")).toEqual(
      TERMS,
    );
    // Without the registry (a context built by hand) nothing is asked.
    expect(await productTerms({ env, db }, "acme")).toBeNull();
    // An unknown product asks nothing.
    expect(
      await productTerms({ env, db, registry: SETTINGS }, "nope"),
    ).toBeNull();
  });

  it("asks nothing for a version with no URL to show", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["acme"]);
    await seedProduct(db, "acme");
    await declareTerms(db, "acme", { version: "2026-10" });
    expect(
      await productTerms({ env, db, registry: SETTINGS }, "acme"),
    ).toBeNull();
  });
});

/** Start Google with `?product=…`; the flow record the start stored. */
async function startFor(
  h: ProviderHarness,
  product: string | null,
): Promise<{
  record: SignInFlowRecord;
  location: URL;
  state: string;
  cookie: string;
}> {
  const qs = product === null ? "" : `?product=${encodeURIComponent(product)}`;
  const res = await h.request(`/login/google${qs}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  const cookie = cookieFrom(res, SIGNIN_BIND_COOKIE)!;
  const raw = await getArtefact(h.env, await signInFlowKey(h.env, state));
  return {
    record: JSON.parse(raw!) as SignInFlowRecord,
    location,
    state,
    cookie,
  };
}

describe("a sign-in the card starts for a product (I-09)", () => {
  it("carries a product whose Identity is on, and ignores anything else", async () => {
    const h = await makeProviderHarness();
    await identityOn(h.db, "djdl");
    expect((await startFor(h, "djdl")).record.product).toBe("djdl");
    // No product, an unknown one, a slug that is not one, and an Identity-off product: none kept.
    expect((await startFor(h, null)).record.product).toBeUndefined();
    expect((await startFor(h, "nope")).record.product).toBeUndefined();
    expect((await startFor(h, "../djdl")).record.product).toBeUndefined();
    await identityOn(h.db, "djdl", false);
    expect((await startFor(h, "djdl")).record.product).toBeUndefined();
  });

  it("hands the email gate the product and its terms", async () => {
    const h = await makeProviderHarness();
    await identityOn(h.db, "djdl");
    await declareTerms(h.db, "djdl", TERMS);
    const { location, state, cookie } = await startFor(h, "djdl");
    h.idToken.google = await h.signGoogle(
      googleClaims(nonceOf(location), { hd: "example.com" }),
    );
    const qs = new URLSearchParams({
      code: "4/0AQSTgQ-code",
      state,
      scope: "email",
      iss: "https://accounts.google.com",
    });
    const res = await h.request(`/login/google/callback?${qs}`, { cookie });
    expect(res.status).toBe(302);
    const gate = cookieFrom(res, EMAIL_GATE_COOKIE);
    expect(gate).toBeTruthy();
    const view = (await (
      await h.request("/api/signin/confirm-email", {
        headers: { origin: ORIGIN },
        cookie: gate,
      })
    ).json()) as { terms: unknown; product: { slug: string } | null };
    expect(view.terms).toEqual(TERMS);
    expect(view.product?.slug).toBe("djdl");
  });

  it("a plain sign-in asks no product's terms", async () => {
    const h = await makeProviderHarness();
    await identityOn(h.db, "djdl");
    await declareTerms(h.db, "djdl", TERMS);
    const { location, state, cookie } = await startFor(h, null);
    h.idToken.google = await h.signGoogle(
      googleClaims(nonceOf(location), { hd: "example.com" }),
    );
    const qs = new URLSearchParams({
      code: "4/0AQSTgQ-code",
      state,
      scope: "email",
      iss: "https://accounts.google.com",
    });
    const res = await h.request(`/login/google/callback?${qs}`, { cookie });
    const gate = cookieFrom(res, EMAIL_GATE_COOKIE);
    const view = (await (
      await h.request("/api/signin/confirm-email", {
        headers: { origin: ORIGIN },
        cookie: gate,
      })
    ).json()) as { terms: unknown; product: unknown };
    expect(view.terms).toBeNull();
    expect(view.product).toBeNull();
  });
});
