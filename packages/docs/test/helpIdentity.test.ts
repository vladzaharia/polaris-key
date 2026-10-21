/**
 * Help is Polaris Locker's site: its pages carry the Locker favicon and touch icon, the files are
 * the brand kit's own bytes, and the Locker scope keeps developer pages on the Key's accent.
 * The page checks skip when the docs have not been built.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lockerIcon } from "../src/lib/helpHost";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const kit = join(root, "..", "brand", "locker-kit", "web");

describe("lockerIcon", () => {
  it("maps each Key icon to the Locker kit's file", () => {
    expect(lockerIcon("/docs/branding/key/favicon.svg")).toBe(
      "/docs/branding/locker/favicon.svg",
    );
    expect(lockerIcon("/docs/branding/key/favicon.ico")).toBe(
      "/docs/branding/locker/favicon.ico",
    );
    expect(lockerIcon("/docs/branding/key/app-icon-dark-180.png")).toBe(
      "/docs/branding/locker/apple-touch-icon.png",
    );
  });
});

describe.skipIf(!existsSync(join(dist, "help", "index.html")))(
  "the built Help pages",
  () => {
    it("link the Locker icons, and the developer pages the Key's", () => {
      for (const page of ["help/index.html", "help/activate/index.html"]) {
        const html = readFileSync(join(dist, page), "utf8");
        expect(html, page).toContain("/docs/branding/locker/favicon.svg");
        expect(html, page).toContain(
          "/docs/branding/locker/apple-touch-icon.png",
        );
        expect(html, page).not.toContain("/docs/branding/key/");
      }
      const dev = readFileSync(
        join(dist, "start", "concepts", "index.html"),
        "utf8",
      );
      expect(dev).toContain("/docs/branding/key/favicon.svg");
      expect(dev).not.toContain("/docs/branding/locker/");
    });

    it("ship the Locker kit's icon files byte for byte", () => {
      for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"])
        expect(
          readFileSync(join(dist, "branding", "locker", f)).equals(
            readFileSync(join(kit, f)),
          ),
          f,
        ).toBe(true);
    });

    it("scope the Locker brand to Help and load Help's own search bundle", () => {
      expect(readFileSync(join(dist, "help", "index.html"), "utf8")).toContain(
        'data-brand="locker"',
      );
      expect(
        readFileSync(join(dist, "start", "concepts", "index.html"), "utf8"),
      ).not.toContain('data-brand="locker"');
    });
  },
);
