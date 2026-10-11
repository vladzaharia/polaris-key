/**
 * The Godot tab on the `build/ui/components/` pages cannot drift from the addon: every class and
 * scene it names is read from sdks/godot/addons/polaris_key/ui/, every view and controller there
 * is placed by a component or an explicit reason, and the tabs and the registry agree.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claimedClasses,
  classOf,
  godotClasses,
  godotTab,
  GODOT_COMPONENTS,
  INTERNAL,
  isViewOrController,
  modelIds,
  plain,
  scenePath,
  themeVariations,
  UI_DIR,
} from "../src/lib/godotKit";
import { repoRoot } from "../src/lib/repo";
import { CATALOG, kebab } from "../src/lib/shots";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const componentsDir = join(
  docsRoot,
  "src",
  "content",
  "docs",
  "build",
  "ui",
  "components",
);
const kitDir = join(repoRoot(), UI_DIR);
const entries = Object.entries(GODOT_COMPONENTS);

/** The component pages, as [catalog component, source]. */
const pages: [string, string][] = Object.keys(CATALOG).map((name) => [
  name,
  readFileSync(join(componentsDir, `${kebab(name)}.mdx`), "utf8"),
]);

describe("the registry against the addon's source", () => {
  it("every stem is a script with a class_name, and every scene exists", () => {
    for (const [component, c] of entries) {
      for (const stem of [c.view, c.controller]) {
        if (stem === undefined) continue;
        expect(
          existsSync(join(kitDir, `${stem}.gd`)),
          `${component}: ${stem}.gd`,
        ).toBe(true);
        expect(classOf(stem), `${component}: ${stem}`).toMatch(/^PKey\w+$/);
      }
      if (c.view !== undefined) {
        expect(
          existsSync(join(kitDir, scenePath(c.view))),
          `${component}: ${scenePath(c.view)}`,
        ).toBe(true);
      }
    }
  });

  it("a view says what it shows and a controller what it answers", () => {
    for (const [component, c] of entries) {
      expect(
        c.view === undefined,
        `${component}: view and shows go together`,
      ).toBe(c.shows === undefined);
      expect(
        c.controller === undefined,
        `${component}: controller and answers go together`,
      ).toBe(c.answers === undefined);
      if (c.controller !== undefined) {
        expect(
          c.view,
          `${component}: a controller serves a scene`,
        ).toBeDefined();
      }
    }
  });

  it("every model is in models.gd and every variation in the theme", () => {
    const models = new Set(modelIds());
    const variations = new Set(themeVariations());
    for (const [component, c] of entries) {
      expect(models.has(c.model), `${component}: model ${c.model}`).toBe(true);
      if (c.variation !== undefined) {
        expect(
          variations.has(c.variation),
          `${component}: variation ${c.variation}`,
        ).toBe(true);
      }
    }
  });

  it("the scan reads real classes (a view, a controller, the gate whose scene and class differ)", () => {
    const byName = new Map(godotClasses().map((c) => [c.name, c]));
    expect(byName.get("PKeyActivationPanel")?.extends).toBe("PKeyUiView");
    expect(byName.get("PKeyGateController")?.file).toBe(
      "gate/gate_controller.gd",
    );
    expect(classOf("gate/pkey_gate")).toBe("PKeyGateView");
  });
});

describe("every view and controller is placed", () => {
  const claimed = new Set(claimedClasses());

  it("is claimed by a component or listed in INTERNAL", () => {
    const loose = godotClasses()
      .filter(isViewOrController)
      .filter((c) => !claimed.has(c.name) && !(c.name in INTERNAL))
      .map((c) => `${c.name} (${c.file})`);
    expect(
      loose,
      "claim it in GODOT_COMPONENTS (src/lib/godotKit.ts) or list it in INTERNAL with a reason",
    ).toEqual([]);
  });

  it("INTERNAL names real classes that no component claims, each with a reason", () => {
    const real = new Set(
      godotClasses()
        .filter(isViewOrController)
        .map((c) => c.name),
    );
    for (const [name, reason] of Object.entries(INTERNAL)) {
      expect(real.has(name), `${name} is a view or controller`).toBe(true);
      expect(claimed.has(name), `${name} is claimed and internal`).toBe(false);
      expect(reason.length, `${name}: reason`).toBeGreaterThan(10);
    }
  });
});

describe("the catalog", () => {
  it("every registered component is a catalog component", () => {
    for (const [component] of entries) {
      expect(component in CATALOG, component).toBe(true);
    }
  });
});

describe("the component pages", () => {
  const withTab = (src: string): boolean =>
    src.includes('<TabItem label="Godot">');
  const named = (src: string): string[] =>
    [...src.matchAll(/<GodotKitTab component="([^"]+)"/g)].map((m) => m[1]!);

  it("a page has the Godot tab exactly when its component is registered, naming itself", () => {
    for (const [name, src] of pages) {
      const registered = name in GODOT_COMPONENTS;
      expect(withTab(src), `${kebab(name)}.mdx tab`).toBe(registered);
      expect(named(src), `${kebab(name)}.mdx component`).toEqual(
        registered ? [name] : [],
      );
    }
  });

  it("a Godot tab opens with the kit's status and sits in the shared ui-kit tabs", () => {
    for (const [name, src] of pages.filter(([n]) => n in GODOT_COMPONENTS)) {
      const tab = src.slice(src.indexOf('<TabItem label="Godot">'));
      expect(tab, name).toMatch(
        /^<TabItem label="Godot">\s*<KitStatus kit="godot" \/>\s*<GodotKitTab component="[A-Za-z]+" \/>\s*<\/TabItem>\s*<\/Tabs>/,
      );
      expect(src, name).toContain('<Tabs syncKey="ui-kit">');
      expect(src, name).toContain(
        'import GodotKitTab from "../../../../../components/ui/GodotKitTab.astro";',
      );
      expect(src, name).toContain(
        'import KitStatus from "../../../../../components/ui/KitStatus.astro";',
      );
    }
  });

  it("no page outside the components folder carries a Godot tab component", () => {
    const stray = readdirSync(join(componentsDir, ".."), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".mdx") && !f.startsWith("components/"))
      .filter((f) =>
        readFileSync(join(componentsDir, "..", f), "utf8").includes(
          "<GodotKitTab",
        ),
      );
    expect(stray).toEqual([]);
  });
});

describe("a rendered tab", () => {
  it("names only classes, theme variations and scenes the scan found, and links both pages", () => {
    const known = new Set([
      ...godotClasses().map((c) => c.name),
      ...themeVariations(),
    ]);
    for (const [component] of entries) {
      const tab = godotTab(component);
      const segs = tab.flatMap((p) => p.segs);
      for (const s of segs) {
        if (typeof s === "object" && "code" in s) {
          if (/^PKey[A-Z]\w*$/.test(s.code)) {
            expect(known.has(s.code), `${component}: ${s.code}`).toBe(true);
          }
          if (s.code.endsWith(".tscn")) {
            expect(existsSync(join(kitDir, s.code)), s.code).toBe(true);
          }
        }
      }
      const hrefs = segs.flatMap((s) =>
        typeof s === "object" && "href" in s ? [s.href] : [],
      );
      expect(hrefs).toEqual([
        "/docs/build/ui/frameworks/godot/",
        "/docs/build/sdks/godot/your-own-ui/",
      ]);
      expect(tab.map((p) => p.label).filter((l) => l !== "")).toContain(
        "Headless",
      );
    }
  });

  it("reads Activate and Devices from the addon", () => {
    expect(godotTab("Activate").map(plain).join("\n")).toContain(
      "`PKeyActivationPanel` (`activation/pkey_activation_panel.tscn`)",
    );
    const devices = godotTab("Devices").map(plain).join("\n");
    expect(devices).toContain("no scene");
    expect(devices).toContain('`view_of("Devices", input)`');
  });

  it("refuses a component the kit does not implement", () => {
    expect(() => godotTab("NotAComponent")).toThrow(
      /not a Godot kit component/,
    );
  });
});
