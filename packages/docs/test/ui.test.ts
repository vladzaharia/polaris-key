/**
 * The `build/ui/` section's drift gates (docs/design/UI-KITS.md §6.2): the pages follow the
 * component catalog, the baselines the component pages embed come from the directories ui-qa's
 * report reads, and a baseline's file name lands on the right component and state.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASELINE_DIRS } from "../../ui-qa/src/config";
import { BASELINES, DIRS } from "../src/lib/baselines";
import { CATALOG, classify, kebab } from "../src/lib/shots";
import { COMPONENTS_NOT_BUILT, UI_KITS, statusLabel } from "../src/lib/uiKits";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(docsRoot, "src", "content", "docs", "build", "ui");
const read = (...p: string[]): string => readFileSync(join(...p), "utf8");

/** The .mdx pages in a build/ui/ subdirectory, without the index and the template. */
const pagesIn = (sub: string): string[] =>
  readdirSync(join(uiDir, sub))
    .filter(
      (f) => f.endsWith(".mdx") && f !== "index.mdx" && !f.startsWith("_"),
    )
    .map((f) => f.slice(0, -".mdx".length));

describe("baseline directories", () => {
  it("are exactly ui-qa's BASELINE_DIRS", () => {
    expect(DIRS).toEqual(
      Object.fromEntries(BASELINE_DIRS.map(({ kit, dir }) => [kit, dir])),
    );
  });

  it("each kit has one docs pattern, inside its own directory", () => {
    const source = read(docsRoot, "src", "lib", "baselines.ts");
    const globs = [
      ...source.matchAll(
        /^\s+"?([a-z-]+)"?: import\.meta\.glob<ImageMetadata>\(\s*"([^"]+)"/gm,
      ),
    ].map((m) => ({ kit: m[1]!, pattern: m[2]! }));
    expect(globs.map((g) => g.kit).sort()).toEqual(Object.keys(DIRS).sort());
    for (const { kit, pattern } of globs) {
      expect(
        pattern.startsWith(`../../../../${DIRS[kit]}/`),
        `${kit}: ${pattern}`,
      ).toBe(true);
      expect(pattern, `${kit} shows themed pairs`).toContain("{dark,light}");
    }
  });

  it("every kit that records baselines is a kit the section knows", () => {
    const ids = new Set(UI_KITS.map((k) => k.id));
    for (const kit of Object.keys(DIRS)) expect(ids.has(kit), kit).toBe(true);
  });

  // Vite shortens a glob key to its shortest relative path, so a kit under packages/ comes back
  // as ../../../sdk-node/…: the collector must resolve keys, not compare them with the pattern.
  it("collects a kit's committed baselines from under packages/ (terminal-node)", () => {
    const tn = BASELINES.filter((b) => b.kit === "terminal-node");
    expect(tn.length).toBeGreaterThan(0);
    for (const b of tn)
      expect(b.file.startsWith(`${DIRS["terminal-node"]}/`), b.file).toBe(true);
    expect(
      tn.some((b) => b.component === "Activate" && b.state === "parsed"),
    ).toBe(true);
  });
});

describe("baseline names", () => {
  const catalog = { ...CATALOG };

  it("map a flat <component>-<state>-<theme> name", () => {
    expect(classify("devices-list-dark.png", catalog)).toMatchObject({
      component: "Devices",
      state: "list",
      variant: "",
      theme: "dark",
    });
  });

  it("keep what follows the state as the variant", () => {
    expect(
      classify("devices-browser-mode-390-light.png", catalog),
    ).toMatchObject({
      component: "Devices",
      state: "browser-mode",
      variant: "390",
      theme: "light",
    });
  });

  it("read Roborazzi's <component>-<state>/<variant>-<theme> layout", () => {
    expect(
      classify("boot-consent/phone-branded-dark.png", catalog),
    ).toMatchObject({
      component: "Boot",
      state: "consent",
      variant: "phone-branded",
    });
    expect(classify("devices/phone-branded-light.png", catalog)).toMatchObject({
      component: "Devices",
      state: "",
      variant: "phone-branded",
      theme: "light",
    });
  });

  it("take the longest component name, so SignInHandoff is not SignIn", () => {
    expect(classify("sign-in-handoff-waiting-dark.png", catalog)).toMatchObject(
      {
        component: "SignInHandoff",
        state: "waiting",
      },
    );
    expect(classify("sign-in-methods-dark.png", catalog)).toMatchObject({
      component: "SignIn",
      state: "methods",
    });
  });

  it("keep a name that matches no component, and skip a file with no theme", () => {
    expect(
      classify("gate-revoked/phone-branded-dark.png", catalog),
    ).toMatchObject({
      component: null,
      name: "gate-revoked",
    });
    expect(classify("devices-list.png", catalog)).toBeNull();
  });
});

describe("component pages", () => {
  const pages = pagesIn("components");

  it("every catalog component a kit ships has its page, built on the template", () => {
    for (const name of Object.keys(CATALOG)) {
      if (COMPONENTS_NOT_BUILT.includes(name)) continue;
      const slug = kebab(name);
      expect(pages, `build/ui/components/${slug}.mdx`).toContain(slug);
      const page = read(uiDir, "components", `${slug}.mdx`);
      expect(page).toContain(`title: "${name}"`);
      expect(page).toContain(`<ComponentStates component="${name}" />`);
      expect(page).toContain(`<KitBaselines component="${name}" />`);
    }
  });

  it("a component no kit builds has no page, and is a catalog component", () => {
    for (const name of COMPONENTS_NOT_BUILT) {
      expect(Object.keys(CATALOG), name).toContain(name);
      expect(pages, name).not.toContain(kebab(name));
    }
  });

  it("no page outlives its catalog component", () => {
    const slugs = new Set(Object.keys(CATALOG).map(kebab));
    for (const page of pages) expect(slugs.has(page), page).toBe(true);
  });
});

describe("recipes", () => {
  const recipes = UI_KITS.filter((k) => "recipe" in k.status);

  it("each recipe kit has a sample folder, a section on the recipes page and no framework page of its own", () => {
    const page = read(uiDir, "recipes.mdx");
    expect(recipes.map((k) => k.id).sort()).toEqual(
      ["angular", "htmx", "preact", "solid", "svelte", "tauri", "vue"].sort(),
    );
    for (const k of recipes) {
      expect(statusLabel(k), k.id).toBe("Recipe");
      for (const s of k.samples ?? [])
        expect(existsSync(join(docsRoot, "..", "..", s)), s).toBe(true);
      expect(page, k.id).toContain(`<KitStatus kit="${k.id}" />`);
      expect(existsSync(join(uiDir, "frameworks", `${k.id}.mdx`)), k.id).toBe(
        false,
      );
    }
  });

  it("the elements kit ships, with its not-published note", () => {
    const k = UI_KITS.find((x) => x.id === "elements");
    expect(k && statusLabel(k)).toBe("Shipped");
    expect(k?.note).toMatch(/not published/i);
  });
});

describe("framework pages", () => {
  it("each is a known kit, built on the template", () => {
    const ids = new Set(UI_KITS.map((k) => k.id));
    for (const page of pagesIn("frameworks")) {
      expect(ids.has(page), page).toBe(true);
      expect(read(uiDir, "frameworks", `${page}.mdx`)).toContain(
        `<KitFacts kit="${page}" />`,
      );
    }
  });

  it("the old Kotlin UI page redirects to the Compose page", () => {
    expect(existsSync(join(uiDir, "frameworks", "compose.mdx"))).toBe(true);
    expect(
      existsSync(
        join(
          docsRoot,
          "src",
          "content",
          "docs",
          "build",
          "sdks",
          "kotlin-ui.mdx",
        ),
      ),
    ).toBe(false);
    expect(
      (
        JSON.parse(read(docsRoot, "site-map.json")) as {
          extraRedirects: Record<string, string>;
        }
      ).extraRedirects["/build/sdks/kotlin-ui"],
    ).toBe("/docs/build/ui/frameworks/compose/");
  });
});
