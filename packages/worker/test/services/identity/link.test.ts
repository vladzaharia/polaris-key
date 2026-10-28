/// <reference types="@cloudflare/workers-types" />

// I-43.2 (WIRE-CONTRACT-V5 §12.11.4): the link offer. Provider tokens are signed by a local key
// (identityProviderHarness); no call leaves the process.
//
//   - the malicious-token case (C5): a Google token whose address the account has not verified is
//     never linked globally; Apple always stays inside the team;
//   - a stolen handle alone does nothing: it needs the device's key and a live step-up;
//   - the step-up is spent by a link and untouched by the offer list;
//   - a conflict moves nothing; every key, proof and token failure is one `invalid_grant`;
//   - the notice goes to both addresses and names the app; Identity off and the gate off are 404.

import { beforeEach, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  appleClaims,
  googleClaims,
  makeProviderHarness,
  type ProviderHarness,
} from "../../identityProviderHarness.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { mkReq, NOW, seedLicenseWithKey } from "../../seed.js";
import { dispatchWith } from "../../../src/dispatch.js";
import {
  serializeServices,
  type ServiceSlug,
} from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";
import { setServices } from "../../../src/core/products/store.js";
import { loadProduct } from "../../../src/core/products.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { sha256B64url } from "../../../src/platform/hash.js";
import {
  exchangeLinkRef,
  type ExchangeLinkRecord,
} from "../../../src/services/identity/passthrough/exchange.js";
import { markFresh } from "../../../src/services/identity/passthrough/fresh.js";
import { signKeyThumbprint } from "../../../src/services/identity/passthrough/nonce.js";
import {
  artefactRef,
  getArtefact,
  putArtefact,
} from "../../../src/core/singleUse.js";
import type { Env } from "../../../src/platform/env.js";

const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const OTHER_DEVICE = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";
const WEB = "1234-web.apps.googleusercontent.com";
const AND = "1234-and.apps.googleusercontent.com";
const TEAM = "ABCDE12345";
const BUNDLE = "com.acme.mac";
const GOOGLE_SUB = "g-sub-1";
const APPLE_SUB = "a-sub-1";
const HANDLE = `lh_${"A".repeat(43)}`;
const HANDLE_2 = `lh_${"B".repeat(43)}`;

let h: ProviderHarness;
let mail: { to: string; text: string }[];

async function setting(key: string, value: unknown): Promise<void> {
  await h.db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, ?, ?, 'manifest', ?, 'test')`,
    SLUG,
    key,
    JSON.stringify(value),
    NOW,
  );
}

async function services(over: { identity?: boolean } = {}): Promise<void> {
  const on: ServiceSlug[] = ["config", "license"];
  if (over.identity !== false) on.push("identity");
  await setServices(
    h.db,
    SLUG,
    serializeServices({ services: servicesOn(...on) }),
    "manifest",
    NOW,
  );
}

interface Dev {
  id: string;
  token: string;
  keys: Awaited<ReturnType<typeof newKeys>>;
}

/** A signed-in device: an activated licence, the email account bound, a registered key. */
async function device(
  id: string,
  key: string,
  email: string,
  keys?: Dev["keys"],
): Promise<Dev & { accountId: string; subject: string }> {
  const product = (await loadProduct(h.env, h.db, SLUG))!;
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": id }),
    h.env,
    h.db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  const token = ((await res.json()) as { token: string }).token;
  const r = await signIn(
    h.db,
    {
      issuerKey: "email",
      subject: email,
      kind: "email",
      email,
      emailVerified: true,
    },
    NOW,
    { unfenced: true, product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error("sign-in failed");
  expect(await setDeviceSubject(h.env, h.db, SLUG, id, r.subject!)).toBe(true);
  const k = keys ?? (await newKeys());
  await upsertDeviceKeys(h.db, SLUG, id, k, NOW);
  return {
    id,
    token,
    keys: k,
    accountId: r.account.id,
    subject: r.subject!,
  };
}

let ada: Dev & { accountId: string; subject: string };

beforeEach(async () => {
  h = await makeProviderHarness();
  h.env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  mail = [];
  h.env.EMAIL = {
    send: async (m: { to: string; text: string }) => {
      mail.push({ to: m.to, text: m.text });
    },
  } as unknown as Env["EMAIL"];
  await services();
  await setting("identity.platformSignIn.google.serverClientId", WEB);
  await setting("identity.platformSignIn.google.clientIds", [AND]);
  await setting("identity.platformSignIn.apple.teamId", TEAM);
  await setting("identity.platformSignIn.apple.bundleIds", [BUNDLE]);
  const { key } = await seedLicenseWithKey(h.db, SLUG);
  ada = await device(DEVICE, key, "ada@gmail.com");
});

const call = (
  method: string,
  d: Pick<Dev, "id" | "token">,
  body?: unknown,
  path = "link",
) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${d.token}`,
        "x-pkey-device": d.id,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    h.env,
    h.db,
    NOW,
  );

const sign = async (priv: CryptoKey, msg: string): Promise<string> =>
  base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)),
    ),
  );

/** A `link` proof: by `priv`, for `device`, over `value` and the hash of `token` (or `-`). */
async function proof(
  priv: CryptoKey,
  value: string,
  o: { token?: string; device?: string; purpose?: string } = {},
): Promise<string> {
  return sign(
    priv,
    [
      "pkey-proof/1",
      o.purpose ?? "link",
      SLUG,
      o.device ?? DEVICE,
      value,
      o.token ? await sha256B64url(o.token) : "-",
    ].join("\n"),
  );
}

/** Store a link handle the way the exchange does, for `d`'s key unless told otherwise. */
async function handleFor(
  rec: Partial<ExchangeLinkRecord>,
  handle = HANDLE,
  keyOf: Dev["keys"] = ada.keys,
): Promise<string> {
  const full: ExchangeLinkRecord = {
    product: SLUG,
    deviceId: DEVICE,
    keyThumbprint: await signKeyThumbprint(keyOf.signKey),
    kind: "google",
    issuerKey: "https://accounts.google.com",
    subject: GOOGLE_SUB,
    tenantScopes: ["", `google-client:${WEB}`],
    email: "mallory@gmail.com",
    emailVerified: true,
    issuedAt: NOW,
    ...rec,
  };
  await putArtefact(
    h.env,
    await exchangeLinkRef(h.env, SLUG, handle),
    JSON.stringify(full),
    600,
  );
  return handle;
}

const postHandle = async (
  d: Dev,
  handle: string,
  o: { signer?: CryptoKey; purpose?: string; device?: string } = {},
) =>
  call("POST", d, {
    linkHandle: handle,
    proof: await proof(o.signer ?? d.keys.priv, handle, {
      ...(o.purpose ? { purpose: o.purpose } : {}),
      device: o.device ?? d.id,
    }),
  });

const live = async (handle: string): Promise<boolean> =>
  (await getArtefact(h.env, await exchangeLinkRef(h.env, SLUG, handle))) !==
  null;
const freshIsLive = async (id = DEVICE): Promise<boolean> =>
  (await getArtefact(h.env, artefactRef("signin-fresh", `${SLUG}:${id}`))) !==
  null;

const links = () =>
  h.db.all<{
    kind: string;
    tenant_scope: string;
    email_verified: number;
    account_id: string;
  }>(
    "SELECT kind, tenant_scope, email_verified, account_id FROM account_links WHERE kind IN ('google','apple')",
  );

/** The nonce route, then a token of the app's own, for the token form. */
async function tokenForm(
  d: Dev,
  mint: (nonce: string) => Promise<string>,
  o: { signer?: CryptoKey } = {},
) {
  const res = await dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/nonce`, {
      method: "POST",
      headers: { "x-pkey-device": d.id, "content-type": "application/json" },
      body: JSON.stringify({
        signKey: d.keys.signKey,
        agreeKey: d.keys.agreeKey,
      }),
    }) as unknown as Request,
    h.env,
    h.db,
    NOW,
  );
  const nonce = ((await res.json()) as { nonce: string }).nonce;
  const token = await mint(nonce);
  return call("POST", d, {
    subjectToken: token,
    nonce,
    signKey: d.keys.signKey,
    agreeKey: d.keys.agreeKey,
    proof: await proof(o.signer ?? d.keys.priv, `${nonce}.${d.keys.signKey}`, {
      token,
      device: d.id,
    }),
  });
}

const google =
  (over: Record<string, unknown> = {}) =>
  (nonce: string) =>
    h.signGoogle(
      googleClaims(nonce, { aud: WEB, azp: AND, sub: GOOGLE_SUB, ...over }),
    );
const apple =
  (over: Record<string, unknown> = {}) =>
  (nonce: string) =>
    h.signApple(appleClaims(nonce, { aud: BUNDLE, sub: APPLE_SUB, ...over }));

const body = async (res: Response) => (await res.json()) as any;

describe("the offer list", () => {
  it("is empty without a live step-up, lists the kinds with one, and does not spend it", async () => {
    let res = await call("GET", ada);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ offer: [] });
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    res = await call("GET", ada);
    expect(await body(res)).toEqual({
      offer: [
        { kind: "google", reach: null },
        { kind: "apple", reach: null },
      ],
    });
    expect(await freshIsLive()).toBe(true);
    expect(await body(await call("GET", ada))).toMatchObject({
      offer: [{}, {}],
    });
  });

  it("leaves out a kind the account already has in the product's scope", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    expect((await postHandle(ada, HANDLE)).status).toBe(200);
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    expect(await body(await call("GET", ada))).toEqual({
      offer: [{ kind: "apple", reach: null }],
    });
  });

  it("needs the device bearer", async () => {
    const res = await call("GET", { id: DEVICE, token: "pkeyt_nope" });
    expect(res.status).toBe(401);
  });
});

describe("the scope of an app-made link (C5)", () => {
  it("a Google token whose address the account has not verified is developer-scoped, never global", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    const res = await tokenForm(
      ada,
      google({ sub: "attacker-sub", email: "mallory@gmail.com" }),
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      linked: { kind: "google", reach: "developer" },
    });
    const rows = await links();
    expect(rows).toEqual([
      expect.objectContaining({
        tenant_scope: `google-client:${WEB}`,
        email_verified: 0,
        account_id: ada.accountId,
      }),
    ]);
    // The same through a handle.
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor(
      { subject: "attacker-2", email: "mallory@gmail.com" },
      HANDLE_2,
    );
    expect(await body(await postHandle(ada, HANDLE_2))).toMatchObject({
      linked: { reach: "developer" },
    });
    expect((await links()).every((l) => l.tenant_scope !== "")).toBe(true);
  });

  it("an address the account has verified, vouched by the provider, is global", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    const res = await tokenForm(ada, google({ email: "Ada@Gmail.com" }));
    expect(await body(res)).toEqual({
      linked: { kind: "google", reach: "global" },
    });
    expect(await links()).toEqual([
      expect.objectContaining({ tenant_scope: "", email_verified: 1 }),
    ]);
  });

  it("an address the provider does not vouch for is developer-scoped even when it matches", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    const res = await tokenForm(
      ada,
      google({ email: "ada@gmail.com", email_verified: false }),
    );
    expect(await body(res)).toMatchObject({ linked: { reach: "developer" } });
  });

  it("an Apple link always stays inside the team", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    const res = await tokenForm(ada, apple({ email: "ada@gmail.com" }));
    expect(await body(res)).toEqual({
      linked: { kind: "apple", reach: "developer" },
    });
    expect(await links()).toEqual([
      expect.objectContaining({ tenant_scope: `apple-team:${TEAM}` }),
    ]);
  });
});

describe("step-up", () => {
  it("is required: without it the answer is 401 and the handle stays live", async () => {
    await handleFor({});
    const res = await postHandle(ada, HANDLE);
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({
      error: { code: "step_up_required" },
    });
    expect(await live(HANDLE)).toBe(true);
    expect(await links()).toEqual([]);
  });

  it("is spent by a link: a second link needs a new sign-in", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({}, HANDLE);
    await handleFor({ subject: "g-2" }, HANDLE_2);
    expect((await postHandle(ada, HANDLE)).status).toBe(200);
    expect(await freshIsLive()).toBe(false);
    expect((await postHandle(ada, HANDLE_2)).status).toBe(401);
    expect(await live(HANDLE_2)).toBe(true);
  });
});

describe("a handle alone does nothing", () => {
  it("a replayed handle is refused", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    expect((await postHandle(ada, HANDLE)).status).toBe(200);
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    const again = await postHandle(ada, HANDLE);
    expect(again.status).toBe(404);
  });

  it("a proof by another key is refused, and nothing is spent", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    const thief = await newKeys();
    const res = await postHandle(ada, HANDLE, { signer: thief.priv });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: { code: "invalid_grant" } });
    expect(await live(HANDLE)).toBe(true);
    expect(await freshIsLive()).toBe(true);
  });

  it("a proof for another purpose or device is refused", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    for (const bad of [{ purpose: "exchange" }, { device: OTHER_DEVICE }]) {
      const res = await postHandle(ada, HANDLE, bad);
      expect(res.status).toBe(400);
      expect(await body(res)).toEqual({ error: { code: "invalid_grant" } });
    }
    expect(await live(HANDLE)).toBe(true);
  });

  it("another device with its own key and its own step-up cannot spend the handle", async () => {
    const { key } = await seedLicenseWithKey(h.db, SLUG, { id: "lic-2" });
    const mallory = await device(
      OTHER_DEVICE,
      key,
      "mallory-account@example.com",
    );
    await markFresh(h.env, SLUG, OTHER_DEVICE, mallory.subject);
    await handleFor({}); // bound to ada's device and key
    const res = await postHandle(mallory, HANDLE);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: { code: "invalid_grant" } });
    expect(await live(HANDLE)).toBe(true);
    expect(await links()).toEqual([]);
  });

  it("a handle recorded for another device is refused even with the right key", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({ deviceId: OTHER_DEVICE });
    const res = await postHandle(ada, HANDLE);
    expect(res.status).toBe(400);
    expect(await live(HANDLE)).toBe(true);
  });

  it("a device with no registered key cannot use a handle", async () => {
    await h.db.run("DELETE FROM device_keys WHERE device_id = ?", DEVICE);
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    const res = await postHandle(ada, HANDLE);
    expect(res.status).toBe(400);
    expect(await live(HANDLE)).toBe(true);
  });

  it("an unknown handle is 404; a malformed body is 400 bad_request", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    expect((await postHandle(ada, HANDLE)).status).toBe(404);
    const res = await call("POST", ada, { linkHandle: "nope", proof: "x" });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: { code: "bad_request" } });
  });
});

describe("the token form", () => {
  it("every proof, key, nonce and token failure is the same refusal", async () => {
    const other = await newKeys();
    const refusals: Response[] = [];
    // A proof failure spends nothing; a token failure spends the step-up, so each is fresh.
    for (const [mint, o] of [
      [google(), { signer: other.priv }],
      [google({ aud: "evil" }), {}],
      [google({ nonce: "another" }), {}],
      [async () => "not.a.jwt", {}],
    ] as const) {
      await markFresh(h.env, SLUG, DEVICE, ada.subject);
      refusals.push(await tokenForm(ada, mint, o));
    }
    const texts: string[] = [];
    for (const r of refusals) {
      expect(r.status).toBe(400);
      texts.push(await r.text());
    }
    for (const t of texts) expect(t).toEqual(texts[0]);
    expect(texts[0]).toContain("invalid_grant");
    expect(await links()).toEqual([]);
  });

  it("a nonce is spent by the first attempt", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    const nonceRes = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/nonce`, {
        method: "POST",
        headers: {
          "x-pkey-device": DEVICE,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          signKey: ada.keys.signKey,
          agreeKey: ada.keys.agreeKey,
        }),
      }) as unknown as Request,
      h.env,
      h.db,
      NOW,
    );
    const nonce = ((await nonceRes.json()) as { nonce: string }).nonce;
    const token = await google()(nonce);
    const req = async () =>
      call("POST", ada, {
        subjectToken: token,
        nonce,
        signKey: ada.keys.signKey,
        agreeKey: ada.keys.agreeKey,
        proof: await proof(ada.keys.priv, `${nonce}.${ada.keys.signKey}`, {
          token,
        }),
      });
    expect((await req()).status).toBe(200);
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    expect((await req()).status).toBe(400);
  });
});

describe("conflict", () => {
  it("a developer-scoped identity of another account is 409 and nothing moves", async () => {
    const other = await signIn(
      h.db,
      {
        issuerKey: "https://accounts.google.com",
        tenantScope: `google-client:${WEB}`,
        subject: GOOGLE_SUB,
        kind: "google",
        email: "other@example.com",
        emailVerified: true,
      },
      NOW,
      {
        unfenced: true,
        product: { slug: SLUG, tenantScopes: [`google-client:${WEB}`] },
      },
    );
    if (other.status !== "signed_in") throw new Error("seed failed");
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    const res = await postHandle(ada, HANDLE);
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: { code: "link_conflict" } });
    expect((await links()).map((r) => r.account_id)).toEqual([
      other.account.id,
    ]);
  });

  it("the global identity of another account is 409 when this account would link it globally", async () => {
    const other = await signIn(
      h.db,
      {
        issuerKey: "https://accounts.google.com",
        subject: GOOGLE_SUB,
        kind: "google",
        email: "other@example.com",
        emailVerified: true,
      },
      NOW,
      { unfenced: true },
    );
    if (other.status !== "signed_in") throw new Error("seed failed");
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({ email: "ada@gmail.com" });
    const res = await postHandle(ada, HANDLE);
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: { code: "link_conflict" } });
    expect(
      (await links()).filter((r) => r.account_id === ada.accountId),
    ).toEqual([]);
  });
});

describe("the notice and the audit", () => {
  it("goes to the primary and the linked address, names the app, and the audit holds no token", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    const res = await tokenForm(ada, google({ email: "mallory@gmail.com" }));
    expect(res.status).toBe(200);
    const to = mail.map((m) => m.to).sort();
    expect(to).toEqual(["ada@gmail.com", "mallory@gmail.com"]);
    expect(mail[0]!.text).toMatch(/was added in .+ as a way to sign in/);
    const audit = await h.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE action = 'identity.link.added'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain("via: app");
    expect(JSON.stringify(audit)).not.toMatch(/mallory|eyJ/);
  });
});

describe("the step-up belongs to one person", () => {
  /** Sign `email` in on the device by a channel that writes no step-up (the device code). */
  async function rebind(email: string): Promise<string> {
    const r = await signIn(
      h.db,
      {
        issuerKey: "email",
        subject: email,
        kind: "email",
        email,
        emailVerified: true,
      },
      NOW,
      { unfenced: true, product: { slug: SLUG } },
    );
    if (r.status !== "signed_in") throw new Error("sign-in failed");
    expect(await setDeviceSubject(h.env, h.db, SLUG, DEVICE, r.subject!)).toBe(
      true,
    );
    return r.subject!;
  }

  it("another person bound later finds no step-up, and the mark is not burned", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await rebind("bob@gmail.com");
    expect(await body(await call("GET", ada))).toEqual({ offer: [] });
    const res = await tokenForm(ada, google({ sub: "a-google" }));
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({
      error: { code: "step_up_required" },
    });
    expect(await freshIsLive()).toBe(true);
    expect(await links()).toEqual([]);
    // The first person back on the device has their step-up again.
    await rebind("ada@gmail.com");
    expect(await body(await call("GET", ada))).toMatchObject({
      offer: [{}, {}],
    });
  });

  it("a handle issued to one person is refused once the device carries another", async () => {
    await handleFor({ boundSubject: ada.subject });
    const bob = await rebind("bob@gmail.com");
    await markFresh(h.env, SLUG, DEVICE, bob);
    const res = await postHandle(ada, HANDLE);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: { code: "invalid_grant" } });
    expect(await live(HANDLE)).toBe(true);
    expect(await freshIsLive()).toBe(true);
    expect(await links()).toEqual([]);
  });

  it("a missing handle or an unverifiable token does not burn the step-up", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    expect((await postHandle(ada, HANDLE)).status).toBe(404);
    expect(await freshIsLive()).toBe(true);
    expect((await tokenForm(ada, google({ aud: "evil" }))).status).toBe(400);
    expect(await freshIsLive()).toBe(true);
  });
});

describe("off", () => {
  it("Identity off answers 404 and writes nothing", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    await services({ identity: false });
    expect((await postHandle(ada, HANDLE)).status).toBe(404);
    expect((await call("GET", ada)).status).toBe(404);
    expect(await links()).toEqual([]);
  });

  it("the launch gate off answers 404 on both methods and spends nothing", async () => {
    await markFresh(h.env, SLUG, DEVICE, ada.subject);
    await handleFor({});
    delete (h.env as unknown as Record<string, unknown>)
      .LAUNCH_IDENTITY_EXCHANGE;
    expect((await postHandle(ada, HANDLE)).status).toBe(404);
    expect((await call("GET", ada)).status).toBe(404);
    expect(await freshIsLive()).toBe(true);
    expect(await live(HANDLE)).toBe(true);
  });
});
