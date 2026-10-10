/**
 * PX-W17: the global account id stays inside Identity and Core (S-16 §5.1; THREAT-MODEL item 12,
 * cross-product correlation). What a developer ever sees is the pairwise subject of THEIR product.
 *
 *   - Static: no non-portal OpenAPI schema declares an `accountId` / `account_id` property.
 *   - Dynamic: with one account owning a licence in each of two products, every product-scoped
 *     console GET that shows licences, devices, activity or the product, every device route, the
 *     signed licence document and the subject feed (`subject_events`) are read, and no body
 *     carries the account id, nor the OTHER product's subject.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { setServices } from "../src/core/repo.js";
import { DEFAULT_SERVICES, serializeServices } from "../src/core/services.js";
import {
  setDeviceSubject,
  subjectFor,
} from "../src/core/accounts/accountSubjects.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { attachLicense } from "../src/services/identity/accounts/claim.js";
import { removeProductData } from "../src/services/identity/accounts/deletion.js";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://key.plrs.im";
const ACCOUNT_ID_PROPERTY = /^account_?id$/i;

type Node = Record<string, unknown>;

describe("the account id never reaches a developer (PX-W17)", () => {
  it("static: no non-portal OpenAPI schema declares an account id property", () => {
    const spec = parseYaml(
      readFileSync(join(here, "..", "openapi", "polaris-key.v3.yaml"), "utf8"),
    ) as { paths: Record<string, Node>; components: Node };

    const resolve = (ref: string): unknown =>
      ref
        .replace(/^#\//, "")
        .split("/")
        .reduce<unknown>(
          (cur, part) =>
            cur && typeof cur === "object" ? (cur as Node)[part] : undefined,
          spec,
        );

    const offending: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown, where: string): void => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${where}[${i}]`));
        return;
      }
      const obj = node as Node;
      if (typeof obj.$ref === "string") walk(resolve(obj.$ref), obj.$ref);
      const props = obj.properties;
      if (props && typeof props === "object") {
        for (const name of Object.keys(props as Node))
          if (ACCOUNT_ID_PROPERTY.test(name))
            offending.push(`${where}.properties.${name}`);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${where}.${k}`);
    };

    let operations = 0;
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!op || typeof op !== "object") continue;
        const tags = ((op as Node).tags as string[] | undefined) ?? [];
        // The portal is the account holder's own surface: it may name the account.
        if (tags.includes("portal")) continue;
        operations++;
        walk(op, `${method.toUpperCase()} ${path}`);
      }
    }
    expect(operations).toBeGreaterThan(50);
    expect(offending).toEqual([]);
  });

  it("dynamic: two products, one account — no developer-facing body carries the account id or the other product's subject", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    for (const slug of ["alpha", "beta"]) {
      await seedProduct(db, slug);
      await setServices(
        db,
        slug,
        serializeServices({
          services: { ...DEFAULT_SERVICES, identity: { enabled: true } },
        }),
        "manifest",
        NOW,
      );
    }
    const signedIn = await signIn(
      db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      NOW,
    );
    if (signedIn.status !== "signed_in") throw new Error(signedIn.status);
    const accountId = signedIn.account.id;
    const ctx = { db, env, now: NOW, origin: ORIGIN };

    const products: Record<
      string,
      { key: string; licenseId: string; subject: string; token: string }
    > = {};
    for (const slug of ["alpha", "beta"]) {
      const { key, licenseId } = await seedLicenseWithKey(db, slug);
      expect(
        (
          await attachLicense(ctx, {
            accountId,
            product: slug,
            licenseId,
            via: "key",
          })
        ).ok,
      ).toBe(true);
      const activated = await dispatchWith(
        new Request(`${ORIGIN}/${slug}/license/activate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "x-pkey-device": "dev-1",
            "x-pkey-version": "1.0.0",
          },
        }) as unknown as Request,
        env,
        db,
        NOW,
      );
      expect(activated.status).toBe(200);
      const { token } = (await activated.json()) as { token: string };
      const subject = await subjectFor(db, accountId, slug, NOW);
      expect(await setDeviceSubject(env, db, slug, "dev-1", subject)).toBe(
        true,
      );
      products[slug] = { key, licenseId, subject, token };
    }
    expect(products.alpha!.subject).not.toBe(products.beta!.subject);

    const { token: adminToken, session } = await issueSession(
      env,
      { sub: "op", name: "Op", email: "op@x.io", groups: ["platform-admins"] },
      NOW,
    );
    const bodies: Array<[string, string, string]> = [];
    for (const [slug, p] of Object.entries(products)) {
      for (const path of [
        `/api/products/${slug}`,
        `/api/products/${slug}/services`,
        `/api/products/${slug}/activity`,
        `/api/products/${slug}/devices`,
        `/api/products/${slug}/devices/summary`,
        `/api/products/${slug}/devices/dev-1`,
        `/api/products/${slug}/license/licenses`,
        `/api/products/${slug}/license/licenses/${p.licenseId}`,
        `/api/products/${slug}/license/licenses/${p.licenseId}/devices`,
        `/api/products/${slug}/license/licenses/${p.licenseId}/keys`,
        // ST-29: the signed-in member's permissions and NoAccessPage's "who can give you access".
        `/api/me`,
        `/api/access/admins?scope=product:${slug}&area=license`,
      ]) {
        const res = await handleAdmin(
          new Request(`${ORIGIN}/manage${path}`, {
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
        bodies.push([slug, `GET /manage${path}`, await res.text()]);
      }
      const device = {
        authorization: `Bearer ${p.token}`,
        "x-pkey-device": "dev-1",
        "x-pkey-version": "1.0.0",
      };
      for (const path of [
        `/${slug}/.well-known/polaris.json`,
        `/${slug}/devices`,
        `/${slug}/devices/dev-1`,
        `/${slug}/license/document`,
        // I-09: the device's own subject read names the subject, never the account.
        `/${slug}/identity/subject`,
      ]) {
        const res = await dispatchWith(
          new Request(`${ORIGIN}${path}`, {
            headers: device,
          }) as unknown as Request,
          env,
          db,
          NOW,
        );
        expect(`${path} ${res.status}`).toBe(`${path} 200`);
        const text = await res.text();
        bodies.push([slug, `GET ${path}`, text]);
        if (path.endsWith("/document")) {
          const part = text.split(".")[1] ?? "";
          const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
          bodies.push([
            slug,
            `${path} payload`,
            atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
          ]);
        }
      }
    }
    // The console shows each product its own subject.
    expect(
      bodies.some(
        ([slug, where, body]) =>
          slug === "alpha" &&
          where.endsWith("/devices/dev-1") &&
          body.includes(products.alpha!.subject),
      ),
    ).toBe(true);

    // The subject feed: per-product removal emits subject.deleted.
    await removeProductData(ctx, {
      accountId,
      product: "beta",
      alsoDetachLicenses: false,
    });
    const feed = await db.all<Record<string, unknown>>(
      "SELECT * FROM subject_events",
    );
    expect(feed.length).toBeGreaterThan(0);
    for (const row of feed)
      bodies.push([String(row.product), "subject_events", JSON.stringify(row)]);

    for (const [slug, where, body] of bodies) {
      const other = slug === "alpha" ? products.beta! : products.alpha!;
      expect(`${where}: ${body.includes(accountId)}`).toBe(`${where}: false`);
      expect(`${where}: ${body.includes(other.subject)}`).toBe(
        `${where}: false`,
      );
    }
  });
});
