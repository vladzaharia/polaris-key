// UK-63: the brand-transition product-chrome rules (B6 rejected patterns, B7 weights, B17
// service-accent state) checked over the RENDERED DOM of the built console and customer site.
// `lintPage` (the §7.3 modernity lint) already covers accent-as-status, state-accent,
// section-index, button-glow, font-weight-700 and the touch floor; this adds the rest of the
// bar's rows, which need computed style and geometry the source lints cannot see. Findings are
// one `rule: detail` line each; a caller subtracts its debt list (see `UxBarDebt`).
import type { Page } from "playwright";

export const UX_BAR_RULES = [
  "ux-glow",
  "ux-gradient",
  "ux-rim-neutral",
  "ux-eyebrow-breadcrumb",
  "ux-tagline",
  "ux-name-over-art",
  "ux-weight",
  "ux-focus-colour",
  "ux-transparency",
] as const;
export type UxBarRule = (typeof UX_BAR_RULES)[number];

export interface UxBarOptions {
  /** Press Tab through the page and check each focus ring (slow; the console's desktop row). */
  focus?: boolean;
  /** How many tab stops to walk. */
  maxTabs?: number;
}

/** A debt entry: `rule` plus a pattern for the finding text; each carries its owner. */
export interface UxBarDebt {
  rule: UxBarRule;
  /** Matches the finding's text (everything after `rule: `). */
  match: RegExp;
  /** Matches the harness label (state id or case name), when the debt is page-specific. */
  where?: RegExp;
  owner: string;
  why: string;
}

/** Findings the debt list does not own; `used` collects the entries that matched. */
export function withoutUxDebt(
  where: string,
  findings: string[],
  debt: readonly UxBarDebt[],
  used?: Set<number>,
): string[] {
  return findings.filter((f) => {
    const rule = f.slice(0, f.indexOf(":"));
    const text = f.slice(f.indexOf(":") + 2);
    const i = debt.findIndex(
      (d) =>
        d.rule === rule &&
        d.match.test(text) &&
        (!d.where || d.where.test(where)),
    );
    if (i < 0) return true;
    used?.add(i);
    return false;
  });
}

/** The in-page checks. Self-contained: it is serialised into the page. */
export function uxBarInPage(opts: { scopeSelector: string }): string[] {
  const out: string[] = [];
  const scope = document.querySelector(opts.scopeSelector) ?? document.body;
  const forced = matchMedia("(forced-colors: active)").matches;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const rgba = (css: string): [number, number, number, number] | null => {
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      // Premultiplied round trip: alpha comes back as 0..255.
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    } catch {
      return null;
    }
  };
  const spread = (c: [number, number, number, number]) =>
    Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  /** A colour with visible hue: channel spread over 40 at more than 5 % alpha. */
  const coloured = (css: string) => {
    const c = rgba(css);
    return !!c && c[3] > 0.05 && spread(c) > 40;
  };
  const splitTop = (s: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  };
  const colourOf = (shadow: string): string => {
    const m = shadow.match(
      /(?:rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\((?:[^()]|\([^()]*\))*\)|#[0-9a-f]{3,8}\b/i,
    );
    return m ? m[0] : "";
  };
  const visible = (el: Element) =>
    el.checkVisibility({ visibilityProperty: true }) &&
    !el.closest("[inert], [aria-hidden=true]");
  const name = (el: Element) => {
    const t = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 28);
    const cls = (el.getAttribute("class") ?? "").split(/\s+/)[0] ?? "";
    return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""}${cls ? "." + cls.slice(0, 24) : ""} "${t}"`;
  };

  const els = Array.from(scope.querySelectorAll("*")).filter(visible);
  const skeleton =
    "[data-skeleton], [class*=skeleton], [class*=Skeleton], [aria-busy=true], [data-shimmer]";

  // B6: glows, coloured shadows, gradients and washes.
  for (const el of els) {
    if (el.closest("[data-sonner-toaster]")) continue;
    for (const pseudo of [null, "::before", "::after"] as const) {
      const cs = getComputedStyle(el, pseudo);
      if (pseudo && (cs.content === "none" || cs.content === "normal"))
        continue;
      const tag = pseudo ? `${name(el)}${pseudo}` : name(el);
      if (cs.boxShadow !== "none" && !el.matches(":focus-visible")) {
        // A hard inset edge (no blur) is the selection marker, not a glow.
        const blur = (s: string) =>
          parseFloat(
            s
              .replace(colourOf(s), "")
              .replace("inset", "")
              .trim()
              .split(/\s+/)[2] ?? "0",
          );
        const hit = splitTop(cs.boxShadow).find(
          (s) =>
            coloured(colourOf(s)) && !(/\binset\b/.test(s) && blur(s) === 0),
        );
        if (hit)
          out.push(`ux-glow: ${tag} has a coloured shadow ${hit.slice(0, 70)}`);
      }
      if (cs.textShadow !== "none") {
        const hit = splitTop(cs.textShadow).find((s) => coloured(colourOf(s)));
        if (hit)
          out.push(
            `ux-glow: ${tag} has a coloured text shadow ${hit.slice(0, 70)}`,
          );
      }
      if (/drop-shadow\(/.test(cs.filter)) {
        const c = colourOf(cs.filter.slice(cs.filter.indexOf("drop-shadow")));
        if (coloured(c)) out.push(`ux-glow: ${tag} has a coloured drop-shadow`);
      }
      if (
        /gradient\(/.test(cs.backgroundImage) &&
        !el.closest(skeleton) &&
        // A masked gradient is a shape (the spinner's arc), not a wash.
        (cs.maskImage ||
          cs.getPropertyValue("-webkit-mask-image") ||
          "none") === "none" &&
        !el.closest("[data-ui-allow~=ux-gradient]")
      ) {
        // A wash is a gradient with a coloured stop, or two different opaque stops. A fade to
        // transparent (a scroll edge), a hatch and a spinner's arc are shapes, not washes.
        const stops = (
          cs.backgroundImage.match(
            /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\((?:[^()]|\([^()]*\))*\)|#[0-9a-f]{3,8}\b/gi,
          ) ?? []
        )
          .map(rgba)
          .filter(
            (c): c is [number, number, number, number] => !!c && c[3] > 0.05,
          );
        const distinct = new Set(stops.map((c) => c.slice(0, 3).join(",")));
        if (stops.some((c) => spread(c) > 40) || distinct.size > 1)
          out.push(`ux-gradient: ${tag} paints a gradient wash`);
      }
    }
  }

  // B6: an accent-tinted card hairline or sheet rim. A card is a rounded block with a border on
  // every side; status, selection and an explicit edge marker are not rims. Not under forced
  // colours, where the palette is the system's.
  if (!forced) {
    // The service accents and the product accent, and the status colours, as the page resolves
    // them: a rim is a breach when it is an accent and not a status colour.
    const resolveToken = (
      v: string,
    ): [number, number, number, number] | null => {
      const probe = document.createElement("span");
      probe.style.color = `var(${v})`;
      scope.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c ? rgba(c) : null;
    };
    const tokens = (names: string[]) =>
      names.flatMap((n) => {
        const c = resolveToken(n);
        return c && c[3] > 0.5 ? [c] : [];
      });
    const services = [
      "core",
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
    ].flatMap((s) => [`--pk-service-${s}`, `--pk-service-${s}-fg`]);
    const accents = tokens([
      ...services,
      "--pk-accent",
      "--pk-accent-fg",
      "--pk-locker-accent",
      "--pk-locker-fg",
    ]);
    const statuses = tokens(
      ["success", "danger", "warning", "info", "signed"].flatMap((s) => [
        `--pk-${s}`,
        `--pk-${s}-border`,
      ]),
    );
    const near = (c: [number, number, number, number], set: typeof accents) =>
      set.some(
        (t) =>
          Math.abs(t[0] - c[0]) +
            Math.abs(t[1] - c[1]) +
            Math.abs(t[2] - c[2]) <=
          36,
      );
    const control =
      "button, input, select, textarea, a, summary, label, [role=button], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=option], [role=menuitem], [role=combobox], [role=alert], [role=status]";
    for (const el of els) {
      if (el.matches(control) || el.closest("svg")) continue;
      if (
        el.matches(
          "[data-status], [data-tone], [data-edge], [data-variant=danger], [data-severity], [data-state=checked], [data-state=active], [data-state=selected], [data-state=on], [aria-selected=true], [aria-checked=true], [aria-pressed=true], [aria-current], [aria-invalid=true], [data-invalid], [data-signed]",
        ) ||
        el.closest("[role=alert], [role=status], [data-status=pill]")
      )
        continue;
      const cs = getComputedStyle(el);
      const w = ["top", "right", "bottom", "left"].map((s) =>
        cs.getPropertyValue(`border-${s}-style`) === "none"
          ? 0
          : parseFloat(cs.getPropertyValue(`border-${s}-width`)),
      );
      if (w.some((x) => x < 1)) continue;
      if (parseFloat(cs.borderTopLeftRadius) < 8) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 96 || r.height < 40) continue;
      const hit = [
        cs.borderTopColor,
        cs.borderRightColor,
        cs.borderBottomColor,
        cs.borderLeftColor,
      ].find((c) => {
        const v = rgba(c);
        return (
          !!v &&
          v[3] > 0.3 &&
          spread(v) > 40 &&
          near(v, accents) &&
          !near(v, statuses)
        );
      });
      if (hit)
        out.push(
          `ux-rim-neutral: ${name(el)} has a rim in a service accent ${hit.slice(0, 50)}`,
        );
    }
  }

  // B6/B13: an eyebrow repeating the breadcrumb or the title, and taglines.
  const crumbs = Array.from(
    document.querySelectorAll(
      'nav[aria-label="Breadcrumb"] li, [data-crumbs] li, [data-crumbs] a',
    ),
  )
    .map((e) => (e.textContent ?? "").trim().toLowerCase())
    .filter(Boolean);
  const h1 = (document.querySelector("h1")?.textContent ?? "")
    .trim()
    .toLowerCase();
  for (const el of document.querySelectorAll(
    "[data-eyebrow], [class*=eyebrow], [class*=Eyebrow], [class*=kicker]",
  )) {
    if (!visible(el)) continue;
    const t = (el.textContent ?? "").trim().toLowerCase();
    if (!t) continue;
    if (crumbs.includes(t))
      out.push(`ux-eyebrow-breadcrumb: "${t}" repeats a breadcrumb`);
    else if (h1 && t === h1)
      out.push(`ux-eyebrow-breadcrumb: "${t}" repeats the title`);
    else if (!el.closest("nav"))
      out.push(
        `ux-eyebrow-breadcrumb: an eyebrow "${t.slice(0, 30)}" in product chrome`,
      );
  }
  for (const el of document.querySelectorAll(
    "[data-tagline], [class*=tagline], [class*=Tagline], [class*=slogan], [data-slogan]",
  ))
    if (visible(el)) out.push(`ux-tagline: ${name(el)} is a tagline or slogan`);

  // B6: a name or label painted over customer art: visible text whose box overlaps an image or
  // art tile (an <img> or [data-art] of at least 64 px a side), unless it is the tile's own
  // caption below the art or an opt-out.
  const arts = Array.from(
    scope.querySelectorAll("img, picture, [data-art], [data-cover]"),
  ).filter((a) => {
    if (!visible(a)) return false;
    if (
      a.matches(
        "[data-avatar], [data-logo], [data-icon], svg, [data-ui-allow~=ux-name-over-art]",
      )
    )
      return false;
    const r = a.getBoundingClientRect();
    return r.width >= 64 && r.height >= 64;
  });
  if (arts.length) {
    const seen = new Set<Element>();
    for (const el of els) {
      if (
        el.children.length > 0 &&
        !Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && n.textContent!.trim(),
        )
      )
        continue;
      if (
        !Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && n.textContent!.trim(),
        )
      )
        continue;
      if (
        el.closest(".sr-only, .pk-sr-only, [data-ui-allow~=ux-name-over-art]")
      )
        continue;
      const tr = el.getBoundingClientRect();
      if (tr.width === 0 || tr.height === 0) continue;
      for (const a of arts) {
        if (a.contains(el) || el.contains(a)) continue;
        const ar = a.getBoundingClientRect();
        const w = Math.min(tr.right, ar.right) - Math.max(tr.left, ar.left);
        const h = Math.min(tr.bottom, ar.bottom) - Math.max(tr.top, ar.top);
        if (w <= 2 || h <= 2 || seen.has(el)) continue;
        // Only text that is stacked above the art, with nothing opaque between, is painted over
        // it: a bar or card that covers the art hides it. The point is the middle of the overlap,
        // and only what is in the window can be hit-tested.
        const cx = Math.max(tr.left, ar.left) + w / 2;
        const cy = Math.max(tr.top, ar.top) + h / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        const stack = document.elementsFromPoint(cx, cy);
        const ti = stack.findIndex((n) => n === el || el.contains(n));
        const ai = stack.findIndex((n) => n === a || a.contains(n));
        if (ti < 0 || ai < ti) continue;
        const covered = stack.slice(ti, ai).some((n) => {
          if (n === el || el.contains(n)) return false;
          const c = rgba(getComputedStyle(n).backgroundColor);
          return !!c && c[3] >= 0.9;
        });
        if (covered) continue;
        seen.add(el);
        out.push(
          `ux-name-over-art: "${(el.textContent ?? "").trim().slice(0, 30)}" is drawn over art ${a.tagName.toLowerCase()}${a.getAttribute("data-art") ? "[data-art]" : ""} ${Math.round(ar.width)}x${Math.round(ar.height)}`,
        );
      }
    }
  }

  // Reduced transparency: no blur or frosted layer survives the preference.
  if (matchMedia("(prefers-reduced-transparency: reduce)").matches)
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const v of [
        cs.backdropFilter,
        cs.getPropertyValue("-webkit-backdrop-filter"),
      ])
        if (v && v !== "none")
          out.push(
            `ux-transparency: ${name(el)} keeps ${v.slice(0, 30)} under reduced transparency`,
          );
    }

  // B7: weights are 400/500/600 on every surface; 700 and up only on the wordmark.
  for (const el of els) {
    if (
      el.closest(
        "svg, [data-wordmark], .pk-wordmark, [data-brand-mark], [data-ui-allow~=ux-weight]",
      )
    )
      continue;
    if (
      !Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent!.trim(),
      )
    )
      continue;
    const wgt = parseInt(getComputedStyle(el).fontWeight, 10);
    if (wgt >= 700) out.push(`ux-weight: ${name(el)} is weight ${wgt}`);
  }
  return [...new Set(out)];
}

/** Presses Tab through the page and checks each stop's ring is the service ring (B6, B17). */
async function focusColourFindings(
  page: Page,
  maxTabs: number,
): Promise<string[]> {
  if (await page.evaluate(() => matchMedia("(forced-colors: active)").matches))
    return [];
  const out: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || !el.matches(":focus-visible"))
        return null;
      // The toaster is the vendor's: a toast takes a tab stop so it can be read and dismissed.
      if (el.closest("[data-sonner-toaster]")) return null;
      const cs = getComputedStyle(el);
      // The element's own ring token, resolved to a colour by a probe on the root.
      const token = cs.getPropertyValue("--pk-focus").trim();
      const probe = document.createElement("span");
      probe.style.color = token || "var(--pk-focus)";
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      const label = `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28)}"`;
      const ring =
        cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0
          ? cs.outlineColor
          : (cs.boxShadow.match(
              /(?:rgba?|oklch|oklab|color)\((?:[^()]|\([^()]*\))*\)/,
            )?.[0] ?? "");
      return { want, ring, label };
    });
    if (!r) continue;
    if (!r.ring) continue;
    const same = await page.evaluate(
      ([a, b]) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const x = c.getContext("2d", { willReadFrequently: true })!;
        const px = (s: string) => {
          x.clearRect(0, 0, 1, 1);
          x.fillStyle = "#000";
          x.fillStyle = s;
          x.fillRect(0, 0, 1, 1);
          return Array.from(x.getImageData(0, 0, 1, 1).data);
        };
        const p = px(a!);
        const q = px(b!);
        return p.every((v, k) => Math.abs(v - q[k]!) <= 3);
      },
      [r.want, r.ring],
    );
    if (!same)
      out.push(
        `ux-focus-colour: ${r.label} rings ${r.ring.slice(0, 40)}, not its service ring ${r.want.slice(0, 40)}`,
      );
  }
  return [...new Set(out)];
}

/**
 * B6, B7 and B17 over what the page shows now. `scope` is the CSS selector of the area to check
 * (the whole body by default).
 */
export async function uxBarFindings(
  page: Page,
  options: UxBarOptions & { scope?: string } = {},
): Promise<string[]> {
  const found = await page.evaluate(uxBarInPage, {
    scopeSelector: options.scope ?? "body",
  });
  if (options.focus)
    found.push(...(await focusColourFindings(page, options.maxTabs ?? 30)));
  return found;
}

/** Emulates `prefers-reduced-transparency: reduce` (Playwright has no option for it). */
export async function reduceTransparency(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
}
