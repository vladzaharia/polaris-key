/**
 * The in-page half of the console's layout lint (`layout.e2e.test.ts`): one self-contained
 * function, serialised into the page by `page.evaluate`, that measures the rendered console and
 * returns every breach of the five layout invariants. It imports nothing and closes over nothing,
 * so Playwright can ship its source text as-is.
 *
 *   trailing-space  A scroll container (the console's `main#content`, an open drawer's body, and
 *                   the document itself) scrolls further than its last visible content plus the
 *                   page's bottom padding. The report names the elements that reach past the
 *                   content, with the height rules (min-height, height, padding, margin, flex-grow)
 *                   that put them there.
 *   equal-height    Cards that sit side by side in one grid/flex row differ in outer height (a cell
 *                   that opens with its card and follows it with an actions row counts by its card),
 *                   their footers (a short closing block holding an action) do not share a bottom
 *                   edge, or a card stretched to its row's height leaves more than a row of empty
 *                   space under its content (stretch-gap: pair cards of close natural heights).
 *                   grown-card: any card, wherever it sits, that ends more than a row below its
 *                   own content (a panel grown to match a neighbouring stack, a pane stretched to
 *                   a long list's height); a placeholder is exempt only when its line is
 *                   actually centred in its box.
 *   right-align     A settings-style row (label left, control or value right) whose control/value
 *                   does not end at the row's content edge, rows in one card that end at different
 *                   x, a switch that is not flush right in its row, a numeric/date/count table column
 *                   that is not right-aligned with tabular figures, page-header actions that do
 *                   not end at the header's right edge, a grid of form fields capped short of its
 *                   card's content edge, or a switch whose help line describes the other state.
 *                   Edges are measured by visible ink: a frameless control (a labelled ghost
 *                   button) ends where its label and icon end, not where its padding does.
 *                   pill-right: a pill in a card header (`[data-card-header]`) sits at the
 *                   header's right edge: nothing but controls after it, and the header's ink
 *                   ends at its content edge (pills mean attention, ADMIN.md §5.11).
 *   overflow        The page or a scroll container scrolls sideways, a table scrolls sideways inside
 *                   its own wrapper (at desktop width; on a phone, a DataTable not drawn as cards),
 *                   a text box clips or spills its text without an intended scroller or a way to
 *                   read the whole text, or a button's non-text child (an icon, a service dot)
 *                   ends past the button's border box (child-spill; the top bar included).
 *                   text-crush: a text box squeezed narrower than about 4ch that wraps to more
 *                   than three lines (a sibling that will not shrink took its width: the text
 *                   is drawn a letter per line). card-spill: anything in a card that ends past
 *                   the card's border box (a row's action pushed out by a long name).
 *   rhythm          A card header (`[data-card-header]`) whose pieces on one line are not centred
 *                   on each other (header-center), or that a control makes taller than its
 *                   title (header-height: an sm button grows a 49px header to 57px beside its
 *                   siblings); a menu's grid of actions that leaves an empty cell in its last row
 *                   (grid-orphan: three links in two columns).
 */

export interface LayoutViolation {
  rule:
    | "trailing-space"
    | "equal-height"
    | "right-align"
    | "overflow"
    | "rhythm";
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
  /**
   * A frameless, labelled control (a ghost or link button, a bare link styled as one): no border,
   * no fill, and a text label. Its padding is invisible, so its edge is its ink (label and icon),
   * not its box. An icon-only button stays measured by its box: the square hit target is the
   * shape a viewer reads.
   */
  const frameless = (e: Element): boolean =>
    e.matches("button,a[href],[role=button]") &&
    !hasBox(e) &&
    !e.hasAttribute("data-icon") &&
    (e.textContent || "").trim().length > 0;
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
      // An svg inside a framed button is covered by the button; inside a frameless one it is
      // ink of its own.
      const host =
        e.tagName.toLowerCase() === "svg" ? e.closest("button") : null;
      if (host !== null && !frameless(host)) continue;
      // A frameless control is its ink (its label is a text run, its icon an svg), not its box.
      if (e !== host && frameless(e)) continue;
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
      // ends, not where its centred label does. A frameless one has no frame to see: its text
      // and icon (counted by `ink`) are its edge.
      if (frameless(e)) continue;
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

  /** A card: a bordered (3+ sides), rounded box of some size that is not a control or a cell. */
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

  // Text squeezed to a sliver: narrower than ~4ch and more than three lines tall, the letters of
  // a reason drawn one per line because a sibling (a long name) would not shrink. A 0px-wide box
  // counts as hidden elsewhere, so this check measures height and visibility on its own.
  for (const root of roots) {
    for (const e of Array.from(root.querySelectorAll("*"))) {
      if (!(e instanceof HTMLElement)) continue;
      if (e.closest(".cm-editor,pre,code,textarea,svg")) continue;
      const own = Array.from(e.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent && n.textContent.trim(),
      );
      if (!own) continue;
      const st = cs(e);
      const r = e.getBoundingClientRect();
      if (r.height <= 1 || st.display === "none" || st.visibility === "hidden")
        continue;
      if (clipped(e.parentElement) || e.closest("[hidden],[inert]")) continue;
      const fs = px(st.fontSize) || 14;
      const lh = px(st.lineHeight) || fs * 1.25;
      const text = (e.textContent || "").trim();
      if (
        text.length > 4 &&
        st.writingMode.startsWith("horizontal") &&
        r.width < fs * 0.55 * 4 &&
        r.height > lh * 3 + 1
      )
        out.push({
          rule: "overflow",
          kind: "text-crush",
          where: where(e),
          detail: `"${text.slice(0, 40)}" is squeezed to ${Math.round(r.width)}px wide and ${Math.round(r.height)}px tall (${Math.round(r.height / lh)} lines)`,
          cause: `text {${short(e)} min-width:${st.minWidth} flex:${st.flex}} siblings: ${Array.from(
            e.parentElement?.children ?? [],
          )
            .filter((k) => k !== e && !hidden(k))
            .map(
              (k) =>
                `${short(k)} w:${Math.round(k.getBoundingClientRect().width)} flex-shrink:${cs(k).flexShrink}`,
            )
            .join(" | ")}`,
          html: snip(e.parentElement),
        });
    }
  }

  // Anything in a card that ends past the card's border box: a row's action pushed out by a long
  // name, a fixed-width child wider than a narrow card. Content of a sideways scroller inside the
  // card, and positioned layers (a popover, a tooltip), are not the card's flow.
  for (const root of roots) {
    for (const card of Array.from(root.querySelectorAll("*"))) {
      if (!cardLike(card) || cs(card).position === "fixed") continue;
      if (card.matches("[role=dialog],[role=alertdialog]")) continue;
      const cr = card.getBoundingClientRect();
      for (const e of Array.from(card.querySelectorAll("*"))) {
        if (hidden(e)) continue;
        const r = e.getBoundingClientRect();
        const past = Math.max(r.right - cr.right, cr.left - r.left);
        if (past <= 1) continue;
        let layered = false;
        for (let n: Element | null = e; n && n !== card; n = n.parentElement) {
          const ns = cs(n);
          // A clipping ancestor (a truncated title, a sideways scroller) hides what runs past it;
          // that ancestor is measured on its own.
          if (
            ns.position === "absolute" ||
            ns.position === "fixed" ||
            (n !== e &&
              ["hidden", "clip", "auto", "scroll"].includes(ns.overflowX))
          ) {
            layered = true;
            break;
          }
        }
        if (layered) continue;
        out.push({
          rule: "overflow",
          kind: "card-spill",
          where: where(e),
          detail: `ends ${Math.round(past)}px past its card's border box (${Math.round(r.left)}–${Math.round(r.right)} in a card ${Math.round(cr.left)}–${Math.round(cr.right)})`,
          cause: `card {${short(card)}} child {${short(e)} w:${Math.round(r.width)} flex-shrink:${cs(e).flexShrink}} parent {${e.parentElement ? short(e.parentElement) : "?"}}`,
          html: snip(e.parentElement),
        });
        break;
      }
    }
  }

  // A button's non-text child (an icon, a row of service dots) that ends past the button's
  // border box: squeezed out of a shrinking trigger, it spills over its neighbour (or is cut off
  // by the button's own overflow clip). The top bar is checked too: the product switcher lives
  // there.
  const topbar = document.querySelector("[data-shell=topbar]");
  for (const root of topbar ? [...roots, topbar] : roots) {
    for (const b of Array.from(
      root.querySelectorAll("button,a[href],[role=button],[role=combobox]"),
    )) {
      if (hidden(b)) continue;
      const br = b.getBoundingClientRect();
      for (const e of Array.from(b.querySelectorAll("*"))) {
        if (hidden(e)) continue;
        // Text runs are the overflow rule's business (truncation with a disclosure is fine).
        if ((e.textContent || "").trim() && e.tagName.toLowerCase() !== "svg")
          continue;
        if (e.closest("svg") !== e && e.closest("svg") !== null) continue;
        const r = e.getBoundingClientRect();
        const past = Math.max(r.right - br.right, br.left - r.left);
        if (past <= 1) continue;
        out.push({
          rule: "overflow",
          kind: "child-spill",
          where: where(e),
          detail: `a non-text child of a ${b.tagName.toLowerCase()} ends ${Math.round(past)}px past the control's border box (child ${Math.round(r.left)}–${Math.round(r.right)}, control ${Math.round(br.left)}–${Math.round(br.right)})`,
          cause: `control {${short(b)} w:${Math.round(br.width)} overflow:${cs(b).overflowX}} child {${short(e)}}`,
          html: snip(b),
        });
        break;
      }
    }
  }

  // A table that scrolls sideways inside its own wrapper: at desktop width every column must fit
  // (truncate a long cell, hide a low-priority column); on a phone a DataTable draws as cards.
  // `data-scroll-x` marks a wrapper whose sideways scroll is the design (a wide matrix).
  for (const root of roots) {
    for (const e of Array.from(root.querySelectorAll("*"))) {
      if (!(e instanceof HTMLElement) || hidden(e) || !isScroller(e, "x"))
        continue;
      if (e.scrollWidth <= e.clientWidth + 1) continue;
      const table = e.querySelector("table,[role=table],[role=grid]");
      if (!table || e.closest("[data-scroll-x]")) continue;
      const dataTable = e.closest("[data-table-id]");
      if (W < 1024 && !dataTable) continue;
      const er = e.getBoundingClientRect();
      const cut = Array.from(
        table.querySelectorAll("th,[role=columnheader]"),
      ).filter(
        (h) => !hidden(h) && h.getBoundingClientRect().right > er.right + 1,
      );
      const widest = Array.from(table.querySelectorAll("td,[role=cell]"))
        .filter((td) => !hidden(td))
        .sort(
          (a, b) =>
            b.getBoundingClientRect().width - a.getBoundingClientRect().width,
        )[0];
      out.push({
        rule: "overflow",
        kind: W < 1024 ? "table-x-scroll-phone" : "table-x-scroll",
        where: where(e),
        detail: `${dataTable ? `DataTable "${dataTable.getAttribute("data-table-id")}"` : "table"} scrolls ${e.scrollWidth - e.clientWidth}px sideways inside its wrapper (scrollWidth ${e.scrollWidth}, clientWidth ${e.clientWidth})${cut.length ? `; columns past the edge: ${cut.map((h) => `"${(h.textContent || "").trim()}"`).join(", ")}` : ""}`,
        cause:
          W < 1024
            ? `a phone draws a DataTable as cards: set mobile="cards"`
            : `widest cell ${widest ? `${short(widest)} w:${Math.round(widest.getBoundingClientRect().width)} "${(widest.textContent || "").trim().slice(0, 40)}"` : "?"}: cap it (block max-w-[…] truncate + title)`,
        html: snip(widest),
      });
    }
    // A grid of form fields that stops short of its card's content edge (a max-width cap) while
    // the rows around it run edge to edge.
    for (const g of Array.from(root.querySelectorAll("*"))) {
      if (hidden(g) || cs(g).display !== "grid") continue;
      const tracks = cs(g).gridTemplateColumns.trim().split(/\s+/).length;
      if (tracks < 2) continue;
      const kids = Array.from(g.children).filter((k) => !hidden(k));
      if (
        kids.length < 2 ||
        !kids.every(
          (k) =>
            k.querySelector(
              "input:not([type=checkbox]):not([type=radio]),select,textarea,[role=combobox]",
            ) !== null,
        )
      )
        continue;
      const parent = g.parentElement;
      if (!parent || !g.closest("section,[class*=rounded-lg]")) continue;
      const gap = contentRight(parent) - g.getBoundingClientRect().right;
      if (gap > 8)
        out.push({
          rule: "right-align",
          kind: "field-grid-short",
          where: where(g),
          detail: `a ${tracks}-column field grid ends ${Math.round(gap)}px short of its card's content edge`,
          cause: `grid {${short(g)} max-width:${cs(g).maxWidth} width:${Math.round(g.getBoundingClientRect().width)}} parent content edge x=${Math.round(contentRight(parent))}`,
          html: snip(g),
        });
    }
    // A switch's help line that describes the other state ("Off, …" beside a switch that is on).
    for (const sw of Array.from(root.querySelectorAll("[role=switch]"))) {
      if (hidden(sw)) continue;
      const row = sw.closest("[data-align]");
      if (!row) continue;
      const on = sw.getAttribute("aria-checked") === "true";
      for (const p of Array.from(row.querySelectorAll("p"))) {
        const t = (p.textContent || "").trim();
        const says = /^Off\b/.test(t) ? false : /^On\b/.test(t) ? true : null;
        if (says !== null && says !== on)
          out.push({
            rule: "right-align",
            kind: "switch-help-state",
            where: where(row),
            detail: `switch is ${on ? "on" : "off"} but its help reads "${t.slice(0, 70)}"`,
            cause: "choose the help line from the switch's value",
          });
      }
    }
  }

  // ── 2 · equal-height rows ──────────────────────────────────────────────────────────────────
  const cardOf = (child: Element): Element | null => {
    let n: Element | null = child;
    for (let i = 0; n && i < 4; i++) {
      if (cardLike(n)) return n;
      const kids: Element[] = Array.from(n.children).filter((k) => !hidden(k));
      if (kids.length === 0) return null;
      if (kids.length !== 1) {
        // A cell that opens with its one card and follows it with plain blocks (an actions row,
        // a note): the card is what sits beside the neighbouring cell's card, so it is the card
        // that must share their edges.
        const boxed = kids.filter((k) => cardLike(k) || hasBox(k));
        return boxed.length === 1 && boxed[0] === kids[0] && cardLike(kids[0]!)
          ? kids[0]!
          : null;
      }
      n = kids[0]!;
    }
    return null;
  };
  /**
   * Empty px between a card's last text or control and its bottom edge. Content centred in its
   * box (a placeholder's one line, as much space above as below) is a deliberate empty state, not
   * trailing space: it counts as 0. Text at the top of a tall box is not centred, and counts.
   */
  const emptyBelow = (card: Element): number => {
    const r = card.getBoundingClientRect();
    let top = r.bottom;
    let bottom = r.top;
    for (const x of ink(card)) {
      top = Math.min(top, x.top);
      bottom = Math.max(bottom, x.bottom);
    }
    // Boxed blocks (a bar of a chart, a progress track, a field's frame) are content too; a
    // nested card is measured on its own.
    for (const e of Array.from(card.querySelectorAll("*"))) {
      if (hidden(e) || !hasBox(e) || cardLike(e)) continue;
      const er = e.getBoundingClientRect();
      if (er.height >= r.height * 0.9) continue;
      top = Math.min(top, er.top);
      bottom = Math.max(bottom, er.bottom);
    }
    const below = r.bottom - px(cs(card).borderBottomWidth) - bottom;
    const above = top - r.top - px(cs(card).borderTopWidth);
    // A placeholder line centred in its box (as much space above as below) is a deliberate empty
    // state; a box with its line at the top and the rest empty is a well of empty card.
    return Math.abs(above - below) <= 24 ? 0 : below;
  };
  /** Max px a stretched card may leave empty under its content (its own padding plus a row). */
  const STRETCH_GAP = 96;
  const stretchReported = new Set<Element>();
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
          // Equal heights bought by stretching: a card whose content ends far above its bottom
          // edge is the "page runs on past the content" look drawn inside a card. Pair cards of
          // close natural heights, or give the taller one its own row.
          const empties = row.map(emptyBelow);
          const worst = Math.max(...empties);
          if (worst > STRETCH_GAP) {
            const i = empties.indexOf(worst);
            stretchReported.add(row[i]!);
            out.push({
              rule: "equal-height",
              kind: "stretch-gap",
              where: where(row[i]!),
              detail: `a card stretched to its row's height leaves ${Math.round(worst)}px empty under its content (row heights ${hs.map((h) => Math.round(h)).join("/")}px; empty ${empties.map((e) => Math.round(e)).join("/")}px)`,
              cause: `container {${short(c)}} stretched card {${short(row[i]!)}}`,
            });
          }
          // Footers: the last block of each card holding an action shares one bottom edge.
          // A footer is a short closing block (an actions row), not a card's whole body.
          const feet = row.map((card) => {
            const kids = Array.from(card.children).filter((k) => !hidden(k));
            const last = kids.length > 1 ? kids[kids.length - 1] : undefined;
            return last &&
              last.getBoundingClientRect().height <= 80 &&
              last.querySelector("button,a[href]")
              ? last
              : null;
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

  // Any card grown past its content, whatever it sits beside: a panel that grows to fill a
  // stretch cell (`[&>:last-child]:flex-1`) whose neighbour is a stack of panels, a pane stretched
  // to the height of a long list beside it, a min-height. Measured against the card's own
  // content, so the shape of the neighbouring cell does not matter.
  if (opts.rows) {
    for (const root of roots) {
      for (const card of Array.from(root.querySelectorAll("*"))) {
        if (stretchReported.has(card) || !cardLike(card)) continue;
        if (card.matches("[role=dialog],[role=alertdialog]")) continue;
        if (cs(card).position === "fixed") continue;
        const empty = emptyBelow(card);
        if (empty <= STRETCH_GAP) continue;
        const s = cs(card);
        const parent = card.parentElement;
        const ps = parent ? cs(parent) : null;
        out.push({
          rule: "equal-height",
          kind: "grown-card",
          where: where(card),
          detail: `a card ${Math.round(card.getBoundingClientRect().height)}px tall leaves ${Math.round(empty)}px empty under its content`,
          cause: `card {${short(card)} ${heightRules(card)} align-self:${s.alignSelf}} parent {${parent ? short(parent) : "?"} display:${ps?.display} flex-direction:${ps?.flexDirection} align-items:${ps?.alignItems} h:${parent ? Math.round(parent.getBoundingClientRect().height) : "?"}}`,
          html: snip(card),
        });
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
  // f. Pills sit at the right edge of their card header (pills mean attention, ADMIN.md §5.11):
  //    nothing but controls after a pill, and the header's ink ends at its content edge.
  for (const root of roots) {
    for (const h of Array.from(root.querySelectorAll("[data-card-header]"))) {
      if (hidden(h)) continue;
      const pills = Array.from(h.querySelectorAll("[data-status=pill]")).filter(
        (p) => !hidden(p),
      );
      if (pills.length === 0) continue;
      const hr = h.getBoundingClientRect();
      const last = pills.reduce((a, b) =>
        b.getBoundingClientRect().right > a.getBoundingClientRect().right
          ? b
          : a,
      );
      const lr = last.getBoundingClientRect();
      // Ink to the right of the pill, on its line, that is not inside a control.
      const onLine = (r: DOMRect) =>
        r.left >= lr.right - 1 && r.bottom > lr.top && r.top < lr.bottom;
      const CTRL = "button,a[href],[role=button],[data-status=pill]";
      const after: DOMRect[] = [];
      const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const p = t.parentElement;
        if (!p || !t.textContent?.trim() || hidden(p) || p.closest(CTRL))
          continue;
        range.selectNodeContents(t);
        for (const r of Array.from(range.getClientRects()))
          if (r.width > 0 && onLine(r)) after.push(r);
      }
      // The cluster's right end: the last pill, or a control after it (by its ink when it is
      // frameless). Text before the pill (a truncated name) is not the cluster: a clipped text
      // run reports its full, unclipped width.
      let right = lr.right;
      inkEdge = last;
      for (const c of Array.from(
        h.querySelectorAll("button,a[href],[role=button]"),
      )) {
        if (hidden(c)) continue;
        const cr = c.getBoundingClientRect();
        if (cr.left < lr.left) continue;
        const x = frameless(c)
          ? Math.max(...ink(c).map((r) => r.right), cr.left)
          : cr.right;
        if (x > right) {
          right = x;
          inkEdge = c;
        }
      }
      const edge = contentRight(h);
      if (after.length > 0 || Math.abs(edge - right) > 2)
        out.push({
          rule: "right-align",
          kind: "pill-right",
          where: where(last),
          detail:
            after.length > 0
              ? `a pill in a card header is followed by ${after.length} piece(s) of non-control content`
              : `the card header's pill cluster ends at x=${Math.round(right)}${edgeName()}, header content edge x=${Math.round(edge)} (${Math.round(edge - right)}px short)`,
          cause: `header {${short(h)} justify:${cs(h).justifyContent}} pill {${short(last)}}`,
          html: snip(h),
        });
    }
  }
  // ── 5 · rhythm ─────────────────────────────────────────────────────────────────────────────
  // a. Card headers: one line of pieces centred on each other, at the height its title sets.
  const CONTROLISH =
    "button,a[href],[role=button],input,select,[role=combobox]";
  for (const root of roots) {
    for (const h of Array.from(root.querySelectorAll("[data-card-header]"))) {
      if (hidden(h)) continue;
      const kids = Array.from(h.children).filter(
        (k) => !hidden(k) && !["absolute", "fixed"].includes(cs(k).position),
      );
      if (kids.length < 2) continue;
      const rs = kids.map((k) => k.getBoundingClientRect());
      // One line only: a header that wrapped (a phone) stacks its action under the title.
      const first = rs[0]!;
      if (!rs.every((r) => r.top < first.bottom && r.bottom > first.top))
        continue;
      // The title: the piece holding the heading (or the first piece). A title of one line sets
      // the line every other piece centres on; a title over a description or a slug may carry a
      // top-aligned pill instead, so only one-line titles are held to the centre.
      const ti = Math.max(
        0,
        kids.findIndex(
          (k) =>
            k.matches("h1,h2,h3,h4,h5,h6") ||
            k.querySelector("h1,h2,h3,h4,h5,h6") !== null,
        ),
      );
      const tr = rs[ti]!;
      const heading = kids[ti]!.matches("h1,h2,h3,h4,h5,h6")
        ? kids[ti]!
        : kids[ti]!.querySelector("h1,h2,h3,h4,h5,h6");
      const oneLine =
        heading === null ||
        tr.height <= heading.getBoundingClientRect().height + 2;
      const centre = (r: DOMRect) => (r.top + r.bottom) / 2;
      const off = rs.map((r) => centre(r) - centre(tr));
      const worst = off.reduce(
        (a, b) => (Math.abs(b) > Math.abs(a) ? b : a),
        0,
      );
      if (oneLine && Math.abs(worst) > 2)
        out.push({
          rule: "rhythm",
          kind: "header-center",
          where: where(h),
          detail: `card header pieces are not centred on one line: centres ${off.map((o) => `${o >= 0 ? "+" : ""}${Math.round(o)}`).join("/")}px from the title's`,
          cause: `header {${short(h)} align-items:${cs(h).alignItems}} pieces: ${kids.map((k, i) => `${short(k)} h:${Math.round(rs[i]!.height)}`).join(" | ")}`,
          html: snip(h),
        });
      // The header's height is its title's (and any pill's): a control beside it hangs into the
      // padding instead of growing the header past its siblings'.
      const hs = cs(h);
      const content =
        h.getBoundingClientRect().height -
        px(hs.paddingTop) -
        px(hs.paddingBottom) -
        px(hs.borderTopWidth) -
        px(hs.borderBottomWidth);
      const plain = kids
        .map((k, i) => ({ k, r: rs[i]!, i }))
        .filter(
          ({ k, i }) =>
            i === ti ||
            (!k.matches(CONTROLISH) && k.querySelector(CONTROLISH) === null),
        );
      if (plain.length === 0 || plain.length === kids.length) continue;
      const titleH = Math.max(...plain.map(({ r }) => r.height));
      if (content > titleH + 2)
        out.push({
          rule: "rhythm",
          kind: "header-height",
          where: where(h),
          detail: `a control makes the card header ${Math.round(content)}px tall inside its padding, its title ${Math.round(titleH)}px (header ${Math.round(h.getBoundingClientRect().height)}px)`,
          cause: `header {${short(h)} padding:${hs.paddingTop}/${hs.paddingBottom}} controls: ${kids
            .filter((k) => !plain.some((p) => p.k === k))
            .map(
              (k) =>
                `${short(k)} h:${Math.round(k.getBoundingClientRect().height)} margin-block:${cs(k).marginTop}/${cs(k).marginBottom}`,
            )
            .join(" | ")}`,
          html: snip(h),
        });
    }
  }
  // b. A menu's grid of actions fills its rows: three links in two columns leave one alone on a
  //    row beside an empty cell, the look of an unfinished menu.
  const menus = [
    ...dialogs,
    ...Array.from(
      document.querySelectorAll(
        "[role=menu],[data-radix-popper-content-wrapper]",
      ),
    ),
  ].filter((m) => !hidden(m));
  const orphanSeen = new Set<Element>();
  for (const m of menus) {
    for (const g of Array.from(m.querySelectorAll("*"))) {
      if (orphanSeen.has(g) || hidden(g)) continue;
      const gs = cs(g);
      if (gs.display !== "grid" && gs.display !== "inline-grid") continue;
      orphanSeen.add(g);
      const cols = gs.gridTemplateColumns.trim().split(/\s+/).length;
      if (cols < 2) continue;
      const items = Array.from(g.children).filter((k) => !hidden(k));
      if (
        items.length < 2 ||
        !items.every(
          (k) =>
            k.matches("a[href],button,[role=menuitem],[role=option]") ||
            (k.children.length === 1 &&
              k.firstElementChild!.matches("a[href],button,[role=menuitem]")),
        )
      )
        continue;
      if (items.length % cols !== 0)
        out.push({
          rule: "rhythm",
          kind: "grid-orphan",
          where: where(g),
          detail: `${items.length} actions in ${cols} columns leave ${cols - (items.length % cols)} empty cell(s) in the last row`,
          cause: `grid {${short(g)} grid-template-columns:${gs.gridTemplateColumns}}: one column, or as many columns as actions`,
          html: snip(g),
        });
    }
  }
  return { violations: out, scrollers: metrics };
}
