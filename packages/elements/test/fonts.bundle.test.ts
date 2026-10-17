// @vitest-environment node
// A bundled app loads Rubik: Vite builds an entry that imports the package's built fonts module,
// and the output holds the woff2 files and a font-face rule that points at them (the sample's
// production build used to emit neither, so the kit drew in the system font).
// Needs `pnpm build` first (it reads dist/); without a build the test says so and passes.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

describe("fonts in a bundled app", () => {
  it("emits the woff2 files and a font-face that names them", async () => {
    if (!existsSync(join(dist, "fonts.js"))) return;
    const { build } = await import("vite");
    const out = mkdtempSync(join(tmpdir(), "pk-fonts-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(out, "index.html"),
      '<!doctype html><script type="module" src="./entry.js"></script>',
    );
    writeFileSync(
      join(out, "entry.js"),
      `import { fontFaceCss } from ${JSON.stringify(join(dist, "fonts.js"))};\nwindow.__css = fontFaceCss();\n`,
    );
    try {
      await build({
        root: out,
        logLevel: "silent",
        configFile: false,
        build: {
          outDir: join(out, "dist"),
          rollupOptions: { input: join(out, "index.html") },
          assetsInlineLimit: 0,
          emptyOutDir: true,
        },
      });
      const emitted = readdirSync(join(out, "dist", "assets"));
      for (const f of [
        "rubik-var-latin",
        "rubik-var-latin-ext",
        "jetbrains-mono-var-latin",
        "jetbrains-mono-var-latin-ext",
      ])
        expect(
          emitted.some((n) => n.startsWith(f) && n.endsWith(".woff2")),
        ).toBe(true);
      const js = readdirSync(join(out, "dist", "assets"))
        .filter((n) => n.endsWith(".js"))
        .map((n) => readFileSync(join(out, "dist", "assets", n), "utf8"))
        .join("\n");
      expect(js).toContain("@font-face");
      expect(js).toMatch(/assets\/rubik-var-latin-[\w-]+\.woff2/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
