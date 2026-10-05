/**
 * A-18d — `pkey listing assets`: derived icons, composed store art, screenshot fit proposals and
 * the upload into the listing model.
 *
 *   - Golden-image tests: every derived and composed slot, and every fitted screenshot, made from
 *     generated fixture inputs, is pinned by its pixel hash (`pkey-pixels/1`, the pixels before
 *     encoding) in `test/fixtures/listing-assets/golden.json`. The pixel operations are integer
 *     arithmetic (`src/listing/raster.ts`), so the hashes are the same on every platform.
 *     `UPDATE_LISTING_GOLDENS=1` rewrites the file after a deliberate change.
 *   - Each output's dimensions, alpha and format are checked against S-15 §7.4's table, written
 *     out again here (not read from `specs.ts`), and against the encoded file itself.
 *   - The §5.6 screenshot cases: iPhone 6.9" for Play, iPad 13" for Play, Mac 16:10 for Steam,
 *     each proposal applied only when accepted.
 *   - The slot names and text rules agree with the Worker's listing model.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  listingAssets,
  type ListingAssetsOptions,
  type ListingAssetsReport,
} from "../src/listingAssets.js";
import { runPkey } from "../src/index.js";
import {
  composite,
  fill,
  makeRaster,
  pixelSha256,
  resize,
  coverRect,
  type Raster,
} from "../src/listing/raster.js";
import { analyseAdaptive, parseFocal } from "../src/listing/derive.js";
import { encodePng } from "../src/listing/io.js";
import { MASTER_RULES, PACK_STORES, SLOT_SPECS } from "../src/listing/specs.js";
import { withZip } from "../src/zip.js";
import {
  LISTING_ASSET_SLOTS,
  listingAssetRule,
} from "../../worker/src/core/storefront/listingModel.js";
import {
  BASE,
  CI_TOKEN,
  SLUG,
  cleanup,
  fakeServer,
  json,
  tempDir,
} from "./publishFixture.js";

const GOLDEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "listing-assets",
  "golden.json",
);
const UPDATE = process.env.UPDATE_LISTING_GOLDENS === "1";

afterEach(cleanup);

// ── Fixture inputs, generated (deterministic, no committed images) ─────────────────────────────

function disc(
  r: Raster,
  cx: number,
  cy: number,
  radius: number,
  c: readonly number[],
): void {
  for (
    let y = Math.max(0, cy - radius);
    y < Math.min(r.height, cy + radius);
    y++
  )
    for (
      let x = Math.max(0, cx - radius);
      x < Math.min(r.width, cx + radius);
      x++
    ) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) continue;
      const i = (y * r.width + x) * 4;
      r.data[i] = c[0]!;
      r.data[i + 1] = c[1]!;
      r.data[i + 2] = c[2]!;
      r.data[i + 3] = c[3] ?? 255;
    }
}

function rect(
  r: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
  c: readonly number[],
): void {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * r.width + x) * 4;
      r.data[i] = c[0]!;
      r.data[i + 1] = c[1]!;
      r.data[i + 2] = c[2]!;
      r.data[i + 3] = c[3] ?? 255;
    }
}

/** A busy, asymmetric picture: gradients, a checker band and discs, so any shift shows. */
function scene(w: number, h: number, seed: number): Raster {
  const r = makeRaster(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      r.data[i] = Math.floor((x * 255) / (w - 1));
      r.data[i + 1] = Math.floor((y * 255) / (h - 1));
      r.data[i + 2] = ((x >> 5) + (y >> 5) + seed) % 2 === 0 ? 40 : 200;
      r.data[i + 3] = 255;
    }
  disc(
    r,
    Math.floor(w * 0.3),
    Math.floor(h * 0.4),
    Math.floor(Math.min(w, h) * 0.18),
    [250, 240, 30],
  );
  disc(
    r,
    Math.floor(w * 0.75),
    Math.floor(h * 0.65),
    Math.floor(Math.min(w, h) * 0.1),
    [20, 30, 220],
  );
  rect(
    r,
    Math.floor(w * 0.05),
    Math.floor(h * 0.85),
    Math.floor(w * 0.4),
    Math.floor(h * 0.05),
    [255, 255, 255],
  );
  return r;
}

/** An icon master: a mark on transparency, inside the central 61 % unless `full`. */
function iconMaster(opts: { full?: boolean; opaque?: boolean } = {}): Raster {
  const r = opts.opaque
    ? fill(1024, 1024, [18, 22, 40, 255])
    : makeRaster(1024, 1024);
  if (opts.full) {
    rect(r, 40, 40, 944, 944, [154, 92, 255]);
    disc(r, 512, 512, 300, [255, 194, 77]);
  } else {
    disc(r, 512, 512, 280, [154, 92, 255]);
    rect(r, 430, 300, 164, 424, [255, 255, 255]);
  }
  return r;
}

/** A wordmark: three letter-ish blocks on transparency, with a transparent margin to trim. */
function wordmark(): Raster {
  const r = makeRaster(1800, 440);
  rect(r, 100, 100, 400, 240, [255, 255, 255]);
  rect(r, 560, 100, 400, 240, [255, 194, 77]);
  disc(r, 1200, 220, 120, [255, 255, 255]);
  rect(r, 1380, 160, 250, 120, [255, 255, 255, 128]);
  return r;
}

interface Inputs {
  dir: string;
  icon: string;
  keyArt: string;
  keyArtPortrait: string;
  wordmark: string;
  screenshots: string;
}

let fixtures: Inputs;

async function writePng(file: string, r: Raster): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await encodePng(r));
  return file;
}

beforeAll(async () => {
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    ".cache",
    "listing-assets-fixtures",
  );
  const shots = path.join(dir, "shots");
  fixtures = {
    dir,
    icon: await writePng(path.join(dir, "icon.png"), iconMaster()),
    // 16:9 at 4000 wide: covers Steam's 3840x1240 hero and the 3840x2160 super hero.
    keyArt: await writePng(path.join(dir, "key-art.png"), scene(4000, 2250, 0)),
    keyArtPortrait: await writePng(
      path.join(dir, "key-art-portrait.png"),
      scene(1500, 2250, 1),
    ),
    wordmark: await writePng(path.join(dir, "wordmark.png"), wordmark()),
    screenshots: shots,
  };
  // S-15 §5.6's devices.
  await writePng(
    path.join(shots, "phone-portrait", "01-menu.png"),
    scene(1320, 2868, 2),
  );
  await writePng(
    path.join(shots, "tablet", "01-board.png"),
    scene(2064, 2752, 3),
  );
  await writePng(
    path.join(shots, "desktop-16x10", "01-mac.png"),
    scene(2880, 1800, 4),
  );
  await writePng(
    path.join(shots, "desktop-16x9", "01-game.png"),
    scene(1920, 1080, 5),
  );
}, 120_000);

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
    get out() {
      return stdout;
    },
    get err() {
      return stderr;
    },
  };
}

async function run(
  extra: Partial<ListingAssetsOptions> = {},
): Promise<{ report: ListingAssetsReport; dir: string; out: string }> {
  const cwd = await tempDir();
  const io = capture();
  const result = await listingAssets({
    cwd,
    out: "assets",
    icon: fixtures.icon,
    keyArt: fixtures.keyArt,
    keyArtPortrait: fixtures.keyArtPortrait,
    wordmark: fixtures.wordmark,
    screenshots: fixtures.screenshots,
    focal: "0.3,0.4",
    env: {},
    stdout: io.stdout,
    stderr: io.stderr,
    ...extra,
  });
  return { report: result.report, dir: result.dir, out: io.out };
}

// ── S-15 §7.4, written out again ───────────────────────────────────────────────────────────────

type Spec = { w: number; h: number; alpha: boolean; format: "png" | "jpeg" };
const SPEC: Record<string, Spec | ((w: number, h: number) => boolean)> = {
  "play:icon": { w: 512, h: 512, alpha: true, format: "png" },
  "ms-store:tile": { w: 300, h: 300, alpha: true, format: "png" },
  "steam:community-icon": { w: 184, h: 184, alpha: false, format: "jpeg" },
  "steam:shortcut-icon": { w: 256, h: 256, alpha: true, format: "png" },
  "flathub:icon": { w: 512, h: 512, alpha: true, format: "png" },
  "snap:icon": { w: 512, h: 512, alpha: true, format: "png" },
  "winget:icon": { w: 256, h: 256, alpha: true, format: "png" },
  "fdroid:icon": { w: 512, h: 512, alpha: true, format: "png" },
  "icon-adaptive-fg": { w: 432, h: 432, alpha: true, format: "png" },
  "icon-adaptive-bg": { w: 432, h: 432, alpha: false, format: "png" },
  "icon-adaptive-mono": { w: 432, h: 432, alpha: true, format: "png" },
  // 1024x500, JPEG or 24-bit PNG, no alpha.
  "play:feature-graphic": { w: 1024, h: 500, alpha: false, format: "png" },
  "fdroid:feature-graphic": { w: 1024, h: 500, alpha: false, format: "png" },
  "steam:header-capsule": { w: 920, h: 430, alpha: false, format: "png" },
  "steam:main-capsule": { w: 1232, h: 706, alpha: false, format: "png" },
  "steam:vertical-capsule": { w: 748, h: 896, alpha: false, format: "png" },
  "steam:small-capsule": { w: 462, h: 174, alpha: false, format: "png" },
  "steam:library-capsule": { w: 600, h: 900, alpha: false, format: "png" },
  "steam:library-header": { w: 920, h: 430, alpha: false, format: "png" },
  "steam:library-hero": { w: 3840, h: 1240, alpha: false, format: "png" },
  // "1280 wide or 720 tall", transparent.
  "steam:library-logo": (w, h) => w === 1280 || h === 720,
  "steam:page-background": { w: 1438, h: 810, alpha: false, format: "png" },
  "ms-store:super-hero": { w: 3840, h: 2160, alpha: false, format: "png" },
  "ms-store:poster": { w: 1440, h: 2160, alpha: false, format: "png" },
  "ms-store:box-art": { w: 2160, h: 2160, alpha: false, format: "png" },
  // 315:250, 630x500 recommended.
  "itch:cover": { w: 630, h: 500, alpha: false, format: "png" },
  // 3:1, 1920x640 recommended.
  "snap:banner": { w: 1920, h: 640, alpha: false, format: "png" },
};

const TEXT_RULES: Record<string, "none" | "title" | "free"> = {
  "steam:library-hero": "none",
  "ms-store:super-hero": "none",
  "steam:page-background": "none",
  "ms-store:poster": "title",
  "ms-store:box-art": "title",
  "steam:header-capsule": "title",
  "play:feature-graphic": "title",
};

describe("pkey listing assets: golden images", () => {
  it("derives and composes every slot to its pinned pixels, and fits the screenshots", async () => {
    const { report, dir } = await run({
      accept: ["play/phone-portrait/01-menu"],
      pad: ["steam/desktop-16x10/01-mac"],
    });
    const actual: Record<string, unknown> = {};
    for (const s of report.slots)
      actual[s.slot] = {
        status: s.status,
        width: s.width ?? null,
        height: s.height ?? null,
        pixelSha256: s.pixelSha256 ?? null,
      };
    for (const s of report.screenshots)
      actual[s.id] = {
        status: s.status,
        width: s.width ?? null,
        height: s.height ?? null,
        pixelSha256: s.pixelSha256 ?? null,
      };
    if (UPDATE) {
      await mkdir(path.dirname(GOLDEN), { recursive: true });
      await writeFile(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as Record<
      string,
      unknown
    >;
    expect(actual).toEqual(golden);
    // Every derived and composed slot is covered, with pixels.
    for (const spec of SLOT_SPECS) {
      const s = report.slots.find((x) => x.slot === spec.slot)!;
      expect(s.pixelSha256, spec.slot).toMatch(/^[0-9a-f]{64}$/);
      expect(s.status, `${spec.slot}: ${s.notes.join("; ")}`).toBe("ok");
    }
    // A lossless output decodes back to exactly the hashed pixels.
    for (const s of [...report.slots, ...report.screenshots]) {
      if (!s.file || s.format !== "png") continue;
      const n = s.alpha ? 4 : 3;
      const { data, info } = await sharp(path.join(dir, s.file))
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.channels, s.file).toBe(n);
      expect(
        pixelSha256(info.width, info.height, n, new Uint8Array(data)),
        s.file,
      ).toBe(s.pixelSha256);
    }
  }, 180_000);

  it("is deterministic: a second run writes the same pixels and bytes", async () => {
    const a = await run();
    const b = await run();
    expect(
      b.report.slots.map((s) => [s.slot, s.pixelSha256, s.sha256]),
    ).toEqual(a.report.slots.map((s) => [s.slot, s.pixelSha256, s.sha256]));
    expect(b.report.packs).toEqual(a.report.packs);
  }, 180_000);
});

describe("pkey listing assets: each output matches S-15 §7.4", () => {
  it("has the slot's dimensions, alpha and format, in the report and in the file", async () => {
    const { report, dir } = await run();
    expect(report.slots.map((s) => s.slot).sort()).toEqual(
      Object.keys(SPEC).sort(),
    );
    for (const s of report.slots) {
      const spec = SPEC[s.slot]!;
      const meta = await sharp(path.join(dir, s.file!)).metadata();
      expect([meta.width, meta.height], s.slot).toEqual([s.width, s.height]);
      if (typeof spec === "function") {
        expect(
          spec(s.width!, s.height!),
          `${s.slot} ${s.width}x${s.height}`,
        ).toBe(true);
        expect(meta.hasAlpha, s.slot).toBe(true);
        expect(meta.format).toBe("png");
        continue;
      }
      expect([s.width, s.height], s.slot).toEqual([spec.w, spec.h]);
      expect(s.alpha, s.slot).toBe(spec.alpha);
      expect(meta.hasAlpha, s.slot).toBe(spec.alpha);
      expect(meta.format, s.slot).toBe(spec.format);
      expect(s.format, s.slot).toBe(spec.format);
    }
    // Play's icon stays under its 1 MB cap; Play outputs say NotAiGenerated.
    expect(
      report.slots.find((s) => s.slot === "play:icon")!.size!,
    ).toBeLessThan(1024 * 1024);
    for (const s of report.slots.filter((x) => x.store === "play"))
      expect(s.aiGeneratedState, s.slot).toBe("NotAiGenerated");
    expect(
      report.slots.find((s) => s.slot === "steam:header-capsule")!
        .aiGeneratedState,
    ).toBeUndefined();
    for (const [slot, rule] of Object.entries(TEXT_RULES))
      expect(report.slots.find((s) => s.slot === slot)!.textAllowed, slot).toBe(
        rule,
      );
  }, 180_000);

  it("never puts the wordmark on a no-text slot", async () => {
    // The same key art with and without a wordmark: a `none` slot's pixels do not change, every
    // `title` slot's do.
    const a = await run({ screenshots: undefined });
    const b = await run({ screenshots: undefined, wordmark: undefined });
    for (const s of a.report.slots) {
      const other = b.report.slots.find((x) => x.slot === s.slot)!;
      if (s.textAllowed === "none")
        expect(other.pixelSha256, s.slot).toBe(s.pixelSha256);
      if (s.textAllowed === "title" && s.slot !== "steam:library-logo") {
        expect(other.pixelSha256, s.slot).not.toBe(s.pixelSha256);
        expect(other.status, s.slot).toBe("red");
      }
    }
    expect(
      b.report.slots.find((s) => s.slot === "steam:library-logo")!.status,
    ).toBe("missing");
  }, 180_000);

  it("crops around the focal point", async () => {
    expect(coverRect(4000, 2250, 1, 1, parseFocal("0.3,0.4"))).toEqual({
      x: 75,
      y: 0,
      width: 2250,
      height: 2250,
    });
    expect(coverRect(4000, 2250, 1, 1, { x: 0, y: 0 }).x).toBe(0);
    expect(coverRect(4000, 2250, 1, 1, { x: 1, y: 1 }).x).toBe(1750);
    const left = await run({ screenshots: undefined, focal: "0,0.5" });
    const right = await run({ screenshots: undefined, focal: "1,0.5" });
    const box = (r: ListingAssetsReport) =>
      r.slots.find((s) => s.slot === "ms-store:box-art")!.pixelSha256;
    expect(box(left.report)).not.toBe(box(right.report));
  }, 180_000);
});

describe("pkey listing assets: screenshots (S-15 §5.6)", () => {
  it('proposes a crop for iPhone 6.9" on Play and a crop for Mac 16:10 on Steam, used only when accepted', async () => {
    const { report, dir, out } = await run();
    const phone = report.screenshots.find(
      (s) => s.id === "play/phone-portrait/01-menu",
    )!;
    expect(phone.status).toBe("pending");
    expect(phone.problems.join()).toContain("2.17:1");
    expect(phone.proposal).toEqual({
      crop: { x: 0, y: 114, width: 1320, height: 2640 },
      pad: { width: 1434, height: 2868 },
    });
    expect(phone.file).toBe("proposals/play/phone-portrait/01-menu.png");
    expect(out).toContain("--accept play/phone-portrait/01-menu");
    const tablet = report.screenshots.find(
      (s) => s.id === "play/tablet/01-board",
    )!;
    expect(tablet).toMatchObject({
      status: "fits",
      method: "as-is",
      width: 2064,
      height: 2752,
    });
    const mac = report.screenshots.find(
      (s) => s.id === "steam/desktop-16x10/01-mac",
    )!;
    expect(mac.status).toBe("pending");
    expect(mac.proposal).toEqual({
      crop: { x: 0, y: 90, width: 2880, height: 1620 },
      pad: { width: 3200, height: 1800 },
    });
    // The Mac shot already fits the Microsoft Store (≥ 1366x768) and the App Store's Mac size.
    expect(
      report.screenshots.find((s) => s.id === "ms-store/desktop-16x10/01-mac")!
        .status,
    ).toBe("fits");
    expect(
      report.screenshots.find((s) => s.id === "app-store/desktop-16x10/01-mac")!
        .status,
    ).toBe("fits");
    expect(
      report.screenshots.find(
        (s) => s.id === "app-store/phone-portrait/01-menu",
      )!.status,
    ).toBe("fits");
    // 1920x1080 is Steam's exact minimum.
    expect(
      report.screenshots.find((s) => s.id === "steam/desktop-16x9/01-game")!
        .status,
    ).toBe("fits");
    // A pending proposal is in no pack.
    const names = await withZip(path.join(dir, "packs/steam.zip"), (z) =>
      Promise.resolve(z.entries.map((e) => e.name)),
    );
    expect(names).not.toContain("screenshots/desktop-16x10/01.png");
    expect(names).toContain("screenshots/desktop-16x9/01.png");
    expect(names).toContain("library-hero.png");
    expect(names).toContain("assets.json");
  }, 180_000);

  it("applies an accepted crop, or a pad, per image", async () => {
    const { report } = await run({
      accept: ["play/phone-portrait/01-menu", "steam/desktop-16x10/01-mac"],
    });
    expect(
      report.screenshots.find((s) => s.id === "play/phone-portrait/01-menu"),
    ).toMatchObject({
      status: "accepted",
      method: "crop",
      width: 1320,
      height: 2640,
      slot: "play:screenshot:phone-portrait:1",
      file: "screenshots/play/phone-portrait/01-01-menu.png",
    });
    expect(
      report.screenshots.find((s) => s.id === "steam/desktop-16x10/01-mac"),
    ).toMatchObject({
      status: "accepted",
      method: "crop",
      width: 2880,
      height: 1620,
    });
    const padded = await run({ pad: ["play/phone-portrait/01-menu"] });
    expect(
      padded.report.screenshots.find(
        (s) => s.id === "play/phone-portrait/01-menu",
      ),
    ).toMatchObject({
      status: "accepted",
      method: "pad",
      width: 1434,
      height: 2868,
    });
  }, 180_000);

  it("refuses an id no proposal has (a typo must not look accepted)", async () => {
    await expect(run({ accept: ["play/phone-portrait/nope"] })).rejects.toThrow(
      /no screenshot proposal/,
    );
    // An image that already fits needs no acceptance.
    await expect(run({ accept: ["play/tablet/01-board"] })).rejects.toThrow(
      /no screenshot proposal/,
    );
  }, 180_000);
});

describe("pkey listing assets: icons", () => {
  it("derives Android's adaptive layers only when the mark sits inside the central 61 %", () => {
    expect(analyseAdaptive(iconMaster()).derivable).toBe(true);
    expect(analyseAdaptive(iconMaster({ opaque: true })).derivable).toBe(true);
    const full = analyseAdaptive(iconMaster({ full: true }));
    expect(full.derivable).toBe(false);
    expect(full.reason).toContain("central 66 of 108 dp");
    // A mark just inside the margin (ceil(1024 * 21 / 108) = 200) passes; one pixel more fails.
    const edge = makeRaster(1024, 1024);
    rect(edge, 200, 200, 624, 624, [255, 0, 0]);
    expect(analyseAdaptive(edge).derivable).toBe(true);
    rect(edge, 199, 300, 1, 1, [255, 0, 0]);
    expect(analyseAdaptive(edge).derivable).toBe(false);
  });

  it("marks the adaptive slots human for a full-bleed master", async () => {
    const cwd = await tempDir();
    const icon = await writePng(
      path.join(cwd, "full.png"),
      iconMaster({ full: true }),
    );
    const { report } = await run({
      icon,
      keyArt: undefined,
      keyArtPortrait: undefined,
      wordmark: undefined,
      screenshots: undefined,
    });
    for (const slot of [
      "icon-adaptive-fg",
      "icon-adaptive-bg",
      "icon-adaptive-mono",
    ]) {
      const s = report.slots.find((x) => x.slot === slot)!;
      expect(s.status, slot).toBe("human");
      expect(s.file, slot).toBeUndefined();
    }
    expect(report.slots.find((s) => s.slot === "play:icon")!.status).toBe("ok");
  }, 60_000);

  it("gives icon-only fallbacks without key art, marked red", async () => {
    const { report } = await run({
      keyArt: undefined,
      keyArtPortrait: undefined,
      screenshots: undefined,
    });
    for (const spec of SLOT_SPECS.filter((s) => s.kind === "compose")) {
      const s = report.slots.find((x) => x.slot === spec.slot)!;
      expect(s.status, spec.slot).toBe("red");
      expect(s.derivedFrom, spec.slot).toBe("icon-master");
      expect(s.notes.join(), spec.slot).toContain("icon-only fallback");
    }
  }, 120_000);

  it("refuses a master that is not square", async () => {
    const cwd = await tempDir();
    const icon = await writePng(
      path.join(cwd, "wide.png"),
      fill(600, 500, [0, 0, 0, 255]),
    );
    await expect(run({ icon })).rejects.toThrow(/must be square/);
  });
});

describe("pkey listing assets: the raster primitives", () => {
  it("resizes a flat colour to the same colour, and keeps transparency clean", () => {
    const flat = resize(fill(1000, 700, [12, 200, 99, 255]), 184, 129);
    expect(new Set(flat.data.filter((_, i) => i % 4 === 1))).toEqual(
      new Set([200]),
    );
    // A red disc on transparency: no dark fringe from the transparent pixels' (black) colour.
    const r = makeRaster(64, 64);
    disc(r, 32, 32, 20, [255, 0, 0]);
    const small = resize(r, 13, 13);
    for (let i = 0; i < small.data.length; i += 4)
      if (small.data[i + 3]! > 0)
        expect(small.data[i], `pixel ${i / 4}`).toBe(255);
  });

  it("composites half-transparent white over black to mid grey", () => {
    const base = fill(2, 1, [0, 0, 0, 255]);
    composite(base, fill(1, 1, [255, 255, 255, 128]), 1, 0);
    expect([...base.data]).toEqual([0, 0, 0, 255, 128, 128, 128, 255]);
  });
});

describe("pkey listing assets: --out and the CLI", () => {
  it("refuses a non-empty --out that is not a previous run, and replaces a previous run's files", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "busy"));
    await writeFile(path.join(cwd, "busy", "keep.txt"), "mine");
    await expect(
      listingAssets({
        cwd,
        out: "busy",
        icon: fixtures.icon,
        env: {},
        stdout: capture().stdout,
        stderr: capture().stderr,
      }),
    ).rejects.toThrow(/not empty/);
    const io = capture();
    const opts = {
      cwd,
      out: "fresh",
      icon: fixtures.icon,
      env: {},
      stdout: io.stdout,
      stderr: io.stderr,
    };
    await listingAssets(opts);
    await writeFile(path.join(cwd, "fresh", "notes.txt"), "mine");
    const again = await listingAssets(opts);
    expect(existsSync(path.join(cwd, "fresh", "notes.txt"))).toBe(true);
    expect(again.report.files).toContain("play/icon.png");
  }, 60_000);

  it("runs as pkey listing assets", async () => {
    const cwd = await tempDir();
    const io = capture();
    const code = await runPkey(
      [
        "listing",
        "assets",
        "--out",
        "o",
        "--icon",
        fixtures.icon,
        "--background",
        "#102030",
      ],
      { cwd, stdout: io.stdout, stderr: io.stderr, env: {} },
    );
    expect(code, io.err).toBe(0);
    const report = JSON.parse(
      await readFile(path.join(cwd, "o", "report.json"), "utf8"),
    ) as ListingAssetsReport;
    expect(report.background).toBe("#102030");
    expect(io.out).toContain("preview.html");
    const bad = capture();
    expect(
      await runPkey(["listing", "assets"], {
        cwd,
        stdout: bad.stdout,
        stderr: bad.stderr,
        env: {},
      }),
    ).toBe(1);
    expect(bad.err).toContain("Usage: pkey listing assets");
  }, 60_000);
});

describe("pkey listing assets --upload", () => {
  it("uploads masters, outputs, accepted screenshots and packs, and registers them", async () => {
    const server = fakeServer();
    server.script("/distribution/listing/assets", () =>
      json({
        ok: true,
        stored: [{ slot: "play:icon" }],
        kept: [{ slot: "steam:library-hero", locale: "en-US" }],
      }),
    );
    const { report, out } = await run({
      upload: true,
      product: SLUG,
      baseUrl: BASE,
      locale: "en-US",
      accept: ["play/phone-portrait/01-menu"],
      env: { PKEY_CI_TOKEN: CI_TOKEN },
      fetchImpl: server.fetchImpl,
      sleep: async () => {},
    });
    const [register] = server.to("/distribution/listing/assets");
    const body = register!.body as {
      ticket: string;
      assets: Array<Record<string, unknown>>;
    };
    expect(body.ticket).toBeTruthy();
    const slots = body.assets.map((a) => a.slot as string);
    // Masters, with their own text rules.
    for (const m of Object.keys(MASTER_RULES))
      expect(
        body.assets.find((a) => a.slot === m),
        m,
      ).toMatchObject({
        textAllowed: MASTER_RULES[m as keyof typeof MASTER_RULES],
        derivedFrom: null,
        locale: "en-US",
      });
    expect(
      body.assets.find((a) => a.slot === "steam:library-hero"),
    ).toMatchObject({
      width: 3840,
      height: 1240,
      alpha: false,
      derivedFrom: "key-art",
      textAllowed: "none",
    });
    expect(
      body.assets.find((a) => a.slot === "play:screenshot:phone-portrait:1"),
    ).toMatchObject({
      width: 1320,
      height: 2640,
      derivedFrom: "screenshot:phone-portrait",
    });
    // The pending Mac proposal for Steam is not uploaded.
    expect(slots).not.toContain("steam:screenshot:desktop-16x10:1");
    expect(slots).toContain("steam:screenshot:desktop-16x9:1");
    for (const store of PACK_STORES)
      expect(slots, store).toContain(`pack:${store}`);
    // Every object was PUT once under the ticket, with its digest.
    const uniqueShas = new Set(body.assets.map((a) => a.sha256));
    expect(server.to("/staging/").length).toBe(uniqueShas.size);
    const uploads = server.to("/release/publish/uploads")[0]!.body as {
      objects: unknown[];
    };
    expect(uploads.objects).toHaveLength(uniqueShas.size);
    // Every row passes the Worker's model.
    for (const a of body.assets)
      expect(listingAssetRule(a.slot as string), a.slot as string).toBe(
        a.textAllowed,
      );
    expect(out).toContain("kept 1 the operator uploaded (steam:library-hero)");
    expect(out).toContain("1 pending screenshot proposal was not uploaded");
    expect(report.packs.map((p) => p.store)).toEqual([...PACK_STORES]);
  }, 180_000);

  it("--dry-run sends nothing", async () => {
    const server = fakeServer();
    const { out } = await run({
      upload: true,
      dryRun: true,
      product: SLUG,
      baseUrl: BASE,
      screenshots: undefined,
      env: { PKEY_CI_TOKEN: CI_TOKEN },
      fetchImpl: server.fetchImpl,
    });
    expect(server.calls).toHaveLength(0);
    expect(out).toContain("Dry run");
  }, 120_000);
});

describe("pkey listing assets: the listing model agrees", () => {
  it("names only the Worker's slots, with the Worker's text rules", () => {
    for (const spec of SLOT_SPECS)
      expect(LISTING_ASSET_SLOTS[spec.slot], spec.slot).toBe(spec.textAllowed);
    for (const [slot, rule] of Object.entries(MASTER_RULES))
      expect(LISTING_ASSET_SLOTS[slot], slot).toBe(rule);
    for (const store of PACK_STORES)
      expect(LISTING_ASSET_SLOTS[`pack:${store}`], store).toBe("free");
  });
});
