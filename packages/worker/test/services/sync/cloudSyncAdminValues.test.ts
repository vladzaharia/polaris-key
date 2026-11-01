/**
 * U-11a.2: the Data tab's values, files and delete routes under
 * `/manage/api/products/<slug>/sync/subjects/<subject>/…`. Admin routes are narrative-only
 * (rule 10). What this pins: another product's subject is `404`, an end-to-end product answers
 * no value and no file (`404`), a request without a fresh step-up is `403 step_up_required` and
 * writes no audit row, each successful action writes exactly one audit row, and a delete takes
 * the object, the directory row and the key ring.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncJson } from "@polaris-key/protocol/sync";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import {
  createRing,
  getRing,
  keyringStore,
} from "../../../src/core/keyring/store.js";
import { cloudSyncStore } from "../../../src/services/sync/subjectStore.js";
import { ADMIN_ROUTES } from "../../../src/console/routes.js";
import { findRoute, levelOf } from "../../../src/console/routeMatch.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { NOW, seedProduct } from "../../seed.js";
import { installDigestStream } from "../../r2Mock.js";
import { hlc, mut, nextId, world, type World } from "./cloudSyncAbuseWorld.js";
import {
  SLUG,
  bytesOf,
  filesWorld,
  push,
  stored,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";

beforeAll(() => installDigestStream());
afterEach(() => vi.restoreAllMocks());

const GROUP = "platform-admins";
const OTHER = "other";
const SECRET = "SECRET-VALUE-9f3a";

async function adminOver(w: World, collections = true) {
  void collections;
  w.env.ADMIN_SESSION_SECRET = "values-admin-secret";
  w.env.PLATFORM_ADMIN_GROUP = GROUP;
  await seedProduct(w.db, OTHER);
  const on = { enabled: true };
  const off = { enabled: false };
  await setServices(
    w.db,
    OTHER,
    serializeServices({
      services: {
        license: on,
        config: on,
        release: off,
        distribution: off,
        update: off,
        identity: on,
        sync: on,
        commerce: off,
        connect: off,
      },
    }),
    "manifest",
    NOW,
  );
  const r = await signIn(
    w.db,
    { issuerKey: "email", subject: "bob@example.com", kind: "email" },
    NOW,
    { unfenced: true, product: { slug: OTHER } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  const otherSubject = r.subject!;
  const csrfOf = new Map<string, string>();
  const session = async (stepUp: boolean) => {
    const made = await consoleTestSession(
      w.env,
      w.db,
      {
        sub: stepUp ? "u-fresh" : "u-stale",
        groups: [GROUP],
        name: "A",
        email: "a@example.test",
        ...(stepUp ? { authTime: NOW - 10, stepUp: true } : {}),
      },
      NOW,
    );
    csrfOf.set(made.token, made.csrf);
    return made.token;
  };
  const fresh = await session(true);
  const stale = await session(false);
  const call = (
    method: "GET" | "POST",
    product: string,
    subject: string,
    tail: string,
    opts: { token?: string; json?: unknown } = {},
  ) => {
    const path = `/api/products/${product}/sync/subjects/${subject}${tail}`;
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${opts.token ?? fresh}`,
          [CSRF_HEADER]: csrfOf.get(opts.token ?? fresh) ?? "",
          ...(opts.json !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
      }),
      w.env,
      w.db,
      path.split("?")[0] as string,
      { now: NOW },
    );
  };
  const audits = (product = SLUG) =>
    w.db.all<{ action: string; target_id: string | null; summary: string }>(
      "SELECT action, target_id, summary FROM audit WHERE product = ? AND action LIKE 'sync.%' ORDER BY rowid",
      product,
    );
  return { otherSubject, fresh, stale, call, audits };
}

const record = (collection: string, id: string, value: SyncJson) => ({
  mutationId: nextId(),
  target: { record: [collection, id] as [string, string] },
  op: "set" as const,
  value,
  editedHlc: hlc,
});

async function serverWorld() {
  const w: FilesWorld = await filesWorld();
  w.env.LAUNCH_SYNC_FILES = "on";
  const a = await adminOver(w);
  return { w, ...a };
}

describe("values", () => {
  it("answers setting values and records in pages, and audits each read once", async () => {
    const { w, call, audits } = await serverWorld();
    await push(w, [mut("ui.theme", "set", { value: SECRET })]);
    for (let at = 0; at < 53; at += 10)
      await push(
        w,
        Array.from({ length: Math.min(10, 53 - at) }, (_, i) =>
          record("big", `r${String(at + i).padStart(3, "0")}`, {
            n: at + i,
          }),
        ),
      );
    const first = await call("GET", SLUG, w.subject, "/values");
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      settings: { key: string; value: unknown; declared: boolean }[];
      records: unknown[];
      next: string | null;
    };
    expect(body.settings).toMatchObject([
      { key: "ui.theme", value: SECRET, declared: false },
    ]);
    expect(body.records).toEqual([]);

    const p1 = (await (
      await call("GET", SLUG, w.subject, "/values?collection=big")
    ).json()) as {
      records: { id: string; value: { n: number }; bytes: number }[];
      next: string | null;
    };
    expect(p1.records).toHaveLength(50);
    expect(p1.records[0]).toMatchObject({ id: "r000", value: { n: 0 } });
    expect(p1.next).toBe("r049");
    const p2 = (await (
      await call(
        "GET",
        SLUG,
        w.subject,
        `/values?collection=big&cursor=${p1.next}`,
      )
    ).json()) as { records: { id: string }[]; next: string | null };
    expect(p2.records.map((r) => r.id)).toEqual(["r050", "r051", "r052"]);
    expect(p2.next).toBeNull();

    const log = await audits();
    expect(log.map((a) => a.action)).toEqual([
      "sync.data.values.view",
      "sync.data.values.view",
      "sync.data.values.view",
    ]);
    expect(JSON.stringify(log)).not.toContain(SECRET);
  });

  it("carries a record's file pointer", async () => {
    const { w, call } = await serverWorld();
    await stored(w, "saves", "s1", bytesOf(1000));
    const body = (await (
      await call("GET", SLUG, w.subject, "/values?collection=saves")
    ).json()) as { records: { id: string; file?: { size: number } }[] };
    expect(body.records[0]).toMatchObject({ id: "s1", file: { size: 1000 } });
  });

  it("needs a fresh step-up, and writes no audit row without one", async () => {
    const { w, call, audits, stale } = await serverWorld();
    const res = await call("GET", SLUG, w.subject, "/values", { token: stale });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "step_up_required",
    );
    expect(await audits()).toEqual([]);
  });

  it("is 404 for another product's subject, a malformed one and a bad collection name", async () => {
    const { w, call, otherSubject, audits } = await serverWorld();
    expect((await call("GET", SLUG, otherSubject, "/values")).status).toBe(404);
    expect((await call("GET", SLUG, "nope", "/values")).status).toBe(404);
    expect(
      (await call("GET", SLUG, w.subject, "/values?collection=a%2Fb")).status,
    ).toBe(400);
    expect(await audits()).toEqual([]);
  });
});

describe("end-to-end product", () => {
  it("answers no values and no file", async () => {
    const w = await world({
      catalog: {
        schemaVersion: 1,
        entries: [],
        cloudSync: { encryption: "e2e" },
      },
      gate: "on",
    });
    const { call, audits } = await adminOver(w);
    await push(w as FilesWorld, [mut("ui.theme", "set", { value: SECRET })]);
    for (const tail of [
      "/values",
      "/values?collection=saves",
      "/files/saves/s1",
      "/files/saves/s1/revisions",
    ])
      expect((await call("GET", SLUG, w.subject, tail)).status).toBe(404);
    expect(await audits()).toEqual([]);
  });
});

describe("files", () => {
  it("downloads the live file or a kept version, and audits the download", async () => {
    const { w, call, audits } = await serverWorld();
    const one = bytesOf(2000, 1);
    const two = bytesOf(3000, 2);
    await stored(w, "big", "g1", one);
    await stored(w, "big", "g1", two, { baseVersion: 1 });
    const live = await call("GET", SLUG, w.subject, "/files/big/g1");
    expect(live.status).toBe(200);
    expect(live.headers.get("content-disposition")).toBe("attachment");
    expect(live.headers.get("cache-control")).toBe("no-store");
    // L-1: the console's security headers, and the file never runs.
    expect(live.headers.get("x-content-type-options")).toBe("nosniff");
    expect(live.headers.get("content-security-policy")).toMatch(/; sandbox$/);
    // The app policy is the base of that header, not just its suffix.
    expect(live.headers.get("content-security-policy")).toMatch(
      /^default-src 'self'; base-uri 'none'/,
    );
    expect(live.headers.get("referrer-policy")).not.toBeNull();
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(two);

    const revs = (await (
      await call("GET", SLUG, w.subject, "/files/big/g1/revisions")
    ).json()) as { revisions: { version: number; size: number }[] };
    expect(revs.revisions).toHaveLength(1);
    expect(revs.revisions[0]).toMatchObject({ size: 2000 });
    const old = await call(
      "GET",
      SLUG,
      w.subject,
      `/files/big/g1?version=${revs.revisions[0]!.version}`,
    );
    expect(new Uint8Array(await old.arrayBuffer())).toEqual(one);

    expect((await audits()).map((a) => a.action)).toEqual([
      "sync.file.download",
      "sync.file.revisions.view",
      "sync.file.download",
    ]);
  });

  it("is 404 for a missing file, 400 for a bad version, 403 without a step-up", async () => {
    const { w, call, stale, otherSubject, audits } = await serverWorld();
    await stored(w, "saves", "s1", bytesOf(10));
    expect(
      (await call("GET", SLUG, w.subject, "/files/saves/ghost")).status,
    ).toBe(404);
    expect(
      (await call("GET", SLUG, w.subject, "/files/saves/s1?version=0")).status,
    ).toBe(400);
    expect(
      (await call("GET", SLUG, w.subject, "/files/saves/s1", { token: stale }))
        .status,
    ).toBe(403);
    expect(
      (await call("GET", SLUG, otherSubject, "/files/saves/s1")).status,
    ).toBe(404);
    expect(await audits()).toEqual([]);
  });
});

describe("delete", () => {
  async function withData() {
    const s = await serverWorld();
    const { w } = s;
    await stored(w, "saves", "s1", bytesOf(100));
    await push(w, [mut("ui.theme", "set", { value: SECRET })]);
    await createRing(w.db, {
      product: SLUG,
      subject: w.subject,
      ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
      rootKid: "kid-1",
      wrap: {
        deviceId: "dev-attack-1",
        ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
        epoch: 1,
        kid: "kid-1",
        kem: 32,
        enc: "E",
        ct: "C",
        by: "dev-attack-1",
      },
      recoveryCt: "R",
      now: NOW - 60,
    });
    return s;
  }

  it("removes the object, its files and the key ring, with one audit row", async () => {
    const { w, call, audits } = await withData();
    expect(w.r2.keys().length).toBeGreaterThan(0);
    const res = await call("POST", SLUG, w.subject, "/delete", {
      json: { confirm: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(w.r2.keys()).toEqual([]);
    expect(await getRing(w.db, SLUG, w.subject)).toBeNull();
    const summary = (await (await call("GET", SLUG, w.subject, "")).json()) as {
      empty: boolean;
      ring: unknown;
    };
    expect(summary.empty).toBe(true);
    expect(summary.ring).toBeNull();
    expect((await audits()).map((a) => a.action)).toEqual([
      "sync.data.delete",
      "sync.data.view",
    ]);
  });

  it.each([
    ["the object's erase", () => vi.spyOn(cloudSyncStore, "delete")],
    ["the key ring's removal", () => vi.spyOn(keyringStore, "delete")],
  ] as const)(
    "leaves one audit row when %s fails (M-1)",
    async (_name, fail) => {
      const { w, call, audits } = await withData();
      fail().mockRejectedValue(new Error("boom"));
      await expect(
        call("POST", SLUG, w.subject, "/delete", { json: { confirm: true } }),
      ).rejects.toThrow("boom");
      expect((await audits()).map((a) => a.action)).toEqual([
        "sync.data.delete",
      ]);
    },
  );

  it("needs a step-up and a confirmation, and is 404 for another product's subject", async () => {
    const { w, call, stale, otherSubject, audits } = await withData();
    expect(
      (
        await call("POST", SLUG, w.subject, "/delete", {
          token: stale,
          json: { confirm: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("POST", SLUG, w.subject, "/delete", { json: {} })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", SLUG, otherSubject, "/delete", {
          json: { confirm: true },
        })
      ).status,
    ).toBe(404);
    expect(await audits()).toEqual([]);
    expect(await getRing(w.db, SLUG, w.subject)).not.toBeNull();
  });
});

describe("level (M-2)", () => {
  const level = (method: "GET" | "POST", tail: string[]) => {
    const m = findRoute(ADMIN_ROUTES, method, [
      "products",
      SLUG,
      "sync",
      "subjects",
      "s",
      ...tail,
    ]);
    if (m.kind !== "route") throw new Error(m.kind);
    return levelOf(m.route);
  };

  it("needs edit to read values, files and revisions, and view for the summary", () => {
    expect(level("GET", ["values"])).toBe("edit");
    expect(level("GET", ["files", "saves", "s1"])).toBe("edit");
    expect(level("GET", ["files", "saves", "s1", "revisions"])).toBe("edit");
    expect(level("GET", [])).toBe("view");
    expect(level("POST", ["delete"])).toBe("edit");
  });
});
