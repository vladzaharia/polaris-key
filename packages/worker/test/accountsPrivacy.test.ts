/**
 * I-05: the global account id never leaves the Worker's Identity and Core code (S-16 §5.1;
 * plans/I-04.md §6.2). A licence owned by an account and a device bound to its pairwise subject
 * are read through every developer-facing route I-05 touched — the device routes (activate, token
 * rotation, the signed licence document, the device list) and the console's licence and device
 * pages — and no response, nor the signed document's payload, carries the account id.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { loadProduct } from "../src/core/products.js";
import { handleDevices } from "../src/core/devices.js";
import { setDeviceSubject } from "../src/core/accountSubjects.js";
import {
  handleActivate,
  handleToken,
} from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { attachLicense } from "../src/services/identity/accounts/claim.js";

function decodeJwsPayload(jws: string): string {
  const part = jws.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

describe("the account id never reaches a developer-facing response (I-05)", () => {
  it("device routes and console licence/device pages answer the subject's world without the account id", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key, licenseId } = await seedLicenseWithKey(db, "djdl");

    const signedIn = await signIn(
      db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      NOW,
      { product: { slug: "djdl" } },
    );
    if (signedIn.status !== "signed_in") throw new Error("sign-in failed");
    const accountId = signedIn.account.id;
    const attached = await attachLicense(
      { db, env, now: NOW, origin: "https://key.plrs.im" },
      { accountId, product: "djdl", licenseId, via: "key" },
    );
    expect(attached.ok).toBe(true);

    const bodies: Array<[string, string]> = [];
    const activate = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(activate.status).toBe(200);
    const activated = await activate.text();
    bodies.push(["POST license/activate", activated]);
    const { token } = JSON.parse(activated) as { token: string };
    expect(
      await setDeviceSubject(env, db, "djdl", "dev-1", signedIn.subject!),
    ).toBe(true);

    const rotated = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(rotated.status).toBe(200);
    const rotatedText = await rotated.text();
    bodies.push(["POST license/token", rotatedText]);
    const fresh = (JSON.parse(rotatedText) as { token: string }).token;

    const doc = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${fresh}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(doc.status).toBe(200);
    const docText = await doc.text();
    bodies.push(["GET license/document", docText]);
    // The document is the compact JWS itself; its payload is what a developer's app reads.
    expect(docText.split(".")).toHaveLength(3);
    bodies.push(["license document payload", decodeJwsPayload(docText)]);

    const devices = await handleDevices(
      mkReq("GET", { authorization: `Bearer ${fresh}` }),
      env,
      db,
      product,
      NOW,
    );
    expect(devices.status).toBe(200);
    bodies.push(["GET devices", await devices.text()]);

    const { token: adminToken, session } = await issueSession(
      env,
      { sub: "op", name: "Op", email: "op@x.io", groups: ["platform-admins"] },
      NOW,
    );
    for (const path of [
      "/api/products/djdl/license/licenses",
      `/api/products/djdl/license/licenses/${licenseId}`,
      "/api/products/djdl/devices",
    ]) {
      const res = await handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method: "GET",
          headers: {
            cookie: `${ADMIN_COOKIE}=${adminToken}`,
            [CSRF_HEADER]: session.csrf,
          },
        }) as unknown as Request,
        env,
        db,
        path,
        { now: NOW },
      );
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
      bodies.push([`GET /manage${path}`, await res.text()]);
    }

    expect(bodies.length).toBeGreaterThanOrEqual(7);
    for (const [where, body] of bodies) {
      expect(`${where}: ${body.includes(accountId)}`).toBe(`${where}: false`);
      expect(`${where}: ${/account_?id/i.test(body)}`).toBe(`${where}: false`);
    }
  });
});
