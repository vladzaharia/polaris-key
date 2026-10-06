import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * src/motion.css (notes/S-23 §6), read as text: jsdom computes no animations, so this pins the
 * stylesheet's contract and the real browser check is e2e/kit.e2e.test.ts (getAnimations() on a
 * closing node).
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const src = join(pkg, "src");
const read = (p: string): string => readFileSync(join(src, p), "utf8");
const css = read("motion.css");
const sonnerCss = readFileSync(
  join(pkg, "node_modules", "sonner", "dist", "styles.css"),
  "utf8",
);

/** `selector { body }` pairs, flattening layers and media blocks (good enough for this file). */
function rules(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim().replace(/\s+/g, " ");
    if (selector.startsWith("@") || /^(from|to|\d+%)$/.test(selector)) continue;
    out.push({ selector, body: m[2]! });
  }
  return out;
}
const motionRules = rules(css);
const norm = (s: string): string => s.replace(/'/g, '"').replace(/\s+/g, " ");

describe("the motion stylesheet is bundled by both apps", () => {
  it("is imported right after styles.css in both entries", () => {
    for (const [entry, styles, motion] of [
      ["main.tsx", '"./styles.css"', '"./motion.css"'],
      ["portal/main.tsx", '"../styles.css"', '"../motion.css"'],
    ] as const) {
      const text = read(entry);
      expect(text, entry).toContain(`import ${styles};\nimport ${motion};`);
    }
  });
});

describe("every Radix overlay animates out", () => {
  // The overlay components: each keeps today's utility classes, which motion.css keys on.
  const overlays: Record<string, string[]> = {
    "ui/Dialog.tsx": ["animate-pk-in", "animate-pk-overlay-in"],
    "ui/Drawer.tsx": ["animate-pk-in"],
    "ui/Popover.tsx": ["animate-pk-in"],
    "ui/Tooltip.tsx": ["animate-pk-in"],
    "ui/DropdownMenu.tsx": ["animate-pk-in"],
    "ui/ActionMenu.tsx": ["animate-pk-in"],
    "ui/Select.tsx": ["animate-pk-in"],
    "console/shell/CommandPalette.tsx": [
      "animate-pk-in",
      "animate-pk-overlay-in",
    ],
    "console/shell/AppShell.tsx": ["animate-pk-in", "animate-pk-overlay-in"],
    "console/shell/ProductSwitcher.tsx": ["animate-pk-in"],
    "portal/components/JumpPalette.tsx": [
      "animate-pk-in",
      "animate-pk-overlay-in",
    ],
  };
  for (const [file, classes] of Object.entries(overlays))
    it(`${file} carries ${classes.join(" and ")}`, () => {
      const text = read(file);
      for (const c of classes) expect(text).toMatch(new RegExp(`\\b${c}\\b`));
    });

  const closing = (cls: string) =>
    motionRules.filter(
      (r) =>
        r.selector.includes(cls) &&
        r.selector.includes('[data-state="closed"]'),
    );

  it("content exits with pk-exit at base, popper content fades at fast", () => {
    const bodies = closing(".animate-pk-in").map((r) => r.body);
    expect(
      bodies.some((b) => /pk-exit var\(--pk-duration-base\)/.test(b)),
    ).toBe(true);
    expect(
      bodies.some((b) => /pk-fade-out var\(--pk-duration-fast\)/.test(b)),
    ).toBe(true);
  });

  it("the scrim fades out at base", () => {
    const bodies = closing(".animate-pk-overlay-in").map((r) => r.body);
    expect(
      bodies.some((b) => /pk-fade-out var\(--pk-duration-base\)/.test(b)),
    ).toBe(true);
  });

  it("open states are 'not closed', so tooltips' delayed-open and instant-open enter too", () => {
    expect(css).toContain(
      ':is(.animate-pk-in, .pk-transient):not([data-state="closed"])',
    );
    for (const side of ["top", "bottom", "left", "right"])
      expect(css).toContain(`[data-side="${side}"]:not(`);
  });

  it("enter animations never fill forwards, so nothing lingers at rest", () => {
    for (const r of motionRules)
      if (
        /animation:\s*pk-(enter|fade-in|pop-in|from-|drawer-in|sheet-in)/.test(
          r.body,
        )
      )
        if (!r.selector.startsWith("::view-transition"))
          expect(r.body, r.selector).toMatch(/backwards/);
  });
});

describe("tokens only", () => {
  it("every animation and transition timing is a token (or 0s for a visibility flip)", () => {
    for (const r of motionRules)
      for (const decl of r.body.split(";")) {
        if (!/^\s*(animation|transition)/.test(decl)) continue;
        const raw = decl.match(/\b\d+(\.\d+)?m?s\b/g) ?? [];
        // `0s` holds visibility in the expand pattern; the countdown's 3000ms is a fallback
        // inside var(--pk-countdown, …), never used when the layer starts it.
        const allowed = raw.filter(
          (v) =>
            v === "0s" ||
            v === "0ms" ||
            /var\(--pk-countdown, 3000ms\)/.test(decl),
        );
        expect(raw, `${r.selector}: ${decl.trim()}`).toEqual(allowed);
      }
  });
});

describe("the refetch bar animates, and stops under reduced motion", () => {
  it("defines pk-refetch as a transform-only sweep", () => {
    const kf = css.match(/@keyframes pk-refetch \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(kf).toMatch(/transform:/);
    expect(kf).not.toMatch(/\b(width|left|margin|opacity):/);
    const rule = motionRules.find((r) => r.selector === ".animate-pk-refetch");
    expect(rule?.body).toMatch(
      /animation: pk-refetch var\(--pk-duration-shimmer\)/,
    );
  });

  it("is in both reduced-motion blocks", () => {
    const reduced = motionRules.filter(
      (r) =>
        r.selector.includes(".animate-pk-refetch") &&
        /animation: none/.test(r.body),
    );
    expect(reduced.length).toBe(2);
    expect(
      reduced.some((r) => r.selector.startsWith(':root[data-motion="reduce"]')),
    ).toBe(true);
  });

  it("is used by RefetchBar", () => {
    expect(read("ui/loading.tsx")).toContain("animate-pk-refetch");
  });
});

describe("reduced motion is an instant swap (S-23 D3)", () => {
  it("stops overlays, loops, bursts and View Transitions under both switches", () => {
    for (const needle of [
      ".animate-pk-in",
      ".animate-pk-overlay-in",
      ".pk-skeleton::after",
      ".pk-burst",
      "::view-transition-group(*)",
    ]) {
      const media = css
        .split("@media (prefers-reduced-motion: reduce)")
        .slice(1);
      expect(
        media.some((block) => block.slice(0, 1200).includes(needle)),
        `${needle} under prefers-reduced-motion`,
      ).toBe(true);
      expect(
        motionRules.some(
          (r) =>
            r.selector.includes(':root[data-motion="reduce"]') &&
            r.selector.includes(needle),
        ),
        `${needle} under data-motion="reduce"`,
      ).toBe(true);
    }
  });
});

describe("View Transition names are gated by type (S-23 §3.4 item 1)", () => {
  it("names nothing permanently", () => {
    for (const r of motionRules) {
      const m = r.body.match(/view-transition-name:\s*([\w-]+)/);
      if (!m || m[1] === "none") continue;
      expect(r.selector, `${r.selector} names ${m[1]}`).toMatch(/\[data-vt/);
    }
  });

  it("selects the console's and the portal's main region without a class", () => {
    expect(css).toMatch(/:is\(main#content, main#flow, \.pk-vt-main\)/);
    expect(read("console/shell/AppShell.tsx")).toMatch(/<main\s+id="content"/);
    expect(read("portal/components/PortalShell.tsx")).toMatch(
      /<main\s+id="content"/,
    );
  });
});

describe("sonner runs on the tokens", () => {
  it("overrides every sonner rule with a hard-coded duration (its spinner loop aside)", () => {
    const overridden = new Set(motionRules.map((r) => norm(r.selector)));
    // Rules inside sonner's own reduced-motion block (`… !important`) stay as they are.
    const timed = rules(sonnerCss).filter(
      (r) =>
        /(transition|animation)[^;]*\b\d+(\.\d+)?m?s\b|animation-duration/.test(
          r.body,
        ) &&
        !/sonner-spin|!important/.test(r.body) &&
        // the spinner's bars: their phase offsets belong to the loading loop
        !r.selector.includes("sonner-loading-bar"),
    );
    expect(timed.length).toBeGreaterThan(5);
    for (const r of timed)
      expect(
        overridden.has(norm(r.selector)),
        `sonner rule ${r.selector}`,
      ).toBe(true);
  });

  it("keeps sonner's own reduced-motion rule", () => {
    expect(sonnerCss).toContain("@media (prefers-reduced-motion)");
    expect(css).not.toMatch(/\[data-sonner-toast\][^{]*\{[^}]*!important/);
  });
});
