/**
 * CC-16.W: `GET /manage/api/products/<slug>/connect/{people,usage}`. Console session, RBAC area
 * `connect`, paging by subject, the service-off answer, and no key or certificate in the body.
 */

import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../../src/core/rbac/can.js";
import { handleAdmin } from "../../../src/console/index.js";
import { ADMIN_COOKIE } from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import {
  accountDeviceKeys,
  upsertDeviceKeys,
} from "../../../src/core/devices/keys.js";
import { accountForSubject } from "../../../src/core/accounts/accountSubjects.js";
import { currentRing } from "../../../src/services/connect/ring.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { NOW } from "../../seed.js";
import { PRINCIPALS } from "../../rbacFixtures.js";
import { A, B, enable, SLUG, world } from "./connectFixture.js";

const SYNTHETIC = new Map<string, Principal>();
vi.mock("../../../src/core/rbac/principal.js", async (importOriginal) =>
  (await import("../../syntheticPrincipals.js")).withSyntheticPrincipals(
    importOriginal,
    (id) => SYNTHETIC.get(id),
  ),
);
SYNTHETIC.set(PRINCIPALS.alphaShip!.memberId, PRINCIPALS.alphaShip!);
const connectAdmin: Principal = {
  memberId: "m-djdl-connect",
  grants: [
    {
      role: "product_admin",
      scope: "product:djdl",
      areas: ["connect"],
      source: "grant",
    },
  ],
};
SYNTHETIC.set(connectAdmin.memberId, connectAdmin);

const GROUP = "platform-admins";
const DAY = 86_400;
const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

async function setup() {
  const w = await world();
  w.env.ADMIN_SESSION_SECRET = "connect-admin-secret";
  w.env.PLATFORM_ADMIN_GROUP = GROUP;
  const get = async (sub: string, groups: string[], path: string) => {
    const { token } = await consoleTestSession(
      w.env,
      w.db,
      { sub, groups, name: "A", email: "a@example.test" },
      NOW,
    );
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }),
      w.env,
      w.db,
      path,
      { now: NOW },
    );
  };
  await currentRing(
    w.db,
    SLUG,
    w.subject,
    () =>
      accountDeviceKeys(w.db, SLUG, w.subject, { seatsHeld: true, now: NOW }),
    NOW,
  );
  return { ...w, get };
}

const PEOPLE = `/api/products/${SLUG}/connect/people`;
const USAGE = `/api/products/${SLUG}/connect/usage`;

describe("GET connect/people", () => {
  it("lists a person's devices and ring epoch, with nothing secret", async () => {
    const w = await setup();
    const res = await w.get("u1", [GROUP], PEOPLE);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.enabled).toBe(true);
    expect(body.nextCursor).toBeNull();
    expect(body.people).toHaveLength(1);
    const p = body.people[0];
    expect(p).toMatchObject({ subject: w.subject, label: null, ringEpoch: 1 });
    expect(p.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([
      A,
      B,
    ]);
    expect(p.devices[0]).toEqual({
      deviceId: A,
      label: null,
      platform: null,
      keysSince: NOW,
      lastSeen: expect.any(Number),
    });
    for (const banned of ["signKey", "agreeKey", "sign_key", "discKey", "ada@"])
      expect(text).not.toContain(banned);
  });

  it("labels a person by the shared contact email, and only one the product may see", async () => {
    const w = await setup();
    const labelOf = async () =>
      (
        (await (await w.get("u1", [GROUP], PEOPLE)).json()) as {
          people: { label: string | null }[];
        }
      ).people[0]!.label;
    // The account email is not shared until the person consents to it.
    expect(await labelOf()).toBeNull();
    const acct = (await accountForSubject(w.db, SLUG, w.subject))!;
    await w.db.run(
      `INSERT INTO account_product_grants (account_id, product, claims_json, granted_at, modified_at)
       VALUES (?, ?, '["name"]', ?, ?)`,
      acct,
      SLUG,
      NOW,
      NOW,
    );
    expect(await labelOf()).toBeNull();
    await w.db.run(
      `UPDATE account_product_grants SET claims_json = '["email"]' WHERE account_id = ?`,
      acct,
    );
    expect(await labelOf()).toBe("ada@example.com");
    // With Identity off the consent is not read.
    await enable(w.db, ["license", "connect"]);
    expect(await labelOf()).toBeNull();
    // The buyer's licence email wins, consent or not.
    await enable(w.db, ["license", "identity", "connect"]);
    await w.db.run(
      `UPDATE account_product_grants SET claims_json = NULL WHERE account_id = ?`,
      acct,
    );
    await w.db.run(
      `UPDATE licenses SET account_id = ?, email = 'buyer@example.com' WHERE product = ?`,
      acct,
      SLUG,
    );
    expect(await labelOf()).toBe("buyer@example.com");
  });

  it("reports the rotation time as keysSince", async () => {
    const w = await setup();
    await upsertDeviceKeys(w.db, SLUG, A, await newKeys(), NOW + 50, NOW + 50);
    const body = (await (await w.get("u1", [GROUP], PEOPLE)).json()) as {
      people: { devices: { deviceId: string; keysSince: number }[] }[];
    };
    const a = body.people[0]!.devices.find((d) => d.deviceId === A)!;
    expect(a.keysSince).toBe(NOW + 50);
  });

  it("pages by subject", async () => {
    const w = await setup();
    for (let i = 0; i < 52; i++)
      await w.db.run(
        `INSERT INTO connect_rings (product, subject, epoch, members_hash, member_ids, disc_key, bumped_at)
         VALUES (?, ?, 3, 'h', '', 'k', ?)`,
        SLUG,
        `ps_${String(i).padStart(3, "0")}`,
        NOW,
      );
    const first = (await (await w.get("u1", [GROUP], PEOPLE)).json()) as {
      people: { subject: string; devices: unknown[] }[];
      nextCursor: string;
    };
    expect(first.people).toHaveLength(50);
    expect(first.nextCursor).toBe(first.people[49]!.subject);
    const second = (await (
      await w.get("u1", [GROUP], `${PEOPLE}?cursor=${first.nextCursor}`)
    ).json()) as { people: { subject: string }[]; nextCursor: null };
    expect(second.people).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const all = [...first.people, ...second.people].map((p) => p.subject);
    expect(new Set(all).size).toBe(53);
  });

  it("filters to one person by exact subject", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO connect_rings (product, subject, epoch, members_hash, member_ids, disc_key, bumped_at)
       VALUES (?, 'ps_other', 3, 'h', '', 'k', ?)`,
      SLUG,
      NOW,
    );
    const one = (await (
      await w.get("u1", [GROUP], `${PEOPLE}?subject=${w.subject}`)
    ).json()) as { people: { subject: string }[]; nextCursor: null };
    expect(one.people.map((p) => p.subject)).toEqual([w.subject]);
    expect(one.nextCursor).toBeNull();
    // Exact, not a prefix, and an unknown subject is an empty page.
    for (const subject of [w.subject.slice(0, -1), "ps_none"])
      expect(
        await (
          await w.get("u1", [GROUP], `${PEOPLE}?subject=${subject}`)
        ).json(),
      ).toEqual({ enabled: true, people: [], nextCursor: null });
  });

  it("answers an empty list for a product with no people", async () => {
    const w = await setup();
    await w.db.run("DELETE FROM connect_rings");
    const body = await (await w.get("u1", [GROUP], PEOPLE)).json();
    expect(body).toEqual({ enabled: true, people: [], nextCursor: null });
  });

  it("allows the connect area and refuses a member without it", async () => {
    const w = await setup();
    expect((await w.get("m-djdl-connect", [GROUP], PEOPLE)).status).toBe(200);
    const res = await w.get(PRINCIPALS.alphaShip!.memberId, [GROUP], PEOPLE);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(w.subject);
  });

  it("answers { enabled: false } while Connect is off", async () => {
    const w = await setup();
    await enable(w.db, ["license", "identity"]);
    const res = await w.get("u1", [GROUP], PEOPLE);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("GET connect/usage", () => {
  it("zero-fills the window, oldest first, and counts people", async () => {
    const w = await setup();
    await w.db.run(
      "INSERT INTO connect_relay_daily (product, day, bytes, sessions) VALUES (?, ?, 700, 3), (?, ?, 50, 1), (?, ?, 9, 9)",
      SLUG,
      day(NOW),
      SLUG,
      day(NOW - 2 * DAY),
      SLUG,
      day(NOW - 40 * DAY),
    );
    const body = (await (
      await w.get("u1", [GROUP], `${USAGE}?days=7`)
    ).json()) as {
      days: { day: string; bytes: number; sessions: number }[];
      totals: unknown;
      people: number;
    };
    expect(body.days).toHaveLength(7);
    expect(body.days[0]!.day).toBe(day(NOW - 6 * DAY));
    expect(body.days[6]).toEqual({ day: day(NOW), bytes: 700, sessions: 3 });
    expect(body.days[4]).toEqual({
      day: day(NOW - 2 * DAY),
      bytes: 50,
      sessions: 1,
    });
    expect(body.totals).toEqual({ bytes: 750, sessions: 4 });
    expect(body.people).toBe(1);
  });

  it("defaults to 30 days and clamps", async () => {
    const w = await setup();
    const len = async (q: string) =>
      (
        (await (await w.get("u1", [GROUP], `${USAGE}${q}`)).json()) as {
          days: unknown[];
        }
      ).days.length;
    expect(await len("")).toBe(30);
    expect(await len("?days=0")).toBe(1);
    expect(await len("?days=9999")).toBe(90);
    expect(await len("?days=x")).toBe(30);
  });

  it("refuses without the area and answers off when Connect is off", async () => {
    const w = await setup();
    expect(
      (await w.get(PRINCIPALS.alphaShip!.memberId, [GROUP], USAGE)).status,
    ).toBe(403);
    await enable(w.db, ["license", "identity"]);
    expect(await (await w.get("u1", [GROUP], USAGE)).json()).toEqual({
      enabled: false,
    });
  });
});
