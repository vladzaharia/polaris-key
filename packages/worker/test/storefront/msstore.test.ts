/**
 * A-18f — the Microsoft Store storefront adapter beyond the conformance suite: the hand-written
 * operation list and its pin, the rule table's body checks (never-list values, typed pricing),
 * the write client (two hosts, two tokens, the seller header, what is sent versus what the gate
 * checked, Retry-After, redirects, error codes, SAS uploads), the asset ZIP, the MSI/EXE token,
 * and the provisioning steps' natural keys and typed confirmations against a fake Microsoft.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { admits } from "../../src/core/storefront/gate.js";
import {
  StoreVendorError,
  StoreWriteDenied,
} from "../../src/core/storefront/errors.js";
import {
  MICROSOFT_STORE_COMPILED_GATE as GATE,
  MSSTORE_SPEC_PIN,
  MSSTORE_WRITE_DENIED,
} from "../../src/core/storefront/rules/microsoftStore.js";
import { storefrontAdapter } from "../../src/core/storefront/adapter.js";
import { projectStoreResource } from "../../src/core/storefront/audit.js";
import {
  MsStoreWriteClient,
  certificationReportDates,
  isSasUrl,
  submissionResource,
} from "../../src/services/distribution/connectors/msstore/write.js";
import {
  crc32,
  storedZip,
} from "../../src/services/distribution/connectors/msstore/zip.js";
import {
  changeRollout,
  commitSubmission,
  MsStoreForeignDraft,
  ownsSubmission,
  stageSubmission,
  submitDraft,
  updateSubmission,
  workerStagedDraft,
  type MsStepContext,
} from "../../src/services/distribution/connectors/msstore/provision.js";
import {
  platformMsStoreSellerId,
  platformMsStoreToken,
} from "../../src/services/distribution/connectors/msstore/token.js";
import type { AdminSession } from "../../src/core/adminApi.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(
    join(HERE, "..", "fixtures", "msstore", "operations.json"),
    "utf8",
  ),
) as {
  source: { title: string; version: string; sha256: string };
  pages: Record<string, string>;
  operations: { method: string; path: string; page: string }[];
  reads: string[];
};

const APP = "9NBLGGH4R315";
const SUB = "1152921504621243540";
const C = `/v1.0/my/applications/${APP}`;
const M = `/submission/v1/product/${APP}`;
const concrete = (t: string) => t.replace(/\{id\}/g, "X1");
const reason = (m: string, p: string, body?: unknown, ctx = {}) => {
  try {
    GATE.check(m, p, body, ctx);
    return null;
  } catch (e) {
    if (e instanceof StoreWriteDenied) return e.reason;
    throw e;
  }
};

// ── The operation list ───────────────────────────────────────────────────────────────────────

describe("the hand-written operation list", () => {
  it("is pinned by fetch date and by the SHA-256 of its operations", () => {
    expect(FIXTURE.source).toEqual({ ...MSSTORE_SPEC_PIN });
    expect(MSSTORE_SPEC_PIN.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      createHash("sha256")
        .update(JSON.stringify(FIXTURE.operations))
        .digest("hex"),
    ).toBe(MSSTORE_SPEC_PIN.sha256);
  });

  it("names the Microsoft reference page of every operation", () => {
    for (const o of FIXTURE.operations) {
      expect(FIXTURE.pages[o.page], `${o.method} ${o.path}`).toMatch(
        /^https:\/\/learn\.microsoft\.com\//,
      );
    }
  });

  it("every documented read is admitted, and only reads are", () => {
    for (const r of FIXTURE.reads)
      expect(admits(GATE, "GET", concrete(r)), r).toBe(true);
  });

  it("denies exactly the five DELETEs Microsoft documents, and the add-on writes", () => {
    const deletes = FIXTURE.operations.filter((o) => o.method === "DELETE");
    expect(deletes).toHaveLength(5);
    expect([...MSSTORE_WRITE_DENIED.delete].sort()).toEqual(
      deletes.map((o) => `${o.method} ${o.path}`).sort(),
    );
    for (const d of deletes)
      expect(reason("DELETE", concrete(d.path))).toBe("not_allowed");
    expect(reason("POST", "/v1.0/my/inappproducts", { productId: "x" })).toBe(
      "not_allowed",
    );
  });

  it("refuses a path on neither API, for every method", () => {
    for (const p of [
      "/v1.0/my/users",
      "/v2/apps",
      "/submission/v1/product",
      "/v1.0/my/applications/../x",
    ])
      for (const m of ["GET", "POST", "PUT"])
        expect(reason(m, p, m === "GET" ? undefined : {})).toBe("invalid_path");
  });
});

// ── Body checks ──────────────────────────────────────────────────────────────────────────────

describe("the rule table's bodies", () => {
  const put = (body: unknown, ctx = {}) =>
    reason("PUT", `${C}/submissions/${SUB}`, body, ctx);

  it("admits a listing update and refuses what the never-list holds", () => {
    const listing = {
      listings: {
        "en-us": {
          baseListing: {
            title: "Dice",
            description: "Roll",
            features: ["a"],
            images: [
              {
                fileName: "Images/shot1.png",
                fileStatus: "PendingUpload",
                imageType: "Screenshot",
              },
            ],
          },
        },
      },
      applicationCategory: "Games_ActionAndAdventure",
    };
    expect(put(listing)).toBeNull();
    // PendingDelete: never removes an image or a package.
    const del = structuredClone(listing);
    del.listings["en-us"].baseListing.images[0]!.fileStatus = "PendingDelete";
    expect(put(del)).toBe("value_not_allowed");
    expect(
      put({
        applicationPackages: [
          { fileName: "a.msix", fileStatus: "PendingDelete" },
        ],
      }),
    ).toBe("value_not_allowed");
    expect(
      put({
        applicationPackages: [
          { fileName: "a.msix", fileStatus: "PendingUpload" },
        ],
      }),
    ).toBe("value_not_allowed");
    // Notes for certification carry test-account credentials; trailers are out of v1.
    expect(put({ notesForCertification: "user: a / pass: b" })).toBe(
      "attribute_not_allowed",
    );
    expect(put({ trailers: [] })).toBe("attribute_not_allowed");
    // Read-only fields are not accepted back.
    expect(put({ fileUploadUrl: "https://x.blob.core.windows.net/a" })).toBe(
      "attribute_not_allowed",
    );
    // A listing keyed by something that is not a language, a traversal in a ZIP name.
    expect(put({ listings: { "../x": { baseListing: {} } } })).toBe(
      "attribute_not_allowed",
    );
    const trav = structuredClone(listing);
    trav.listings["en-us"].baseListing.images[0]!.fileName = "../../etc/passwd";
    expect(put(trav)).toBe("value_not_allowed");
    expect(
      put({
        listings: {
          "en-us": { baseListing: { features: Array(21).fill("f") } },
        },
      }),
    ).toBe("invalid_body");
  });

  it("types any pricing change and checks the tier", () => {
    expect(put({ pricing: { priceId: "Tier5" } })).toBe(
      "typed_confirmation_required",
    );
    expect(
      put({ pricing: { priceId: "Tier5" } }, { typedConfirmation: true }),
    ).toBeNull();
    expect(
      put({ pricing: { priceId: "$4.99" } }, { typedConfirmation: true }),
    ).toBe("value_not_allowed");
    expect(
      put(
        { pricing: { marketSpecificPricings: { US: "Tier3", de: "Tier3" } } },
        { typedConfirmation: true },
      ),
    ).toBe("attribute_not_allowed");
    const patch = (b: unknown, ctx = {}) =>
      reason("PATCH", `${M}/metadata`, b, ctx);
    expect(patch({ availability: { pricing: "PAID" } })).toBe(
      "typed_confirmation_required",
    );
    expect(patch({ availability: { freeTrial: "FREE_TRIAL" } })).toBe(
      "typed_confirmation_required",
    );
    expect(patch({ availability: { markets: ["US", "DE"] } })).toBeNull();
    expect(
      reason("PUT", `${M}/metadata`, { availability: { markets: ["US"] } }),
    ).toBe("typed_confirmation_required");
    expect(
      patch({
        properties: {
          category: "Games",
          privacyPolicyUrl: "https://ex.test/p",
        },
      }),
    ).toBeNull();
    expect(
      patch({ properties: { privacyPolicyUrl: "javascript:alert(1)" } }),
    ).toBe("value_not_allowed");
    expect(patch({ listingsToRemove: ["en-us"] })).toBe(
      "attribute_not_allowed",
    );
    expect(patch({ properties: { certificationNotes: "pw" } })).toBe(
      "attribute_not_allowed",
    );
  });

  it("packages are https URLs; commits and submit take no body; the rollout is 0–100", () => {
    const pkg = {
      packageUrl: "https://dl.plrs.im/dice/1.0/setup.exe",
      packageType: "exe",
      architectures: ["X64"],
      languages: ["en-us"],
    };
    expect(reason("PUT", `${M}/packages`, { packages: [pkg] })).toBeNull();
    expect(
      reason("PUT", `${M}/packages`, {
        packages: [{ ...pkg, packageUrl: "http://x.test/a.exe" }],
      }),
    ).toBe("value_not_allowed");
    expect(
      reason("PUT", `${M}/packages`, {
        packages: [{ ...pkg, packageUrl: "https://u:p@x.test/a.exe" }],
      }),
    ).toBe("value_not_allowed");
    expect(reason("POST", `${M}/packages/commit`, {})).toBeNull();
    expect(
      reason("POST", `${M}/submit`, { x: 1 }, { typedConfirmation: true }),
    ).toBe("attribute_not_allowed");
    const roll = `${C}/submissions/${SUB}/updatepackagerolloutpercentage`;
    expect(reason("POST", roll, { percentage: 25 })).toBeNull();
    expect(reason("POST", roll, { percentage: 101 })).toBe("value_not_allowed");
    expect(
      reason("POST", `${C}/submissions/${SUB}/finalizepackagerollout`, {}),
    ).toBe("typed_confirmation_required");
    expect(
      reason("POST", `${C}/submissions/${SUB}/haltpackagerollout`, {}),
    ).toBeNull();
    // Replacing a language's asset set is an update with a plain confirm (S-15 §8.4).
    expect(
      reason("PUT", `${M}/listings/assets/commit`, {
        listingAssets: {
          language: "en-us",
          screenshots: [
            { id: "a", assetUrl: "https://x.blob.core.windows.net/s" },
          ],
        },
      }),
    ).toBeNull();
  });
});

// ── Audit redaction ──────────────────────────────────────────────────────────────────────────

describe("redaction", () => {
  it("drops the SAS upload URL and the certification report URLs before the projection", () => {
    const raw = {
      id: SUB,
      status: "CertificationFailed",
      fileUploadUrl: "https://x.blob.core.windows.net/a?sig=SECRET",
      statusDetails: {
        certificationReports: [
          {
            date: "2026-10-04T00:00:00Z",
            reportUrl: "https://r.test/?token=SECRET",
          },
        ],
      },
      pricing: { priceId: "Tier2" },
    };
    const r = submissionResource(raw)!;
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(r.attributes).toMatchObject({
      status: "CertificationFailed",
      priceId: "Tier2",
    });
    expect(
      JSON.stringify(projectStoreResource("microsoft-store", r)),
    ).not.toContain("SECRET");
    expect(certificationReportDates(raw)).toEqual(["2026-10-04T00:00:00Z"]);
  });
});

// ── The write client ─────────────────────────────────────────────────────────────────────────

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function client(
  respond: (url: URL, init: RequestInit) => Response = () => new Response("{}"),
  more: Partial<ConstructorParameters<typeof MsStoreWriteClient>[0]> = {},
) {
  const sent: Sent[] = [];
  const tokens = { classic: 0, msi: 0 };
  const c = new MsStoreWriteClient({
    classicToken: async () => (tokens.classic++, "classic-token"),
    msiToken: async () => (tokens.msi++, "msi-token"),
    sellerId: "12345678",
    sleep: async () => {},
    fetchImpl: async (u, init = {}) => {
      sent.push({
        url: u,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? init.body : null,
      });
      return respond(new URL(u), init);
    },
    ...more,
  });
  return { c, sent, tokens };
}

describe("MsStoreWriteClient", () => {
  it("routes each API to its host with its own token; MSI/EXE carries the seller id", async () => {
    const { c, sent, tokens } = client();
    await c.request("GET", C);
    await c.request("PATCH", `${M}/metadata`, {
      properties: { category: "Games" },
    });
    expect(sent[0]!.url).toBe(`https://manage.devcenter.microsoft.com${C}`);
    expect(sent[0]!.headers.authorization).toBe("Bearer classic-token");
    expect(sent[0]!.headers["x-seller-account-id"]).toBeUndefined();
    expect(sent[1]!.url).toBe(`https://api.store.microsoft.com${M}/metadata`);
    expect(sent[1]!.headers.authorization).toBe("Bearer msi-token");
    expect(sent[1]!.headers["x-seller-account-id"]).toBe("12345678");
    expect(JSON.parse(sent[1]!.body!)).toEqual({
      properties: { category: "Games" },
    });
    expect(tokens).toEqual({ classic: 1, msi: 1 });
  });

  it("sends what the gate checked: no body for a commit, the percentage as a query", async () => {
    const { c, sent } = client();
    await c.request("POST", `${C}/submissions/${SUB}/commit`, undefined, {
      typedConfirmation: true,
    });
    await c.request(
      "POST",
      `${C}/submissions/${SUB}/updatepackagerolloutpercentage`,
      { percentage: 25 },
    );
    expect(sent[0]!.body).toBeNull();
    expect(sent[1]!.body).toBeNull();
    expect(new URL(sent[1]!.url).searchParams.get("percentage")).toBe("25");
  });

  it("refuses before any token: a DELETE, an untyped commit, MSI/EXE without a seller id", async () => {
    const { c, sent, tokens } = client();
    await expect(
      c.request("DELETE", `${C}/submissions/${SUB}`),
    ).rejects.toBeInstanceOf(StoreWriteDenied);
    await expect(
      c.request("POST", `${C}/submissions/${SUB}/commit`),
    ).rejects.toThrow(/typed_confirmation_required/);
    expect(tokens).toEqual({ classic: 0, msi: 0 });
    expect(sent).toEqual([]);
    const noSeller = client(undefined, { sellerId: null });
    await expect(
      noSeller.c.request("GET", `${M}/status`),
    ).rejects.toBeInstanceOf(StoreVendorError);
    expect(noSeller.tokens.msi).toBe(0);
  });

  it("honours Retry-After, then reports the stop to the budget", async () => {
    const waits: number[] = [];
    const stops: (number | undefined)[] = [];
    const { c, sent } = client(
      () => new Response("", { status: 429, headers: { "Retry-After": "7" } }),
      {
        sleep: async (ms) => void waits.push(ms),
        maxRetries: 1,
        onRateStop: async (s) => void stops.push(s),
      },
    );
    await expect(c.request("GET", `${M}/status`)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    expect(sent).toHaveLength(2);
    expect(waits).toContain(7000);
    expect(stops).toEqual([7]);
  });

  it("self-throttles between sends", async () => {
    let t = 1000;
    const waits: number[] = [];
    const { c } = client(undefined, {
      clock: () => t,
      sleep: async (ms) => void waits.push(ms),
      minIntervalMs: 500,
    });
    await c.request("GET", C);
    t += 100;
    await c.request("GET", C);
    expect(waits).toEqual([400]);
  });

  it("refuses a redirect, keeps only an enum-like error code, and maps isSuccess: false", async () => {
    const redirect = client(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test" },
        }),
    );
    await expect(redirect.c.request("GET", C)).rejects.toMatchObject({
      status: 302,
    });
    expect(redirect.sent).toHaveLength(1);
    const bad = client(
      () =>
        new Response(
          JSON.stringify({ code: "InvalidState", message: "secret detail" }),
          { status: 409 },
        ),
    );
    const e = await bad.c.request("GET", C).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 409, code: "InvalidState" });
    expect(String((e as Error).message)).not.toContain("secret detail");
    const notOk = client(
      () =>
        new Response(
          JSON.stringify({
            isSuccess: false,
            errors: [{ code: "ActiveSubmission", message: "m" }],
          }),
        ),
    );
    await expect(
      notOk.c.request("POST", `${M}/submit`, undefined, {
        typedConfirmation: true,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "ActiveSubmission",
    });
  });

  it("uploads to an Azure Blob SAS URL only, with no bearer token", async () => {
    const { c, sent } = client(() => new Response(null, { status: 201 }));
    await c.uploadToSas(
      "https://productingestionbin1.blob.core.windows.net/ingestion/a?sig=s",
      new Uint8Array([1]),
      "application/zip",
    );
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(sent[0]!.headers["x-ms-blob-type"]).toBe("BlockBlob");
    for (const bad of [
      "https://evil.test/a",
      "http://a.blob.core.windows.net/x",
      "https://a.blob.core.windows.net.evil.test/x",
      "https://u:p@a.blob.core.windows.net/x",
    ]) {
      expect(isSasUrl(bad), bad).toBe(false);
      await expect(
        c.uploadToSas(bad, new Uint8Array([1]), "image/png"),
      ).rejects.toThrow();
    }
  });
});

describe("the asset ZIP", () => {
  it("writes a stored archive with correct CRCs and refuses unsafe names", () => {
    const bytes = new TextEncoder().encode("hello");
    const zip = storedZip([{ name: "Images/a.png", bytes }]);
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(14, true)).toBe(crc32(bytes));
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(v.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    for (const name of ["../a.png", "/abs.png", "a/../../b", "C:\\x"])
      expect(() => storedZip([{ name, bytes }]), name).toThrow();
    expect(() =>
      storedZip([
        { name: "a", bytes },
        { name: "a", bytes },
      ]),
    ).toThrow(/duplicate/);
  });
});

// ── The MSI/EXE token ────────────────────────────────────────────────────────────────────────

describe("the MSI/EXE token", () => {
  it("is a v2.0 scope token in its own cache slot; the classic token is unchanged", async () => {
    const env = makeEnv(new KvMock(), []);
    (env as unknown as Record<string, unknown>).PLATFORM_MS_PARTNER_CENTER =
      JSON.stringify({
        tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
        clientId: "c",
        clientSecret: "s",
        sellerId: "12345678",
      });
    const db = makeTestDb();
    const posts: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      posts.push({ url, body });
      return new Response(
        JSON.stringify({
          access_token: body.has("scope") ? "msi" : "classic",
          expires_in: 3600,
        }),
      );
    };
    const team = {
      team: { sub: "u1", name: "Ada", email: "ada@example.test" },
    };
    expect(
      await platformMsStoreToken(
        env,
        db,
        team,
        "ms-store:provision",
        NOW,
        fetchImpl,
        "msi",
      ),
    ).toBe("msi");
    expect(
      await platformMsStoreToken(
        env,
        db,
        team,
        "ms-store:provision",
        NOW,
        fetchImpl,
      ),
    ).toBe("classic");
    // Cached separately: neither is minted again, nor served for the other.
    expect(
      await platformMsStoreToken(
        env,
        db,
        team,
        "ms-store:provision",
        NOW,
        fetchImpl,
        "msi",
      ),
    ).toBe("msi");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.url).toMatch(/\/oauth2\/v2\.0\/token$/);
    expect(posts[0]!.body.get("scope")).toBe(
      "https://api.store.microsoft.com/.default",
    );
    expect(posts[0]!.body.has("resource")).toBe(false);
    expect(posts[1]!.url).toMatch(/\/oauth2\/token$/);
    expect(posts[1]!.body.get("resource")).toBe(
      "https://manage.devcenter.microsoft.com",
    );
    expect(await platformMsStoreSellerId(env, db)).toBe("12345678");
  });
});

// ── Provisioning steps against a fake Microsoft ──────────────────────────────────────────────

const SESSION: AdminSession = {
  sub: "u1",
  name: "Ada",
  email: "ada@example.test",
  groups: ["admins"],
  csrf: "c",
  exp: NOW + 3600,
};
const SLUG = "dice";

class FakeMicrosoft {
  pending: string | null = null;
  status: Record<string, string> = {};
  rollout = {
    isPackageRollout: true,
    packageRolloutPercentage: 10,
    packageRolloutStatus: "PackageRolloutInProgress",
  };
  ongoing = "";
  writes: string[] = [];
  next = 1152921504621243540n;

  respond = (url: URL, init: RequestInit): Response => {
    const m = init.method ?? "GET";
    const p = url.pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (m !== "GET") this.writes.push(`${m} ${p}`);
    if (m === "GET" && p === C)
      return json({
        id: APP,
        primaryName: "Dice Roller",
        ...(this.pending
          ? { pendingApplicationSubmission: { id: this.pending } }
          : {}),
      });
    if (m === "POST" && p === `${C}/submissions`) {
      const id = String(this.next++);
      this.pending = id;
      this.status[id] = "PendingCommit";
      return json({
        id,
        status: "PendingCommit",
        fileUploadUrl: "https://x.blob.core.windows.net/a?sig=s",
      });
    }
    const sub = p.match(new RegExp(`^${C}/submissions/(\\d+)(/.*)?$`));
    if (sub) {
      const [, id, rest = ""] = sub;
      if (m === "GET" && rest === "")
        return json({ id, status: this.status[id!] ?? "Published" });
      if (m === "PUT" && rest === "")
        return json({ id, status: this.status[id!] });
      if (m === "POST" && rest === "/commit") {
        this.status[id!] = "CommitStarted";
        return json({ status: "CommitStarted" });
      }
      if (m === "GET" && rest === "/packagerollout") return json(this.rollout);
      if (m === "POST" && rest === "/finalizepackagerollout") {
        this.rollout = {
          ...this.rollout,
          packageRolloutPercentage: 100,
          packageRolloutStatus: "PackageRolloutComplete",
        };
        return json(this.rollout);
      }
    }
    if (m === "GET" && p === `${M}/status`)
      return json({
        isSuccess: true,
        responseData: { ongoingSubmissionId: this.ongoing },
      });
    if (m === "POST" && p === `${M}/submit`) {
      this.ongoing = "S-1";
      return json({ isSuccess: true, responseData: { submissionId: "S-1" } });
    }
    return new Response("", { status: 404 });
  };
}

async function steps() {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  const fake = new FakeMicrosoft();
  const { c } = client(fake.respond);
  const ctx: MsStepContext = {
    db,
    client: c,
    session: SESSION,
    product: SLUG,
    appId: APP,
    now: NOW,
  };
  return { db, fake, ctx };
}

const KEY = (n: number) => `${n}f8e2d3c-1111-4222-8333-944455556666`;

describe("provisioning steps", () => {
  it("creates the pending submission once, and reuses it only because the ledger made it", async () => {
    const { db, fake, ctx } = await steps();
    const first = await stageSubmission(ctx, KEY(1));
    expect(first).toMatchObject({
      outcome: "written",
      resultIds: { submission: fake.pending },
    });
    expect(await ownsSubmission(db, SLUG, APP, fake.pending!)).toBe(true);
    // Another intent finds the ledger's own pending submission: no second POST.
    expect(await stageSubmission(ctx, KEY(2))).toMatchObject({
      outcome: "existing",
    });
    expect(fake.writes.filter((w) => w.endsWith("/submissions"))).toHaveLength(
      1,
    );
    expect(await workerStagedDraft(db, SLUG, APP)).toBe(fake.pending);
  });

  it("never adopts, changes or commits a pending submission it did not create", async () => {
    const { fake, ctx } = await steps();
    fake.pending = "1152921504621200000";
    const e = await stageSubmission(ctx, KEY(3)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MsStoreForeignDraft);
    expect((e as MsStoreForeignDraft).deepLink).toBe(
      `https://partner.microsoft.com/dashboard/products/${APP}/submissions/1152921504621200000`,
    );
    await expect(
      updateSubmission(ctx, KEY(4), fake.pending, { visibility: "Public" }),
    ).rejects.toBeInstanceOf(MsStoreForeignDraft);
    await expect(
      commitSubmission(ctx, KEY(5), fake.pending, "Dice Roller"),
    ).rejects.toBeInstanceOf(MsStoreForeignDraft);
    expect(fake.writes).toEqual([]);
  });

  it("commits only when the operator typed the app's primary name; a pricing update likewise", async () => {
    const { db, fake, ctx } = await steps();
    await stageSubmission(ctx, KEY(6));
    const sid = fake.pending!;
    expect(
      await commitSubmission(ctx, KEY(7), sid, "dice roller"),
    ).toMatchObject({
      outcome: "refused",
      refusal: { reason: "confirmation_mismatch" },
    });
    expect(
      await updateSubmission(ctx, KEY(8), sid, {
        pricing: { priceId: "Tier2" },
      }),
    ).toMatchObject({
      outcome: "refused",
      refusal: { reason: "confirmation_required" },
    });
    expect(
      fake.writes.some((w) => w.endsWith("/commit") || w.startsWith("PUT")),
    ).toBe(false);
    expect(
      await updateSubmission(
        ctx,
        KEY(9),
        sid,
        { pricing: { priceId: "Tier2" } },
        "Dice Roller",
      ),
    ).toMatchObject({
      outcome: "written",
    });
    expect(
      await commitSubmission(ctx, KEY(10), sid, " Dice Roller "),
    ).toMatchObject({ outcome: "written" });
    // Committed: no staged draft left for CI to protect, and a second commit sends nothing.
    expect(await workerStagedDraft(db, SLUG, APP)).toBeNull();
    expect(
      await commitSubmission(ctx, KEY(11), sid, "Dice Roller"),
    ).toMatchObject({ outcome: "existing" });
    expect(fake.writes.filter((w) => w.endsWith("/commit"))).toHaveLength(1);
  });

  it("finalizes a rollout only typed, and submits an MSI/EXE draft once", async () => {
    const { fake, ctx } = await steps();
    expect(
      await changeRollout(ctx, KEY(12), SUB, {
        kind: "finalize",
        confirm: "x",
      }),
    ).toMatchObject({ outcome: "refused" });
    expect(
      await changeRollout(ctx, KEY(13), SUB, {
        kind: "finalize",
        confirm: "Dice Roller",
      }),
    ).toMatchObject({
      outcome: "written",
    });
    expect(fake.rollout.packageRolloutStatus).toBe("PackageRolloutComplete");
    expect(await submitDraft(ctx, KEY(14), "Dice Roller")).toMatchObject({
      outcome: "written",
      resultIds: { submission: "S-1" },
    });
    expect(await submitDraft(ctx, KEY(15), "Dice Roller")).toMatchObject({
      outcome: "existing",
    });
    expect(fake.writes.filter((w) => w.endsWith("/submit"))).toHaveLength(1);
  });

  it("is registered with the A-16 credential and Microsoft's primary name as the phrase", () => {
    const a = storefrontAdapter("microsoft-store")!;
    expect(a.credential).toBe("microsoft-store.partner-center");
    expect(a.outletKinds).toEqual(["ms-store"]);
    expect(a.capabilities.rate.kind).toBe("retry-after");
  });
});
