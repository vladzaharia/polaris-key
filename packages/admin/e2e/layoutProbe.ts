/**
 * The in-page half of the console's layout lint (`layout.e2e.test.ts`): one self-contained
 * function, serialised into the page by `page.evaluate`, that measures the rendered console and
 * returns every breach of the four layout invariants. It imports nothing and closes over nothing,
 * so Playwright can ship its source text as-is.
 *
 *   trailing-space  A scroll container (the console's `main#content`, an open drawer's body, and
 *                   the document itself) scrolls further than its last visible content plus the
 *                   page's bottom padding. The report names the elements that reach past the
 *                   content, with the height rules (min-height, height, padding, margin, flex-grow)
 *                   that put them there.
 *   equal-height    Cards that sit side by side in one grid/flex row differ in outer height, or their
 *                   footers (the last block holding an action) do not share a bottom edge.
 *   right-align     A settings-style row (label left, control or value right) whose control/value
 *                   does not end at the row's content edge, rows in one card that end at different
 *                   x, a switch that is not flush right in its row, a numeric/date/count table column
 *                   that is not right-aligned with tabular figures, or page-header actions that do
 *                   not end at the header's right edge.
 *   overflow        The page or a scroll container scrolls sideways, or a text box clips or spills
 *                   its text without an intended scroller or a way to read the whole text.
 */

export interface LayoutViolation {
  rule: "trailing-space" | "equal-height" | "right-align" | "overflow";
  /** A finer key for grouping (`main`, `settings-row`, `table-numeric`…). */
  kind: string;
  /** A short, stable-ish CSS path to the offending element. */
  where: string;
  /** What was measured. */
  detail: string;
  /** Class lists and computed rules on and around the element: the root-cause trail. */
  cause: string;
  /** The offending element's markup, trimmed. */
  html?: string;
}

export interface ProbeOptions {
  /** Max px a scroller may run past its last visible box (the page's bottom padding). */
  trailingSlack: number;
  /** Check equal heights (desktop only: rows stack on a phone). */
  rows: boolean;
}

/** What one scroll container measured, breach or not: the report's evidence for rule 1. */
export interface ScrollMetric {
  where: string;
  scrollHeight: number;
  clientHeight: number;
  /** Where the last visible box ends, in the scroller's content coordinates. */
  boxBottom: number;
  /** Where the last text or control ends. */
  inkBottom: number;
}

export interface ProbeResult {
  violations: LayoutViolation[];
  scrollers: ScrollMetric[];
}

export function probeLayout(opts: ProbeOptions): ProbeResult {
  const out: LayoutViolation[] = [];
  const metrics: ScrollMetric[] = [];
  const snip = (el: Element | null | undefined) =>
    el ? el.outerHTML.replace(/\s+/g, " ").slice(0, 600) : undefined;
  const W = window.innerWidth;
  const H = window.innerHeight;

  const mainEl = document.getElementById("content");
  const behindModal =
    mainEl !== null &&
    mainEl.closest("[aria-hidden=true],[inert]") !== null &&
    document.querySelector("[role=dialog],[role=alertdialog]") !== null;

  // ── helpers ────────────────────────────────────────────────────────────────────────────────
  const cs = (el: Element) => getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const cls = (el: Element) =>
    (typeof el.className === "string"
      ? el.className
      : el.getAttribute("class") || ""
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .join(".");
  const short = (el: Element) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    for (const a of [
      "data-template",
      "data-align",
      "role",
      "data-slot",
      "data-page-title",
      "aria-label",
    ]) {
      const v = el.getAttribute(a);
      if (v !== null) s += `[${a}${v ? `="${v.slice(0, 30)}"` : ""}]`;
    }
    const c = cls(el);
    if (c) s += `.${c}`;
    return s;
  };
  const where = (el: Element) => {
    const parts: string[] = [];
    let n: Element | null = el;
    while (n && parts.length < 4 && n !== document.body) {
      parts.unshift(short(n));
      if (n.id === "content" || n.getAttribute("role") === "dialog") break;
      n = n.parentElement;
    }
    return parts.join(" > ");
  };
  const clippedCache = new WeakMap<Element, boolean>();
  /** Inside a visually-hidden (`sr-only`) box: a 1px clipped ancestor. */
  const clipped = (el: Element | null): boolean => {
    if (!el || el === document.body) return false;
    const hit = clippedCache.get(el);
    if (hit !== undefined) return hit;
    const r = el.getBoundingClientRect();
    const s = cs(el);
    const own =
      (r.width <= 1 || r.height <= 1) &&
      (s.overflow === "hidden" || s.overflow === "clip" || s.clip !== "auto");
    const v = own || clipped(el.parentElement);
    clippedCache.set(el, v);
    return v;
  };
  const hidden = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return true;
    const s = cs(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0")
      return true;
    if (clipped(el.parentElement)) return true;
    const h = el.closest("[hidden],[inert]");
    // A modal makes everything behind it inert; the page is still drawn there.
    return h !== null && !(behindModal && h.contains(mainEl!));
  };
  const transparent = (c: string) =>
    c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c) || c.endsWith(" / 0)");
  const borderSides = (el: Element) => {
    const s = cs(el);
    let n = 0;
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      const w = px(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const style = s.getPropertyValue(`border-${side.toLowerCase()}-style`);
      const color = s.getPropertyValue(`border-${side.toLowerCase()}-color`);
      if (w > 0 && style !== "none" && !transparent(color)) n += 1;
    }
    return n;
  };
  const hasBox = (el: Element) => {
    const s = cs(el);
    return borderSides(el) > 0 || !transparent(s.backgroundColor);
  };
  const REPLACED =
    "img,svg,input,select,textarea,button,canvas,video,[role=switch],[role=combobox],[role=checkbox],[role=radio],progress,meter";
  /** Boxes of the visible "ink" under `root`: text runs, replaced elements and controls. */
  const ink = (root: Element): DOMRect[] => {
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent || !t.textContent.trim()) continue;
      const p = t.parentElement;
      if (!p || hidden(p)) continue;
      range.selectNodeContents(t);
      for (const r of Array.from(range.getClientRects()))
        if (r.width > 0 && r.height > 0) rects.push(r);
    }
    for (const e of Array.from(root.querySelectorAll(REPLACED))) {
      if (hidden(e)) continue;
      // An svg inside a button is covered by the button.
      if (e.tagName.toLowerCase() === "svg" && e.closest("button") !== null)
        continue;
      rects.push(e.getBoundingClientRect());
    }
    return rects;
  };
  /**
   * The right edge of what a viewer sees inside `el` (text, controls, pills, boxed fields), `el`
   * included. A box counts while it is narrower than 90% of `ref` (the row): a pill, a button or a
   * field's frame, not a full-width wrapper.
   */
  /** The element that set the last `inkRight` result: the report names it. */
  let inkEdge: Element | null = null;
  const inkRight = (el: Element, ref: number): number | null => {
    let right: number | null = null;
    inkEdge = null;
    const take = (x: number, by: Element | null) => {
      if (right === null || x > right) {
        right = x;
        inkEdge = by;
      }
    };
    for (const r of ink(el)) take(r.right, null);
    for (const e of [el, ...Array.from(el.querySelectorAll("*"))]) {
      if (hidden(e)) continue;
      const r = e.getBoundingClientRect();
      // A control's frame is its edge at any width: a full-width button ends where its box
      // ends, not where its centred label does.
      if (e.matches(REPLACED) || (hasBox(e) && e.matches("a[href]")))
        take(r.right, e);
      else if (hasBox(e) && r.width < ref * 0.9) take(r.right, e);
    }
    return right;
  };
  const edgeName = () => (inkEdge ? ` set by ${short(inkEdge)}` : "");
  const contentRight = (el: Element) =>
    el.getBoundingClientRect().right -
    px(cs(el).paddingRight) -
    px(cs(el).borderRightWidth);
  const isScroller = (el: Element, axis: "y" | "x") => {
    const o = axis === "y" ? cs(el).overflowY : cs(el).overflowX;
    return o === "auto" || o === "scroll";
  };
  const heightRules = (el: Element) => {
    const s = cs(el);
    const bits: string[] = [];
    if (s.minHeight !== "0px" && s.minHeight !== "auto")
      bits.push(`min-height:${s.minHeight}`);
    if (el instanceof HTMLElement && el.style.height)
      bits.push(`style.height:${el.style.height}`);
    if (px(s.paddingBottom) > 0) bits.push(`padding-bottom:${s.paddingBottom}`);
    if (px(s.marginBottom) > 0) bits.push(`margin-bottom:${s.marginBottom}`);
    if (s.flexGrow !== "0") bits.push(`flex-grow:${s.flexGrow}`);
    if (s.display.includes("grid"))
      bits.push(`grid-rows:${s.gridTemplateRows}`);
    bits.push(`h:${Math.round(el.getBoundingClientRect().height)}`);
    return bits.join(" ");
  };

  const dialogs = Array.from(
    document.querySelectorAll("[role=dialog],[role=alertdialog]"),
  ).filter((d) => !hidden(d));
  const main = document.getElementById("content");
  const roots: Element[] = [];
  if (main) roots.push(main);
  roots.push(...dialogs);

  // ── 1 · trailing space ─────────────────────────────────────────────────────────────────────
  const doc = document.scrollingElement as HTMLElement;
  if (doc.scrollHeight > H + 1)
    out.push({
      rule: "trailing-space",
      kind: "document",
      where: "document.scrollingElement",
      detail: `document scrolls ${doc.scrollHeight - H}px past the viewport (${doc.scrollHeight} > ${H})`,
      cause: Array.from(document.body.children)
        .filter((c) => c.getBoundingClientRect().bottom > H + 1)
        .map((c) => `${short(c)} {${heightRules(c)}}`)
        .join(" | "),
    });
  if (doc.scrollWidth > W + 1)
    out.push({
      rule: "overflow",
      kind: "document-x",
      where: "document.scrollingElement",
      detail: `document scrolls ${doc.scrollWidth - W}px sideways`,
      cause: "",
    });

  const scrollers = new Set<Element>();
  for (const root of roots) {
    if (isScroller(root, "y")) scrollers.add(root);
    for (const e of Array.from(root.querySelectorAll("*"))) {
      if (hidden(e) || !isScroller(e, "y")) continue;
      if (e.tagName === "TEXTAREA" || e.closest(".cm-editor")) continue;
      if ((e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 1)
        scrollers.add(e);
    }
  }
  if (mainEl) scrollers.add(mainEl);
  for (const sc of scrollers) {
    const el = sc as HTMLElement;
    const top = el.getBoundingClientRect().top + el.clientTop - el.scrollTop;
    let boxBottom = 0;
    let inkBottom = 0;
    for (const r of ink(el)) inkBottom = Math.max(inkBottom, r.bottom - top);
    for (const e of Array.from(el.querySelectorAll("*"))) {
      if (hidden(e) || !hasBox(e)) continue;
      const s = cs(e);
      if (s.position === "fixed") continue;
      boxBottom = Math.max(boxBottom, e.getBoundingClientRect().bottom - top);
    }
    boxBottom = Math.max(boxBottom, inkBottom);
    metrics.push({
      where: where(el),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      boxBottom: Math.round(boxBottom),
      inkBottom: Math.round(inkBottom),
    });
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const gap = el.scrollHeight - boxBottom;
    const inkGap = el.scrollHeight - inkBottom;
    const kind = el.id === "content" ? "main" : "scroller";
    if (gap > opts.trailingSlack || inkGap > opts.trailingSlack * 2) {
      // The elements that reach past the last visible box: the deepest few name the culprit.
      const reach: { el: Element; depth: number; bottom: number }[] = [];
      for (const e of Array.from(el.querySelectorAll("*"))) {
        if (cs(e).position === "fixed") continue;
        const b = e.getBoundingClientRect().bottom - top;
        if (b > boxBottom + 4) {
          let d = 0;
          for (let n: Element | null = e; n && n !== el; n = n.parentElement)
            d++;
          reach.push({ el: e, depth: d, bottom: b });
        }
      }
      reach.sort((a, b) => b.depth - a.depth);
      out.push({
        rule: "trailing-space",
        kind,
        where: where(el),
        detail: `scrolls ${Math.round(gap)}px past the last visible box (ink gap ${Math.round(inkGap)}px; scrollHeight ${el.scrollHeight}, clientHeight ${el.clientHeight}, last box ends at ${Math.round(boxBottom)})`,
        cause:
          `scroller {${heightRules(el)}} ` +
          reach
            .slice(0, 4)
            .map(
              (r) =>
                `${short(r.el)} {${heightRules(r.el)} bottom:${Math.round(r.bottom)}}`,
            )
            .join(" | "),
      });
    }
  }

  // ── 4 · overflow ───────────────────────────────────────────────────────────────────────────
  for (const root of roots) {
    const el = root as HTMLElement;
    if (el.scrollWidth > el.clientWidth + 1) {
      const rr = el.getBoundingClientRect();
      const wide = Array.from(el.querySelectorAll("*"))
        .filter(
          (e) => !hidden(e) && e.getBoundingClientRect().right > rr.right + 1,
        )
        .filter((e) => {
          // Only the outermost offender of each subtree, skipping content of an x-scroller.
          for (let n = e.parentElement; n && n !== el; n = n.parentElement)
            if (isScroller(n, "x")) return false;
          return true;
        })
        .slice(0, 3);
      out.push({
        rule: "overflow",
        kind: "page-x",
        where: where(el),
        detail: `scrolls ${el.scrollWidth - el.clientWidth}px sideways`,
        cause: wide
          .map(
            (e) =>
              `${short(e)} w:${Math.round(e.getBoundingClientRect().width)}`,
          )
          .join(" | "),
      });
    }
    for (const e of Array.from(el.querySelectorAll("*"))) {
      if (!(e instanceof HTMLElement) || hidden(e)) continue;
      if (e.closest(".cm-editor,pre,code,textarea")) continue;
      const own = Array.from(e.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent && n.textContent.trim(),
      );
      if (!own) continue;
      if (e.scrollWidth <= e.clientWidth + 1 || e.clientWidth === 0) continue;
      const s = cs(e);
      if (isScroller(e, "x")) continue;
      const titled =
        e.closest("[title]") !== null ||
        e.closest("[data-state][aria-describedby]") !== null ||
        e.closest("[data-truncate-disclosed]") !== null;
      if (s.overflowX === "hidden" || s.overflowX === "clip") {
        if (s.textOverflow === "ellipsis" && titled) continue;
        out.push({
          rule: "overflow",
          kind:
            s.textOverflow === "ellipsis"
              ? "truncated-no-disclosure"
              : "clipped",
          where: where(e),
          detail: `"${(e.textContent || "").trim().slice(0, 60)}" needs ${e.scrollWidth}px, has ${e.clientWidth}px`,
          cause: short(e),
        });
      } else if (s.display !== "inline") {
        out.push({
          rule: "overflow",
          kind: "spills",
          where: where(e),
          detail: `"${(e.textContent || "").trim().slice(0, 60)}" spills ${e.scrollWidth - e.clientWidth}px out of its box`,
          cause: `${short(e)} white-space:${s.whiteSpace} overflow-wrap:${s.overflowWrap}`,
        });
      }
    }
  }

  // ── 2 · equal-height rows ──────────────────────────────────────────────────────────────────
  const cardLike = (e: Element) => {
    if (hidden(e)) return false;
    const tag = e.tagName.toLowerCase();
    if (
      [
        "button",
        "input",
        "select",
        "textarea",
        "table",
        "tr",
        "td",
        "th",
      ].includes(tag)
    )
      return false;
    if (e.getAttribute("role") === "switch" || e.getAttribute("role") === "tab")
      return false;
    const r = e.getBoundingClientRect();
    if (r.width < 120 || r.height < 40) return false;
    if (px(cs(e).borderTopLeftRadius) < 2) return false;
    return borderSides(e) >= 3;
  };
  const cardOf = (child: Element): Element | null => {
    let n: Element | null = child;
    for (let i = 0; n && i < 4; i++) {
      if (cardLike(n)) return n;
      const kids: Element[] = Array.from(n.children).filter((k) => !hidden(k));
      if (kids.length !== 1) return null;
      n = kids[0]!;
    }
    return null;
  };
  if (opts.rows) {
    for (const root of roots) {
      for (const c of Array.from(root.querySelectorAll("*"))) {
        if (hidden(c)) continue;
        const s = cs(c);
        const grid = s.display === "grid" || s.display === "inline-grid";
        const rowFlex =
          (s.display === "flex" || s.display === "inline-flex") &&
          s.flexDirection.startsWith("row");
        if (!grid && !rowFlex) continue;
        const kids = Array.from(c.children).filter(
          (k) => !hidden(k) && !["absolute", "fixed"].includes(cs(k).position),
        );
        if (kids.length < 2) continue;
        const cards = kids
          .map((k) => ({ k, card: cardOf(k) }))
          .filter((x): x is { k: Element; card: Element } => x.card !== null);
        if (cards.length < 2) continue;
        // Group by row: the grid/flex item's top edge.
        const rows = new Map<number, Element[]>();
        for (const { k, card } of cards) {
          const t = Math.round(k.getBoundingClientRect().top);
          const key = [...rows.keys()].find((x) => Math.abs(x - t) <= 2) ?? t;
          rows.set(key, [...(rows.get(key) ?? []), card]);
        }
        for (const row of rows.values()) {
          if (row.length < 2) continue;
          const rs = row.map((x) => x.getBoundingClientRect());
          const hs = rs.map((r) => r.height);
          const tops = rs.map((r) => r.top);
          const spread = Math.max(...hs) - Math.min(...hs);
          const topSpread = Math.max(...tops) - Math.min(...tops);
          if (spread > 1 || topSpread > 1) {
            out.push({
              rule: "equal-height",
              kind: "row-height",
              where: where(c),
              detail: `${row.length} side-by-side cards: heights ${hs.map((h) => Math.round(h)).join("/")}px, tops ${tops.map((t) => Math.round(t)).join("/")}`,
              cause: `container {${short(c)} align-items:${s.alignItems}} cards: ${row
                .map((x) => `${short(x)} align-self:${cs(x).alignSelf}`)
                .join(" | ")}`,
              html: snip(row[0]!.parentElement),
            });
            continue;
          }
          // Footers: the last block of each card holding an action shares one bottom edge.
          const feet = row.map((card) => {
            const last = Array.from(card.children)
              .filter((k) => !hidden(k))
              .pop();
            return last && last.querySelector("button,a[href]") ? last : null;
          });
          if (feet.every((f) => f !== null)) {
            const bs = feet.map((f) => f!.getBoundingClientRect().bottom);
            if (Math.max(...bs) - Math.min(...bs) > 2)
              out.push({
                rule: "equal-height",
                kind: "footer-align",
                where: where(c),
                detail: `card footers end at ${bs.map((b) => Math.round(b)).join("/")}`,
                cause: feet.map((f) => short(f!)).join(" | "),
              });
          }
        }
      }
    }
  }

  // ── 3 · right alignment ────────────────────────────────────────────────────────────────────
  const CONTROL =
    "[role=switch],[role=combobox],select,button,input,a[href],[data-tone],[data-slot=badge]";
  const rowsByCard = new Map<Element, { row: Element; right: number }[]>();
  const checkRow = (row: Element, value: Element, kind: string) => {
    const right = inkRight(value, row.getBoundingClientRect().width);
    if (right === null) return;
    const edge = contentRight(row);
    const card =
      row.closest("section,[data-template] > div,[class*=rounded-lg]") ??
      row.parentElement!;
    rowsByCard.set(card, [...(rowsByCard.get(card) ?? []), { row, right }]);
    if (Math.abs(edge - right) > 2)
      out.push({
        rule: "right-align",
        kind,
        where: where(row),
        detail: `value ends at x=${Math.round(right)}${edgeName()}, row content edge x=${Math.round(edge)} (${Math.round(edge - right)}px short)`,
        cause: `row {${short(row)} justify:${cs(row).justifyContent}} value {${short(value)} text-align:${cs(value).textAlign} justify:${cs(value).justifyContent}}`,
        html: snip(value),
      });
  };
  const seen = new Set<Element>();
  for (const root of roots) {
    // a. SettingsRow, every variant: the end column, or the aside.
    for (const row of Array.from(root.querySelectorAll("[data-align]"))) {
      if (hidden(row)) continue;
      const inner = row.firstElementChild;
      if (!inner) continue;
      const align = row.getAttribute("data-align");
      seen.add(inner);
      if (align === "end") {
        const value = inner.lastElementChild;
        if (value && value !== inner.firstElementChild)
          checkRow(row, value, "settings-row");
      } else {
        // stretch/block: a read-only status (`aside`) is a value and belongs flush right.
        const aside =
          align === "block"
            ? inner.firstElementChild?.children[1]
            : inner.firstElementChild?.children[1];
        if (aside && !hidden(aside))
          checkRow(row, aside, `settings-row-${align}-aside`);
      }
    }
    // b. Generic label/value rows: flex space-between or a two-track grid of label + value.
    for (const row of Array.from(root.querySelectorAll("*"))) {
      if (seen.has(row) || hidden(row) || row.closest("[data-align]")) continue;
      if (
        row.closest(
          "table,[role=table],[role=grid],[role=tablist],header,nav,[role=toolbar]",
        )
      )
        continue;
      const s = cs(row);
      const kids = Array.from(row.children).filter(
        (k) => !hidden(k) && !["absolute", "fixed"].includes(cs(k).position),
      );
      if (kids.length !== 2) continue;
      const r = row.getBoundingClientRect();
      if (r.width < 260) continue;
      const [label, value] = kids as [Element, Element];
      const lt = (label.textContent || "").trim();
      if (!lt || label.querySelector("input,textarea,select,[role=combobox]"))
        continue;
      const vr = value.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      // Side by side, label on the left.
      if (
        !(
          lr.left < vr.left &&
          Math.abs(lr.top - vr.top) < Math.max(lr.height, vr.height)
        )
      )
        continue;
      if (
        value.querySelector(
          "textarea,.cm-editor,table,[role=table],[role=radiogroup]",
        )
      )
        continue;
      // Two term-over-value tiles side by side (a DescriptionList grid) are not a label and a value.
      if (
        value.querySelector("dt") !== null ||
        label.querySelector("dt") !== null
      )
        continue;
      const vt = (value.textContent || "").trim();
      const hasControl =
        value.matches(CONTROL) || value.querySelector(CONTROL) !== null;
      if (!hasControl && (vt.length === 0 || vt.length > 48)) continue;
      // A big block on the right (a card, a list) is not a value.
      if (vr.height > 80) continue;
      const flexSplit =
        (s.display === "flex" &&
          s.flexDirection === "row" &&
          s.justifyContent === "space-between") ||
        (s.display === "flex" &&
          px(cs(value).marginLeft) > 0 &&
          cs(value).marginLeft !== "0px");
      const gridSplit =
        s.display === "grid" &&
        s.gridTemplateColumns.trim().split(/\s+/).length === 2;
      if (!flexSplit && !gridSplit) continue;
      checkRow(row, value, gridSplit ? "kv-grid-row" : "kv-flex-row");
    }
    // c. A switch is flush right in its row.
    for (const sw of Array.from(root.querySelectorAll("[role=switch]"))) {
      if (hidden(sw) || sw.closest("[data-align]")) continue;
      let row: Element | null = sw.parentElement;
      while (row && row !== root) {
        const others = (row.textContent || "")
          .replace(sw.textContent || "", "")
          .trim();
        if (others && row.getBoundingClientRect().width > 200) break;
        row = row.parentElement;
      }
      if (!row || row === root) continue;
      const edge = contentRight(row);
      const right = sw.getBoundingClientRect().right;
      if (Math.abs(edge - right) > 2)
        out.push({
          rule: "right-align",
          kind: "switch",
          where: where(row),
          detail: `switch ends at x=${Math.round(right)}, its row's content edge x=${Math.round(edge)}`,
          cause: `row {${short(row)} display:${cs(row).display} justify:${cs(row).justifyContent}}`,
          html: snip(row),
        });
    }
    // d. Table columns of numbers, counts and dates: right-aligned, tabular figures.
    const tables = Array.from(
      root.querySelectorAll("table,[role=table],[role=grid]"),
    ).filter(
      (t) =>
        !hidden(t) &&
        !t.parentElement?.closest("table,[role=table],[role=grid]"),
    );
    const NUM =
      /^[−+-]?[\d,]+(\.\d+)?\s*(%|ms|s|m|h|d|KB|MB|GB|TB|B|bp|days?|hours?|minutes?|seats?|devices?|keys?|licenses?)?$/i;
    const DATE =
      /(\bago\b|^in \d|just now|yesterday|today|^\d{4}-\d{2}-\d{2}|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|^\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;
    const VERSION = /^v?\d+\.\d+(\.\d+)?/;
    for (const t of tables) {
      const rows = Array.from(t.querySelectorAll("tr,[role=row]")).filter(
        (r) => !hidden(r) && r.closest("table,[role=table],[role=grid]") === t,
      );
      const cellsOf = (r: Element) =>
        Array.from(r.children).filter((c) =>
          c.matches(
            "td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]",
          ),
        );
      const head = rows.find((r) =>
        cellsOf(r).some((c) => c.matches("th,[role=columnheader]")),
      );
      const body = rows.filter(
        (r) =>
          r !== head &&
          cellsOf(r).some((c) => c.matches("td,[role=cell],[role=gridcell]")),
      );
      if (body.length === 0) continue;
      const ncols = Math.max(...body.map((r) => cellsOf(r).length));
      for (let j = 0; j < ncols; j++) {
        const cells = body
          .map((r) => cellsOf(r)[j])
          .filter((c): c is Element => !!c && !hidden(c));
        const texts = cells
          .map((c) => (c.textContent || "").trim())
          .filter((x) => x && x !== "—" && x !== "-");
        if (texts.length === 0) continue;
        if (texts.filter((x) => VERSION.test(x)).length > texts.length / 2)
          continue;
        const numeric = texts.filter((x) => NUM.test(x) || DATE.test(x)).length;
        if (numeric < Math.max(1, texts.length * 0.6)) continue;
        const bad: string[] = [];
        let noTab = 0;
        for (const c of cells) {
          const tx = (c.textContent || "").trim();
          if (!tx) continue;
          const right = inkRight(c, c.getBoundingClientRect().width);
          if (right !== null && Math.abs(contentRight(c) - right) > 2)
            bad.push(
              `"${tx.slice(0, 20)}" short by ${Math.round(contentRight(c) - right)}px`,
            );
          let deepest: Element = c;
          for (const e of Array.from(c.querySelectorAll("*")))
            if (
              !hidden(e) &&
              Array.from(e.childNodes).some(
                (n) => n.nodeType === 3 && n.textContent?.trim(),
              )
            )
              deepest = e;
          if (!cs(deepest).fontVariantNumeric.includes("tabular-nums"))
            noTab += 1;
        }
        const hc = head ? cellsOf(head)[j] : undefined;
        const headerText = hc ? (hc.textContent || "").trim() : `col ${j + 1}`;
        if (bad.length)
          out.push({
            rule: "right-align",
            kind: "table-numeric",
            where: where(t),
            detail: `column "${headerText}" holds numbers/dates but is not right-aligned: ${bad.slice(0, 2).join("; ")}${bad.length > 2 ? ` (+${bad.length - 2})` : ""}`,
            cause: `cell {${short(cells[0]!)} text-align:${cs(cells[0]!).textAlign}}`,
            html: snip(cells[0]),
          });
        if (noTab)
          out.push({
            rule: "right-align",
            kind: "table-tabular-nums",
            where: where(t),
            detail: `column "${headerText}": ${noTab}/${cells.length} cells lack tabular-nums`,
            cause: `cell {${short(cells[0]!)} font-variant-numeric:${cs(cells[0]!).fontVariantNumeric}}`,
          });
        if (hc && !hidden(hc) && bad.length === 0) {
          const hr = inkRight(hc, hc.getBoundingClientRect().width);
          if (hr !== null && Math.abs(contentRight(hc) - hr) > 2)
            out.push({
              rule: "right-align",
              kind: "table-numeric-header",
              where: where(t),
              detail: `header "${headerText}" of a right-aligned column is not right-aligned (short by ${Math.round(contentRight(hc) - hr)}px)`,
              cause: `th {${short(hc)} text-align:${cs(hc).textAlign}}`,
            });
        }
      }
    }
  }
  // Rows in one card end at one x.
  for (const [card, list] of rowsByCard) {
    if (list.length < 2) continue;
    const rights = list.map((x) => x.right);
    if (Math.max(...rights) - Math.min(...rights) > 2)
      out.push({
        rule: "right-align",
        kind: "card-consistency",
        where: where(card),
        detail: `${list.length} rows end at x=${[...new Set(rights.map((r) => Math.round(r)))].join("/")}`,
        cause: list
          .filter((x) => Math.abs(x.right - Math.max(...rights)) > 2)
          .slice(0, 3)
          .map((x) => short(x.row))
          .join(" | "),
      });
  }
  // e. Page-header actions end at the header's right edge.
  for (const h of Array.from(document.querySelectorAll("#content header"))) {
    const title = h.querySelector("[data-page-title]");
    if (!title || hidden(h)) continue;
    const grid = h.querySelector(":scope > div.grid") ?? h.firstElementChild;
    if (!grid) continue;
    const parts = Array.from(grid.children).filter((k) => !hidden(k));
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1]!;
    const right = inkRight(last, h.getBoundingClientRect().width);
    if (right === null) continue;
    const edge = contentRight(h);
    if (Math.abs(edge - right) > 2)
      out.push({
        rule: "right-align",
        kind: "header-actions",
        where: where(last),
        detail: `header actions end at x=${Math.round(right)}, header edge x=${Math.round(edge)}`,
        cause: `${short(grid)} > ${short(last)}`,
        html: snip(last),
      });
  }
  return { violations: out, scrollers: metrics };
}
