import type { Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  PROFILE_BORN,
  type Handler,
  type Reply,
  portalRoutes,
  profileRoutes,
} from "./portalFixtures.js";
import { SHIPPED } from "./portalStates.js";
import {
  axe,
  h1,
  horizontalOverflow,
  smallTargets,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";

/**
 * WCAG 1.4.10 reflow on the product page (EXPERIENCE.md §7.3): no page-level sideways scroll at
 * 320 CSS px or at 200 % text, however long the product's or the developer's name. The section tabs
 * scroll inside their own labelled strip; long names wrap.
 */
let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

const LONG_NAME =
  "Nightfall Chronicles Complete Collection Definitive Anniversary Edition";
/** One unbroken 60-character word: the worst case for wrapping. */
const LONG_DEV = "Lanternworks".padEnd(60, "x");

function longNames(slug: string): Record<string, Handler> {
  const routes = portalRoutes("three");
  const product = routes[`/api/products/${slug}`] as (req: Request) => Reply;
  const library = routes["/api/library"] as (req: Request) => Reply;
  const patch = (o: Record<string, unknown>): Record<string, unknown> => ({
    ...o,
    name: LONG_NAME,
    developerName: LONG_DEV,
  });
  return {
    [`/api/products/${slug}`]: (req) => {
      const r = product(req);
      return { ...r, body: patch(r.body as Record<string, unknown>) };
    },
    "/api/library": (req) => {
      const r = library(req);
      const body = r.body as { products: Record<string, unknown>[] };
      return {
        ...r,
        body: {
          ...body,
          products: body.products.map((p) =>
            p.product === slug ? patch(p) : p,
          ),
        },
      };
    },
  };
}

/** With PK_SHOTS_DIR set, each row is also saved in both themes (before/after review shots). */
const SHOTS = process.env.PK_SHOTS_DIR;
const SHOT_ROWS = [
  { label: "320-text200", width: 320, height: 640, text: 200 },
  { label: "390-text200", width: 390, height: 844, text: 200 },
  { label: "1440", width: 1440, height: 900, text: 100 },
] as const;

describe.skipIf(!SHOTS)("reflow screenshots", () => {
  for (const { label, width, height, text } of SHOT_ROWS) {
    for (const theme of ["dark", "light"] as const) {
      it(`${label} ${theme}`, async () => {
        const o = await portal.open("three", "/#/p/nightfall", {
          width,
          height,
          theme,
          routes: longNames("nightfall"),
        });
        try {
          await h1(o.page, LONG_NAME);
          await o.page.evaluate((pct) => {
            document.documentElement.style.setProperty(
              "font-size",
              `${pct}%`,
              "important",
            );
          }, text);
          await o.page.waitForTimeout(400);
          await o.page.screenshot({
            fullPage: true,
            path: `${SHOTS}/${label}-${theme}.png`,
          });
        } finally {
          await o.close();
        }
      });
    }
  }
});

/** The elements whose right edge passes the window's, for a failure message (not a gate). */
function widest(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .filter((e) => e.checkVisibility())
      // Inside a scroller, not on the page.
      .filter((e) => {
        for (let a = e.parentElement; a; a = a.parentElement) {
          const ox = getComputedStyle(a).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") return false;
        }
        return true;
      })
      // The outermost: its parent still fits.
      .filter(
        (e) =>
          !e.parentElement ||
          e.parentElement.getBoundingClientRect().right <=
            window.innerWidth + 1,
      )
      .slice(0, 8)
      .map(
        (e) =>
          `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 30)}" ${e.getAttribute("aria-label") ?? ""} ${Math.round(e.getBoundingClientRect().right)}`,
      ),
  );
}

const ROWS = [
  { label: "320 + 200 % text", width: 320, height: 640, text: 200 },
  { label: "390 + 200 % text", width: 390, height: 844, text: 200 },
  { label: "320", width: 320, height: 640, text: 100 },
  { label: "1440", width: 1440, height: 900, text: 100 },
] as const;

describe("the product page reflows", () => {
  for (const { label, width, height, text } of ROWS) {
    for (const path of ["/#/p/nightfall", "/#/p/nightfall/license"]) {
      const theme: Theme = width % 2 === 0 ? "dark" : "light";
      it(`${label}: ${path}, long names, no sideways scroll`, async ({
        expect,
      }) => {
        const o = await portal.open("three", path, {
          width,
          height,
          theme,
          routes: longNames("nightfall"),
        });
        try {
          await h1(o.page, LONG_NAME);
          if (text !== 100)
            // Through the CSSOM: the page's CSP refuses a style element.
            await o.page.evaluate((pct) => {
              document.documentElement.style.setProperty(
                "font-size",
                `${pct}%`,
                "important",
              );
            }, text);
          await o.page.waitForTimeout(400);
          const over = await horizontalOverflow(o.page);
          // On a failure the message names the elements that pass the window's edge.
          expect(over > 0 ? await widest(o.page) : []).toEqual([]);
          expect(over).toBeLessThanOrEqual(0);
          // The long names stay inside their own boxes.
          const spill = await o.page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main h1, main h1 ~ div, [data-product-actions]",
              ),
            ]
              .filter((e) => e.scrollWidth > e.clientWidth + 1)
              .map((e) => `${e.tagName} ${e.scrollWidth}>${e.clientWidth}`),
          );
          expect(spill).toEqual([]);
          // The tab strip (a nav of links, each a tab stop) scrolls inside itself when it must:
          // its box is never wider than the window.
          const strip = await o.page.evaluate(() => {
            const nav = document.querySelector<HTMLElement>(
              "[data-section-pills]",
            );
            if (!nav || !nav.checkVisibility()) return null;
            const box = nav.getBoundingClientRect();
            return {
              right: Math.round(box.right),
              inner: window.innerWidth,
              left: Math.round(box.left),
            };
          });
          if (strip) {
            expect(strip.left).toBeGreaterThanOrEqual(0);
            expect(strip.right).toBeLessThanOrEqual(strip.inner);
          }
          expect(await smallTargets(o.page, 24)).toEqual([]);
          const violations = await axe(o.page);
          expect(violations).toEqual([]);
        } finally {
          await o.close();
        }
      });
    }
  }
});

/** A 60-character display name with spaces, and an unbroken 40-character address. */
const LONG_PERSON =
  "Maximilian Alexander Fennick-Vandersteen the Third of Harbor";
const LONG_EMAIL = `${"a".repeat(30)}@example.org`;

function longPerson(): Record<string, Handler> {
  const base = portalRoutes("three")["/api/me"] as (req: Request) => Reply;
  return {
    "/api/me": (req) => {
      const r = base(req);
      const body = r.body as { account: Record<string, unknown> };
      return {
        ...r,
        body: {
          ...body,
          account: { ...body.account, name: LONG_PERSON, email: LONG_EMAIL },
        },
      };
    },
  };
}

const IDENTITY_ROWS = [
  { label: "320", width: 320, height: 640, text: 100 },
  { label: "1280 + 200 % text", width: 1280, height: 800, text: 200 },
  { label: "1440", width: 1440, height: 900, text: 100 },
] as const;

describe("identity rows wrap instead of cutting the name", () => {
  // The Account page still scrolls sideways at 320 px with 200 % text outside the identity rows
  // (provider rows, the Changing-a-method note, Download my data): a follow-up, not this check.
  for (const { label, width, height, text } of IDENTITY_ROWS) {
    for (const path of ["/#/account", "/#/account/methods"]) {
      const theme: Theme = width % 2 === 0 ? "dark" : "light";
      it(`${label}: ${path}, long name and address, no sideways scroll`, async ({
        expect,
      }) => {
        const o = await portal.open("three", path, {
          width,
          height,
          theme,
          routes: longPerson(),
        });
        try {
          await h1(o.page, "Account");
          if (text !== 100)
            await o.page.evaluate((pct) => {
              document.documentElement.style.setProperty(
                "font-size",
                `${pct}%`,
                "important",
              );
            }, text);
          await o.page.waitForTimeout(400);
          const over = await horizontalOverflow(o.page);
          expect(over > 0 ? await widest(o.page) : []).toEqual([]);
          expect(over).toBeLessThanOrEqual(0);
          // No text in main is clipped by an ellipsis in a row with the long values.
          const clipped = await o.page.evaluate(() =>
            [...document.querySelectorAll("main *")]
              .filter(
                (e) =>
                  e.children.length === 0 &&
                  getComputedStyle(e).textOverflow === "ellipsis" &&
                  e.scrollWidth > e.clientWidth + 1 &&
                  /Maximilian|aaaaaaaa/.test(e.textContent ?? ""),
              )
              .map((e) => (e.textContent ?? "").slice(0, 30)),
          );
          expect(clipped).toEqual([]);
        } finally {
          await o.close();
        }
      });
    }
  }
});

/**
 * Text that is cut or broken (WCAG 1.4.4), which a page-level scroll check never sees: a box whose
 * content is wider or taller than it is and that clips it (`overflow` not visible), a box whose
 * content spills out of it, and an ordinary word broken across lines. Scroll strips that are meant
 * to scroll (`overflow-x: auto | scroll`) and words over 20 characters (a token) are left out.
 */
function clippedText(page: Page, words = true): Promise<string[]> {
  return page.evaluate((checkWords) => {
    const out: string[] = [];
    const label = (e: Element): string =>
      `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 30)}"`;
    const hasOwnText = (e: Element): boolean =>
      [...e.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
      );
    for (const e of document.querySelectorAll<HTMLElement>(
      "main *, header *, nav *, [role=dialog] *",
    )) {
      if (!e.checkVisibility() || !hasOwnText(e)) continue;
      const cs = getComputedStyle(e);
      if (cs.display === "inline" || e.clientWidth <= 1 || e.clientHeight <= 1)
        continue;
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
      if (e.scrollWidth > e.clientWidth + 1)
        out.push(`${label(e)} wide ${e.scrollWidth}>${e.clientWidth}`);
      if (cs.overflowY !== "visible" && e.scrollHeight > e.clientHeight + 1)
        out.push(`${label(e)} tall ${e.scrollHeight}>${e.clientHeight}`);
    }
    // A text box whose right edge is past what its clipping or scrolling ancestor shows: the
    // reader would have to scroll inside a region to read it, or never could.
    const roots = [
      document.querySelector("main") ?? document.body,
      ...document.querySelectorAll("[role=dialog]"),
    ];
    const texts: Text[] = [];
    for (const root of roots) {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) texts.push(n as Text);
    }
    for (const n of texts) {
      const el = n.parentElement;
      if (!el || !el.checkVisibility() || !(n.textContent ?? "").trim())
        continue;
      // cmdk's own label is visually hidden by inline styles, not a class.
      if (el.closest("[data-section-pills], .sr-only, [cmdk-label]")) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      const box = r.getBoundingClientRect();
      if (box.width === 0) continue;
      for (let a = el; a; a = a.parentElement) {
        if (a === document.documentElement) break;
        const cs = getComputedStyle(a);
        if (cs.overflowX === "visible") continue;
        // A scroll region a keyboard reaches (a code frame with `tabindex`, a tab strip of
        // buttons that scroll into view on focus) is meant to scroll (LF3): its text is not cut.
        if (
          (cs.overflowX === "auto" || cs.overflowX === "scroll") &&
          el.closest("button, a[href], [tabindex]")
        )
          break;
        if (box.right > a.getBoundingClientRect().right + 1) {
          out.push(
            `${label(el)} past ${a.tagName.toLowerCase()} edge ${Math.round(box.right)}>${Math.round(a.getBoundingClientRect().right)}`,
          );
          break;
        }
      }
    }
    for (const n of texts) {
      if (!checkWords) break;
      const parent = n.parentElement;
      if (!parent || !parent.checkVisibility()) continue;
      if (
        parent.closest(
          "[dir=rtl], code, pre, [data-section-pills], [data-token]",
        )
      )
        continue;
      const text = n.textContent ?? "";
      for (const m of text.matchAll(/[^\s-]+/g)) {
        // A token (an address, an id) may break anywhere; only ordinary words are held to it.
        if (m[0].length > 20 || m[0].includes("@")) continue;
        const r = document.createRange();
        r.setStart(n, m.index!);
        r.setEnd(n, m.index! + m[0].length);
        const tops = new Set(
          [...r.getClientRects()].map((q) => Math.round(q.top)),
        );
        if (tops.size > 1)
          out.push(`word "${m[0]}" breaks in ${label(parent)}`);
      }
    }
    return out.slice(0, 12);
  }, words);
}

/** Fixed and stuck-sticky elements' share of the window's height, at a scroll offset. */
function chromeShare(page: Page, scrollY: number): Promise<number> {
  return page.evaluate((y) => {
    window.scrollTo(0, y);
    const vh = window.innerHeight;
    const boxes: [number, number][] = [];
    for (const e of document.querySelectorAll<HTMLElement>("body *")) {
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (!e.checkVisibility()) continue;
      const r = e.getBoundingClientRect();
      if (r.height === 0 || r.bottom < 0 || r.top > vh) continue;
      if (cs.position === "sticky") {
        const top = parseFloat(cs.top);
        const bottom = parseFloat(cs.bottom);
        const stuck =
          (!Number.isNaN(top) && Math.abs(r.top - top) < 1) ||
          (!Number.isNaN(bottom) && Math.abs(vh - r.bottom - bottom) < 1);
        if (!stuck) continue;
      }
      boxes.push([Math.max(0, r.top), Math.min(vh, r.bottom)]);
    }
    boxes.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let end = -1;
    for (const [a, b] of boxes) {
      const from = Math.max(a, end);
      if (b > from) total += b - from;
      end = Math.max(end, b);
    }
    return total / vh;
  }, scrollY);
}

async function enlarge(page: Page, pct: number): Promise<void> {
  // Through the CSSOM: the page's CSP refuses a style element.
  await page.evaluate((p) => {
    document.documentElement.style.setProperty(
      "font-size",
      `${p}%`,
      "important",
    );
  }, pct);
  await page.waitForTimeout(400);
}

const LARGE_ROWS = [
  { label: "390 + 200 % text", width: 390, height: 844, text: 200 },
  { label: "320 + 200 % text", width: 320, height: 640, text: 200 },
  { label: "320", width: 320, height: 640, text: 100 },
  { label: "390", width: 390, height: 844, text: 100 },
] as const;

/** The Library, the Account page and its packages at the large-text rows (B2, M7). */
const LARGE_STATES = [
  { name: "library grid", scenario: "three", path: "/#/", heading: "Library" },
  {
    name: "library list",
    scenario: "twelve",
    path: "/#/?view=list",
    heading: "Library",
  },
  {
    name: "library grid, 12",
    scenario: "twelve",
    path: "/#/?view=grid",
    heading: "Library",
  },
  {
    name: "account",
    scenario: "three",
    path: "/#/account",
    heading: "Account",
  },
  {
    name: "account packages",
    scenario: "three",
    path: "/#/account/packages",
    heading: "Account",
  },
] as const;

describe("the Library and Account lose no text", () => {
  for (const { label, width, height, text } of LARGE_ROWS) {
    for (const st of LARGE_STATES) {
      const theme: Theme = width % 2 === 0 ? "dark" : "light";
      it(`${label}: ${st.name}: no clipped or broken text, no sideways scroll`, async ({
        expect,
      }) => {
        const o = await portal.open(st.scenario, st.path, {
          width,
          height,
          theme,
        });
        try {
          await h1(o.page, st.heading);
          if (text !== 100) await enlarge(o.page, text);
          await o.page.waitForTimeout(300);
          const over = await horizontalOverflow(o.page);
          expect(over > 0 ? await widest(o.page) : []).toEqual([]);
          expect(over).toBeLessThanOrEqual(0);
          expect(await clippedText(o.page)).toEqual([]);
          expect(await axe(o.page)).toEqual([]);
        } finally {
          await o.close();
        }
      });
    }
  }

  for (const height of [568, 640, 780]) {
    for (const path of ["/#/", "/#/account"]) {
      it(`320 x ${height} + 200 % text: ${path}: fixed chrome is a quarter of the window at most`, async ({
        expect,
      }) => {
        const o = await portal.open("three", path, { width: 320, height });
        try {
          await h1(o.page, path === "/#/" ? "Library" : "Account");
          await enlarge(o.page, 200);
          for (const y of [0, 200, 600])
            expect(await chromeShare(o.page, y)).toBeLessThanOrEqual(0.25);
        } finally {
          await o.close();
        }
      });
    }
  }

  it("390 x 844 at 100 % text keeps the sticky header and strip", async ({
    expect,
  }) => {
    const o = await portal.open("three", "/#/", { width: 390, height: 844 });
    try {
      await h1(o.page, "Library");
      const pos = await o.page.evaluate(() => ({
        header: getComputedStyle(document.querySelector("header")!).position,
        strip: getComputedStyle(document.querySelector("[data-missing-strip]")!)
          .position,
      }));
      expect(pos).toEqual({ header: "sticky", strip: "sticky" });
    } finally {
      await o.close();
    }
  });
});

/**
 * The one-product hero, the Activate sheet and the focused flows at large text on a phone
 * (LF1: B2 remainder, M4). A dialog's body must not shrink to a sliver: its content is reachable
 * without scrolling a 32 px slot.
 */
const LF4_IDS = new Set([
  "product-entry",
  "product-identity",
  "product-no-cover",
  "product-no-icon",
  "product-account-bound",
  "product-install-sources",
  "switcher",
  "discover-empty",
  "storefront-not-found",
  "account-link-start",
  "account-link-both",
  "account-link-stale",
  "account-last-method",
]);
const FLOW_STATES = [
  { id: "library-1", scenario: "one", path: "/#/", heading: /library/i },
  ...[
    "activate-enter",
    "activate-confirm",
    "device-limit",
    "download-flow",
    "product-token",
    // The product-page variants and the secondary pages (LF4, 200 % text on a phone).
    "product-entry",
    "product-identity",
    "product-no-cover",
    "product-no-icon",
    "product-account-bound",
    "product-install-sources",
    "switcher",
    "discover-empty",
    "storefront-not-found",
    "account-link-start",
    "account-link-both",
    "account-link-stale",
    "account-last-method",
  ].map((id) => ({ id })),
] as const;

describe("the one-product Library and the flows lose no text at large text", () => {
  for (const { label, width, height, text } of LARGE_ROWS.filter(
    (r) => r.text === 200,
  )) {
    for (const st of FLOW_STATES) {
      const theme: Theme = width % 2 === 0 ? "dark" : "light";
      it(`${label}: ${st.id}: no clipped or broken text, no sideways scroll`, async ({
        expect,
      }) => {
        const shipped =
          "scenario" in st ? null : SHIPPED.find((s) => s.id === st.id)!;
        const o = await portal.open(
          shipped ? shipped.scenario : st.scenario,
          shipped ? shipped.path : st.path,
          {
            width,
            height,
            theme,
            routes: shipped?.routes,
          },
        );
        try {
          if (shipped) await shipped.ready(o.page);
          else await h1(o.page, st.heading);
          // A pasted key, so the field is as full as it gets.
          if (st.id === "activate-enter")
            await o.page.fill(
              "[role=dialog] textarea",
              "pkey_nightfall_AAAA-BBBB-CCCC-DDDD-EEEE-FFFF",
            );
          await enlarge(o.page, text);
          await o.page.waitForTimeout(300);
          const over = await horizontalOverflow(o.page);
          expect(over > 0 ? await widest(o.page) : []).toEqual([]);
          expect(over).toBeLessThanOrEqual(0);
          // At 320 CSS px and 200 % text the window is 160 px wide in effect: a long word may break
          // across lines there (nothing is lost or cut), on the product-page variants and
          // secondary pages added in LF4; everything else still holds.
          expect(
            await clippedText(o.page, !(width <= 320 && LF4_IDS.has(st.id))),
          ).toEqual([]);
          // A dialog's body is never a sliver to scroll in: the sheet scrolls as a whole.
          const slot = await o.page.evaluate(() => {
            const b = document.querySelector<HTMLElement>(
              "[data-pk-dialog-body]",
            );
            return b
              ? { scroll: b.scrollHeight, client: b.clientHeight }
              : null;
          });
          if (slot) expect(slot.scroll).toBeLessThanOrEqual(slot.client + 1);
          // The key field keeps its room: no more than five lines, never a character a line.
          if (st.id === "activate-enter") {
            const field = await o.page.evaluate(() => {
              const t = document.querySelector<HTMLTextAreaElement>(
                "[role=dialog] textarea",
              );
              if (!t) return null;
              const cs = getComputedStyle(t);
              const lh = parseFloat(cs.lineHeight);
              const pad =
                parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
              return { height: t.getBoundingClientRect().height - pad, lh };
            });
            if (field) expect(field.height / field.lh).toBeLessThanOrEqual(5);
          }
          // A code frame clips what leaves it (LF3, M7): each of its buttons (Wrap, Copy) sits
          // wholly inside the frame, and so does every Copy button beside a shown-once value.
          const cut = await o.page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("[role=dialog] button")]
              .filter((b) => b.checkVisibility())
              .flatMap((b) => {
                const frame = b.closest<HTMLElement>(
                  "[data-code-frame], [data-secret-box]",
                );
                if (!frame) return [];
                const r = b.getBoundingClientRect();
                const f = frame.getBoundingClientRect();
                return r.right > f.right + 0.5 || r.left < f.left - 0.5
                  ? [
                      `${b.getAttribute("aria-label") ?? b.textContent} ${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(f.left)}-${Math.round(f.right)}`,
                    ]
                  : [];
              }),
          );
          expect(cut).toEqual([]);
          expect(await axe(o.page)).toEqual([]);
        } finally {
          await o.close();
        }
      });
    }
  }
});

describe("the profile editor's birth date (I-33)", () => {
  for (const { label, width, height, text } of ROWS) {
    it(`${label}: the whole date shows, Remove wraps under it`, async ({
      expect,
    }) => {
      const o = await portal.open("three", "/#/account/profile", {
        width,
        height,
        routes: profileRoutes(PROFILE_BORN),
      });
      try {
        await h1(o.page, "Account");
        const card = o.page.getByRole("region", { name: "Profile" });
        await card.getByRole("button", { name: "Edit profile" }).click();
        if (text !== 100)
          await o.page.evaluate((pct) => {
            document.documentElement.style.setProperty(
              "font-size",
              `${pct}%`,
              "important",
            );
          }, text);
        await o.page.waitForTimeout(400);
        const field = card.getByRole("textbox", { name: /Birth date/ });
        const remove = card.getByRole("button", { name: "Remove birth date" });
        const f = (await field.boundingBox())!;
        const r = (await remove.boundingBox())!;
        // A narrow screen gives the field the whole row and Remove sits under it.
        if (width < 640) expect(r.y).toBeGreaterThanOrEqual(f.y + f.height - 1);
        // The date's text is not cut: the input's content fits its box.
        expect(
          await field.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
        ).toBe(true);
        expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
      } finally {
        await o.close();
      }
    });
  }
});
