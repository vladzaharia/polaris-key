/// <reference types="@cloudflare/workers-types" />

/**
 * I-49.7 (WIRE-CONTRACT-V5 §12.11.8): the restore grant of `POST /<p>/identity/token`. Security
 * properties, each with a negative control:
 *
 *   - every refusal from the shape to the account check is ONE byte-identical `400 invalid_grant`;
 *   - a wrong secret, a bad proof and another product's key consume nothing; the right key is used
 *     once and a replay finds nothing;
 *   - the gate is checked first: with the launch gate, the setting or Identity off nothing is read
 *     or consumed;
 *   - `confirm` names no provider and carries no address; `choice/complete` finishes it, and sends
 *     the notice and marks the origin, even when the gate has gone off meanwhile;
 *   - a restore never takes over a device row of another person; it never writes the step-up;
 *   - the audit row names the device and never the secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import * as lifecycle from "../../../src/core/devices/lifecycle.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { sha256B64url } from "../../../src/platform/hash.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { NOW, seedProduct } from "../../seed.js";
import { artefactRef, getArtefact } from "../../../src/core/singleUse.js";
import { loadProductPublic } from "../../../src/core/products.js";
import { accountForSubject } from "../../../src/core/accounts/accountSubjects.js";
import { getDevice } from "../../../src/core/devices/store.js";
import {
  getDeviceKeys,
  upsertDeviceKeys,
} from "../../../src/core/devices/keys.js";
import { askedScopeHash } from "../../../src/services/identity/passthrough/routes.js";
import { suppressEmail } from "../../../src/core/notify/emailDelivery.js";
import { mintRestoreKey } from "../../../src/services/identity/restore/store.js";
import { RESTORE_GRANT_TYPE } from "@polaris-key/protocol/identity";
import {
  A,
  B,
  BASE,
  C,
  SLUG,
  bindTo,
  enable,
  ensureBoundDevice,
  setRestoreGate,
  world,
  type World,
} from "../connect/connectFixture.js";

vi.mock("../../../src/core/devices/lifecycle.js", async (orig) => {
  const m =
    await orig<typeof import("../../../src/core/devices/lifecycle.js")>();
  return { ...m, notifyDeviceChange: vi.fn(m.notifyDeviceChange) };
});

const NEW = "NEWDEVICE0000000000000000000001X";
const OTHER_SLUG = "other";

interface Mail {
  to: string;
  subject: string;
  text: string;
}
let w: World;
let mail: Mail[];

beforeEach(async () => {
  w = await world();
  mail = [];
  (w.env as unknown as { EMAIL: unknown }).EMAIL = {
    send: async (m: Mail) => {
      mail.push({ to: m.to, subject: m.subject, text: m.text });
    },
  };
  // Identity alone: no licence choice is due, so a redeem binds a licence-less device.
  await enable(w.db, ["identity"]);
});
afterEach(() => vi.restoreAllMocks());

const gate = (v: string | undefined) => setRestoreGate(w, v);

const accountId = async (): Promise<string> =>
  (await accountForSubject(w.db, SLUG, w.subject))!;

async function seedConsent(): Promise<void> {
  const pub = (await loadProductPublic(w.db, SLUG))!;
  await w.db.run(
    `INSERT INTO account_product_grants
       (account_id, product, claims_json, granted_at, modified_at, scope_hash)
     VALUES (?, ?, '["profile","email"]', ?, ?, ?)
     ON CONFLICT (account_id, product) DO UPDATE SET scope_hash = excluded.scope_hash`,
    await accountId(),
    SLUG,
    NOW,
    NOW,
    await askedScopeHash(pub),
  );
}

interface Keys {
  signKey: string;
  agreeKey: string;
  priv: CryptoKey;
}

async function enrol(
  device = A,
): Promise<{ restoreId: string; secret: string }> {
  return (await mintRestoreKey(w.env, w.db, {
    product: SLUG,
    deviceId: device,
    subject: w.subject,
    boundSubject: w.subject,
    now: NOW,
  }))!;
}

async function sign(
  keys: Keys,
  o: { id: string; secret: string; device?: string; product?: string },
): Promise<string> {
  const msg = [
    "pkey-proof/1",
    "restore",
    o.product ?? SLUG,
    o.device ?? NEW,
    `${o.id}.${keys.signKey}`,
    await sha256B64url(o.secret),
  ].join("\n");
  return base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        keys.priv,
        new TextEncoder().encode(msg),
      ),
    ),
  );
}

interface Attempt {
  id?: string;
  secret?: string;
  keys?: Keys;
  /** The key the proof is signed with (default `keys`). */
  signer?: Keys;
  device?: string;
  slug?: string;
  clientId?: string;
  proof?: string;
  drop?: string[];
  now?: number;
  choice?: string;
}

async function redeem(
  key: { restoreId: string; secret: string },
  o: Attempt = {},
): Promise<{
  res: Response;
  text: string;
  body: Record<string, any>;
  keys: Keys;
}> {
  const keys = o.keys ?? (await newKeys());
  const id = o.id ?? key.restoreId;
  const secret = o.secret ?? key.secret;
  const device = o.device ?? NEW;
  const slug = o.slug ?? SLUG;
  const proof =
    o.proof ??
    (await sign(o.signer ?? keys, { id, secret, device, product: slug }));
  const fields: Record<string, string> = {
    grant_type: RESTORE_GRANT_TYPE,
    client_id: o.clientId ?? slug,
    restore_id: id,
    restore_secret: secret,
    device_key: keys.signKey,
    agree_key: keys.agreeKey,
    proof,
    ...(o.choice ? { license_choice: o.choice } : {}),
  };
  for (const d of o.drop ?? []) delete fields[d];
  const res = await dispatchWith(
    new Request(`${BASE}/${slug}/identity/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-pkey-device": device,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    w.env,
    w.db,
    o.now ?? NOW,
  );
  const text = await res.text();
  return {
    res,
    text,
    body: text.startsWith("{") ? JSON.parse(text) : {},
    keys,
  };
}

const keyRows = async (product = SLUG) =>
  (await w.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identity_restore_keys WHERE product = ?",
    product,
  ))!.n;

const events = () =>
  vi.mocked(lifecycle.notifyDeviceChange).mock.calls.map((c) => c[1]);

/** `choice/complete` on a restore's pending grant, then what every finished restore leaves. */
async function complete(grant: string, extra: Record<string, unknown>) {
  const res = await dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/choice/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pkey-device": NEW },
      body: JSON.stringify({ grant, ...extra }),
    }),
    w.env,
    w.db,
    NOW,
  );
  const body = (await res.json()) as Record<string, any>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect((await getDevice(w.db, SLUG, NEW))?.subject).toBe(w.subject);
  expect(
    await w.db.first(
      "SELECT 1 FROM identity_restore_origins WHERE device_id = ?",
      NEW,
    ),
  ).not.toBeNull();
  expect(events()).toContainEqual(
    expect.objectContaining({ kind: "keys", deviceId: NEW, via: "restore" }),
  );
  expect(mail).toHaveLength(1);
  expect(mail[0]!.subject).toContain("from your backup");
  return body;
}

describe("a successful restore", () => {
  it("signs a new device in: a device token, keys registered via restore, origin marked, the key used up, audited without the secret", async () => {
    await seedConsent();
    const key = await enrol();
    const r = await redeem(key);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.body.issued_token_type).toBe("urn:polaris-key:token-type:device");
    expect(r.body.token_type).toBe("Bearer");
    expect(typeof r.body.access_token).toBe("string");
    expect(r.body.subject).toBe(w.subject);
    expect(r.body.license).toBeNull();
    // The device is bound to the subject, with its keys.
    expect((await getDevice(w.db, SLUG, NEW))?.subject).toBe(w.subject);
    const held = await getDeviceKeys(w.db, SLUG, NEW);
    expect(held?.sign_key).toBe(r.keys.signKey);
    expect(held?.agree_key).toBe(r.keys.agreeKey);
    expect(events()).toContainEqual(
      expect.objectContaining({ kind: "keys", deviceId: NEW, via: "restore" }),
    );
    // Used once; the origin is marked.
    expect(await keyRows()).toBe(0);
    const origin = await w.db.first<{ subject: string }>(
      "SELECT subject FROM identity_restore_origins WHERE product = ? AND device_id = ?",
      SLUG,
      NEW,
    );
    expect(origin?.subject).toBe(w.subject);
    // The audit row names the device and never the secret or the id.
    const audit = await w.db.all<{
      action: string;
      summary: string;
      target_id: string;
    }>(
      "SELECT action, summary, target_id FROM audit WHERE action = 'signin.restore'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target_id).toBe(NEW);
    expect(JSON.stringify(audit)).not.toContain(key.secret);
    expect(JSON.stringify(audit)).not.toContain(key.restoreId);
    // It is not a same-device sign-in: no step-up mark, so no link offer.
    expect(
      await getArtefact(w.env, artefactRef("signin-fresh", `${SLUG}:${NEW}`)),
    ).toBeNull();
  });

  it("the restored device, which holds no licence, enrols a key of its own", async () => {
    await seedConsent();
    const r = await redeem(await enrol());
    expect(r.res.status).toBe(200);
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/restore`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${r.body.access_token}`,
          "x-pkey-device": NEW,
        },
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(201);
    expect(await keyRows()).toBe(1);
  });

  it("sends the security notice to the primary address, offering Remove this device and Sign out everywhere", async () => {
    await seedConsent();
    const r = await redeem(await enrol());
    expect(r.res.status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe("ada@example.com");
    expect(mail[0]!.subject).toContain("signed in on");
    expect(mail[0]!.subject).toContain("from your backup");
    expect(mail[0]!.text).toContain(
      `Remove this device: ${BASE}/#/account/devices`,
    );
    expect(mail[0]!.text).toContain(`${BASE}/#/account/sessions`);
    expect(mail[0]!.text).toContain("every verified email on the account");
    expect(mail[0]!.text).not.toMatch(/rs_|rk_/);
  });

  it("the restore notice names the app by its checked name", async () => {
    // DNI: the notice goes to an inbox before anyone has judged the stored product name.
    await seedConsent();
    await w.db.run(
      "UPDATE products SET name = ? WHERE slug = ?",
      "Steam",
      SLUG,
    );
    const r = await redeem(await enrol());
    expect(r.res.status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).not.toContain("Steam");
    expect(mail[0]!.text).not.toContain("Steam");
    expect(mail[0]!.subject).toContain(`${SLUG} signed in on`);
  });

  it("a replay of the same key finds nothing", async () => {
    await seedConsent();
    const key = await enrol();
    expect((await redeem(key)).res.status).toBe(200);
    const again = await redeem(key, { device: B });
    expect(again.res.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("a card choice and a device name are accepted", async () => {
    await seedConsent();
    const r = await redeem(await enrol(), { choice: "card" });
    expect(r.res.status).toBe(200);
  });
});

describe("one refusal, whichever check failed", () => {
  it("is a byte-identical 400 invalid_grant for the shape, the proof, the held key, the key and the account", async () => {
    await seedConsent();
    const key = await enrol();
    const good = await newKeys();
    const other = await newKeys();
    // A device that already holds a signing key presents another one.
    await enable(w.db, ["identity"]);
    const attempts: [string, Attempt][] = [
      ["wrong secret", { secret: `rs_${"A".repeat(43)}` }],
      ["unknown id", { id: `rk_${"B".repeat(22)}` }],
      ["malformed id", { id: "nope" }],
      ["malformed secret", { secret: "nope" }],
      ["missing agree key", { drop: ["agree_key"] }],
      ["missing proof", { drop: ["proof"] }],
      ["missing secret", { drop: ["restore_secret"] }],
      ["bad proof bytes", { proof: "A".repeat(86) }],
      ["proof by another key", { keys: good, signer: other }],
      [
        "proof for another device",
        {
          proof: await sign(good, {
            id: key.restoreId,
            secret: key.secret,
            device: B,
          }),
          keys: good,
        },
      ],
      ["client_id of another product", { clientId: OTHER_SLUG }],
      ["bad license_choice", { choice: "both" }],
      ["bad device id", { device: "a b" }],
    ];
    const texts = new Set<string>();
    let i = 0;
    for (const [name, a] of attempts) {
      // A fresh minute each time, so the limits (tested below) never speak.
      const r = await redeem(key, { now: NOW + 120 * ++i, ...a });
      expect(r.res.status, name).toBe(400);
      expect(r.body.error, name).toBe("invalid_grant");
      texts.add(r.text);
    }
    expect([...texts]).toEqual([JSON.stringify({ error: "invalid_grant" })]);
    // Nothing above spent the key: the right redeem still works.
    expect(await keyRows()).toBe(1);
    expect((await redeem(key)).res.status).toBe(200);
  });

  it("refuses when the device holds a different signing key, and consumes nothing", async () => {
    await seedConsent();
    const key = await enrol();
    // NEW registers keys of its own first (it is a known device with a held key).
    const held = await newKeys();
    await upsertDeviceKeys(w.db, SLUG, NEW, held, NOW);
    const r = await redeem(key);
    expect(r.res.status).toBe(400);
    expect(r.text).toBe(JSON.stringify({ error: "invalid_grant" }));
    expect(await keyRows()).toBe(1);
  });

  it("refuses an agree key another device holds, after the key is used", async () => {
    await seedConsent();
    const key = await enrol();
    const stolen = await w.db.first<{ agree_key: string }>(
      "SELECT agree_key FROM device_keys WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    const keys = await newKeys();
    const r = await redeem(key, {
      keys: { ...keys, agreeKey: stolen!.agree_key },
    });
    expect(r.res.status).toBe(400);
    expect(r.text).toBe(JSON.stringify({ error: "invalid_grant" }));
    expect(await getDevice(w.db, SLUG, NEW)).toBeNull();
  });

  it("refuses a disabled account, erased or merged away, same body, after the key is used", async () => {
    await seedConsent();
    const key = await enrol();
    await w.db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      await accountId(),
    );
    const r = await redeem(key);
    expect(r.res.status).toBe(400);
    expect(r.text).toBe(JSON.stringify({ error: "invalid_grant" }));
    expect(await keyRows()).toBe(0);
  });
});

describe("the key is bound to its product", () => {
  async function otherProduct() {
    await seedProduct(w.db, OTHER_SLUG);
    await w.db.run(
      "UPDATE products SET services_json = (SELECT services_json FROM products WHERE slug = ?) WHERE slug = ?",
      SLUG,
      OTHER_SLUG,
    );
    await ensureBoundDevice(w.db, OTHER_SLUG, A, w.subject);
    return (await mintRestoreKey(w.env, w.db, {
      product: OTHER_SLUG,
      deviceId: A,
      subject: w.subject,
      boundSubject: w.subject,
      now: NOW,
    }))!;
  }

  it("refuses another product's id and secret under this product's client_id, and does not consume it", async () => {
    await seedConsent();
    const foreign = await otherProduct();
    const r = await redeem(foreign);
    expect(r.res.status).toBe(400);
    expect(r.text).toBe(JSON.stringify({ error: "invalid_grant" }));
    expect(await keyRows(OTHER_SLUG)).toBe(1);
    // And the other way: this product's key at the other product's route.
    const own = await enrol();
    const wrongWay = await redeem(own, { slug: OTHER_SLUG });
    expect(wrongWay.res.status).toBe(400);
    expect(await keyRows(SLUG)).toBe(1);
    expect(await getDevice(w.db, OTHER_SLUG, NEW)).toBeNull();
  });
});

describe("the gate is checked first", () => {
  it("answers unsupported_grant_type and consumes nothing with the launch gate off, unset or runtime", async () => {
    const key = await enrol();
    for (const v of ["off", undefined, "runtime"]) {
      gate(v);
      const r = await redeem(key);
      expect(r.res.status, String(v)).toBe(400);
      expect(r.body.error, String(v)).toBe("unsupported_grant_type");
    }
    expect(await keyRows()).toBe(1);
  });

  it("answers unsupported_grant_type with the product setting off", async () => {
    const key = await enrol();
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.restore', 'false', 'manifest', ?, 'test')`,
      SLUG,
      NOW,
    );
    const r = await redeem(key);
    expect(r.body.error).toBe("unsupported_grant_type");
    expect(await keyRows()).toBe(1);
  });

  it("is a 404 with Identity off, like every identity route", async () => {
    const key = await enrol();
    await enable(w.db, ["license"]);
    expect((await redeem(key)).res.status).toBe(404);
    expect(await keyRows()).toBe(1);
  });
});

/** The one refusal of §12.11.8, byte for byte. */
const REFUSED = JSON.stringify({ error: "invalid_grant" });

/** A redeem that is refused with the one body and leaves nothing bound and no mail. */
async function expectRefusedNothingBound(key: {
  restoreId: string;
  secret: string;
}) {
  const r = await redeem(key);
  expect(r.res.status).toBe(400);
  expect(r.text).toBe(REFUSED);
  expect(await getDevice(w.db, SLUG, NEW)).toBeNull();
  expect(await getDeviceKeys(w.db, SLUG, NEW)).toBeNull();
  expect(mail).toHaveLength(0);
}

describe("the enrolling device must still be signed in as the account", () => {
  it("redeems while the enrolling device is signed in (control)", async () => {
    await seedConsent();
    expect((await redeem(await enrol())).res.status).toBe(200);
  });

  it("refuses when the enrolling device's binding was cleared by raw SQL", async () => {
    await seedConsent();
    const key = await enrol();
    await w.db.run(
      "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    await expectRefusedNothingBound(key);
  });

  it("refuses when the enrolling device was deauthorized by raw SQL", async () => {
    await seedConsent();
    const key = await enrol();
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    await expectRefusedNothingBound(key);
  });

  it("refuses when the enrolling device is now bound to another subject", async () => {
    await seedConsent();
    const key = await enrol();
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen)
       VALUES (?, ?, '', 'authorized', ?, ?)`,
      SLUG,
      C,
      NOW,
      NOW,
    );
    const bob = await bindTo(w, C, "bob@example.com");
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
      bob,
      SLUG,
      A,
    );
    await expectRefusedNothingBound(key);
  });

  it("refuses when the enrolling device row is gone", async () => {
    await seedConsent();
    const key = await enrol();
    await w.db.run(
      "DELETE FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    await expectRefusedNothingBound(key);
  });
});

describe("a restore needs an address a security notice can reach", () => {
  const RELAY = "abc123@privaterelay.appleid.com";

  /** The account's addresses, exactly these (verified): no link address, a primary one at most. */
  async function onlyAddresses(primary: string | null) {
    const id = await accountId();
    await w.db.run(
      "UPDATE account_links SET email = NULL, email_verified = 0 WHERE account_id = ?",
      id,
    );
    await w.db.run(
      "UPDATE accounts SET primary_email = ?, primary_email_verified_at = ? WHERE id = ?",
      primary,
      primary ? NOW : null,
      id,
    );
  }

  /** A second verified address, on the account's first email link. */
  async function addWorkAddress() {
    const id = await accountId();
    await w.db.run(
      `UPDATE account_links SET email = 'ada.work@example.com', email_verified = 1
        WHERE account_id = ? AND rowid = (SELECT MIN(rowid) FROM account_links WHERE account_id = ?)`,
      id,
      id,
    );
  }

  it("refuses an account whose only address is a private-relay one, while the relay sender is not registered", async () => {
    await seedConsent();
    await onlyAddresses(RELAY);
    await expectRefusedNothingBound(await enrol());
  });

  it("restores that account once the relay sender is registered, and the relay address gets the notice", async () => {
    await seedConsent();
    await onlyAddresses(RELAY);
    (w.env as unknown as Record<string, unknown>).EMAIL_APPLE_RELAY =
      "registered";
    const r = await redeem(await enrol());
    expect(r.res.status, r.text).toBe(200);
    expect(mail.map((m) => m.to)).toEqual([RELAY]);
  });

  it("refuses an account with no address", async () => {
    await seedConsent();
    await onlyAddresses(null);
    await expectRefusedNothingBound(await enrol());
  });

  it("refuses an account whose only address is suppressed", async () => {
    await seedConsent();
    await onlyAddresses("ada@example.com");
    await suppressEmail(w.env, w.db, "ada@example.com", "complaint", NOW);
    await expectRefusedNothingBound(await enrol());
  });

  it("sends the notice to every verified address of the account", async () => {
    await seedConsent();
    await onlyAddresses("ada@example.com");
    await addWorkAddress();
    const r = await redeem(await enrol());
    expect(r.res.status, r.text).toBe(200);
    expect(mail.map((m) => m.to).sort()).toEqual([
      "ada.work@example.com",
      "ada@example.com",
    ]);
  });

  it("a suppressed address does not block a restore while another address can be reached", async () => {
    await seedConsent();
    await onlyAddresses("ada@example.com");
    await addWorkAddress();
    await suppressEmail(w.env, w.db, "ada@example.com", "complaint", NOW);
    const r = await redeem(await enrol());
    expect(r.res.status, r.text).toBe(200);
    expect(mail.map((m) => m.to)).toEqual(["ada.work@example.com"]);
  });

  it("is checked before terms and consent, so a confirm path binds nothing either", async () => {
    // No consent seeded: this restore would answer `confirm`. With no reachable address it refuses.
    await onlyAddresses(null);
    await expectRefusedNothingBound(await enrol());
  });
});

describe("a day's restores are capped per account", () => {
  it("answers the 6th restore of one account in a day with 429 rate_limited", async () => {
    await seedConsent();
    const devices = Array.from({ length: 6 }, (_, i) =>
      `ACCT${i}`.padEnd(32, "0"),
    );
    for (const [i, d] of devices.entries()) {
      await ensureBoundDevice(
        w.db,
        SLUG,
        `ENROL${i}`.padEnd(32, "0"),
        w.subject,
      );
      const key = await mintRestoreKey(w.env, w.db, {
        product: SLUG,
        deviceId: `ENROL${i}`.padEnd(32, "0"),
        subject: w.subject,
        boundSubject: w.subject,
        now: NOW,
      });
      // A fresh minute each time, so the network and device limits never speak.
      const r = await redeem(key!, { device: d, now: NOW + 120 * (i + 1) });
      if (i < 5) expect(r.res.status, `restore ${i + 1}: ${r.text}`).toBe(200);
      else {
        expect(r.res.status).toBe(429);
        expect(r.body.error).toBe("rate_limited");
        expect(await getDevice(w.db, SLUG, d)).toBeNull();
      }
    }
  });
});

describe("terms and consent", () => {
  it("answers 403 interstitial_required with reason terms, key used", async () => {
    await seedConsent();
    const TERMS = { version: "2026-10", url: "https://acme.example/terms" };
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.terms', ?, 'manifest', ?, 'resync')`,
      SLUG,
      JSON.stringify(TERMS),
      NOW,
    );
    const r = await redeem(await enrol());
    expect(r.res.status).toBe(403);
    expect(r.body.error).toBe("interstitial_required");
    expect(r.body.reason).toBe("terms");
    expect(r.body.linkHandle).toBeUndefined();
    expect(await keyRows()).toBe(0);
  });

  it("answers confirm with no provider and no address when the person has not consented, then choice/complete finishes it with the notice, even after the gate went off", async () => {
    const key = await enrol();
    const r = await redeem(key);
    expect(r.res.status).toBe(200);
    expect(r.body.status).toBe("confirm");
    expect(r.body.consent.as).toEqual({ provider: null, email: null });
    // No address anywhere in the body.
    expect(r.text).not.toContain("ada@example.com");
    expect(r.text).not.toContain("@");
    expect(r.body.access_token).toBeUndefined();
    // Nothing is bound yet, no notice yet.
    expect(await getDevice(w.db, SLUG, NEW)).toBeNull();
    expect(mail).toHaveLength(0);
    expect(await keyRows()).toBe(0);

    gate("off");
    const body = await complete(r.body.grant, {
      consent: { claims: ["profile", "email"] },
    });
    expect(typeof body.access_token).toBe("string");
    expect((await getDeviceKeys(w.db, SLUG, NEW))?.sign_key).toBe(
      r.keys.signKey,
    );
    const audit = await w.db.all<{ action: string }>(
      "SELECT action FROM audit WHERE target_id = ? AND action LIKE 'signin.%'",
      NEW,
    );
    expect(audit.map((a) => a.action)).toContain("signin.restore");
  });
});

describe("a licence choice that is due", () => {
  it("hands over a pending grant that carries the restore, and choice/complete finishes it: origin, keys, notice", async () => {
    await enable(w.db, ["license", "identity"]);
    await seedConsent();
    const r = await redeem(await enrol());
    expect(r.res.status, r.text).toBe(200);
    expect(r.body.status).toBe("choose");
    expect(r.body.access_token).toBeUndefined();
    expect(mail).toHaveLength(0);
    expect(await getDevice(w.db, SLUG, NEW)).toBeNull();
    expect(await keyRows()).toBe(0);
    // The person enters a licence key in the app: that binds the device.
    await complete(r.body.grant, { choice: { kind: "key", key: w.key } });
  });
});

describe("a device row of someone else", () => {
  it("is never taken over: a row bound to another person's subject is refused", async () => {
    await seedConsent();
    // NEW already exists as a device bound to a different person.
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen)
       VALUES (?, ?, '', 'authorized', ?, ?)`,
      SLUG,
      NEW,
      NOW,
      NOW,
    );
    const other = await bindTo(w, NEW, "bob@example.com");
    expect(other).not.toBe(w.subject);
    const r = await redeem(await enrol());
    expect(r.res.status).toBe(400);
    expect(r.text).toBe(JSON.stringify({ error: "invalid_grant" }));
    expect((await getDevice(w.db, SLUG, NEW))?.subject).toBe(other);
  });

  it("a row already bound to this same person is allowed", async () => {
    await seedConsent();
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen)
       VALUES (?, ?, '', 'authorized', ?, ?)`,
      SLUG,
      NEW,
      NOW,
      NOW,
    );
    await bindTo(w, NEW, "ada@example.com");
    const r = await redeem(await enrol());
    expect(r.res.status, r.text).toBe(200);
  });
});

describe("limits", () => {
  it("5 a minute per device and 10 per network, both 429 rate_limited", async () => {
    await seedConsent();
    const key = await enrol();
    // A wrong secret still spends the device's budget (the limit comes before the lookup).
    for (let i = 0; i < 5; i++)
      expect(
        (await redeem(key, { secret: `rs_${"A".repeat(43)}` })).res.status,
      ).toBe(400);
    const sixth = await redeem(key);
    expect(sixth.res.status).toBe(429);
    expect(sixth.body.error).toBe("rate_limited");
    // The key was not spent by the throttled call.
    expect(await keyRows()).toBe(1);
    // Another device gets in until the network's 10 a minute run out.
    for (let i = 0; i < 4; i++)
      expect(
        (
          await redeem(key, {
            device: `DEV${i}`.padEnd(32, "0"),
            secret: `rs_${"A".repeat(43)}`,
          })
        ).res.status,
      ).toBe(400);
    const net = await redeem(key, { device: `DEVX`.padEnd(32, "0") });
    expect(net.res.status).toBe(429);
  });
});
