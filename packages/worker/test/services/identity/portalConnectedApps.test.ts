/**
 * I-21.15: Polaris Locker's Connected apps API (`GET`, `PATCH` and `DELETE /api/me/connected-apps`).
 * The list says what each registered client gets; Change flips only the optional claims the person
 * already decided; Disconnect ends the grant and the refresh families at once.
 */
import { describe, expect, it } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { setClientStatus } from "../../../src/services/identity/issuer/clientsRepo.js";
import {
  changeGrantClaimsStatement,
  getClientGrant,
  putClientGrant,
} from "../../../src/services/identity/issuer/grantsRepo.js";
import type { Db } from "../../../src/db/types.js";
import { NOW } from "../../seed.js";
import { BASE, SLUG } from "../connect/connectFixture.js";
import {
  connectedAppsCall,
  portalSessionFor,
} from "./issuer/connectedAppsKit.js";
import { issuerSuite } from "./issuer/issuerFlow.js";
import { mkClient } from "./issuer/issuerWorld.js";

const { s, token, signIn } = issuerSuite("connected-apps-pepper");

const me = () => portalSessionFor(s.w, s.accountId);
const base = (clientId: string) => `/api/me/connected-apps/${SLUG}/${clientId}`;
const json = async (res: Response) => (await res.json()) as any;

describe("GET /api/me/connected-apps", () => {
  it("lists each client with what it gets, newest use first, and nothing secret", async () => {
    await signIn(s.spa);
    await signIn(s.web);
    // The web client was used more recently.
    await s.w.db.run(
      "UPDATE identity_client_grants SET last_used_at = ? WHERE client_id = ?",
      NOW + 50,
      s.web.clientId,
    );
    const res = await connectedAppsCall(
      s.w,
      await me(),
      "GET",
      "/api/me/connected-apps",
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({ product: SLUG });
    const [first, second] = body.products[0].clients;
    expect(first.clientId).toBe(s.web.clientId);
    expect(second.clientId).toBe(s.spa.clientId);
    expect(second).toEqual({
      clientId: s.spa.clientId,
      name: "spa-app",
      developer: null,
      partner: false,
      iconUrl: null,
      returnHost: "spa.example.com",
      available: true,
      gets: [
        { item: "name", granted: true, fixed: true },
        { item: "picture", granted: false, fixed: false },
        { item: "email", granted: true, fixed: false },
        { item: "entitlements", granted: true, fixed: true },
        { item: "offline", granted: true, fixed: true },
      ],
      grantedAt: NOW,
      lastUsedAt: NOW,
    });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/scope_hash|scopeHash|redirect|pkeyo_|pkeycs_/);
  });

  it("is empty with no grant, and lists a disabled client as unavailable", async () => {
    const empty = await connectedAppsCall(
      s.w,
      await me(),
      "GET",
      "/api/me/connected-apps",
    );
    expect(await json(empty)).toEqual({ products: [] });
    await signIn();
    await setClientStatus(s.w.db, SLUG, s.spa.clientId, "disabled", NOW);
    const body = await json(
      await connectedAppsCall(s.w, await me(), "GET", "/api/me/connected-apps"),
    );
    expect(body.products[0].clients[0].available).toBe(false);
  });

  it("is unavailable while the issuer is off, and answers another person's list empty", async () => {
    await signIn();
    await s.w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    const body = await json(
      await connectedAppsCall(s.w, await me(), "GET", "/api/me/connected-apps"),
    );
    expect(body.products[0].clients[0].available).toBe(false);
    const other = await s.w.db.first<{ id: string }>(
      "SELECT id FROM accounts LIMIT 1",
    );
    expect(other).not.toBeNull();
    await s.w.db.run(
      "INSERT INTO accounts (id, status, created_at, modified_at) VALUES ('acct_other', 'active', ?, ?)",
      NOW,
      NOW,
    );
    const theirs = await portalSessionFor(s.w, "acct_other", "eve@example.com");
    expect(
      await json(
        await connectedAppsCall(s.w, theirs, "GET", "/api/me/connected-apps"),
      ),
    ).toEqual({ products: [] });
  });

  it("names a partner client's developer", async () => {
    const partner = await mkClient(s.w, {
      key: "partner-app",
      type: "spa",
      redirectUris: ["https://partner.example.net/cb"],
      developerName: "Partner Games Ltd",
    });
    await signIn(partner);
    const body = await json(
      await connectedAppsCall(s.w, await me(), "GET", "/api/me/connected-apps"),
    );
    expect(body.products[0].clients[0]).toMatchObject({
      developer: "Partner Games Ltd",
      partner: true,
    });
  });
});

describe("PATCH Change what a client gets", () => {
  it("flips a decided optional claim, keeps granted_at, the scopes and the families, and audits the item", async () => {
    const t = await signIn();
    const before = (await getClientGrant(
      s.w.db,
      SLUG,
      s.accountId,
      s.spa.clientId,
    ))!;
    const res = await connectedAppsCall(
      s.w,
      await me(),
      "PATCH",
      base(s.spa.clientId),
      {
        body: { claims: { email: false, picture: true } },
        at: NOW + 30,
      },
    );
    expect(res.status).toBe(200);
    const view = await json(res);
    expect(view.gets).toContainEqual({
      item: "email",
      granted: false,
      fixed: false,
    });
    expect(view.gets).toContainEqual({
      item: "picture",
      granted: true,
      fixed: false,
    });
    const after = (await getClientGrant(
      s.w.db,
      SLUG,
      s.accountId,
      s.spa.clientId,
    ))!;
    expect(after).toMatchObject({
      claimsGranted: ["name", "picture"],
      claimsDeclined: ["email"],
      grantedAt: before.grantedAt,
      scopes: before.scopes,
      scopeHash: before.scopeHash,
      changedAt: NOW + 30,
    });
    // The family stays; the next refresh carries the new claims, userinfo reads them live.
    const refreshed = await token(
      {
        grant_type: "refresh_token",
        client_id: s.spa.clientId,
        refresh_token: t.refresh_token,
      },
      { at: NOW + 30 },
    );
    expect(refreshed.status).toBe(200);
    const info = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/userinfo`, {
        headers: { authorization: `Bearer ${t.access_token}` },
      }),
      s.w.env,
      s.w.db,
      NOW + 30,
    );
    expect((await json(info)).email).toBeUndefined();
    const row = await s.w.db.first<{
      action: string;
      summary: string;
      actor_sub: string;
      target_id: string;
    }>(
      "SELECT action, summary, actor_sub, target_id FROM audit WHERE action = 'identity.client.change'",
    );
    expect(row).toMatchObject({
      actor_sub: s.w.subject,
      target_id: s.spa.clientId,
    });
    expect(row!.summary).toContain("email");
    expect(row!.summary).toContain("picture");
  });

  it("changes nothing and writes no audit row when the value is the same", async () => {
    await signIn();
    const res = await connectedAppsCall(
      s.w,
      await me(),
      "PATCH",
      base(s.spa.clientId),
      {
        body: { claims: { email: true } },
      },
    );
    expect(res.status).toBe(200);
    expect(
      await s.w.db.first(
        "SELECT 1 FROM audit WHERE action = 'identity.client.change'",
      ),
    ).toBeNull();
  });
});

/** The world's database, but `before` runs once, just before the first guarded batch lands. */
const racing = (before: () => Promise<void>) => {
  let done = false;
  const real = s.w.db;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "batchChanges")
        return async (
          statements: Parameters<NonNullable<Db["batchChanges"]>>[0],
        ) => {
          if (!done) {
            done = true;
            await before();
          }
          return target.batchChanges!(statements);
        };
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...s.w, db } as typeof s.w;
};
const grantNow = () =>
  getClientGrant(s.w.db, SLUG, s.accountId, s.spa.clientId).then((g) => g!);
const changeAudits = () =>
  s.w.db.all("SELECT 1 FROM audit WHERE action = 'identity.client.change'");

describe("PATCH racing another write", () => {
  it("a Change that loses to another Change is 409 revision_conflict and writes nothing, no audit row", async () => {
    await signIn();
    const read = await grantNow();
    const w = racing(async () => {
      const stmt = changeGrantClaimsStatement(
        {
          ...read,
          claimsGranted: ["name", "picture", "email"],
          claimsDeclined: [],
        },
        NOW + 20,
        read.changedAt,
      );
      await s.w.db.run(stmt.sql, ...stmt.params);
    });
    const res = await connectedAppsCall(
      w,
      await me(),
      "PATCH",
      base(s.spa.clientId),
      {
        body: { claims: { email: false } },
        at: NOW + 20,
      },
    );
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: "revision_conflict",
      message: "This app's access changed. Reload to see it.",
    });
    // The winner's claims stand; the loser's lost update never landed.
    expect((await grantNow()).claimsGranted).toEqual([
      "name",
      "picture",
      "email",
    ]);
    expect(await changeAudits()).toHaveLength(0);
  });

  it("a Change that races a re-consent in the same second is 409, and the re-consent stands", async () => {
    await signIn();
    const read = await grantNow();
    const w = racing(async () => {
      await putClientGrant(
        s.w.db,
        {
          product: SLUG,
          accountId: s.accountId,
          clientId: s.spa.clientId,
          claimsGranted: read.claimsGranted,
          claimsDeclined: read.claimsDeclined,
          scopes: read.scopes,
          scopeHash: read.scopeHash,
        },
        read.changedAt,
      );
    });
    const res = await connectedAppsCall(
      w,
      await me(),
      "PATCH",
      base(s.spa.clientId),
      {
        body: { claims: { email: false } },
        at: read.changedAt,
      },
    );
    expect(res.status).toBe(409);
    expect((await grantNow()).claimsGranted).toEqual(read.claimsGranted);
    expect(await changeAudits()).toHaveLength(0);
  });

  it("two Changes in one second both land when they run one after the other", async () => {
    await signIn();
    const who = await me();
    const at = (await grantNow()).changedAt;
    for (const email of [false, true])
      expect(
        (
          await connectedAppsCall(s.w, who, "PATCH", base(s.spa.clientId), {
            body: { claims: { email } },
            at,
          })
        ).status,
      ).toBe(200);
    expect(await changeAudits()).toHaveLength(2);
  });
});

describe("DELETE Disconnect", () => {
  it("is 204, ends the grant and the families at once, and a second one is 404", async () => {
    const t = await signIn();
    const other = await signIn(s.web);
    const res = await connectedAppsCall(
      s.w,
      await me(),
      "DELETE",
      base(s.spa.clientId),
    );
    expect(res.status).toBe(204);
    expect(
      await getClientGrant(s.w.db, SLUG, s.accountId, s.spa.clientId),
    ).toBeNull();
    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: s.spa.clientId,
      refresh_token: t.refresh_token,
    });
    expect(((await refreshed.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    const info = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/userinfo`, {
        headers: { authorization: `Bearer ${t.access_token}` },
      }),
      s.w.env,
      s.w.db,
      NOW,
    );
    expect(info.status).toBe(401);
    // The other client is untouched.
    expect(
      await getClientGrant(s.w.db, SLUG, s.accountId, s.web.clientId),
    ).not.toBeNull();
    expect(other.refresh_token).toBeTruthy();
    expect(
      (await connectedAppsCall(s.w, await me(), "DELETE", base(s.spa.clientId)))
        .status,
    ).toBe(404);
    const audit = await s.w.db.all<{ summary: string }>(
      "SELECT summary FROM audit WHERE action = 'identity.client.disconnect'",
    );
    expect(audit).toHaveLength(1);
    // Signing in again asks again: the grant is new, and the old family stays refused.
    const again = await signIn(s.spa);
    expect(again.refresh_token).not.toBe(t.refresh_token);
  });

  it("removes a client the product turned off", async () => {
    await signIn();
    await setClientStatus(s.w.db, SLUG, s.spa.clientId, "disabled", NOW);
    expect(
      (await connectedAppsCall(s.w, await me(), "DELETE", base(s.spa.clientId)))
        .status,
    ).toBe(204);
  });
});
