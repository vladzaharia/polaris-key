import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lockerShell } from "../src/services/identity/portal/lockerShell.js";

/**
 * LK-06: the portal shell as Polaris Locker. The Worker rewrites the build's `index.html`; this
 * pins the rewrite to the real file, so a head edit cannot leave a Key link in the Locker shell or
 * point at a file the build does not emit, and shows the inline script (its hash is in
 * `core/adminCsp.ts`) is untouched.
 */
const here = dirname(fileURLToPath(import.meta.url));
const admin = join(here, "..", "..", "admin");
const html = readFileSync(join(admin, "index.html"), "utf8");
const vite = readFileSync(join(admin, "vite.config.ts"), "utf8");
const emitted = Array.from(
  (vite.match(/LOCKER_WEB_FILES[^=]*=\s*\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(
    /"([^"]+)"/g,
  ),
  (m) => m[1]!,
);
const script = (h: string) => h.match(/<script>[\s\S]*?<\/script>/)?.[0];

describe("lockerShell", () => {
  const out = lockerShell(html);

  it("brands the document and leaves no Key link", () => {
    expect(out).toContain('<html lang="en" data-brand="locker">');
    expect(out).toContain("<title>Polaris Locker</title>");
    expect(out).not.toContain("/assets/branding/key/");
    expect(out).not.toContain("<title>Polaris Key");
  });

  it("links only emitted files that the brand package ships", () => {
    const links = [
      ...out.matchAll(/href="\/assets\/branding\/locker\/([^"]+)"/g),
    ].map((m) => m[1]!);
    expect(links).toEqual(
      expect.arrayContaining([
        "favicon.svg",
        "favicon.ico",
        "apple-touch-icon.png",
        "site.webmanifest",
      ]),
    );
    const web = join(here, "..", "..", "brand", "web", "locker");
    for (const name of [...links, ...emitted])
      expect(existsSync(join(web, name)), name).toBe(true);
    for (const name of links) expect(emitted).toContain(name);
  });

  it("keeps the CSP-hashed inline script byte for byte", () => {
    expect(script(out)).toBe(script(html));
  });

  it("returns a shell it does not recognise as it was", () => {
    expect(lockerShell("<html><head></head></html>")).toBe(
      "<html><head></head></html>",
    );
  });
});
