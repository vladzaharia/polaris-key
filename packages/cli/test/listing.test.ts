// `pkey listing import --godot` (A-18c): the Godot project read without the editor, and the
// two-step import through the admin API.
//
// What is pinned:
//   * the ConfigFile parser on what Godot writes (multi-line dictionaries, constructors, typed
//     containers, escapes, comments), so a real `project.godot` never trips it;
//   * the facts read from the fixture project (`test/fixtures/godot-listing`): names and
//     localized names, versions, bundle ids (a `$genname` template refused), category hints,
//     copyright, company, the icon master from the iOS preset and Android's adaptive layers, each
//     resolved under the project with its digest and PNG size — and NEVER
//     `application/config/description`, the Project Manager's tooltip;
//   * the call sequence: `/manage/api/me` for the CSRF token, then the import WITHOUT a
//     confirmation (the diff; nothing written), and only with `--apply` the same upload again
//     with the diff's digest; a changed diff is printed and fails;
//   * `--dry-run` makes no call at all.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_COOKIE_ENV,
  parseGodotConfig,
  readGodotListing,
  resolveResPath,
  runPkey,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "fixtures", "godot-listing");
const ORIGIN = "https://key.example";
const COOKIE = "__Host-pkey_admin=session-token-value";
const CSRF = "csrf-token-abc123";
const DIGEST = "a".repeat(64);

const sha256 = async (rel: string) =>
  createHash("sha256")
    .update(await readFile(path.join(PROJECT, rel)))
    .digest("hex");

describe("the Godot ConfigFile parser", () => {
  it("reads what Godot writes: sections, strings, dictionaries over lines, constructors", () => {
    const cfg = parseGodotConfig(
      [
        "; comment",
        "config_version=5",
        "",
        "[application]",
        "",
        'config/name="Dice \\"Roll\\"\\n2"',
        "config/name_localized={",
        '"de": "Würfel",',
        '"ja": "\\u30b5\\u30a4"',
        "}",
        'config/features=PackedStringArray("4.4", "Forward Plus")',
        "config/count=-12",
        "config/ratio=1.5e2",
        "config/flag=true",
        "config/none=null",
        'config/typed=Array[String](["a", "b"])',
        'config/name2=&"StringName"',
        "",
        "[preset.0.options]",
        "",
        'multi="line one',
        'line two"',
        '"quoted key"=Color(0.1, 0.2, 0.3, 1)',
      ].join("\n"),
    );
    expect(cfg[""]).toEqual({ config_version: 5 });
    const a = cfg.application!;
    expect(a["config/name"]).toBe('Dice "Roll"\n2');
    expect(a["config/name_localized"]).toEqual({ de: "Würfel", ja: "サイ" });
    expect(a["config/features"]).toEqual({
      $type: "PackedStringArray",
      args: ["4.4", "Forward Plus"],
    });
    expect(a["config/count"]).toBe(-12);
    expect(a["config/ratio"]).toBe(150);
    expect(a["config/flag"]).toBe(true);
    expect(a["config/none"]).toBeNull();
    expect(a["config/typed"]).toEqual({
      $type: "Array[String]",
      args: [["a", "b"]],
    });
    expect(a["config/name2"]).toBe("StringName");
    expect(cfg["preset.0.options"]).toEqual({
      multi: "line one\nline two",
      "quoted key": { $type: "Color", args: [0.1, 0.2, 0.3, 1] },
    });
  });

  it("names the file and line of what it cannot read", () => {
    expect(() =>
      parseGodotConfig('[a]\nkey="unterminated\n', "project.godot"),
    ).toThrow(/^project\.godot:2: unterminated string/);
    expect(() => parseGodotConfig("[a]\nkey=@\n", "x.cfg")).toThrow(
      /^x\.cfg:2: unexpected "@"/,
    );
  });

  it("keeps res:// paths inside the project", () => {
    expect(resolveResPath("/p", "res://icons/a.png")).toBe(
      path.resolve("/p/icons/a.png"),
    );
    expect(resolveResPath("/p", "res://../secret.png")).toBeNull();
    expect(resolveResPath("/p", "uid://abc")).toBeNull();
    expect(resolveResPath("/p", "/etc/passwd")).toBeNull();
  });
});

describe("reading the fixture project", () => {
  it("reads every listing fact, never the description; resolves the icons with digests", async () => {
    const r = await readGodotListing(PROJECT);
    expect(r.presets).toEqual([
      "Android (Android)",
      "iOS (iOS)",
      "macOS (macOS)",
      "Windows Desktop (Windows Desktop)",
    ]);
    expect(r.listing).toEqual({
      project: "godot-listing",
      name: "djdl",
      nameLocalized: { de: "djdl Profi", pt_BR: "djdl Pro" },
      copyright: "2026 Acme Audio Ltd",
      company: "Acme Audio",
      versions: [
        { platform: "project", value: "1.2.0" },
        { platform: "android", value: "1.2.0" },
        { platform: "ios", value: "1.2.0" },
        { platform: "macos", value: "1.2.0" },
        { platform: "windows", value: "1.2.0.0" },
      ],
      bundleIds: [
        { platform: "ios", value: "gg.acme.djdl" },
        { platform: "macos", value: "gg.acme.djdl" },
        { platform: "android", value: "gg.acme.djdl.android" },
      ],
      categoryHints: [
        { platform: "macos", value: "Music" },
        { platform: "android", value: "music" },
      ],
      icons: [
        {
          slot: "icon-master",
          path: "res://icons/app_store_1024.png",
          setting: "icons/app_store_1024x1024",
          sha256: await sha256("icons/app_store_1024.png"),
          width: 1024,
          height: 1024,
        },
        {
          slot: "icon-adaptive-fg",
          path: "res://icons/adaptive_fg.png",
          setting: "launcher_icons/adaptive_foreground_432x432",
          sha256: await sha256("icons/adaptive_fg.png"),
          width: 432,
          height: 432,
        },
        {
          slot: "icon-adaptive-mono",
          path: "res://icons/missing_mono.png",
          setting: "launcher_icons/adaptive_monochrome_432x432",
        },
      ],
    });
    expect(JSON.stringify(r.listing)).not.toContain("tooltip");
    expect(r.warnings).toEqual([
      'launcher_icons/adaptive_monochrome_432x432 "res://icons/missing_mono.png" does not exist in the project',
    ]);
  });

  it("falls back to application/config/icon; a named preset is read even when a template", async () => {
    const r = await readGodotListing(path.join(PROJECT, "project.godot"), {
      presets: ["Android (old)", "Windows Desktop"],
    });
    expect(r.presets).toEqual([
      "Windows Desktop (Windows Desktop)",
      "Android (old) (Android)",
    ]);
    expect(r.listing.icons).toEqual([
      expect.objectContaining({
        slot: "icon-master",
        path: "res://icon.png",
        setting: "application/config/icon",
        width: 256,
      }),
    ]);
    expect(r.listing.bundleIds).toEqual([]);
    expect(r.warnings).toContain(
      'android package/unique_name "com.example.$genname" is a template (it holds $), not an id',
    );
  });

  it("refuses a directory without project.godot", async () => {
    await expect(readGodotListing(HERE)).rejects.toThrow(/No project\.godot/);
  });
});

/** A fake admin API: `/manage/api/me`, then the import (`preview` or `apply` answers). */
function fakeAdmin(answers: {
  preview: Record<string, unknown>;
  apply?: Record<string, unknown> | { status: number; body: unknown };
}) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: input, init, body });
    if (input === `${ORIGIN}/manage/api/me`)
      return new Response(JSON.stringify({ csrf: CSRF }), { status: 200 });
    if (
      input === `${ORIGIN}/manage/api/products/djdl/distribution/listing/import`
    ) {
      if (!body.confirm)
        return new Response(JSON.stringify({ import: answers.preview }), {
          status: 200,
        });
      const a = answers.apply!;
      if ("status" in a && typeof a.status === "number")
        return new Response(JSON.stringify(a.body), { status: a.status });
      return new Response(JSON.stringify({ import: a }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const PREVIEW = {
  applied: false,
  digest: DIGEST,
  createsListing: false,
  defaultLocale: "en-US",
  changes: [
    {
      field: "name",
      action: "keep",
      current: "djdl",
      currentSource: "app-store",
      proposed: "DJDL",
      proposedSource: "godot",
      reason: "app-store outranks godot for this field",
    },
    {
      field: "developerName",
      action: "add",
      current: null,
      currentSource: null,
      proposed: "Acme Audio",
      proposedSource: "godot",
      reason: null,
    },
    {
      field: "locales.de.name",
      action: "replace",
      current: "djdl",
      currentSource: "manifest",
      proposed: "djdl Profi",
      proposedSource: "godot",
      reason: null,
    },
  ],
  refused: [],
  identifiers: [
    {
      kind: "bundleId",
      platform: "ios",
      value: "gg.acme.djdl",
      outlets: [{ outlet: "app-store", value: "gg.acme.djdl", matches: true }],
    },
  ],
  assets: [
    {
      slot: "icon-master",
      ref: "res://icons/app_store_1024.png",
      width: 1024,
      height: 1024,
    },
  ],
  written: [],
};

function io(fetchImpl: typeof fetch, cookie: string | null = COOKIE) {
  let out = "";
  let err = "";
  return {
    io: {
      cwd: HERE,
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
      env: cookie === null ? {} : { [ADMIN_COOKIE_ENV]: cookie },
      fetchImpl,
    },
    out: () => out,
    err: () => err,
  };
}

describe("pkey listing import --godot", () => {
  it("uploads the project's facts and prints the diff; nothing is confirmed without --apply", async () => {
    const admin = fakeAdmin({ preview: PREVIEW });
    const t = io(admin.fetchImpl);
    const code = await runPkey(
      [
        "listing",
        "import",
        "--godot",
        "fixtures/godot-listing",
        "--product",
        "djdl",
        "--base-url",
        ORIGIN,
      ],
      t.io as never,
    );
    expect(t.err()).toBe("");
    expect(code).toBe(0);
    expect(admin.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/manage/api/me`,
      `${ORIGIN}/manage/api/products/djdl/distribution/listing/import`,
    ]);
    const post = admin.calls[1]!;
    expect(new Headers(post.init.headers).get("x-pkey-csrf")).toBe(CSRF);
    expect(new Headers(post.init.headers).get("cookie")).toBe(COOKIE);
    expect(post.body.source).toBe("godot");
    expect(post.body.confirm).toBeUndefined();
    expect(post.body.godot).toMatchObject({
      name: "djdl",
      company: "Acme Audio",
      copyright: "2026 Acme Audio Ltd",
    });
    expect(JSON.stringify(post.body)).not.toContain("tooltip");
    const out = t.out();
    expect(out).toContain(
      'keep     name             "djdl" (kept: app-store outranks godot',
    );
    expect(out).toContain('add      developerName    "Acme Audio"');
    expect(out).toContain('replace  locales.de.name  "djdl" -> "djdl Profi"');
    expect(out).toContain("bundleId (ios) gg.acme.djdl: app-store matches");
    expect(out).toContain(
      "icon icon-master: res://icons/app_store_1024.png (1024x1024)",
    );
    expect(out).toContain(
      "Nothing written. Re-run with --apply to write 2 changes.",
    );
  });

  it("--apply confirms with the preview's digest (and --fields narrows it)", async () => {
    const admin = fakeAdmin({
      preview: PREVIEW,
      apply: { ...PREVIEW, applied: true, written: ["developerName"] },
    });
    const t = io(admin.fetchImpl);
    const code = await runPkey(
      [
        "listing",
        "import",
        "--godot",
        PROJECT,
        "--product",
        "djdl",
        "--base-url",
        ORIGIN,
        "--fields",
        "developerName",
        "--apply",
      ],
      t.io as never,
    );
    expect(t.err()).toBe("");
    expect(code).toBe(0);
    expect(admin.calls).toHaveLength(3);
    expect(admin.calls[2]!.body).toMatchObject({
      source: "godot",
      confirm: DIGEST,
      fields: ["developerName"],
    });
    expect(admin.calls[2]!.body.godot).toEqual(admin.calls[1]!.body.godot);
    expect(t.out()).toContain("Applied 1 change: developerName");
  });

  it("a diff that changed before the confirmation is printed and fails", async () => {
    const admin = fakeAdmin({
      preview: PREVIEW,
      apply: {
        status: 409,
        body: {
          reason: "import_changed",
          message: "changed",
          import: { ...PREVIEW, digest: "b".repeat(64), changes: [] },
        },
      },
    });
    const t = io(admin.fetchImpl);
    const code = await runPkey(
      [
        "listing",
        "import",
        "--godot",
        PROJECT,
        "--product",
        "djdl",
        "--base-url",
        ORIGIN,
        "--apply",
      ],
      t.io as never,
    );
    expect(code).toBe(1);
    expect(t.err()).toContain(
      "changed since the preview, so nothing was written",
    );
    expect(t.err()).toContain("No changes");
  });

  it("--dry-run prints the upload and contacts nothing; refusals cost no call", async () => {
    const admin = fakeAdmin({ preview: PREVIEW });
    const t = io(admin.fetchImpl, null);
    expect(
      await runPkey(
        ["listing", "import", "--godot", PROJECT, "--dry-run"],
        t.io as never,
      ),
    ).toBe(0);
    expect(admin.calls).toEqual([]);
    // The upload, byte for byte as the Worker's own suite replays it (`listingImport.test.ts`).
    expect(JSON.parse(t.out())).toEqual(
      JSON.parse(
        await readFile(
          path.join(HERE, "fixtures", "godot-listing.upload.json"),
          "utf8",
        ),
      ),
    );

    const noCookie = io(admin.fetchImpl, null);
    expect(
      await runPkey(
        ["listing", "import", "--godot", PROJECT, "--product", "djdl"],
        noCookie.io as never,
      ),
    ).toBe(1);
    expect(noCookie.err()).toContain(`${ADMIN_COOKIE_ENV} is not set`);
    expect(noCookie.err()).toContain(
      "`pkey listing import` imports through the admin API",
    );

    const usage = io(admin.fetchImpl);
    expect(await runPkey(["listing", "import"], usage.io as never)).toBe(1);
    expect(usage.err()).toContain("Usage: pkey listing import --godot");
    const fieldsAlone = io(admin.fetchImpl);
    expect(
      await runPkey(
        [
          "listing",
          "import",
          "--godot",
          PROJECT,
          "--product",
          "djdl",
          "--fields",
          "name",
        ],
        fieldsAlone.io as never,
      ),
    ).toBe(1);
    expect(fieldsAlone.err()).toContain("--fields goes with --apply");
    expect(admin.calls).toEqual([]);
  });
});
