// The modernity lint's in-page half (UI-KITS.md §7.3). Injected as a plain script (never through
// a bundler, so nothing rewrites it) by src/run.ts; it defines window.__pkUiLint(options) and
// returns { violations, strings }.
//
// Scope. Every element matching options.scope (default "[data-shot]") is one scope; a page with
// none is linted as a single "page" scope. Inside a scope:
//   - [data-ui-chrome] marks platform or board chrome drawn around the kit (a status bar, a window
//     frame, a host app the kit drops into, a caption). Nothing inside it is linted and its
//     strings are not kit strings.
//   - [data-ui-allow="rule rule …"] allows the named rules on that subtree. Every use must carry a
//     reason in the markup next to it; the e2e suite counts them so the allowance cannot grow
//     unnoticed.
//   - [data-ui-touch] (on the scope, inside it or on any ancestor) marks a touch variant: touch
//     targets ≥ 44 px.
//   - [data-ui-preset="native"] marks the native preset (§3.4): the platform's own fonts and
//     colours are expected there, so font-family and colour-literal do not apply.
// Style rules (the ones about authored CSS) are checked on every CSSStyleRule whose selector
// matches at least one linted element, so board layout CSS and chrome CSS never count.
(function () {
  "use strict";

  const BUTTONISH =
    'button, [role="button"], input[type="button"], input[type="submit"], .k-btn, [data-part~="button"]';
  const INTERACTIVE =
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const HEADINGS =
    'h1, h2, h3, h4, h5, h6, [role="heading"], .k-h1, .k-h2, [data-part~="title"], [data-part~="heading"]';
  const LEDES = '.k-lede, [data-part~="lede"], [data-part~="subtitle"]';
  const META = '.k-meta, [data-part~="meta"], [data-part~="row-meta"]';
  const FIELDS =
    'input, textarea, [role="textbox"], .k-field, [data-part~="field"]';
  const PRIMARY = '.primary, [data-variant="primary"], [data-part~="primary"]';
  const CLOSE =
    '[aria-label="Close"], [aria-label="close"], [data-part~="close"], button:has(> [data-icon="x"]), .k-iconbtn:has([data-icon="x"])';
  const SEPARATORS = new Set(["·", "•", "|", "—", "–", "/"]);
  const KEY_RE =
    /^(pkey_[a-z0-9]+_[A-Z0-9…]{4,}|[A-Z0-9]{4,6}(-[A-Z0-9]{4,6}){2,})$/;

  window.__pkUiLint = function (options) {
    const o = Object.assign(
      {
        scope: "[data-shot]",
        fonts: [],
        allowWeight700: [],
        dismissWords: ["Cancel", "Later", "Not now"],
        minTouch: 44,
        minFont: 12,
      },
      options || {},
    );
    // Configured markings (a board's chrome, allowances and touch variants live in config so the
    // mockups themselves stay clean markup).
    for (const sel of o.chrome || [])
      for (const el of document.querySelectorAll(sel))
        el.setAttribute("data-ui-chrome", "");
    for (const sel of o.touch || [])
      for (const el of document.querySelectorAll(sel))
        el.setAttribute("data-ui-touch", "");
    for (const [rule, sels] of Object.entries(o.allow || {}))
      for (const sel of sels)
        for (const el of document.querySelectorAll(sel)) {
          const cur = el.getAttribute("data-ui-allow");
          el.setAttribute("data-ui-allow", cur ? `${cur} ${rule}` : rule);
        }
    const violations = [];
    const strings = [];
    let scopes = [...document.querySelectorAll(o.scope)];
    if (!scopes.length) scopes = [document.body];

    const fonts = new Set(
      (o.fonts.length ? o.fonts : themeFonts()).map((f) => norm(f)),
    );

    for (const scope of scopes) {
      const scopeName =
        scope.getAttribute("data-shot") ||
        scope.getAttribute("data-ui-scope") ||
        "page";
      const report = (rule, el, detail) => {
        if (el && allowed(el, rule)) return;
        violations.push({
          rule,
          scope: scopeName,
          target: el ? describe(el) : "",
          detail,
        });
      };
      const els = [scope, ...scope.querySelectorAll("*")].filter(
        (el) => !el.closest("[data-ui-chrome]") && visible(el),
      );

      for (const el of els) {
        const cs = getComputedStyle(el);
        const textual = hasOwnText(el) && !iconFont(cs);
        const native = !!el.closest('[data-ui-preset="native"]');

        // Borders: hairlines only.
        for (const side of ["top", "right", "bottom", "left"]) {
          const w = parseFloat(cs[`border-${side}-width`]);
          if (cs[`border-${side}-style`] !== "none" && w > 1) {
            report("border-width", el, `border-${side} is ${w}px (max 1px)`);
            break;
          }
        }

        if (el.matches(BUTTONISH)) {
          if (cs.textTransform === "uppercase")
            report("button-uppercase", el, "text-transform: uppercase");
          for (const layer of shadowLayers(cs.boxShadow)) {
            if (!layer.inset && layer.color && chromatic(layer.color))
              report(
                "button-glow",
                el,
                `coloured box-shadow ${layer.color} under a button`,
              );
          }
        }

        if (textual) {
          const fam = norm(cs.fontFamily.split(",")[0] || "");
          if (!native && fonts.size && !fonts.has(fam))
            report(
              "font-family",
              el,
              `font-family ${cs.fontFamily.split(",")[0]} is not the theme's (${[...fonts].join(", ")})`,
            );
          const weight = parseInt(cs.fontWeight, 10);
          if (
            weight >= 700 &&
            !o.allowWeight700.some((s) => el.matches(s) || el.closest(s))
          )
            report("font-weight-700", el, `font-weight ${weight}`);
          const size = parseFloat(cs.fontSize);
          if (size < o.minFont)
            report("text-size-floor", el, `font-size ${size}px (min 12px)`);
          if (SEPARATORS.has(ownText(el).trim()) && el !== scope) {
            const pd = getComputedStyle(el.parentElement).display;
            if (/flex|grid/.test(pd))
              report(
                "tier-separator",
                el,
                `separator "${ownText(el).trim()}" is its own ${pd} item; keep it in one text run with its neighbours`,
              );
          }
          const t = el.textContent.trim();
          if (
            KEY_RE.test(t) &&
            el.closest(FIELDS) &&
            lineCount(el) > 1 &&
            !/nowrap|pre/.test(cs.whiteSpace)
          )
            report(
              "key-nowrap",
              el,
              "a license key wraps inside a field (white-space: nowrap + middle ellipsis)",
            );
        }

        if (
          el.matches(`${HEADINGS}, ${LEDES}, ${META}`) &&
          el.textContent.trim()
        ) {
          const orphan = orphanWord(el);
          if (orphan)
            report(
              "orphan",
              el,
              `last line is the single word "${orphan}" (text-wrap: balance for headings, pretty for body, or rewrite)`,
            );
        }

        // Shape and material.
        if (cs.backdropFilter && cs.backdropFilter !== "none") {
          let p = el.parentElement;
          while (p && p !== scope.parentElement) {
            const pb = getComputedStyle(p).backdropFilter;
            if (pb && pb !== "none" && !p.closest("[data-ui-chrome]")) {
              report(
                "glass-on-glass",
                el,
                `backdrop-filter inside ${describe(p)}, which is already glass`,
              );
              break;
            }
            p = p.parentElement;
          }
        }
        squareInRounded(el, cs, scope, report);
        if (el.matches('[data-part~="scrim"], .scrim, .k-scrim')) {
          const host = el.offsetParent || el.parentElement;
          if (host) {
            const a = el.getBoundingClientRect();
            const b = host.getBoundingClientRect();
            if (
              a.left > b.left + 1 ||
              a.top > b.top + 1 ||
              a.right < b.right - 1 ||
              a.bottom < b.bottom - 1
            )
              report(
                "scrim-coverage",
                el,
                "the scrim does not cover the whole window evenly",
              );
          }
        }
        if (
          el.matches(
            'img, [data-art], [data-part~="logo"], [data-part~="art"], [data-part~="icon"], [data-part~="image"]',
          ) &&
          emptyBox(el, cs)
        )
          report(
            "empty-placeholder",
            el,
            "an empty placeholder where an image or logo belongs",
          );

        if (
          el.closest("[data-ui-touch]") &&
          el.matches(INTERACTIVE) &&
          !inlineLink(el, cs)
        ) {
          const r = el.getBoundingClientRect();
          if (r.width < o.minTouch - 0.5 || r.height < o.minTouch - 0.5)
            report(
              "touch-target",
              el,
              `${Math.round(r.width)}×${Math.round(r.height)}px (min ${o.minTouch}px on touch)`,
            );
        }
      }

      // Regions: one primary, one dismissal.
      const regions = new Set();
      for (const el of els) {
        if (el.matches(PRIMARY) && el.matches(BUTTONISH))
          regions.add(region(el, scope));
      }
      for (const r of regions) {
        const primaries = [...r.querySelectorAll(PRIMARY)].filter(
          (b) =>
            b.matches(BUTTONISH) &&
            visible(b) &&
            !b.closest("[data-ui-chrome]") &&
            region(b, scope) === r,
        );
        if (primaries.length > 1)
          report(
            "one-primary",
            primaries[1],
            `${primaries.length} primary buttons in ${describe(r)}`,
          );
      }
      const surfaces = new Set(
        els.filter((el) => el.matches(CLOSE)).map((el) => region(el, scope)),
      );
      for (const s of surfaces) {
        const dismiss = [...s.querySelectorAll(BUTTONISH)].find(
          (b) =>
            visible(b) &&
            region(b, scope) === s &&
            o.dismissWords.includes(b.textContent.trim()),
        );
        if (dismiss)
          report(
            "x-beside-cancel",
            dismiss,
            `a close X and "${dismiss.textContent.trim()}" on one surface`,
          );
      }

      // Interactive states, from the authored CSS.
      for (const el of els) {
        if (!el.matches(INTERACTIVE) || el.matches("[data-ui-static]"))
          continue;
        const missing = ["hover", "active", "disabled", "focus-visible"].filter(
          (st) => !hasStateRule(el, st),
        );
        if (missing.length)
          report(
            "interactive-states",
            el,
            `no ${missing.map((m) => ":" + m).join(", ")} style`,
          );
      }

      // Visible strings for the string lint (node side).
      for (const el of els) {
        if (!hasOwnText(el) || el.closest("[data-ui-no-strings]")) continue;
        if (iconFont(getComputedStyle(el))) continue;
        const text = el.innerText.replace(/\s+/g, " ").trim();
        if (!text) continue;
        // Only the outermost text-bearing element of a run: nested inline formatting (<b>, <span>)
        // belongs to its parent's string.
        const p = el.parentElement;
        if (
          p &&
          p !== scope.parentElement &&
          hasOwnText(p) &&
          !p.closest("[data-ui-chrome]") &&
          scope.contains(p) &&
          getComputedStyle(el).display.startsWith("inline")
        )
          continue;
        // Preformatted output (the terminal) is a list of lines, each its own string.
        if (getComputedStyle(el).whiteSpace.startsWith("pre")) {
          for (const line of el.innerText.split("\n")) {
            const t = line.replace(/\s+/g, " ").trim();
            if (t)
              strings.push({ scope: scopeName, target: describe(el), text: t });
          }
          continue;
        }
        strings.push({ scope: scopeName, target: describe(el), text });
      }
    }

    // Authored CSS: every style rule that applies to a linted element.
    const linted = new Set();
    for (const scope of scopes)
      for (const el of [scope, ...scope.querySelectorAll("*")])
        if (!el.closest("[data-ui-chrome]")) linted.add(el);
    for (const { rule, sheet } of styleRules()) {
      let hit = o.allRules ? document.body : null;
      if (!hit)
        try {
          const base = stripPseudo(rule.selectorText);
          if (!base) continue;
          for (const el of document.querySelectorAll(base)) {
            if (linted.has(el)) {
              hit = el;
              break;
            }
          }
        } catch {
          continue;
        }
      if (!hit) continue;
      cssRules(rule, sheet, hit, violations, scopes);
    }

    // Inline style attributes are authored CSS too (a React style prop, a mockup's one-off).
    for (const el of linted) {
      const css = el.getAttribute && el.getAttribute("style");
      if (css)
        checkDecls(
          "[style]",
          el.style.cssText,
          `inline style on ${describe(el)}`,
          el,
          violations,
          scopes,
        );
    }

    // No alert / confirm.
    for (const call of window.__pkUiLintAlerts || [])
      violations.push({
        rule: "no-alert",
        scope: "page",
        target: "window",
        detail: `${call}() was called`,
      });
    for (const s of document.querySelectorAll("script:not([src])")) {
      const m = s.textContent.match(
        /(^|[^.\w])(window\.)?(alert|confirm|prompt)\s*\(/,
      );
      if (m)
        violations.push({
          rule: "no-alert",
          scope: "page",
          target: "inline script",
          detail: `${m[3]}() in an inline script`,
        });
    }

    return { violations, strings };
  };

  // ── style-rule checks ──────────────────────────────────────────────────────────────────────
  function cssRules(rule, sheet, hit, out, scopes) {
    checkDecls(
      rule.selectorText,
      rule.style.cssText,
      `${sheetName(sheet)} ${rule.selectorText}`,
      hit,
      out,
      scopes,
    );
  }

  function checkDecls(sel, cssText, where, hit, out, scopes) {
    const scope = scopeOf(hit, scopes);
    const push = (id, detail) => {
      if (allowed(hit, id)) return;
      out.push({ rule: id, scope, target: where, detail });
    };
    // The declarations as authored, with shorthands kept: the CSSOM's own enumeration expands
    // `padding: 0 16px` into padding-left and padding-right, which are not what anyone wrote.
    const decls = splitTop(cssText, ";")
      .map((d) => {
        const i = d.indexOf(":");
        return i < 0
          ? null
          : [
              d.slice(0, i).trim().toLowerCase(),
              d
                .slice(i + 1)
                .replace(/!important/, "")
                .trim(),
            ];
      })
      .filter(Boolean);
    const focusish = /:focus(?![-\w])/.test(sel);
    const focusVisible = /:focus-visible/.test(sel);
    for (const [p, v] of decls) {
      if (
        focusish &&
        /^(outline|box-shadow|border)/.test(p) &&
        v &&
        v !== "none" &&
        !/^0(px)?$/.test(v) &&
        !/:not\(:focus-visible\)/.test(sel)
      ) {
        push(
          "focus-visible-only",
          `${p} on :focus (the ring belongs on :focus-visible only)`,
        );
      }
      if (
        (focusish || focusVisible) &&
        p === "box-shadow" &&
        v !== "none" &&
        shadowLayers(v).some((l) => !l.inset)
      )
        push(
          "focus-ring-spread",
          "an outer box-shadow on focus (one 2 px outline at offset 0, no halo)",
        );
      if (/^(margin|padding|border)-(left|right)(-|$)/.test(p))
        push(
          "rtl-physical",
          `${p} (use ${p.replace("left", "inline-start").replace("right", "inline-end")})`,
        );
      if (p === "left" || p === "right")
        push(
          "rtl-physical",
          `${p}: ${v} (use inset-inline-${p === "left" ? "start" : "end"})`,
        );
      if (
        (p === "text-align" || p === "float" || p === "clear") &&
        /^(left|right)$/.test(v)
      )
        push(
          "rtl-physical",
          `${p}: ${v} (use ${v === "left" ? "start" : "end"})`,
        );
      if (/(^|[\s(,])-?[\d.]+(vw|svw|lvw|dvw|vmin|vmax)\b/.test(v))
        push("no-vw", `${p}: ${v} (container units only)`);
      if (p === "font-size" && fractionalPx(v))
        push("fractional-font-size", `font-size: ${v}`);
      if (
        !p.startsWith("--") &&
        // A mask's colours are alpha stops, not colours anyone sees.
        !/^(-webkit-)?mask/.test(p) &&
        colourLiteral(v) &&
        !hit.closest('[data-ui-preset="native"]')
      )
        push(
          "colour-literal",
          `${p}: ${v} (colours come from the generated tokens)`,
        );
    }
    // The font shorthand never survives into getPropertyValue("font-size") with its authored
    // unit when it uses var(); read the authored cssText for fractional sizes there.
    const m = cssText.match(/font:\s*[^;]*?\s(\d+\.\d+)px/);
    if (
      m &&
      !decls.some(([p]) => p === "font-size" && fractionalPx(`${m[1]}px`))
    )
      push("fractional-font-size", `font: …${m[1]}px…`);
  }

  function hasStateRule(el, state) {
    const pats = {
      hover: /:hover/,
      active: /:active/,
      disabled: /:disabled|\[aria-disabled|\[disabled|:is\(\[aria-disabled/,
      "focus-visible": /:focus-visible/,
    };
    for (const { rule } of styleRules()) {
      const sel = rule.selectorText;
      if (!pats[state].test(sel)) continue;
      for (const part of splitSelector(sel)) {
        if (!pats[state].test(part)) continue;
        const base = stripPseudo(part)
          .replace(/\[aria-disabled[^\]]*\]|\[disabled\]/g, "")
          .trim();
        try {
          if (!base || base === "*" || el.matches(base)) return true;
        } catch {
          /* unsupported selector */
        }
      }
    }
    return false;
  }

  let ruleCache = null;
  function styleRules() {
    if (ruleCache) return ruleCache;
    ruleCache = [];
    const walk = (list, sheet) => {
      for (const r of list) {
        if (r instanceof CSSStyleRule) {
          ruleCache.push({ rule: r, sheet });
          if (r.cssRules && r.cssRules.length) walk(r.cssRules, sheet);
        } else if (r instanceof CSSImportRule) {
          if (r.styleSheet) walk(r.styleSheet.cssRules, r.styleSheet);
        } else if (r.cssRules) {
          walk(r.cssRules, sheet);
        }
      }
    };
    for (const s of document.styleSheets) {
      try {
        walk(s.cssRules, s);
      } catch {
        /* cross-origin sheet */
      }
    }
    return ruleCache;
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────
  function themeFonts() {
    const root = getComputedStyle(document.documentElement);
    const out = [];
    for (const v of [
      "--pk-font-sans",
      "--pk-font-mono",
      "--kit-font",
      "--kit-mono",
    ]) {
      const f = root.getPropertyValue(v).trim();
      if (f && !f.startsWith("var(")) out.push(f.split(",")[0]);
    }
    return out;
  }
  // Ligature icon fonts (Material Symbols): their text is a glyph name, not copy or type.
  function iconFont(cs) {
    return /symbols|icons/i.test(cs.fontFamily.split(",")[0] || "");
  }
  function norm(f) {
    return f
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
  }
  function allowed(el, rule) {
    let n = el;
    while (n && n.nodeType === 1) {
      const a = n.getAttribute("data-ui-allow");
      if (a && a.split(/\s+/).includes(rule)) return true;
      n = n.parentElement;
    }
    return false;
  }
  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t;
  }
  function hasOwnText(el) {
    if (el.closest("svg")) return false;
    if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName)) return false;
    return ownText(el).trim().length > 0;
  }
  function describe(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 4; i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += `#${n.id}`;
      const cls = [...n.classList].slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      if (n.hasAttribute("data-shot"))
        s += `[data-shot=${n.getAttribute("data-shot")}]`;
      parts.unshift(s);
      if (n.hasAttribute("data-shot")) break;
      n = n.parentElement;
    }
    const t = el.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
    return parts.join(" > ") + (t ? ` "${t}"` : "");
  }
  function scopeOf(el, scopes) {
    const s = scopes.find((x) => x.contains(el));
    return (
      (s && (s.getAttribute("data-shot") || s.getAttribute("data-ui-scope"))) ||
      "page"
    );
  }
  function sheetName(sheet) {
    if (!sheet) return "";
    if (sheet.href) return sheet.href.split("/").pop();
    return "inline <style>";
  }
  function splitSelector(sel) {
    return splitTop(sel, ",");
  }
  function splitTop(sel, sep) {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of sel) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === sep && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function stripPseudo(sel) {
    return splitSelector(sel)
      .map((s) =>
        s
          .replace(
            /::?(before|after|placeholder|selection|marker|backdrop|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g,
            "",
          )
          .replace(
            /:(hover|active|focus-visible|focus-within|focus|visited|link|disabled|enabled|checked|indeterminate|placeholder-shown|invalid|valid|required|optional|read-only|read-write|default|target)\b/g,
            "",
          )
          .replace(/:not\(\s*\)/g, "")
          .trim(),
      )
      .filter(Boolean)
      .map((s) => (/[>+~]$/.test(s) ? s + " *" : s))
      .join(", ");
  }
  function shadowLayers(v) {
    if (!v || v === "none") return [];
    return splitSelector(v).map((layer) => {
      const color =
        (layer.match(
          /(rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|color-mix\(.*\)|oklch\([^)]*\)|hsla?\([^)]*\))/i,
        ) || [])[0] || null;
      const lens =
        layer.replace(color || "", "").match(/-?[\d.]+px|\b0\b/g) || [];
      return {
        inset: /\binset\b/.test(layer),
        color,
        spread: lens[3] ? parseFloat(lens[3]) : 0,
      };
    });
  }
  function chromatic(color) {
    const m = color.match(/rgba?\(([^)]*)\)/);
    if (!m) return /oklch|hsl|color-mix|#/.test(color);
    const n = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    const [r, g, b] = n;
    const a = n.length > 3 ? n[3] : 1;
    if (a === 0) return false;
    return Math.max(r, g, b) - Math.min(r, g, b) > 40;
  }
  function colourLiteral(v) {
    const s = v.replace(/var\([^)]*\)/g, "");
    if (/#[0-9a-f]{3,8}\b/i.test(s)) return true;
    if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(s)) return true;
    return /(^|[\s,(])(white|black|red|blue|green|gray|grey|orange|purple|yellow|pink)(?=$|[\s,)])/i.test(
      s,
    );
  }
  function fractionalPx(v) {
    if (/clamp|calc|min\(|max\(|var\(/.test(v)) return false;
    const px = v.match(/^(-?[\d.]+)px$/);
    if (px) return !Number.isInteger(parseFloat(px[1]));
    const rem = v.match(/^(-?[\d.]+)r?em$/);
    if (rem && /rem$/.test(v))
      return !Number.isInteger(parseFloat(rem[1]) * 16);
    return false;
  }
  function lineCount(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set(
      [...range.getClientRects()]
        .filter((r) => r.width > 0)
        .map((r) => Math.round(r.top)),
    );
    return tops.size;
  }
  function orphanWord(el) {
    const words = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && n.parentElement.closest("svg")) continue;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(n.nodeValue))) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        const rect = [...r.getClientRects()].pop();
        if (rect && rect.width > 0)
          words.push({ w: m[0], top: Math.round(rect.top), h: rect.height });
      }
    }
    if (words.length < 3) return null;
    const lines = [];
    for (const w of words) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - w.top) < w.h / 2) last.words.push(w.w);
      else lines.push({ top: w.top, words: [w.w] });
    }
    if (lines.length < 2) return null;
    const tail = lines[lines.length - 1].words;
    const prev = lines[lines.length - 2].words;
    // An orphan is a lone last word under a fuller line. A heading set word per line (large
    // Dynamic Type, 200 % font) has no fuller line to balance against. A glyph-only token (a
    // separator, an arrow) is not a word.
    if (
      tail.length === 1 &&
      prev.length >= 2 &&
      /[\p{L}\p{N}]{2,}/u.test(tail[0])
    )
      return tail[0];
    return null;
  }
  function squareInRounded(el, cs, scope, report) {
    if (el === scope) return;
    const bg = cs.backgroundColor;
    const opaqueBg =
      bg && !/rgba\([^)]*,\s*0\)$/.test(bg) && bg !== "transparent";
    if (!opaqueBg && cs.backgroundImage === "none") return;
    if (
      parseFloat(cs.borderTopLeftRadius) > 0 ||
      parseFloat(cs.borderBottomRightRadius) > 0
    )
      return;
    let p = el.parentElement;
    for (let i = 0; p && i < 4 && scope.contains(p); i++, p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (/hidden|clip/.test(pcs.overflow)) return;
      const rad =
        parseFloat(pcs.borderTopLeftRadius) ||
        parseFloat(pcs.borderBottomLeftRadius);
      if (!rad) continue;
      const a = el.getBoundingClientRect();
      const b = p.getBoundingClientRect();
      const touches =
        (Math.abs(a.left - b.left) < 1 || Math.abs(a.right - b.right) < 1) &&
        (Math.abs(a.top - b.top) < 1 || Math.abs(a.bottom - b.bottom) < 1);
      if (touches && rad >= 2)
        report(
          "square-in-rounded",
          el,
          `square corner inside ${describe(p)} (radius ${rad}px); take the group radius or clip`,
        );
      return;
    }
  }
  function emptyBox(el, cs) {
    if (el.tagName === "IMG") return !el.complete || el.naturalWidth === 0;
    if (el.children.length) return false;
    if (el.textContent.trim()) return false;
    if (cs.backgroundImage && cs.backgroundImage !== "none") return false;
    if (cs.maskImage && cs.maskImage !== "none") return false;
    return true;
  }
  function inlineLink(el, cs) {
    return (
      el.tagName === "A" &&
      cs.display === "inline" &&
      ownText(el.parentElement).trim().length > 0
    );
  }
  function region(el, scope) {
    return (
      el.closest(
        '[data-region], form, dialog, [role="dialog"], [role="alertdialog"], .k-card, [data-part~="card"], [data-part~="sheet"]',
      ) || scope
    );
  }
})();
