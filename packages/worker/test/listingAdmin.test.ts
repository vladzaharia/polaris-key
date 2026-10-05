/**
 * A-18b — the shared listing model's admin API (narrative-only, `adminApi` route kind), through
 * the real admin dispatcher: create and edit the listing (validated against the model's limits,
 * refused and never cut), locales, overrides, per-release store notes (the default from the
 * release notes with Markdown stripped and a proposed 500-character cut), the fit report, the
 * `.pkey/distribution` import, and the audit row every write leaves.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, seedProduct } from "./seed.js";
import { CONSOLE, enableServices, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

let db: Db;
let env: Env;
const SLUG = "acme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
interface JsonResponse extends Response {
  json(): Promise<Loose>;
}

async function admin(
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution/listing${path}`;
  return (await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full.split("?")[0]!,
    { now: NOW },
  )) as JsonResponse;
}

async function auditRows(): Promise<
  { action: string; summary: string; target_id: string }[]
> {
  return db.all(
    "SELECT action, summary, target_id FROM audit WHERE product = ? ORDER BY at, rowid",
    SLUG,
  );
}

const NOTES = `## What's new

- **Fairer dice**: the [d20](https://x.example) is fixed.
- The d100 is back.

<!-- internal: do not ship -->
Thanks to everyone who reported it.`;

let seq = 0;
async function seedRelease(
  releaseId: string,
  notes: string | null,
): Promise<void> {
  seq += 1;
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, notes, published_at, created_at, modified_at, deliverable_id, seq, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'app', ?, 'stable')`,
    SLUG,
    releaseId,
    releaseId.replace(/^v/, ""),
    notes,
    NOW,
    NOW,
    NOW,
    seq,
  );
}

async function seedOutlet(
  id: string,
  listing: Record<string, unknown> | null,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_outlets
       (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
     VALUES (?, ?, 'altstore', '{}', ?, ?, ?)`,
    SLUG,
    id,
    listing ? JSON.stringify(listing) : null,
    NOW,
    NOW,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
});

describe("the listing: read, create, edit", () => {
  it("answers an empty model with the limits, slots and stores the editor needs", async () => {
    const res = await admin("GET", "");
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.listing).toBeNull();
    expect(v.locales).toEqual([]);
    expect(v.limits).toMatchObject({
      name: 30,
      subtitle: 30,
      shortDescription: 78,
      description: 4000,
      promotionalText: 170,
      releaseNotesShort: 500,
    });
    expect(v.limits.features).toEqual({ maxItems: 20, maxItemChars: 200 });
    expect(v.slots["steam:library-hero"]).toBe("none");
    expect(v.stores.map((s: Loose) => s.store)).toEqual([
      "app-store",
      "play",
      "ms-store",
      "steam",
      "flathub",
      "snap",
      "winget",
      "fdroid",
    ]);
    expect(v.precedence.name).toEqual({
      order: ["app-store", "play", "ms-store", "godot", "manifest", "product"],
      custom: false,
    });
  });

  it("creating needs a default locale; then app and locale fields are stored and audited", async () => {
    const none = await admin("PUT", "", { app: { name: "Diceroll" } });
    expect(none.status).toBe(422);
    expect((await none.json()).fields).toEqual(["defaultLocale"]);

    const res = await admin("PUT", "", {
      app: {
        defaultLocale: "en-US",
        name: "Diceroll",
        urls: {
          website: "https://diceroll.example",
          support: "https://diceroll.example/s",
        },
        tint: "#ff8800",
      },
      locales: {
        "en-US": {
          subtitle: "Roll dice",
          keywords: ["dice", "rpg"],
          features: ["Roll any die"],
        },
      },
      precedence: { name: ["manifest", "app-store"] },
    });
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.listing.app).toEqual({
      defaultLocale: "en-US",
      name: "Diceroll",
      urls: {
        website: "https://diceroll.example",
        support: "https://diceroll.example/s",
      },
      tint: "#ff8800",
    });
    expect(v.listing.source).toBe("admin");
    expect(v.locales).toEqual([
      expect.objectContaining({
        locale: "en-US",
        subtitle: "Roll dice",
        keywords: ["dice", "rpg"],
        features: ["Roll any die"],
        source: "admin",
        modifiedBy: "u1",
      }),
    ]);
    expect(v.precedence.name).toEqual({
      order: ["manifest", "app-store"],
      custom: true,
    });
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(["distribution.listing.update"]);
    expect(rows[0]!.summary).toMatch(
      /^Created the store listing: app\.defaultLocale/,
    );
    // The audit names fields, never their text.
    expect(rows[0]!.summary).not.toContain("Roll dice");

    // Edit: clear a field, add and remove locales.
    await admin("PUT", "", { locales: { "fr-FR": { subtitle: "Lancez" } } });
    const edited = await (
      await admin("PUT", "", {
        app: { tint: null },
        locales: { "fr-FR": null, "de-DE": { subtitle: "Würfeln" } },
      })
    ).json();
    expect(edited.listing.app.tint).toBeUndefined();
    expect(edited.locales.map((l: Loose) => l.locale)).toEqual([
      "de-DE",
      "en-US",
    ]);
    expect((await auditRows()).at(-1)!.summary).toMatch(/fr-FR removed/);
  });

  it("refuses a value over the model's limit, naming it, and stores nothing (never a cut)", async () => {
    await admin("PUT", "", {
      app: { defaultLocale: "en-US", name: "Diceroll" },
    });
    const res = await admin("PUT", "", {
      app: { name: "n".repeat(31) },
      locales: {
        "en-US": {
          shortDescription: "s".repeat(79),
          features: Array(21).fill("f"),
        },
        "not a locale": { subtitle: "x" },
      },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe("invalid_listing");
    expect(body.fields).toEqual([
      "name",
      "locales.en-US.shortDescription",
      "locales.en-US.features",
      "locales.not a locale",
    ]);
    const v = await (await admin("GET", "")).json();
    expect(v.listing.app.name).toBe("Diceroll");
    expect(v.locales).toEqual([]);
    expect((await auditRows()).length).toBe(1);
  });

  it("rejects stray parts and methods", async () => {
    expect((await admin("PUT", "", { bogus: 1 })).status).toBe(422);
    expect((await admin("POST", "")).status).toBe(405);
    expect((await admin("DELETE", "/fit")).status).toBe(405);
  });
});

describe("overrides", () => {
  it("needs a listing, validates store and field, sets and removes, audited", async () => {
    const early = await admin("PUT", "/overrides", {
      store: "steam",
      field: "shortDescription",
      value: "x",
    });
    expect(early.status).toBe(409);
    expect((await early.json()).reason).toBe("no_listing");
    await admin("PUT", "", {
      app: { defaultLocale: "en-US", name: "Diceroll" },
    });

    expect(
      (
        await admin("PUT", "/overrides", {
          store: "nope",
          field: "name",
          value: "x",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin("PUT", "/overrides", {
          store: "steam",
          field: "nope",
          value: "x",
        })
      ).status,
    ).toBe(422);

    // An override may exceed the model (Steam's short description over 78)...
    const long = "s".repeat(200);
    const set = await admin("PUT", "/overrides", {
      store: "steam",
      field: "shortDescription",
      value: long,
    });
    expect(set.status).toBe(200);
    expect((await set.json()).overrides).toEqual([
      expect.objectContaining({
        store: "steam",
        locale: null,
        field: "shortDescription",
        value: long,
        source: "admin",
      }),
    ]);
    // ...and the feeds may be overridden too.
    expect(
      (
        await admin("PUT", "/overrides", {
          store: "altstore",
          locale: "en-US",
          field: "subtitle",
          value: "AltStore only",
        })
      ).status,
    ).toBe(200);

    const removed = await admin("PUT", "/overrides", {
      store: "steam",
      field: "shortDescription",
      value: null,
    });
    expect(removed.status).toBe(200);
    expect((await removed.json()).overrides.map((o: Loose) => o.store)).toEqual(
      ["altstore"],
    );
    expect(
      (
        await admin("PUT", "/overrides", {
          store: "steam",
          field: "shortDescription",
          value: null,
        })
      ).status,
    ).toBe(404);
    expect((await auditRows()).map((r) => r.action)).toEqual([
      "distribution.listing.update",
      "distribution.listing.override",
      "distribution.listing.override",
      "distribution.listing.override.remove",
    ]);
    expect((await auditRows())[1]!.target_id).toBe("steam/*/shortDescription");
  });
});

describe("per-release store notes (S-15 §5.5)", () => {
  it("default from the release notes with Markdown stripped; a cut to 500 is proposed, not stored", async () => {
    await seedRelease("v1.2.0", NOTES);
    const res = await admin("GET", "/release-notes/v1.2.0");
    expect(res.status).toBe(200);
    const { notes, limits } = await res.json();
    expect(limits).toEqual({ short: 500, text: 10000 });
    expect(notes.version).toBe("1.2.0");
    expect(notes.locales).toEqual([
      expect.objectContaining({
        locale: "en-US",
        source: "default",
        short: null,
        proposedShort: null,
        text: "What's new\n\nFairer dice: the d20 is fixed.\nThe d100 is back.\n\nThanks to everyone who reported it.",
      }),
    ]);
    // Nothing was stored by reading.
    expect(await db.all("SELECT * FROM dist_listing_release_notes")).toEqual(
      [],
    );

    const long = "This release rewrites the dice engine. ".repeat(20);
    await seedRelease("v1.3.0", long);
    const proposed = (
      await (await admin("GET", "/release-notes/v1.3.0")).json()
    ).notes.locales[0];
    expect(proposed.text.length).toBeGreaterThan(500);
    expect(proposed.proposedShort.length).toBeLessThanOrEqual(500);
    expect(proposed.proposedShort.endsWith(".")).toBe(true);

    expect((await admin("GET", "/release-notes/v9.9.9")).status).toBe(404);
  });

  it("stores per-locale notes with a short form, validated and audited; removing goes back to the default", async () => {
    await seedRelease("v1.2.0", NOTES);
    const bad = await admin("PUT", "/release-notes/v1.2.0", {
      locale: "en-US",
      text: "ok",
      short: "s".repeat(501),
    });
    expect(bad.status).toBe(422);
    expect((await bad.json()).fields).toEqual(["short"]);
    expect(
      (
        await admin("PUT", "/release-notes/v1.2.0", {
          locale: "nope",
          text: "ok",
        })
      ).status,
    ).toBe(422);

    const put = await admin("PUT", "/release-notes/v1.2.0", {
      locale: "fr-FR",
      text: "Dés plus justes.",
      short: "Dés justes.",
    });
    expect(put.status).toBe(200);
    const locales = (await put.json()).notes.locales;
    expect(locales.map((l: Loose) => [l.locale, l.source])).toEqual([
      ["en-US", "default"],
      ["fr-FR", "admin"],
    ]);
    expect(locales[1]).toMatchObject({
      text: "Dés plus justes.",
      short: "Dés justes.",
      modifiedBy: "u1",
    });

    await admin("PUT", "/release-notes/v1.2.0", {
      locale: "en-US",
      text: "Fairer dice.",
    });
    const after = (await (await admin("GET", "/release-notes/v1.2.0")).json())
      .notes.locales;
    expect(after.map((l: Loose) => [l.locale, l.source, l.text])).toEqual([
      ["en-US", "admin", "Fairer dice."],
      ["fr-FR", "admin", "Dés plus justes."],
    ]);
    const del = await admin("PUT", "/release-notes/v1.2.0", {
      locale: "en-US",
      text: null,
    });
    expect(del.status).toBe(200);
    expect((await del.json()).notes.locales[0].source).toBe("default");
    expect(
      (
        await admin("PUT", "/release-notes/v1.2.0", {
          locale: "en-US",
          text: null,
        })
      ).status,
    ).toBe(404);
    expect((await auditRows()).map((r) => [r.action, r.target_id])).toEqual([
      ["distribution.listing.notes", "v1.2.0"],
      ["distribution.listing.notes", "v1.2.0"],
      ["distribution.listing.notes.remove", "v1.2.0"],
    ]);
  });
});

describe("the fit report", () => {
  it("grades every store; with a release, its notes are projected (red on Play when over 500, with a proposal)", async () => {
    const empty = await (await admin("GET", "/fit")).json();
    expect(empty.exists).toBe(false);
    expect(empty.stores.every((s: Loose) => s.status === "red")).toBe(true);

    await admin("PUT", "", {
      app: {
        defaultLocale: "en-US",
        name: "Diceroll",
        developerName: "Vlad",
        contactEmail: "s@diceroll.example",
        urls: { support: "https://diceroll.example/s" },
      },
      locales: {
        "en-US": {
          subtitle: "Roll dice with friends",
          shortDescription: "A tiny dice roller.",
          description: "Diceroll rolls dice.",
        },
      },
    });
    await seedRelease(
      "v1.3.0",
      "This release rewrites the dice engine. ".repeat(20),
    );
    const res = await admin("GET", "/fit?release=v1.3.0");
    expect(res.status).toBe(200);
    const report = await res.json();
    const by = Object.fromEntries(
      report.stores.map((s: Loose) => [s.store, s]),
    );
    expect(by["app-store"].status).toBe("green");
    expect(by["app-store"].payload.locales["en-US"].whatsNew).toMatch(
      /^This release/,
    );
    expect(by.play.status).toBe("red");
    expect(by.play.payload).toBeNull();
    const notes = by.play.issues.find((i: Loose) => i.field === "releaseNotes");
    expect(notes).toMatchObject({ issue: "too_long", limit: 500 });
    expect(notes.proposal.length).toBeLessThanOrEqual(500);
    expect(by.fdroid.status).toBe("red");

    const one = await (await admin("GET", "/fit?store=snap")).json();
    expect(one.stores.map((s: Loose) => s.store)).toEqual(["snap"]);
    expect((await admin("GET", "/fit?store=nope")).status).toBe(422);
    expect((await admin("GET", "/fit?release=v9")).status).toBe(404);
    // Reading the report writes nothing.
    expect((await auditRows()).length).toBe(1);
  });
});

describe("import from .pkey/distribution listing (A-18c: preview, then confirm)", () => {
  const LISTING = {
    name: "Diceroll",
    subtitle: "Roll dice with friends",
    description: "Diceroll rolls dice.",
    developerName: "Vlad",
    tintColor: "#ff8800",
    website: "https://diceroll.example",
    iconUrl: "https://diceroll.example/icon.png",
    screenshots: ["https://diceroll.example/1.png"],
  };

  /** Preview the import, then apply it with the preview's digest. */
  async function importApplied(body: Record<string, unknown>) {
    const preview = await (await admin("POST", "/import", body)).json();
    const res = await admin("POST", "/import", {
      ...body,
      confirm: preview.import.digest,
    });
    expect(res.status).toBe(200);
    return { preview: preview.import, applied: await res.json() };
  }

  const fieldsOf = (changes: Loose[], action?: string) =>
    changes.filter((c) => !action || c.action === action).map((c) => c.field);

  it("previews the manifest listing an outlet shows, writes nothing; applying stores it, source import", async () => {
    await seedOutlet("altstore", LISTING);
    const res = await admin("POST", "/import", { source: "manifest" });
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.import).toMatchObject({
      applied: false,
      createsListing: true,
      defaultLocale: "en-US",
      sources: [{ source: "manifest", ref: "altstore", ok: true }],
      refused: [],
      written: [],
    });
    expect(v.import.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fieldsOf(v.import.changes, "add")).toEqual([
      "name",
      "developerName",
      "tint",
      "urls.website",
      "locales.en-US.subtitle",
      "locales.en-US.description",
    ]);
    expect(v.import.changes[0]).toMatchObject({
      field: "name",
      action: "add",
      current: null,
      currentSource: null,
      proposed: "Diceroll",
      proposedSource: "manifest",
    });
    expect(v.import.skipped).toEqual([
      {
        source: "manifest",
        field: "iconUrl",
        reason: expect.stringMatching(/not imported/),
      },
      {
        source: "manifest",
        field: "screenshots",
        reason: expect.stringMatching(/not imported/),
      },
    ]);
    // A preview writes nothing.
    expect(v.listing).toBeNull();
    expect(await auditRows()).toEqual([]);

    const applied = await (
      await admin("POST", "/import", {
        source: "manifest",
        confirm: v.import.digest,
      })
    ).json();
    expect(applied.import.applied).toBe(true);
    expect(applied.import.written).toHaveLength(6);
    expect(applied.listing.source).toBe("import");
    expect(applied.listing.app).toEqual({
      defaultLocale: "en-US",
      name: "Diceroll",
      developerName: "Vlad",
      tint: "#ff8800",
      urls: { website: "https://diceroll.example" },
    });
    expect(applied.listing.provenance).toEqual({
      name: "manifest",
      developerName: "manifest",
      tint: "manifest",
      "urls.website": "manifest",
    });
    expect(applied.locales[0]).toMatchObject({
      locale: "en-US",
      subtitle: LISTING.subtitle,
      source: "import",
      provenance: { subtitle: "manifest", description: "manifest" },
    });
    const audits = await auditRows();
    expect(audits.map((r) => r.action)).toEqual([
      "distribution.listing.import",
    ]);
    // The audit row names the fields and the source, never the text.
    expect(audits[0]!.summary).toContain("from manifest: name, developerName");
    expect(audits[0]!.summary).not.toContain("Diceroll");
    // A second import has nothing to change and leaves no audit row.
    const again = await importApplied({ source: "manifest" });
    expect(again.preview.changes).toEqual([]);
    expect(again.applied.import.written).toEqual([]);
    expect((await auditRows()).length).toBe(1);
  });

  it("keeps an operator's values unless overwrite, refuses an over-limit value (never cut)", async () => {
    await seedOutlet("altstore", {
      ...LISTING,
      name: "Diceroll: the tabletop dice roller",
    });
    await admin("PUT", "", {
      app: { defaultLocale: "en-US", developerName: "Ada" },
      locales: { "en-US": { subtitle: "Mine" } },
    });
    const { preview, applied: v } = await importApplied({
      source: "manifest",
    });
    expect(
      preview.changes
        .filter((c: Loose) => c.action === "keep")
        .map((c: Loose) => [c.field, c.currentSource, c.reason]),
    ).toEqual([
      ["developerName", "admin", "typed by an operator"],
      ["locales.en-US.subtitle", "admin", "typed by an operator"],
    ]);
    expect(preview.refused).toEqual([
      {
        field: "name",
        message: "name must be at most 30 characters (it is 34)",
        source: "manifest",
      },
    ]);
    expect(v.import.written).toEqual([
      "tint",
      "urls.website",
      "locales.en-US.description",
    ]);
    expect(v.listing.app.developerName).toBe("Ada");
    expect(v.listing.app.name).toBeUndefined();
    // The applied rows carry source = 'import'; the operator's fields keep no import source.
    expect(v.listing.source).toBe("import");
    expect(v.listing.provenance).toEqual({
      tint: "manifest",
      "urls.website": "manifest",
    });

    const over = await importApplied({ source: "manifest", overwrite: true });
    expect(over.applied.import.written).toEqual([
      "developerName",
      "locales.en-US.subtitle",
    ]);
    expect(over.applied.listing.app.developerName).toBe("Vlad");
  });

  it("an operator's edit takes a field over from the import; an unchanged re-send does not", async () => {
    await seedOutlet("altstore", LISTING);
    await importApplied({ source: "manifest" });
    await admin("PUT", "", {
      app: {
        name: "Diceroll Deluxe",
        urls: { website: "https://diceroll.example" },
      },
    });
    const v = await (await admin("GET", "")).json();
    expect(v.listing.source).toBe("admin");
    expect(v.listing.provenance).toEqual({
      developerName: "manifest",
      tint: "manifest",
      "urls.website": "manifest",
    });
    const again = await (
      await admin("POST", "/import", { source: "manifest" })
    ).json();
    expect(
      again.import.changes.map((c: Loose) => [c.field, c.action, c.reason]),
    ).toEqual([["name", "keep", "typed by an operator"]]);
  });

  it("a stale confirmation is refused with the fresh diff; fields narrow an apply", async () => {
    await seedOutlet("altstore", LISTING);
    const first = await (
      await admin("POST", "/import", { source: "manifest" })
    ).json();
    // The listing changes between the preview and the confirmation.
    await admin("PUT", "", { app: { defaultLocale: "en-US", name: "Mine" } });
    const stale = await admin("POST", "/import", {
      source: "manifest",
      confirm: first.import.digest,
    });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.reason).toBe("import_changed");
    expect(body.import.digest).not.toBe(first.import.digest);
    expect((await (await admin("GET", "")).json()).listing.app.tint).toBe(
      undefined,
    );

    const partial = await admin("POST", "/import", {
      source: "manifest",
      confirm: body.import.digest,
      fields: ["tint"],
    });
    expect(partial.status).toBe(200);
    const p = await partial.json();
    expect(p.import.written).toEqual(["tint"]);
    expect(p.listing.app).toEqual({
      defaultLocale: "en-US",
      name: "Mine",
      tint: "#ff8800",
    });
    const unknown = await admin("POST", "/import", {
      source: "manifest",
      confirm: (
        await (await admin("POST", "/import", { source: "manifest" })).json()
      ).import.digest,
      fields: ["name"],
    });
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).reason).toBe("unknown_fields");
    expect(
      (await admin("POST", "/import", { source: "manifest", fields: ["tint"] }))
        .status,
    ).toBe(422);
  });

  it("names the outlet; refuses unknown sources and outlets without a listing", async () => {
    await seedOutlet("altstore", null);
    await seedOutlet("beta", { name: "Diceroll Beta" });
    expect((await admin("POST", "/import", { source: "nope" })).status).toBe(
      422,
    );
    expect((await admin("POST", "/import", { source: "godot" })).status).toBe(
      422,
    );
    expect(
      (
        await admin("POST", "/import", {
          sources: [{ source: "manifest" }, { source: "manifest" }],
        })
      ).status,
    ).toBe(422);
    const missing = await admin("POST", "/import", {
      source: "manifest",
      outlet: "altstore",
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).reason).toBe("no_manifest_listing");
    const { preview, applied: v } = await importApplied({
      source: "manifest",
      locale: "de-DE",
    });
    expect(preview.sources[0].ref).toBe("beta");
    expect(v.listing.app).toEqual({
      defaultLocale: "de-DE",
      name: "Diceroll Beta",
    });
  });
});
