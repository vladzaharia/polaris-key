/**
 * HA-06 — `pkey assets push` (`src/assets.ts`): the local checks, the upload ticket and the S3
 * PUTs into its staging prefix, `POST /<p>/assets`, and the stored / kept / refused answer; plus
 * the Action's `assets` map parser and glob resolution.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";
import {
  globToRegExp,
  parseAssetMap,
  resolveAssetMap,
  slotMaxBytes,
  slotProblem,
} from "../src/assets.js";
import {
  BASE,
  CI_TOKEN,
  SLUG,
  capture,
  cleanup,
  fakeServer,
  instant,
  json,
  sha,
  tempDir,
} from "./publishFixture.js";

afterEach(cleanup);

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5,
]);

async function workspace(files: Record<string, Uint8Array>): Promise<string> {
  const cwd = await tempDir();
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(cwd, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return cwd;
}

async function pkey(argv: string[], cwd: string, server = fakeServer()) {
  const io = capture();
  const code = await runPkey(argv, {
    cwd,
    stdout: io.stdout,
    stderr: io.stderr,
    env: { PKEY_CI_TOKEN: CI_TOKEN },
    fetchImpl: server.fetchImpl,
    sleep: instant,
  });
  return { code, out: io.out(), err: io.err(), server };
}

describe("pkey assets push", () => {
  it("uploads the file under a ticket and pushes it into its slot", async () => {
    const cwd = await workspace({ "art/icon.png": PNG });
    const server = fakeServer();
    server.script("/assets", () =>
      json({
        ok: true,
        stored: [
          {
            slot: "presentation.icon",
            locale: "",
            sha256: sha(PNG),
            size: PNG.length,
            contentType: "image/png",
          },
        ],
        kept: [],
        refused: [],
      }),
    );
    const r = await pkey(
      [
        "assets",
        "push",
        "art/icon.png",
        "--slot",
        "presentation.icon",
        "--product",
        SLUG,
        "--base-url",
        BASE,
      ],
      cwd,
      server,
    );
    expect(r.code, r.err).toBe(0);
    const [uploads] = server.to("/release/publish/uploads");
    expect(uploads!.body).toEqual({
      objects: [{ sha256: sha(PNG), size: PNG.length }],
    });
    // The file went to the ticket's staging key, with its digest.
    expect(server.r2.get(`staging/${SLUG}/t1/${sha(PNG)}`)).toEqual(PNG);
    const [pushed] = server.to(`/${SLUG}/assets`);
    expect(pushed!.headers.authorization).toBe(`Bearer ${CI_TOKEN}`);
    expect(pushed!.body).toEqual({
      ticket: expect.stringMatching(/^pkeyup_/),
      assets: [
        { slot: "presentation.icon", sha256: sha(PNG), size: PNG.length },
      ],
    });
    expect(r.out).toContain("Hosted presentation.icon");
    expect(r.out).toContain("1 hosted, 0 kept, 0 refused");
  });

  it("uploads even an object the uploads route reports present, and sends the locale", async () => {
    const cwd = await workspace({ "a.png": PNG });
    const server = fakeServer();
    server.present.add(sha(PNG));
    server.script("/assets", () =>
      json({ ok: true, stored: [], kept: [], refused: [] }),
    );
    const r = await pkey(
      [
        "assets",
        "push",
        "a.png",
        "--slot",
        "play:feature-graphic",
        "--locale",
        "de-DE",
        "--product",
        SLUG,
        "--base-url",
        BASE,
      ],
      cwd,
      server,
    );
    expect(r.code, r.err).toBe(0);
    expect(server.to("/staging/")).toHaveLength(1);
    expect(
      (server.to(`/${SLUG}/assets`)[0]!.body as { assets: unknown[] })
        .assets[0],
    ).toMatchObject({ slot: "play:feature-graphic", locale: "de-DE" });
  });

  it("reports kept slots as a success and refused ones as a failure", async () => {
    const cwd = await workspace({ "a.png": PNG });
    const kept = fakeServer();
    kept.script("/assets", () =>
      json({
        ok: true,
        stored: [],
        kept: [{ slot: "listing.header", locale: "", reason: "console" }],
        refused: [],
      }),
    );
    const args = (slot: string) => [
      "assets",
      "push",
      "a.png",
      "--slot",
      slot,
      "--product",
      SLUG,
      "--base-url",
      BASE,
    ];
    const k = await pkey(args("listing.header"), cwd, kept);
    expect(k.code).toBe(0);
    expect(k.out).toContain("Kept listing.header: the console's upload wins");
    const refused = fakeServer();
    refused.script("/assets", () =>
      json({
        ok: false,
        stored: [],
        kept: [],
        refused: [
          { slot: "listing.screenshot:1", locale: "", reason: "not-an-image" },
        ],
      }),
    );
    const f = await pkey(args("listing.screenshot:1"), cwd, refused);
    expect(f.code).toBe(1);
    expect(f.err).toContain("Refused listing.screenshot:1: not-an-image");
  });

  it("dry run checks the file and sends nothing", async () => {
    const cwd = await workspace({ "a.png": PNG });
    const r = await pkey(
      [
        "assets",
        "push",
        "a.png",
        "--slot",
        "listing.header",
        "--product",
        SLUG,
        "--dry-run",
      ],
      cwd,
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Would push a.png → listing.header");
    expect(r.server.calls).toHaveLength(0);
  });

  it("refuses bad slots, locales, missing or oversized files before sending anything", async () => {
    const cwd = await workspace({
      "a.png": PNG,
      "big.png": new Uint8Array(10 * 1024 * 1024 + 1),
      "empty.png": new Uint8Array(0),
    });
    const fail = async (extra: string[], file = "a.png") => {
      const r = await pkey(
        ["assets", "push", file, "--product", SLUG, ...extra],
        cwd,
      );
      expect(r.code).not.toBe(0);
      expect(r.server.calls).toHaveLength(0);
      return r.err;
    };
    expect(await fail(["--slot", "pack:steam"])).toContain(
      "is not a slot CI can push",
    );
    expect(await fail(["--slot", "listing.screenshot:17"])).toContain(
      "screenshot slots 1 to 16",
    );
    expect(
      await fail(["--slot", "listing.header", "--locale", "Not A Tag"]),
    ).toContain("--locale must be a language tag");
    expect(await fail(["--slot", "listing.header"], "nope.png")).toContain(
      "no such file",
    );
    expect(await fail(["--slot", "listing.header"], "empty.png")).toContain(
      "is empty",
    );
    expect(await fail(["--slot", "presentation.icon"], "big.png")).toContain(
      "takes files up to 10485760 bytes",
    );
    expect(await fail([])).toContain("Usage: pkey assets push");
  });
});

describe("slot rules", () => {
  it("caps icon slots at 10 MiB and the rest at 20 MiB", () => {
    expect(slotMaxBytes("presentation.icon")).toBe(10 * 1024 * 1024);
    expect(slotMaxBytes("play:icon")).toBe(10 * 1024 * 1024);
    expect(slotMaxBytes("listing.header")).toBe(20 * 1024 * 1024);
    expect(slotProblem("listing.screenshot")).toContain("needs its number");
    expect(slotProblem("release-file")).not.toBeNull();
    expect(slotProblem("steam:library-hero")).toBeNull();
  });
});

describe("the assets map", () => {
  it("splits each line at the last ': ', reads @locale and skips comments", () => {
    expect(
      parseAssetMap(
        [
          "# presentation",
          "art/icon.png: presentation.icon",
          "",
          "store/play feature.png: play:feature-graphic@de-DE",
          "  shots/*.png: listing.screenshot  ",
        ].join("\n"),
      ),
    ).toEqual([
      { glob: "art/icon.png", slot: "presentation.icon" },
      {
        glob: "store/play feature.png",
        slot: "play:feature-graphic",
        locale: "de-DE",
      },
      { glob: "shots/*.png", slot: "listing.screenshot" },
    ]);
    expect(() => parseAssetMap("art/icon.png presentation.icon")).toThrow(
      /line 1/,
    );
    expect(() => parseAssetMap("a.png: x@")).toThrow(/line 1/);
    expect(() => parseAssetMap("# only a comment")).toThrow(/names no file/);
  });

  it("matches globs with *, ** and ?", () => {
    expect(globToRegExp("art/*.png").test("art/icon.png")).toBe(true);
    expect(globToRegExp("art/*.png").test("art/x/icon.png")).toBe(false);
    expect(globToRegExp("**/icon.png").test("a/b/icon.png")).toBe(true);
    expect(globToRegExp("**/icon.png").test("icon.png")).toBe(true);
    expect(globToRegExp("shot-?.png").test("shot-1.png")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("numbers an unnumbered screenshot glob's matches and needs exactly one file elsewhere", async () => {
    const base = await workspace({
      "art/icon.png": PNG,
      "shots/02.png": PNG,
      "shots/01.png": PNG,
      "two/a.png": PNG,
      "two/b.png": PNG,
    });
    const entries = await resolveAssetMap(
      base,
      parseAssetMap(
        "art/icon.png: presentation.icon\nshots/*.png: listing.screenshot@fr",
      ),
    );
    expect(
      entries.map((e) => [path.relative(base, e.file), e.slot, e.locale]),
    ).toEqual([
      ["art/icon.png", "presentation.icon", undefined],
      ["shots/01.png", "listing.screenshot:1", "fr"],
      ["shots/02.png", "listing.screenshot:2", "fr"],
    ]);
    await expect(
      resolveAssetMap(base, parseAssetMap("two/*.png: listing.header")),
    ).rejects.toThrow(/matches 2 files/);
    await expect(
      resolveAssetMap(base, parseAssetMap("none/*.png: listing.header")),
    ).rejects.toThrow(/matches no file/);
  });
});
