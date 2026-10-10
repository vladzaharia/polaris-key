import { describe, expect, it } from "vitest";
import { NOW, seedProduct } from "./seed.js";
import {
  Device,
  lastLink,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import {
  beginProviderSignIn,
  EMAIL_GATE_LANDING,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import {
  httpsUrl,
  parsePlatformTerms,
  PLATFORM_TERMS_KEY,
  PLATFORM_TERMS_PRODUCT,
  platformTerms,
} from "../src/core/platformTerms.js";
import { productTerms } from "../src/services/identity/accounts/terms.js";
import { listingLegalUrls } from "../src/services/distribution/listing/store.js";
import { insertAccount } from "../src/services/identity/accounts/repo.js";

// I-33 (plans/I-27.md §2.4, Q2): Polaris Key's own terms. Unset by default: no step, no row. Set,
// every new account accepts them in FinishStep, on both new-account paths (a provider's first
// sign-in and a new address's email code), recorded as a `_platform` row in the batch that makes
// the account. And a product's terms URL defaults to its listing's `eulaUrl`, with the listing's
// privacy notice linked beside it.

const GATE = "/api/signin/confirm-email";
const TERMS = {
  version: "2026-10",
  termsUrl: "https://key.plrs.im/legal/terms",
  privacyUrl: "https://key.plrs.im/legal/privacy",
};

async function publish(w: CardWorld, value: unknown): Promise<void> {
  await w.db.run(
    `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
     VALUES (?, ?, 1, ?, 'owner')
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    PLATFORM_TERMS_KEY,
    JSON.stringify(value),
    NOW,
  );
}

async function acceptances(
  w: CardWorld,
): Promise<
  Array<{ account_id: string; product: string; version: string; url: string }>
> {
  return w.db.all(
    "SELECT account_id, product, version, url FROM account_terms_acceptances ORDER BY account_id",
  );
}

async function count(w: CardWorld, table: string): Promise<number> {
  return (await w.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table}`,
  ))!.n;
}

function google(subject: string, email: string): ProviderSignIn {
  return {
    identity: {
      issuerKey: "https://accounts.google.com",
      subject,
      kind: "google",
      email,
      emailVerified: true,
      displayName: "Ada Lovelace",
    },
    profile: { name: "Ada Lovelace" },
  };
}

async function arrive(w: CardWorld, input: ProviderSignIn): Promise<Device> {
  const d = new Device(w, "198.51.100.40");
  d.absorb(
    await beginProviderSignIn(
      d.request("GET", "/signin/google/callback"),
      w.env,
      w.db,
      input,
      NOW,
    ),
  );
  return d;
}

describe("the setting's value", () => {
  it("reads only exactly {version, termsUrl, privacyUrl} with https URLs", () => {
    expect(parsePlatformTerms(TERMS)).toEqual(TERMS);
    for (const bad of [
      null,
      "2026-10",
      [TERMS],
      { ...TERMS, version: "" },
      { ...TERMS, version: "two words" },
      { ...TERMS, termsUrl: "http://key.plrs.im/legal/terms" },
      { ...TERMS, privacyUrl: "javascript:alert(1)" },
      { ...TERMS, termsUrl: "https://user:pw@key.plrs.im/terms" },
      { version: TERMS.version, termsUrl: TERMS.termsUrl },
      { ...TERMS, extra: true },
    ])
      expect(parsePlatformTerms(bad)).toBeNull();
    expect(httpsUrl(`https://x.example/${"a".repeat(2100)}`)).toBeNull();
  });

  it("is unset by default, and a malformed row reads as unset", async () => {
    const w = await seededWorld();
    expect(await platformTerms(w.db)).toBeNull();
    await publish(w, { ...TERMS, termsUrl: "http://insecure.example" });
    expect(await platformTerms(w.db)).toBeNull();
    await w.db.run(
      "UPDATE platform_settings SET value_json = 'not json' WHERE key = ?",
      PLATFORM_TERMS_KEY,
    );
    expect(await platformTerms(w.db)).toBeNull();
    await publish(w, TERMS);
    expect(await platformTerms(w.db)).toEqual(TERMS);
  });
});

describe("unset (Q2: dormant)", () => {
  it("a new address's email code creates the account at once, with no terms step and no row", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    const res = await d.signInWithCode("ada@example.com");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("signed_in");
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(await count(w, "accounts")).toBe(1);
    expect(await acceptances(w)).toEqual([]);
  });

  it("a provider's gate shows no Polaris Key terms, and passing it writes no row", async () => {
    const w = await seededWorld();
    const d = await arrive(w, google("g-1", "ada@gmail.com"));
    const view = (await (await d.send("GET", GATE)).json()) as Record<
      string,
      unknown
    >;
    expect(view.platformTerms).toBeNull();
    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      200,
    );
    expect(await count(w, "accounts")).toBe(1);
    expect(await acceptances(w)).toEqual([]);
  });
});

describe("set: the email path finishes through the gate", () => {
  it("a new address answers `finish`, creates nothing until the terms are ticked, then records them", async () => {
    const w = await seededWorld();
    await publish(w, TERMS);
    const d = new Device(w);
    const verified = await d.signInWithCode("ada@example.com");
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({
      status: "finish",
      next: EMAIL_GATE_LANDING,
    });
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(true);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await count(w, "accounts")).toBe(0);

    const view = (await (await d.send("GET", GATE)).json()) as Record<
      string,
      any
    >;
    expect(view).toEqual(
      expect.objectContaining({
        status: "gate",
        provider: "email",
        emailRequired: false,
        platformTerms: TERMS,
        terms: null,
      }),
    );
    expect(view.email.confirmed).toBe("ada@example.com");
    expect(view.profile.suggestions).toEqual([
      { name: "ada", source: "email" },
    ]);
    expect(view.profile.birthdate).toBeNull();

    const unticked = await d.send("POST", GATE, { name: "Ada" });
    expect(unticked.status).toBe(400);
    expect(await unticked.json()).toEqual(
      expect.objectContaining({
        error: "terms_required",
        platformTerms: TERMS,
      }),
    );
    const stale = await d.send("POST", GATE, {
      platformTermsVersion: "2025-01",
    });
    expect(stale.status).toBe(400);
    expect(await count(w, "accounts")).toBe(0);

    const done = await d.send("POST", GATE, {
      name: "Ada",
      platformTermsVersion: TERMS.version,
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(
      expect.objectContaining({ status: "signed_in", next: "/" }),
    );
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    const account = (await w.db.first<{
      id: string;
      display_name: string;
      primary_email: string;
    }>("SELECT id, display_name, primary_email FROM accounts"))!;
    expect(account.display_name).toBe("Ada");
    expect(account.primary_email).toBe("ada@example.com");
    // One sign-in method: the email itself.
    expect(
      await w.db.all(
        "SELECT kind, subject FROM account_links WHERE account_id = ?",
        account.id,
      ),
    ).toEqual([{ kind: "email", subject: "ada@example.com" }]);
    // Polaris Key's terms, recorded under `_platform` with the terms URL; no row for privacy.
    expect(await acceptances(w)).toEqual([
      {
        account_id: account.id,
        product: PLATFORM_TERMS_PRODUCT,
        version: TERMS.version,
        url: TERMS.termsUrl,
      },
    ]);
    expect(JSON.stringify(await acceptances(w))).not.toContain(
      TERMS.privacyUrl,
    );
    // The new session works.
    expect((await d.me()).status).toBe(200);
  });

  it("a magic link opened in the asking browser lands on the gate instead of signing in", async () => {
    const w = await seededWorld();
    await publish(w, TERMS);
    const d = new Device(w);
    await d.send("POST", "/api/signin/email/start", {
      email: "ada@example.com",
    });
    const token = new URL(lastLink(w, "ada@example.com")).searchParams.get(
      "token",
    )!;
    const res = await d.send(
      "POST",
      "/magic/verify",
      { token },
      { form: true },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(true);
    expect(await count(w, "accounts")).toBe(0);
  });

  it("an address an account already knows signs in as before, asking nothing", async () => {
    const w = await seededWorld();
    const first = new Device(w, "203.0.113.50");
    expect((await first.signInWithCode("ada@example.com")).status).toBe(200);
    await publish(w, TERMS);
    const again = new Device(w, "203.0.113.51");
    const res = await again.signInWithCode("ada@example.com");
    expect(((await res.json()) as { status: string }).status).toBe("signed_in");
    expect(await acceptances(w)).toEqual([]);
    // An address another account uses only as its primary email keeps today's refusal.
    await insertAccount(
      w.db,
      {
        primaryEmail: "mara@example.com",
        primaryEmailVerified: true,
        displayName: "Mara",
      },
      NOW,
    );
    const third = new Device(w, "203.0.113.52");
    const refused = await third.signInWithCode("mara@example.com");
    expect(refused.status).toBe(409);
    expect(third.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
  });

  it("a second account taking the address meanwhile ends the gate with email_in_use, writing nothing", async () => {
    const w = await seededWorld();
    await publish(w, TERMS);
    const d = new Device(w, "203.0.113.60");
    await d.signInWithCode("ada@example.com");
    await insertAccount(
      w.db,
      {
        primaryEmail: "ada@example.com",
        primaryEmailVerified: true,
        displayName: "Other",
      },
      NOW,
    );
    const res = await d.send("POST", GATE, {
      platformTermsVersion: TERMS.version,
    });
    expect(res.status).toBe(409);
    expect(await acceptances(w)).toEqual([]);
    expect(await count(w, "accounts")).toBe(1);
  });
});

describe("set: the provider path", () => {
  it("asks for both terms, and records Polaris Key's and the product's with the account", async () => {
    const w = await seededWorld();
    await publish(w, TERMS);
    const input: ProviderSignIn = {
      ...google("g-2", "ada@gmail.com"),
      product: {
        slug: "acme",
        terms: {
          version: "v3",
          url: "https://acme.example/eula",
          privacyUrl: "https://acme.example/privacy",
        },
      },
    };
    const d = await arrive(w, input);
    const view = (await (await d.send("GET", GATE)).json()) as Record<
      string,
      any
    >;
    expect(view.platformTerms).toEqual(TERMS);
    expect(view.terms).toEqual({
      version: "v3",
      url: "https://acme.example/eula",
      privacyUrl: "https://acme.example/privacy",
    });
    expect(view.profile.suggestions).toEqual([
      { name: "Ada Lovelace", source: "google" },
      { name: "ada", source: "email" },
    ]);
    const onlyProduct = await d.send("POST", GATE, {
      choice: "provider",
      termsVersion: "v3",
    });
    expect(onlyProduct.status).toBe(400);
    expect(
      ((await onlyProduct.json()) as { platformTerms?: unknown }).platformTerms,
    ).toEqual(TERMS);
    const ok = await d.send("POST", GATE, {
      choice: "provider",
      termsVersion: "v3",
      platformTermsVersion: TERMS.version,
    });
    expect(ok.status).toBe(200);
    const rows = await acceptances(w);
    expect(rows.map((r) => [r.product, r.version, r.url]).sort()).toEqual([
      [PLATFORM_TERMS_PRODUCT, TERMS.version, TERMS.termsUrl],
      ["acme", "v3", "https://acme.example/eula"],
    ]);
  });

  it("a known account that already confirmed its email signs in without a step", async () => {
    const w = await seededWorld();
    const first = await arrive(w, google("g-3", "ada@gmail.com"));
    expect(
      (await first.send("POST", GATE, { choice: "provider" })).status,
    ).toBe(200);
    await publish(w, TERMS);
    const again = new Device(w, "198.51.100.41");
    const res = again.absorb(
      await beginProviderSignIn(
        again.request("GET", "/signin/google/callback"),
        w.env,
        w.db,
        google("g-3", "ada@gmail.com"),
        NOW,
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(again.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
  });

  it("the version a gate opened with is the one it records, even if the setting changes meanwhile", async () => {
    const w = await seededWorld();
    await publish(w, TERMS);
    const d = await arrive(w, google("g-4", "ada@gmail.com"));
    await publish(w, { ...TERMS, version: "2027-01" });
    const ok = await d.send("POST", GATE, {
      choice: "provider",
      platformTermsVersion: TERMS.version,
    });
    expect(ok.status).toBe(200);
    expect((await acceptances(w)).map((r) => r.version)).toEqual([
      TERMS.version,
    ]);
  });

  it("FinishStep's Initials keeps the provider's picture off the account", async () => {
    const w = await seededWorld();
    const d = await arrive(w, google("g-5", "ada@gmail.com"));
    const bad = await d.send("POST", GATE, {
      choice: "provider",
      picture: "upload",
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await d.send("POST", GATE, {
          choice: "provider",
          picture: "initials",
        })
      ).status,
    ).toBe(200);
    const row = (await w.db.first<{
      avatar_key: string | null;
      details_source_json: string;
    }>("SELECT avatar_key, details_source_json FROM accounts"))!;
    expect(row.avatar_key).toBeNull();
    expect(JSON.parse(row.details_source_json).picture).toEqual({
      source: "initials",
      explicit: true,
    });
  });
});

describe("a product's terms URLs come from its listing", () => {
  async function listing(
    w: CardWorld,
    urls: Record<string, unknown> | null,
  ): Promise<void> {
    await seedProduct(w.db, "dice");
    await w.db.run(
      `INSERT INTO dist_listings (product, default_locale, urls_json, source, created_at, modified_at, modified_by)
       VALUES ('dice', 'en-US', ?, 'admin', ?, ?, 'op')`,
      urls === null ? null : JSON.stringify(urls),
      NOW,
      NOW,
    );
  }

  it("reads eula and privacy, https only", async () => {
    const w = await seededWorld();
    await listing(w, {
      eula: "https://dice.example/eula",
      privacy: "https://dice.example/privacy",
      website: "https://dice.example",
    });
    expect(await listingLegalUrls(w.db, "dice")).toEqual({
      eulaUrl: "https://dice.example/eula",
      privacyUrl: "https://dice.example/privacy",
    });
    const w2 = await seededWorld();
    await listing(w2, { eula: "http://dice.example/eula", privacy: 7 });
    expect(await listingLegalUrls(w2.db, "dice")).toEqual({
      eulaUrl: null,
      privacyUrl: null,
    });
    expect(await listingLegalUrls(w2.db, "nope")).toEqual({
      eulaUrl: null,
      privacyUrl: null,
    });
  });

  it("defaults the terms URL to the listing's eulaUrl and links its privacy notice", async () => {
    const delivery = {
      legalUrls: async () => ({
        eulaUrl: "https://dice.example/eula",
        privacyUrl: "https://dice.example/privacy",
      }),
    };
    expect(await productTerms({ version: "2026-10" }, delivery)).toEqual({
      version: "2026-10",
      url: "https://dice.example/eula",
      privacyUrl: "https://dice.example/privacy",
    });
    // A declared URL wins over the listing's; the privacy notice still comes from the listing.
    expect(
      await productTerms(
        { version: "2026-10", url: "https://dice.example/terms-v2" },
        delivery,
      ),
    ).toEqual({
      version: "2026-10",
      url: "https://dice.example/terms-v2",
      privacyUrl: "https://dice.example/privacy",
    });
    // Nothing to accept: no declaration, a bad version, or no URL anywhere (Distribution off).
    expect(await productTerms(null, delivery)).toBeNull();
    expect(await productTerms({ version: "a b" }, delivery)).toBeNull();
    expect(await productTerms({ version: "2026-10" }, null)).toBeNull();
    expect(
      await productTerms(
        { version: "2026-10" },
        {
          legalUrls: async () => ({ eulaUrl: null, privacyUrl: null }),
        },
      ),
    ).toBeNull();
  });
});
