// Locker fidelity: the in-repo copy of the Polaris Locker launch kit (locker-kit/) is byte-identical
// to the kit's own manifest.json (SHA-256) except for the three files it leaves out, the tokens
// equal the kit's, and every mark, lockup and badge the package renders reproduces the kit's
// own file exactly (the generator proves the same before it writes).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LOCKER_LAYOUTS,
  LOCKER_BADGE_KINDS,
  LOCKER_BADGE_THEMES,
  LOCKER_BADGE_TREATMENTS,
  LOCKER_MARK_VARIANTS,
} from "../scripts/locker.js";
import {
  lockerKitBadgeSvg,
  lockerKitLockupSvg,
  lockerKitMarkSvg,
} from "../src/marks/svg.js";
import { LOCKER } from "../src/tokens/primitives.js";

const PKG = join(import.meta.dirname, "..");
const KIT = join(PKG, "locker-kit");
const read = (p: string) => readFileSync(join(KIT, p), "utf8");

/**
 * Left out of the copy because the package already ships them: the variable Rubik and its
 * licence (fonts/), and two copies of the Key brand guide (2.9 MB).
 */
const OMITTED = [
  "fonts/OFL.txt",
  "fonts/Rubik-400.ttf",
  "fonts/Rubik-500.ttf",
  "fonts/Rubik-600.ttf",
  "fonts/Rubik-Variable.ttf",
  "source/Polaris-Key-Brand-Guide-Edition04.pdf",
  "docs/Polaris-Key-Brand-Guide-with-Locker-v1.pdf",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("locker-kit/ matches the kit's manifest.json", () => {
  const manifest = JSON.parse(read("manifest.json")) as {
    version: string;
    files: { path: string; bytes: number; sha256: string }[];
  };
  const kept = manifest.files.filter((f) => !OMITTED.includes(f.path));

  it("is Launch Kit v1.0.0 and omits exactly the named files", () => {
    expect(manifest.version).toBe("1.0.0");
    const listed = manifest.files.map((f) => f.path);
    for (const o of OMITTED) expect(listed).toContain(o);
    for (const o of OMITTED) expect(existsSync(join(KIT, o))).toBe(false);
  });

  it("holds no file the manifest does not list", () => {
    const listed = new Set(manifest.files.map((f) => f.path));
    const extra = walk(KIT)
      .map((p) => relative(KIT, p))
      .filter((p) => p !== "manifest.json" && !listed.has(p));
    expect(extra).toEqual([]);
  });

  it.each(kept.map((f) => [f.path, f] as const))("%s", (_, f) => {
    const bytes = readFileSync(join(KIT, f.path));
    expect(bytes.length).toBe(f.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
  });
});

describe("tokens equal tokens/locker.tokens.json", () => {
  const kit = JSON.parse(read("tokens/locker.tokens.json")) as Record<
    "dark" | "light",
    Record<string, string>
  >;
  it.each(["dark", "light"] as const)("%s", (theme) => {
    for (const k of Object.keys(LOCKER) as (keyof typeof LOCKER)[])
      expect(LOCKER[k][theme], `${theme}.${k}`).toBe(kit[theme]![k]);
  });
  it("css/locker.css is the kit's tokens/locker.css, verbatim", () => {
    expect(readFileSync(join(PKG, "css/locker.css"))).toEqual(
      readFileSync(join(KIT, "tokens/locker.css")),
    );
  });
});

describe("rendered artwork is the kit's file, byte for byte", () => {
  it.each(
    LOCKER_MARK_VARIANTS.flatMap((v) =>
      (["micro", "master"] as const).map((c) => [c, v] as const),
    ),
  )("mark %s %s", (cut, variant) => {
    expect(lockerKitMarkSvg(cut, variant)).toBe(
      read(`logos/svg/locker-mark-${variant}-${cut}.svg`).trimEnd(),
    );
  });
  it("mark master currentColor", () => {
    expect(lockerKitMarkSvg("master", "currentColor")).toBe(
      read("logos/svg/locker-mark-currentColor.svg").trimEnd(),
    );
  });
  it.each(
    LOCKER_LAYOUTS.flatMap((l) =>
      LOCKER_MARK_VARIANTS.map((v) => [l, v] as const),
    ),
  )("lockup %s %s", (layout, variant) => {
    expect(lockerKitLockupSvg(layout, variant)).toBe(
      read(`logos/svg/locker-${layout}-${variant}.svg`).trimEnd(),
    );
  });
  const badges = LOCKER_BADGE_KINDS.flatMap((k) =>
    LOCKER_BADGE_THEMES.flatMap((th) =>
      LOCKER_BADGE_TREATMENTS.map((tr) => [k, th, tr] as const),
    ),
  );
  it.each(badges)("badge %s %s %s", (kind, theme, treatment) => {
    expect(lockerKitBadgeSvg(`locker-${kind}`, treatment, theme)).toBe(
      read(`badges/locker-${kind}-${theme}-${treatment}.svg`).trimEnd(),
    );
  });
});

describe("web files", () => {
  it("the manifest is the kit's with id, start_url and scope /", () => {
    const ours = JSON.parse(
      readFileSync(join(PKG, "web/locker/site.webmanifest"), "utf8"),
    );
    const kit = JSON.parse(read("web/site.webmanifest"));
    expect(ours).toMatchObject({ id: "/", start_url: "/", scope: "/" });
    expect(ours.icons).toEqual(kit.icons);
    expect(ours.name).toBe(kit.name);
  });
  it("the icon bytes are the kit's", () => {
    for (const f of readdirSync(join(KIT, "web")).filter(
      (f) => f !== "site.webmanifest" && f !== "README.md",
    ))
      expect(
        readFileSync(join(PKG, "web/locker", f)).equals(
          readFileSync(join(KIT, "web", f)),
        ),
        f,
      ).toBe(true);
  });
});
