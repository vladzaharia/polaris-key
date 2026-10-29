import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { closeContext } from "./teardown.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { GLOBAL_PAGES, SECTIONS } from "../src/console/nav.js";
import {
  DEVICE_ID,
  fixtureImage,
  IMG_ORIGIN,
  LONG_SLUG,
  PACK_ID,
  PLATFORM_ONLY_ME,
  PLATFORM_ONLY_READY,
  PRODUCT_ROLE_ME,
  PLATFORM_PAUSE_ITEM,
  resolve,
  SYNC_USAGE,
} from "./layoutFixtures.js";
import {
  columnBreaches,
  emptyStateStarBreaches,
  lintFindings,
  forcedColourBreaches,
  pillTextBreaches,
  rowMenuOverlaps,
  shellStateBreaches,
  unlabelledScrollers,
} from "./pageChecks.js";
import { reduceTransparency } from "../../ui-qa/src/index.ts";
import { pausedPlatformSettings } from "./layoutData.js";
import { staleUxDebt, uxBarChecked } from "./uxBar.js";
import {
  probeLayout,
  type LayoutViolation,
  type ScrollMetric,
} from "./layoutProbe.js";

/**
 * The console's layout lint: a permanent regression gate over EVERY console page.
 *
 * Each page (enumerated from `nav.ts`, plus every record, tab, drawer and dialog the fixtures
 * reach) is opened in the BUILT console, under the Worker's CSP, at 1440×900, 1280×800 (a laptop),
 * 768×1024 (a tablet) and 390×844, plus 360×780 (ADMIN.md's narrowest) for a few product pages
 * whose top bar is the tightest (the product switcher beside the environment badge), in the
 * dark and the light theme, over realistic data (`layoutFixtures.ts`): a populated product, a
 * product with a long name and an empty product. `probeLayout` (`layoutProbe.ts`) then measures
 * the page inside the console's own scroll container (`main#content`), every open drawer's scroller
 * and the document, and fails on any breach of the four invariants:
 *
 *   1. no trailing space below the last visible content (beyond the page's bottom padding);
 *   2. side-by-side cards share their outer height and footer edge, and no card runs far past its
 *      own content, whatever sits beside it (from 1024px);
 *   3. settings-style rows, switches, numeric/date table columns and header actions are flush right;
 *   4. no sideways scroll, no clipped or spilled text.
 *
 * A per-page report is printed, and written as JSON to `PK_LAYOUT_REPORT` when set. With
 * `PK_SHOTS_DIR` set it also saves a screenshot of every page (the top, and the bottom of the
 * scroll container when it scrolls).
 */

const here = fileURLToPath(new URL("..", import.meta.url));
// The console shell's policy as the Worker sends it with an image host configured.
const CSP = appSecurityHeaders(new Headers(), {
  imgOrigin: IMG_ORIGIN,
}).get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const REPORT = process.env.PK_LAYOUT_REPORT;
/** The page wrapper's bottom padding is 24px; 48 allows a card's own padding on top of it. */
const TRAILING_SLACK = 48;

/**
 * Masthead and stretch overshoots that belong to a page's own composition, each with the package
 * that fixes it (ST-48 builds the shell; the area packages build their screens on it). The list
 * only shrinks: a full run fails when an entry no longer matches a violation, so delete the entry
 * in the change that fixes the page. It is empty now (B-235); a new page never joins it.
 */
const MASTHEAD_DEBT: {
  /** The case name (`djdl:licenses/record/keys`). */
  cases: RegExp;
  /** `rule/kind`. */
  kinds: readonly string[];
  owner: string;
  why: string;
}[] = [];
const debtMatched = new Set<number>();

/** Splits a page's violations into new ones and those a MASTHEAD_DEBT entry owns. */
function withoutDebt(
  name: string,
  violations: LayoutViolation[],
): LayoutViolation[] {
  return violations.filter((v) => {
    const i = MASTHEAD_DEBT.findIndex(
      (d) => d.cases.test(name) && d.kinds.includes(`${v.rule}/${v.kind}`),
    );
    if (i < 0) return true;
    debtMatched.add(i);
    return false;
  });
}

interface Case {
  name: string;
  hash: string;
  /** Opens a drawer or dialog after the page settles. */
  act?: (page: Page) => Promise<void>;
  /** Answers for these API paths in place of the fixtures (a different member, a paused product). */
  override?: Record<string, unknown>;
  /** The case needs a window at least this wide (a control that is not drawn below it). */
  minWidth?: number;
  /**
   * The case is meant to show an error state (an ErrorState, a not-found page or the
   * AppErrorBoundary). Any other case that draws one fails: it hides a fixture gap.
   */
  expectError?: boolean;
  /** Replaces what `resolve` answers for a path (ST-31.15: who the member is, who can help). */
  api?: Record<string, unknown>;
}

const LONG_NAME =
  "Starfall Chronicles Remastered Definitive Collector's Edition of the Long Night, Part Two: The Reckoning of the Seven Moons and the Ninefold Tide, Anniversary Re-release";

/** ST-31.15: the no-access cases; the 200 %-text and small-phone rows open every one. */
const NO_ACCESS_CASES = [
  "no-access:product",
  "no-access:two-products",
  "no-access:unknown-role",
  "no-access:nobody",
  "no-access:home",
  "no-access:long-name",
  "no-access:long-address",
];

/** ST-31.15: the no-access states, each a different member (`admin.no-access`, `.no-access-home`). */
function noAccessCases(): Case[] {
  const me = (
    email: string,
    roles: unknown[],
    products: { slug: string; name: string; schemaVersion: number }[],
    productAreas: Record<string, string[]> = {},
  ) => ({
    sub: "m-x",
    name: "Lucía Ortega",
    email,
    csrf: "c",
    platformAdmin: false,
    sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    products,
    permissions: {
      roles,
      platform: { view: ["console"], edit: ["console"] },
      products: Object.fromEntries(
        Object.entries(productAreas).map(([k, v]) => [k, { view: v, edit: v }]),
      ),
    },
  });
  const djdl = [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }];
  const narrowed = {
    role: "product_admin",
    scope: "product:djdl",
    areas: ["ship", "commerce"],
    source: "grant",
  };
  const admins = (list: unknown[]) => ({
    "/manage/api/access/admins": {
      scope: "product:djdl",
      area: "license",
      admins: list,
    },
  });
  const people = [
    { name: "Kenji Mori", email: "kenji@example.com", role: "product_admin" },
    { name: "Ada Lindqvist", email: "ada@example.com", role: "superadmin" },
    { name: "Jonas Weber", email: "jonas@example.com", role: "superadmin" },
  ];
  const lucia = me("lucia@example.com", [narrowed], djdl, {
    djdl: ["ship", "commerce"],
  });
  const list: Case[] = [
    {
      name: "no-access:product",
      hash: "#/p/djdl/license/licenses",
      api: { "/manage/api/me": lucia, ...admins(people) },
    },
    {
      name: "no-access:two-products",
      hash: "#/p/djdl/license/licenses",
      api: {
        "/manage/api/me": me(
          "lucia@example.com",
          [
            narrowed,
            {
              role: "product_admin",
              scope: "product:acme",
              areas: null,
              source: "grant",
            },
          ],
          [...djdl, { slug: "acme", name: "Acme", schemaVersion: 2 }],
          {
            djdl: ["ship", "commerce"],
            acme: ["core", "license", "ship", "commerce"],
          },
        ),
        ...admins(people),
      },
    },
    {
      name: "no-access:unknown-role",
      hash: "#/p/djdl/license/licenses",
      api: {
        "/manage/api/me": me(
          "lucia@example.com",
          [
            {
              role: "workspace_auditor",
              scope: "platform",
              areas: null,
              source: "grant",
            },
          ],
          djdl,
          {},
        ),
        ...admins(people),
      },
    },
    {
      name: "no-access:nobody",
      hash: "#/p/djdl/license/licenses",
      api: { "/manage/api/me": lucia, ...admins([]) },
    },
    {
      name: "no-access:home",
      hash: "#/",
      api: {
        "/manage/api/me": me(
          "noor@studio.example.com",
          [
            {
              role: "console_access",
              scope: "platform",
              areas: null,
              source: "rule",
            },
          ],
          [],
        ),
        "/manage/api/access/admins": {
          scope: "platform",
          area: "console",
          admins: people.slice(1),
        },
      },
    },
    {
      name: "no-access:long-address",
      hash: "#/p/djdl/license/licenses",
      api: {
        "/manage/api/me": {
          ...lucia,
          email: "lucia.ortega@studio-operations.example.com",
          products: [{ ...djdl[0]!, name: LONG_NAME }],
        },
        "/manage/api/products/djdl": {
          product: {
            ...(resolve("/manage/api/products/djdl") as { product: object })
              .product,
            name: LONG_NAME,
          },
        },
        ...admins(people),
      },
    },
    {
      name: "no-access:long-name",
      hash: "#/p/djdl/license/licenses",
      api: {
        "/manage/api/me": {
          ...lucia,
          products: [{ ...djdl[0]!, name: LONG_NAME }],
        },
        "/manage/api/products/djdl": {
          product: {
            ...(resolve("/manage/api/products/djdl") as { product: object })
              .product,
            name: LONG_NAME,
          },
        },
        ...admins(people),
      },
      // No title is cut: the h1 shows every line it wraps to (ST-31.15 B1).
      act: async (page) => {
        const h1 = page.getByRole("heading", { level: 1 });
        await h1.waitFor();
        const clipped = await h1.evaluate(
          (el) =>
            el.scrollHeight > el.clientHeight + 1 ||
            getComputedStyle(el).webkitLineClamp !== "none",
        );
        expect(clipped, "the h1 is clipped").toBe(false);
      },
    },
  ];
  // Each case's `/products` is the member's own, so the switcher and sidebar are what they see.
  return list.map((c) => {
    const m = c.api!["/manage/api/me"] as { products: { slug: string }[] };
    const all = (
      resolve("/manage/api/products") as {
        products: { slug: string; name: string }[];
      }
    ).products;
    const own = new Set(m.products.map((p) => p.slug));
    const names = new Map(
      m.products.map((p) => [p.slug, (p as { name?: string }).name]),
    );
    return {
      ...c,
      api: {
        ...c.api,
        "/manage/api/products": {
          products: all
            .filter((p) => own.has(p.slug))
            .map((p) => ({ ...p, name: names.get(p.slug) ?? p.name })),
        },
      },
    };
  });
}

// ── The case list: nav.ts's pages, their records and tabs, the overlays ──────────────────────

const RECORD_IDS: Record<string, { id: string; child?: string[] }> = {
  devices: { id: DEVICE_ID },
  licenses: { id: "lic_1" },
  "license-batches": { id: "batch_long" },
  tiers: { id: "pro" },
  profiles: { id: "base" },
  releases: { id: "v0.4.2" },
  deliverables: { id: PACK_ID },
  "package-feeds": { id: "npm", child: ["@djdl/sdk"] },
  "platform-feeds": { id: "npm", child: ["polaris-key", "@polaris-key/node"] },
  // PS-06: the built-in storefront's own page.
  storefronts: { id: "polaris-key" },
  // ST-51: an event's drawer, over the list (the id is one the layout fixture's feed holds).
  "platform-activity": { id: "pax1" },
};

function cases(): Case[] {
  const list: Case[] = [];
  const enc = encodeURIComponent;
  for (const section of SECTIONS) {
    for (const p of section.items) {
      const path = p.path ? `/${p.path}` : "";
      list.push({ name: `djdl:${p.page}`, hash: `#/p/djdl${path}` });
      if (p.inNav)
        list.push({ name: `empty:${p.page}`, hash: `#/p/empty${path}` });
      const rec = p.record && RECORD_IDS[p.page];
      if (p.record && rec) {
        const tabs = p.record.tabs ?? [undefined];
        for (const tab of tabs)
          list.push({
            name: `djdl:${p.page}/record${tab ? `/${tab}` : ""}`,
            hash: `#/p/djdl${path}/${enc(rec.id)}${tab ? `/${tab}` : ""}`,
          });
        if (p.record.child && rec.child)
          for (const tab of p.record.child.tabs ?? [undefined])
            list.push({
              name: `djdl:${p.page}/record/${p.record.child.segment}${tab ? `/${tab}` : ""}`,
              hash: `#/p/djdl${path}/${enc(rec.id)}/${p.record.child.segment}/${rec.child.map(enc).join("/")}${tab ? `/${tab}` : ""}`,
            });
      }
    }
  }
  // CX-LREC's holder variants of the license record: Waiting (lic_3) and Floating (lic_10).
  for (const [holder, id] of [
    ["waiting", "lic_3"],
    ["floating", "lic_10"],
  ] as const)
    for (const tab of ["overview", "keys", "devices", "activity", "config"])
      list.push({
        name: `djdl:licenses/record-${holder}/${tab}`,
        hash: `#/p/djdl/license/licenses/${id}/${tab}`,
      });
  list.push({ name: `long:overview`, hash: `#/p/${LONG_SLUG}` });
  list.push({ name: `long:sync-usage`, hash: `#/p/${LONG_SLUG}/sync/usage` });
  list.push({ name: `long:settings`, hash: `#/p/${LONG_SLUG}/settings` });
  for (const p of GLOBAL_PAGES) {
    list.push({ name: `global:${p.page}`, hash: `#/${p.path}` });
    const rec = p.record && RECORD_IDS[p.page];
    if (p.record && rec) {
      for (const tab of p.record.tabs ?? [undefined])
        list.push({
          name: `global:${p.page}/record${tab ? `/${tab}` : ""}`,
          hash: `#/${p.path}/${enc(rec.id)}${tab ? `/${tab}` : ""}`,
        });
      if (p.record.child && rec.child)
        for (const tab of p.record.child.tabs ?? [undefined])
          list.push({
            name: `global:${p.page}/record/${p.record.child.segment}${tab ? `/${tab}` : ""}`,
            hash: `#/${p.path}/${enc(rec.id)}/${p.record.child.segment}/${rec.child.map(enc).join("/")}${tab ? `/${tab}` : ""}`,
          });
    }
  }
  // Query-addressed views and overlays.
  list.push(
    {
      name: "home:table",
      hash: "#/",
      // The Cards/Table switch is not drawn below 640 px: a phone always shows Cards.
      minWidth: 640,
      act: async (page) => {
        await page.getByRole("radio", { name: "Table" }).click();
        // A phone draws the table as cards (`mobile="cards"`): wait on the choice, not the role.
        await page
          .locator("[role=radio][aria-checked=true]", { hasText: "Table" })
          .waitFor();
      },
    },
    // ST-44b: Home while Cloud Sync writes are paused. Superadmin is `global:home` (the platform
    // row among the product rows); a Platform admin with no product grant sees the row and the
    // first-run state; a product admin never gets the item from the server.
    {
      name: "home:paused-platform-only",
      hash: "#/",
      override: {
        "/manage/api/me": PLATFORM_ONLY_ME,
        "/manage/api/products": { products: [] },
        "/manage/api/platform/ready": PLATFORM_ONLY_READY,
        "/manage/api/attention": { items: [PLATFORM_PAUSE_ITEM] },
        "/manage/api/platform/settings": pausedPlatformSettings(),
      },
    },
    {
      name: "home:paused-product-role",
      hash: "#/",
      override: {
        "/manage/api/me": PRODUCT_ROLE_ME,
        "/manage/api/attention": {
          items: (
            (resolve("/manage/api/attention") as { items: { id: string }[] })
              .items ?? []
          ).filter((i) => i.id !== PLATFORM_PAUSE_ITEM.id),
        },
      },
    },
    {
      name: "dialog:resume-from-home",
      hash: "#/",
      override: { "/manage/api/platform/settings": pausedPlatformSettings() },
      act: async (page) => {
        await page.getByRole("button", { name: "Resume writes" }).click();
        await page.getByRole("alertdialog").waitFor();
      },
    },
    { name: "djdl:activity?table", hash: "#/p/djdl/activity?view=table" },
    // F-34.7: waiting feeds with a package deliverable (the one-line publish command).
    {
      name: "waiting:package-feeds",
      hash: "#/p/waiting/distribution/feeds",
    },
    // F-34.7: a deep link to an ecosystem the product does not declare (the guided panel).
    {
      name: "djdl:package-feeds?undeclared",
      hash: "#/p/djdl/distribution/feeds/swift",
    },
    // F-33b.4: Service tokens (product) and Registry tokens (platform, no Create), and the mint dialog.
    {
      name: "djdl:feeds/tokens",
      hash: "#/p/djdl/distribution/feeds/tokens",
    },
    { name: "global:platform-feeds/tokens", hash: "#/platform/feeds/tokens" },
    {
      name: "dialog:new-service-token",
      hash: "#/p/djdl/distribution/feeds/tokens",
      act: async (page) => {
        await page.getByRole("button", { name: "New token…" }).click();
        await page.getByRole("dialog", { name: "New service token" }).waitFor();
      },
    },
    // U-05.20: Cloud Sync's Usage tab is a route tab, not a nav row: its empty twin by hand.
    { name: "empty:sync-usage", hash: "#/p/empty/sync/usage" },
    // U-05.21: Setup as a product admin while writes are paused (the access line, no Resume).
    {
      name: "djdl:sync-setup?role",
      hash: "#/p/djdl/sync/setup",
      override: {
        "/manage/api/me": PRODUCT_ROLE_ME,
        "/manage/api/products/djdl/sync/usage": {
          ...SYNC_USAGE,
          paused: {
            since: Math.floor(Date.now() / 1000) - 3600,
            by: null,
            reason: null,
          },
        },
      },
    },
    {
      name: "global:platform-activity?timeline",
      hash: "#/platform/activity?view=timeline",
    },
    // ST-31.11/12: Platform → Members' overlays: the Invite drawer (empty, and filled to its
    // tallest), a member's roles, and the drawer's Add a role and Edit areas views. Each checks
    // that the primary action is in view whatever the window.
    {
      name: "global:platform-members?invite",
      hash: "#/platform/members",
      act: async (page) => {
        await openInviteDrawer(page);
        await primaryInView(page);
      },
    },
    {
      name: "global:platform-members?invite-filled",
      hash: "#/platform/members",
      act: async (page) => {
        const drawer = await openInviteDrawer(page);
        await drawer.getByLabel("Email addresses").fill("hana@example.com, ");
        await drawer.getByLabel("Email addresses").fill("theo@example.com, ");
        await drawer.getByRole("radio", { name: /^Product admin/ }).click();
        await drawer.getByRole("combobox").click();
        await page.getByRole("option").first().click();
        await drawer.getByRole("radio", { name: /Only these areas/ }).click();
        await primaryInView(page);
      },
    },
    // ST-31.14: no name or short address breaks inside a word in the Member cell.
    {
      name: "djdl:settings-members?words",
      hash: "#/p/djdl/settings/members",
      act: async (page) => {
        const broken = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(
            'table[aria-label="Admins"] td:first-child p',
          )) {
            const node =
              el.firstChild?.nodeType === 3
                ? el.firstChild
                : el.querySelector("span")?.firstChild;
            if (!node || node.nodeType !== 3) continue;
            const text = node.textContent ?? "";
            if (text.length > 24) continue;
            let at = 0;
            for (const word of text.split(/\s+/)) {
              const i = text.indexOf(word, at);
              at = i + word.length;
              const r = document.createRange();
              r.setStart(node, i);
              r.setEnd(node, i + word.length);
              const tops = new Set(
                [...r.getClientRects()].map((x) => Math.round(x.top)),
              );
              if (tops.size > 1) out.push(`${text}: ${word}`);
            }
          }
          return out;
        });
        if (broken.length > 0)
          throw new Error(`broken words: ${broken.join("; ")}`);
      },
    },
    // ST-31.14: the Invite drawer from the product's Members tab (role fixed, product fixed).
    {
      name: "djdl:settings-members?invite",
      hash: "#/p/djdl/settings/members",
      act: async (page) => {
        await openInviteDrawer(page);
        await primaryInView(page);
      },
    },
    {
      name: "djdl:settings-members?invite-filled",
      hash: "#/p/djdl/settings/members",
      act: async (page) => {
        const drawer = await openInviteDrawer(page);
        await drawer.getByLabel("Email addresses").fill("hana@example.com, ");
        await drawer.getByLabel("Email addresses").fill("theo@example.com, ");
        await drawer.getByRole("radio", { name: /Only these areas/ }).click();
        await primaryInView(page);
      },
    },
    // ST-31.13: the Roles tab, and on a phone the tile that picks the matrix column.
    {
      name: "global:platform-members?tab=roles",
      hash: "#/platform/members?tab=roles",
      act: async (page) => {
        const tile = page.getByRole("button", { name: /^Console access/ });
        if (await tile.isVisible()) await tile.click();
      },
    },
    {
      name: "global:platform-members?edit-roles",
      hash: "#/platform/members",
      act: async (page) => {
        await openEditDrawer(page);
        await primaryInView(page);
      },
    },
    {
      name: "global:platform-members?add-role",
      hash: "#/platform/members",
      act: async (page) => {
        const drawer = await openEditDrawer(page);
        await drawer.getByRole("button", { name: "Add a role" }).click();
        // The drawer's title changes with the view.
        await page
          .getByRole("dialog", { name: /Add a role for Sam Okoye/ })
          .getByRole("radio", { name: /^Product admin/ })
          .waitFor();
        await primaryInView(page);
      },
    },
    {
      name: "global:platform-members?edit-areas",
      hash: "#/platform/members",
      act: async (page) => {
        const drawer = await openEditDrawer(page);
        const edit = drawer
          .getByRole("button", { name: /Edit areas of/ })
          .first();
        if ((await edit.count()) > 0 && (await edit.isEnabled())) {
          await edit.click();
          await page
            .getByRole("dialog", { name: /Areas for Sam Okoye/ })
            .getByRole("button", { name: "Save areas" })
            .waitFor();
          await primaryInView(page);
        }
      },
    },

    {
      name: "djdl:rollouts?view=matrix&cell",
      hash: "#/p/djdl/distribution/rollouts?view=matrix&cell=rel_240:altstore",
    },
    {
      name: "djdl:rollouts?view=readiness",
      hash: "#/p/djdl/distribution/rollouts?view=readiness",
    },
    {
      name: "djdl:rollouts?cell",
      hash: "#/p/djdl/distribution/rollouts?cell=rel_240:direct",
    },
    {
      name: "djdl:outlets?outlet",
      hash: "#/p/djdl/distribution/outlets?outlet=altstore",
    },
    {
      name: "djdl:catalog-editor?entry",
      hash: "#/p/djdl/config/catalog/edit?entry=network.timeout",
    },
    // A minted token's "Code only. DJDL calls mintToken(…)" line scrolled sideways at 200 % text.
    {
      name: "djdl:catalog-editor?minted",
      hash: "#/p/djdl/config/catalog/edit?entry=applemusic.token",
    },
    // B-217: the Add to storefronts flow, at the steps whose rows wrapped sideways at 200 %.
    ...(["prerequisites", "listing", "assets", "run"] as const).map((step) => ({
      name: `djdl:storefronts?flow=${step}`,
      hash: `#/p/djdl/distribution/storefronts?flow=add&stores=google-play&step=${step}`,
    })),
    // A-27.11: the listing editor scoped to a store (the page's switcher), on the fit tab.
    {
      name: "djdl:presentation-listing?store",
      hash: "#/p/djdl/settings/presentation/listing?tab=fit&store=google-play",
    },
    // B-216: the New license wizard's segments at 200 % text (they read "Lim…" and "Deli…").
    {
      name: "dialog:new-license",
      hash: "#/p/djdl/license/licenses",
      act: async (page) => {
        await page.getByRole("button", { name: "New license" }).click();
        await page.getByRole("dialog").first().waitFor();
      },
    },
    // F-34.8: the off page, and the Turn off package feeds dialog over the Packages cards.
    { name: "feedsoff:package-feeds", hash: "#/p/feedsoff/distribution/feeds" },
    {
      name: "dialog:turn-off-feeds",
      hash: "#/p/djdl/distribution/feeds",
      act: async (page) => {
        await page
          .getByRole("button", { name: "Turn off package feeds" })
          .click();
        await page.getByRole("alertdialog").waitFor();
      },
    },
    // M6: the Services switch opens the same typed dialog.
    {
      name: "dialog:turn-off-feeds-services",
      hash: "#/p/djdl/settings/features",
      act: async (page) => {
        await page.getByRole("switch", { name: /Packages/ }).click();
        await page.getByRole("alertdialog").waitFor();
      },
    },
    {
      name: "dialog:turn-off-feeds-409",
      hash: "#/p/djdl/distribution/feeds",
      act: async (page) => {
        await page
          .getByRole("button", { name: "Turn off package feeds" })
          .click();
        const dialog = page.getByRole("alertdialog");
        await dialog.getByRole("textbox").fill("djdl");
        await dialog
          .getByRole("button", { name: "Turn off package feeds" })
          .click();
        await dialog.getByText(/changed since you opened this/).waitFor();
      },
    },
    // LX-27c.4: the wizard's Delivery step with the invitation, its key box and the email preview.
    {
      name: "dialog:new-license-delivery",
      hash: "#/p/djdl/license/licenses",
      act: async (page) => {
        await page.getByRole("button", { name: "New license" }).click();
        const dialog = page.getByRole("dialog").first();
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Continue" }).click();
        await dialog.getByLabel(/^Email/).fill("grace@example.com");
        await dialog.getByRole("button", { name: "Continue" }).click();
        await dialog.getByRole("button", { name: "Continue" }).click();
        await dialog
          .getByRole("radio", { name: /Email an invitation/ })
          .waitFor();
      },
    },
    // LX-27c.5: the record of a waiting licence that was invited.
    {
      name: "djdl:license-waiting",
      hash: "#/p/djdl/license/licenses/lic_wait",
      act: async (page) => {
        await page.getByRole("button", { name: "Resend invitation" }).waitFor();
        await page.getByRole("region", { name: "Invitation" }).waitFor();
      },
    },
    {
      name: "dialog:set-secret",
      hash: "#/p/djdl/settings/keys",
      act: async (page) => {
        await page.getByRole("button", { name: "Set secret" }).first().click();
        await page.getByRole("dialog").first().waitFor();
      },
    },
    {
      name: "dialog:delete-product",
      hash: "#/p/djdl/settings",
      act: async (page) => {
        await page.getByRole("button", { name: "Delete product…" }).click();
        await page
          .locator("[role=dialog],[role=alertdialog]")
          .first()
          .waitFor();
      },
    },
  );
  return [...list, ...noAccessCases()];
}

const CASES = cases();
const PAUSED_HOME_CASES = [
  "home:paused-platform-only",
  "home:paused-product-role",
  "dialog:resume-from-home",
];
/** The cases the zoom rows open: Home, tables, a record, a settings page and an overlay. */
const ZOOM_CASES = [
  "global:home",
  "home:table",
  // ST-44b.2: Home while Cloud Sync writes are paused, and the Resume dialog opened from it.
  ...PAUSED_HOME_CASES,
  "djdl:overview",
  "djdl:licenses",
  "djdl:licenses/record/overview",
  "djdl:devices",
  "djdl:keys",
  "djdl:settings",
  "djdl:services",
  "djdl:app-sign-in",
  "djdl:releases",
  "djdl:deliverables/record/delivery",
  "djdl:activity?table",
  "djdl:sync-usage",
  "djdl:sync-setup",
  "djdl:sync-setup?role",
  "djdl:storefronts?flow=prerequisites",
  "djdl:storefronts?flow=listing",
  "djdl:storefronts?flow=assets",
  "djdl:storefronts?flow=run",
  "djdl:presentation-listing?store",
  "dialog:new-license",
  "long:overview",
  "dialog:set-secret",
];
/** Home (Cards and Table) and a product's Overview. */
const HOME_CASES = [
  "global:home",
  "home:table",
  "djdl:overview",
  ...PAUSED_HOME_CASES,
];
/** The pages the phone-at-200%-text row opens. */
const TEXT200_CASES = [
  "djdl:sync-usage",
  // ST-31.13: the Roles tab's tiles and one-column matrix.
  "global:platform-members?tab=roles",
  // ST-30c.4: the rows' name column kept its width at 200 % text.
  "global:sign-in-methods",
  ...NO_ACCESS_CASES,
  "djdl:settings",
  // U-05.21: Cloud Sync Setup's tier rows, ceiling meter and pause row.
  "djdl:sync-setup",
  "djdl:sync-setup?role",
  "djdl:services",
  "djdl:portal",
  "djdl:licenses/record/overview",
  // CXF-LREC: the holder variants, whose primary action ("Resend invitation", "Assign to a
  // person") is the longest label on the record's header (cases come from LAYOUT-fx's fixtures).
  "djdl:licenses/record-waiting/overview",
  "djdl:licenses/record-floating/overview",
  // N1: the data tables' phone cards, where a status pill wrapped out of its box.
  "djdl:licenses",
  // CF1 / M1: the pages that scrolled sideways at 390 px with 200 % text.
  "djdl:catalog-edit",
  "djdl:catalog-editor?entry",
  "djdl:catalog-editor?minted",
  "djdl:integration",
  "djdl:releases/record/builds",
  "djdl:outlets",
  "djdl:credentials",
  "djdl:storefronts",
  "djdl:storefronts?flow=prerequisites",
  "djdl:storefronts?flow=listing",
  "djdl:storefronts?flow=assets",
  "djdl:storefronts?flow=run",
  // CF5: the Rollouts masthead at 200 % text on a phone.
  "djdl:rollouts",
  "djdl:activity",
  "global:platform-status",
  "djdl:settings-members",
  // F-34.7: the Packages cards (the access chip beside a long title) at 200 % text.
  "djdl:package-feeds",
  "empty:package-feeds",
  "feedsoff:package-feeds",
  "djdl:package-feeds?undeclared",
  "waiting:package-feeds",
  "djdl:settings-members?invite-filled",
  // ST-31.12: the Members drawer, at its tallest views.
  "global:platform-members?invite-filled",
  "global:platform-members?add-role",
  "global:platform-members?edit-areas",
  "global:platform-members?edit-roles",
];
/** The product Members tab, with the check that no name breaks inside a word (ST-31.14). */
const MEMBERS_TAB = ["djdl:settings-members", "djdl:settings-members?words"];
/** The Members drawer's views (ST-31.12). */
const DRAWER_CASES = [
  "djdl:settings-members?invite",
  "djdl:settings-members?invite-filled",
  "global:platform-members?invite",
  "global:platform-members?invite-filled",
  "global:platform-members?add-role",
  "global:platform-members?edit-areas",
  "global:platform-members?edit-roles",
];
/** The console's content column at its widest (BRAND.md §7.6). */
const CONSOLE_COLUMN_MAX = 1760;
/** `PK_LAYOUT_VIEWPORTS=1280x720,1920x1080` swaps the gate viewports for others locally. */
const VIEWPORTS: {
  label: string;
  width: number;
  height: number;
  /** Only these cases (by name) at this viewport. */
  only?: readonly string[];
  /** Only the cases this accepts (the wide and zoom rows skip the empty-state twins). */
  accept?: (name: string) => boolean;
  /** The root font size as a percentage (WCAG 1.4.4 text resize), on top of the viewport. */
  rootFontPercent?: number;
  /** The device pixel ratio: browser zoom is a smaller CSS viewport at a higher ratio. */
  deviceScaleFactor?: number;
  /** Emulate a Windows contrast theme, or `prefers-contrast: more`. */
  forcedColors?: "active";
  contrast?: "more";
  /** Emulate `prefers-reduced-transparency: reduce` (no blur survives; UK-63). */
  reducedTransparency?: boolean;
}[] = process.env.PK_LAYOUT_VIEWPORTS
  ? process.env.PK_LAYOUT_VIEWPORTS.split(",").map((v) => {
      const [width, height] = v.split("x").map(Number) as [number, number];
      return { label: v, width, height };
    })
  : [
      { label: "desktop", width: 1440, height: 900 },
      // A common laptop: the content column is under 1000px beside the sidebar.
      { label: "laptop", width: 1280, height: 800 },
      // A tablet or a narrow window: no sidebar, but too narrow for wide tables.
      { label: "tablet", width: 768, height: 1024 },
      // The shell v2 matrix (ST-48): the icon rail at its narrowest (1024), the iPad (834) and the
      // phone widths (390 above, 360 below). The canvas is inset only from 1024 px.
      {
        label: "rail",
        width: 1024,
        height: 768,
        accept: (n) => !n.startsWith("empty:"),
      },
      {
        label: "ipad",
        width: 834,
        height: 1112,
        accept: (n) => !n.startsWith("empty:"),
      },
      { label: "phone", width: 390, height: 844 },
      // D7: the console's two review sizes, a small laptop window and a landscape phone.
      { label: "d7-laptop", width: 1180, height: 820 },
      { label: "d7-landscape", width: 844, height: 390 },
      // Home and Overview at the laptop the owner works on (1512). Overview's own 200 % text (its
      // masthead sentence, the By platform rows) belongs to the Overview package.
      { label: "mac", width: 1512, height: 818, only: HOME_CASES },
      // ADMIN.md's narrowest width, for the pages with a product in the top bar: the switcher's
      // chevron once spilled out of its border box here (ADMIN.md §2.2).
      {
        label: "small-phone",
        width: 360,
        height: 780,
        only: [
          ...ZOOM_CASES,
          "djdl:health",
          "djdl:rollouts",
          // F-34.7: the URL breaks at separators and the publish command scrolls, not splits.
          "djdl:package-feeds",
          "empty:package-feeds",
          "djdl:package-feeds?undeclared",
          "waiting:package-feeds",
          "no-access:long-name",
        ],
      },
      // UI-KITS.md §7.1's wide desktop: every page with content (the empty-state twins add
      // nothing to a width check). The column stays capped (CONSOLE_COLUMN_MAX).
      {
        label: "wide",
        width: 1920,
        height: 1080,
        accept: (n) => !n.startsWith("empty:"),
      },
      // 200 % zoom in a 1280 × 800 and a 1440 × 900 window, and 400 % in 1280 × 1024
      // (320 × 256 CSS px, WCAG 1.4.10): the key pages, a table, a record, an overlay.
      ...[
        { label: "zoom200", width: 640, height: 400, deviceScaleFactor: 2 },
        {
          label: "zoom200-wide",
          width: 720,
          height: 450,
          deviceScaleFactor: 2,
        },
        { label: "zoom400", width: 320, height: 256, deviceScaleFactor: 4 },
      ].map((v) => ({ ...v, only: ZOOM_CASES })),
      // 200 % text on a phone (WCAG 1.4.4; a text-only zoom keeps the window): Home, and the
      // Settings tabs and a licence record, where a word broke into letters, a control ran off
      // the screen and a date input spilled.
      // ST-31.12: the Members drawer at 150 % text on the two small phones (the areas grid once
      // overlapped its labels there).
      ...[
        { label: "phone-text150-390", width: 390, height: 844 },
        { label: "phone-text150-360", width: 360, height: 780 },
      ].map((v) => ({
        ...v,
        rootFontPercent: 150,
        only: DRAWER_CASES,
      })),
      // ST-31.14 B1: the product Members tab at a small tablet's width (large text on a desktop is
      // e2e/productMembers.e2e.test.ts).
      { label: "tablet-700", width: 700, height: 900, only: MEMBERS_TAB },

      {
        label: "phone-text200",
        width: 390,
        height: 844,
        rootFontPercent: 200,
        only: [
          "global:home",
          "home:table",
          "djdl:overview",
          ...PAUSED_HOME_CASES,
          ...TEXT200_CASES,
        ],
      },
      // Forced colours (a Windows contrast theme) and `prefers-contrast: more`: Home, Licenses and
      // Services.
      // UI-KITS.md §7.1's small landscape (a phone on its side, a split window): 640 × 360.
      {
        label: "landscape-small",
        width: 640,
        height: 360,
        only: [...ZOOM_CASES, "global:sign-in-methods"],
      },
      // Reduced transparency: the dialog and drawer backdrops lose their blur (UK-63).
      {
        label: "reduced-transparency",
        width: 1440,
        height: 900,
        reducedTransparency: true,
        only: [
          "global:home",
          "djdl:licenses",
          "djdl:services",
          "dialog:set-secret",
        ],
      },
      {
        label: "forced-colors",
        width: 1440,
        height: 900,
        forcedColors: "active" as const,
        only: [
          "global:home",
          "home:table",
          "djdl:licenses",
          "djdl:services",
          "djdl:app-sign-in",
          "dialog:set-secret",
        ],
      },
      {
        label: "more-contrast",
        width: 1440,
        height: 900,
        contrast: "more" as const,
        only: [
          "global:home",
          "home:table",
          "djdl:licenses",
          "djdl:services",
          "djdl:app-sign-in",
          "dialog:set-secret",
        ],
      },
    ];
const THEMES = ["dark", "light"] as const;

// ── Harness ──────────────────────────────────────────────────────────────────────────────────

let server: PreviewServer;
let browser: Browser;
let base: string;
const report: Record<
  string,
  {
    violations: LayoutViolation[];
    scrollers: ScrollMetric[];
    gaps: string[];
    errors: string[];
    /** The page drew an error or not-found state instead of its content. */
    errorState: boolean;
  }
> = {};

beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`)) {
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "silent",
  });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  // `PK_LAYOUT_BROWSER=webkit|firefox` runs the same lint in another engine locally.
  const engine = { chromium, firefox, webkit }[
    (process.env.PK_LAYOUT_BROWSER ?? "chromium") as "chromium"
  ];
  browser = await engine.launch();
});

afterAll(async () => {
  // A full run owes the debt list its shrinking: an entry that matched nothing is paid.
  if (!ONLY && !ONLY_CASES && !process.env.PK_LAYOUT_VIEWPORTS) {
    const paid = MASTHEAD_DEBT.filter((_, i) => !debtMatched.has(i));
    if (paid.length)
      throw new Error(
        `MASTHEAD_DEBT entries that no longer match a violation (delete them): ${paid.map((d) => `${d.cases} (${d.owner})`).join(", ")}`,
      );
  }
  if (!ONLY && !ONLY_CASES && !process.env.PK_LAYOUT_VIEWPORTS) {
    const stale = staleUxDebt("console");
    if (stale.length)
      throw new Error(
        `UX_BAR_DEBT entries that no longer match a finding (delete them): ${stale.join(", ")}`,
      );
  }
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
  const lines: string[] = ["", "── Layout lint report ──"];
  let total = 0;
  for (const [key, r] of Object.entries(report)) {
    total += r.violations.length;
    lines.push(
      `${r.violations.length ? "FAIL" : "ok  "} ${key}${r.errorState ? "  (error state)" : ""}${r.gaps.length ? `  (fixture gaps: ${r.gaps.join(", ")})` : ""}`,
    );
    for (const v of r.violations)
      lines.push(
        `     · [${v.rule}/${v.kind}] ${v.detail}\n         at ${v.where}`,
      );
  }
  lines.push(
    `── ${total} violation(s) over ${Object.keys(report).length} page loads ──`,
  );
  printSync(`${lines.join("\n")}\n`);
  if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 2));
});

/**
 * Straight to stdout, synchronously: the runner shows console output only for failing tests, and
 * an async write of a report this long is cut off when the worker exits. The report is wanted
 * whole, on a green run too.
 */
function printSync(text: string): void {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
    }
  }
}

async function open(
  c: Case,
  theme: "dark" | "light",
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    rootFontPercent?: number;
    forcedColors?: "active";
    contrast?: "more";
    reducedTransparency?: boolean;
  },
): Promise<{ page: Page; gaps: string[]; errors: string[] }> {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    colorScheme: theme,
    forcedColors: viewport.forcedColors ?? "none",
    contrast: viewport.contrast ?? "no-preference",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((t) => {
    window.localStorage.setItem("pk-admin-theme", t);
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  }, theme);
  const gaps: string[] = [];
  const errors: string[] = [];
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const image = fixtureImage(url);
    if (image)
      return route.fulfill({
        body: image,
        headers: {
          "content-type": "image/png",
          "access-control-allow-origin": "*",
        },
      });
    if (url.pathname.startsWith("/manage/api/")) {
      // F-34.8: the switch's PUT meets a newer owner row (the 409 `version_conflict` case).
      if (
        route.request().method() === "PUT" &&
        url.pathname.endsWith("/distribution/package-feeds")
      )
        return route.fulfill({
          status: 409,
          json: {
            error: "bad_request",
            reason: "version_conflict",
            packageFeeds: {
              enabled: true,
              version: 4,
              updatedAt: Math.floor(Date.now() / 1000) - 60,
              updatedBy: "mbr_01J9ZANALIMA",
            },
          },
        });
      if (route.request().method() !== "GET")
        return route.fulfill({ json: { ok: true } });
      const body =
        c.override && url.pathname in c.override
          ? c.override[url.pathname]
          : c.api && url.pathname in c.api
            ? c.api[url.pathname]
            : resolve(url.pathname);
      if (body === undefined) {
        gaps.push(url.pathname);
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      }
      return route.fulfill({ json: body });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  if (viewport.reducedTransparency) await reduceTransparency(page);
  page.on("pageerror", (e) => errors.push(e.message));
  if (viewport.rootFontPercent)
    await ctx.addInitScript((pct) => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = `${pct}%`;
      });
    }, viewport.rootFontPercent);
  await page.goto(`${base}/manage.html${c.hash}`);
  await page
    .locator("[data-page-title], [data-error-action]")
    .first()
    .waitFor({ timeout: 15_000 });
  // Let queries settle: no skeletons, no spinners, for a beat.
  await page
    .waitForFunction(
      () =>
        !document.querySelector(
          "#content [data-skeleton], #content [aria-busy=true]",
        ),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(350);
  if (c.act) {
    await c.act(page);
    await page.waitForTimeout(400);
  }
  // A nested scroller (a virtualized table, a drawer body) is measured at its end, where a
  // virtualizer has drawn its last rows and only a real gap can remain below them.
  const nested = await page.evaluate(() => {
    let n = 0;
    for (const e of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      if (e.id === "content") continue;
      const o = getComputedStyle(e).overflowY;
      if (
        (o === "auto" || o === "scroll") &&
        e.scrollHeight > e.clientHeight + 1
      ) {
        e.scrollTop = e.scrollHeight;
        n += 1;
      }
    }
    return n;
  });
  if (nested) await page.waitForTimeout(300);
  return { page, gaps, errors };
}

const slug = (s: string) =>
  s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");

async function shoot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${file}.png` });
  const scrolls = await page.evaluate(() => {
    const m = document.getElementById("content");
    if (!m || m.scrollHeight <= m.clientHeight + 1) return false;
    m.scrollTop = m.scrollHeight;
    return true;
  });
  if (scrolls) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${file}--bottom.png` });
    await page.evaluate(() => {
      document.getElementById("content")!.scrollTop = 0;
    });
  }
}

/** `PK_LAYOUT_ONLY=desktop/dark` narrows a local run to one combination. */
const ONLY = process.env.PK_LAYOUT_ONLY;
/** The Members drawer, opened from the header's Invite people. */
async function openInviteDrawer(page: Page) {
  await page.getByRole("button", { name: "Invite people" }).click();
  const drawer = page.getByRole("dialog", { name: "Invite people" });
  await drawer.waitFor();
  return drawer;
}

/** The Members drawer, opened from Sam Okoye's row menu. */
async function openEditDrawer(page: Page) {
  await page
    .getByRole("button", { name: "Actions for Sam Okoye" })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /Edit roles/ }).click();
  const drawer = page.getByRole("dialog", { name: /Edit roles for Sam Okoye/ });
  await drawer.waitFor();
  return drawer;
}

/** The drawer's last footer button is fully inside the window (the primary action is in view). */
async function primaryInView(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const d = document.querySelector("[role=dialog]");
    const footer = d?.querySelector("[data-drawer-footer]");
    const buttons = footer ? [...footer.querySelectorAll("button")] : [];
    if (buttons.length === 0) return "no footer button";
    // Both buttons of the footer row (Cancel and the primary) are fully inside the window.
    for (const b of buttons.slice(-2)) {
      const r = b.getBoundingClientRect();
      if (!(r.top >= 0 && r.bottom <= window.innerHeight + 0.5 && r.width > 0))
        return `"${b.textContent}" out of view (${Math.round(r.top)}..${Math.round(r.bottom)} of ${window.innerHeight})`;
    }
    // Nothing scrolls sideways inside the drawer body.
    const body = d?.querySelector<HTMLElement>(".pk-scroll");
    if (body && body.scrollWidth > body.clientWidth + 1)
      return `the drawer body scrolls sideways by ${body.scrollWidth - body.clientWidth}px`;
    return "ok";
  });
  if (ok !== "ok") throw new Error(ok);
}

/** `PK_LAYOUT_CASES=overview,settings` narrows a local run to cases whose name contains one. */
const ONLY_CASES = process.env.PK_LAYOUT_CASES?.split(",");

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    if (ONLY && ONLY !== `${vp.label}/${theme}`) continue;
    describe.concurrent(
      `layout · ${vp.label} ${vp.width}×${vp.height} · ${theme}`,
      () => {
        for (const c of CASES) {
          if (vp.only && !vp.only.includes(c.name)) continue;
          if (vp.accept && !vp.accept(c.name)) continue;
          if (c.minWidth && vp.width < c.minWidth) continue;
          if (ONLY_CASES && !ONLY_CASES.some((n) => c.name.includes(n)))
            continue;
          it(c.name, async () => {
            const { page, gaps, errors } = await open(c, theme, vp);
            try {
              const { violations, scrollers } = await page.evaluate(
                probeLayout,
                {
                  // The page's bottom padding is in rem, so it grows with the text.
                  trailingSlack:
                    TRAILING_SLACK * ((vp.rootFontPercent ?? 100) / 100),
                  rows: vp.width >= 1024,
                },
              );
              const csp = await page.evaluate(() =>
                (window as unknown as { __v: string[] }).__v.splice(0),
              );
              // An ErrorState (a failed load or a not-found page), anywhere on the page, or the
              // AppErrorBoundary: both carry `data-error-state`.
              const errorState =
                (await page.locator("[data-error-state]").count()) > 0;
              const found = withoutDebt(c.name, violations);
              report[`${vp.label}/${theme} ${c.name} ${c.hash}`] = {
                violations: found,
                scrollers,
                gaps: [...new Set(gaps)],
                errors,
                errorState,
              };
              if (SHOTS)
                await shoot(page, `${slug(c.name)}--${vp.label}-${theme}`);
              expect(
                errorState,
                c.expectError
                  ? "an expectError case must show an error state"
                  : `the page drew an error state (a fixture gap? see the report's gaps: ${[...new Set(gaps)].join(", ") || "none"})`,
              ).toBe(c.expectError === true);
              expect(csp, "CSP violations").toEqual([]);
              // F-34.7: the Packages page passes axe (contrast included) in both themes.
              if (c.name.includes("package-feeds"))
                expect(await axeWithin(page, "#content"), "axe").toEqual([]);
              expect(
                await page.evaluate(
                  () =>
                    document.documentElement.scrollWidth - window.innerWidth,
                ),
                "page-level horizontal scroll",
              ).toBeLessThanOrEqual(0);
              expect(
                await unlabelledScrollers(page),
                "sideways tables outside a labelled region",
              ).toEqual([]);
              if (vp.label === "wide" || vp.label.startsWith("zoom")) {
                // ui:lint over the built page (`pnpm ui:lint --html`; pageChecks.ts).
                // Every rule, with 24 px touch targets (WCAG 2.5.8) at every size.
                expect(
                  await lintFindings(page, { minTouch: 24 }),
                  "ui:lint findings",
                ).toEqual([]);
              }
              if (
                [
                  "desktop",
                  "phone",
                  "landscape-small",
                  "reduced-transparency",
                ].includes(vp.label)
              )
                // B6, B7, B17 over the render (UK-63); the focus-ring walk once per page.
                expect(
                  await uxBarChecked(page, c.name, {
                    focus: vp.label === "desktop" && theme === "dark",
                  }),
                  "UX bar (B6, B7, B17)",
                ).toEqual([]);
              if (
                ["desktop", "phone", "rail"].includes(vp.label) &&
                (await page.locator("header[data-masthead]").count()) > 0
              )
                // axe zero over the masthead and any workbench (ST-48): landmarks, names, contrast.
                expect(
                  [
                    ...(await axeWithin(page, "header[data-masthead]")),
                    ...((await page.locator("[data-workbench]").count()) > 0
                      ? await axeWithin(page, "[data-workbench]")
                      : []),
                  ],
                  "axe: masthead and workbench",
                ).toEqual([]);
              expect(
                await shellStateBreaches(page),
                "shell state colours (B2, B4, B17)",
              ).toEqual([]);
              expect(
                await pillTextBreaches(page),
                "status text escapes its pill or chip (N1)",
              ).toEqual([]);
              expect(
                await rowMenuOverlaps(page),
                "a row menu sits on the row's text (T1)",
              ).toEqual([]);
              expect(
                await emptyStateStarBreaches(page),
                "stationary star (BRAND.md §7.7)",
              ).toEqual([]);
              if (vp.forcedColors)
                expect(
                  await forcedColourBreaches(page),
                  "forced-colour boundaries",
                ).toEqual([]);
              if (vp.forcedColors) {
                // B-009: a sidebar group header is a row, not a control box. It and the single-page
                // link opt out with data-forced-flat, so neither is drawn with a 1 px border.
                const boxed = await page.evaluate(() =>
                  [
                    ...document.querySelectorAll<HTMLElement>(
                      "[data-section-header]",
                    ),
                  ]
                    // The current page's row keeps its 2 px selected border (the non-colour cue).
                    .filter(
                      (el) =>
                        el.checkVisibility() &&
                        !el.hasAttribute("aria-current"),
                    )
                    .map((el) => ({
                      flat: el.hasAttribute("data-forced-flat"),
                      border: getComputedStyle(el).borderTopWidth,
                      label: (el.textContent ?? "").trim().slice(0, 30),
                    }))
                    .filter((h) => !h.flat || h.border !== "0px")
                    .map(
                      (h) => `${h.label}: flat=${h.flat} border=${h.border}`,
                    ),
                );
                expect(
                  boxed,
                  "sidebar group headers are flat in forced colours",
                ).toEqual([]);
              }
              if (vp.forcedColors && c.name === "djdl:services") {
                // State never rests on colour alone: in forced colours an on switch must draw
                // differently from an off one (track fill and knob). The fixture has every
                // switch on, so an off twin is a clone with the unchecked state attributes.
                const looks = await page.evaluate(() => {
                  const sw = document.querySelector<HTMLElement>(
                    '[role="switch"][data-state="checked"]',
                  );
                  if (!sw) return null;
                  const draw = (el: HTMLElement) =>
                    `${getComputedStyle(el).backgroundColor}|${getComputedStyle(el.firstElementChild!).backgroundColor}`;
                  const on = draw(sw);
                  const twin = sw.cloneNode(true) as HTMLElement;
                  for (const el of [twin, twin.firstElementChild!])
                    el.setAttribute("data-state", "unchecked");
                  sw.after(twin);
                  const off = draw(twin);
                  twin.remove();
                  return { on, off };
                });
                expect(looks, "an on switch is drawn").not.toBeNull();
                expect(
                  looks!.on,
                  "on and off switches look the same in forced colours",
                ).not.toBe(looks!.off);
              }
              expect(
                await columnBreaches(
                  page,
                  "#content > div",
                  CONSOLE_COLUMN_MAX,
                  false,
                ),
                "content column",
              ).toEqual([]);
              expect(
                found.map(
                  (v) => `[${v.rule}/${v.kind}] ${v.detail} @ ${v.where}`,
                ),
              ).toEqual([]);
            } finally {
              await closeContext(page.context());
            }
          });
        }
      },
    );
  }
}

// ── Home's product card (owner polish 2026-10-07) ─────────────────────────────────────────────

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

/** axe-core (WCAG 2.2 A/AA) over one element of the page; one line per failing node. */
async function axeWithin(page: Page, selector: string): Promise<string[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (sel) => {
    const a = (
      window as unknown as {
        axe: {
          run: (
            ctx: Element,
            opts: unknown,
          ) => Promise<{
            violations: { id: string; nodes: { target: unknown[] }[] }[];
          }>;
        };
      }
    ).axe;
    const r = await a.run(document.querySelector(sel)!, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      resultTypes: ["violations"],
    });
    return r.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id} @ ${n.target.join(" ")}`),
    );
  }, selector);
}

// ── Needs attention rows keep their shape (ST-44b.3) ───────────────────────────────────────────
// A grid template the browser drops (it did once: `fit-content()` inside `minmax()`) stacks every
// row and still passes the overflow checks, so the shape itself is pinned: at a laptop width the
// pill, the subject and the action share one line.
describe("Needs attention rows are one line at 1440 and stack on a phone (ST-44b.3)", () => {
  const HOME: Case = { name: "global:home", hash: "#/" };
  for (const theme of THEMES) {
    it(`${theme}`, async () => {
      const desk = await open(HOME, theme, { width: 1440, height: 900 });
      try {
        const rows = desk.page.locator("[data-attention-list] ul > li");
        const n = await rows.count();
        expect(n).toBeGreaterThan(1);
        for (let i = 0; i < n; i++) {
          const row = rows.nth(i);
          const tops = await row.evaluate((li) => {
            const top = (el: Element | null) =>
              el ? el.getBoundingClientRect().top : NaN;
            return [
              top(li.querySelector("[class*=pill], [data-tone], span")),
              top(li.querySelector("[title]")),
              top([...li.querySelectorAll("a[href], button")].pop() ?? null),
              li.getBoundingClientRect().height,
            ];
          });
          const [pill, subject, action] = tops as number[];
          expect(Math.abs(subject! - pill!), `row ${i} subject`).toBeLessThan(
            8,
          );
          expect(Math.abs(action! - pill!), `row ${i} action`).toBeLessThan(10);
        }
      } finally {
        await closeContext(desk.page.context());
      }
      const phone = await open(HOME, theme, { width: 390, height: 844 });
      try {
        const li = phone.page.locator("[data-attention-list] ul > li").first();
        const [pill, action] = await li.evaluate((el) => [
          el.querySelector("span")!.getBoundingClientRect().top,
          [...el.querySelectorAll("a[href], button")]
            .pop()!
            .getBoundingClientRect().top,
        ]);
        expect(action! - pill!).toBeGreaterThan(20);
      } finally {
        await closeContext(phone.page.context());
      }
    });
  }
});

describe("Home's product card (owner polish 2026-10-07)", () => {
  const HOME: Case = { name: "global:home", hash: "#/" };
  const CARDS = 'main [aria-label="Products"]';

  for (const theme of THEMES) {
    it(`${theme}: one row of named feature glyphs; on a phone, the name and one pip per feature in its accent`, async () => {
      const desk = await open(HOME, theme, { width: 1440, height: 900 });
      try {
        const page = desk.page;
        const card = page.locator(`${CARDS} article[aria-label="DJDL"]`);
        const icons = card.locator("[data-feature-link]");
        expect(await icons.count()).toBe(7);
        for (const label of ["Licensing", "Ship builds", "Cloud Sync"]) {
          // A feature with a problem names it too ("Managed config: 1 needs attention").
          const link = card.getByRole("link", { name: label, exact: true });
          expect(await link.isVisible()).toBe(true);
          expect(await link.getAttribute("title")).toBe(label);
        }
        expect(await card.locator("[data-feature-pips]").isVisible()).toBe(
          false,
        );
        // No facts, rows or footer on the card.
        expect(await card.locator("[data-service-row]").count()).toBe(0);
        expect(await card.textContent()).not.toMatch(/Synced|Changed|active/);
        expect(await axeWithin(page, CARDS)).toEqual([]);
      } finally {
        await closeContext(desk.page.context());
      }

      const phone = await open(HOME, theme, { width: 390, height: 844 });
      try {
        const page = phone.page;
        const card = page.locator(`${CARDS} article[aria-label="DJDL"]`);
        const pips = card.getByRole("img", {
          name: "Licensing, Managed config: 1 needs attention, Ship builds, Sign-in, Cloud Sync, Commerce",
        });
        expect(await pips.isVisible()).toBe(true);
        // The glyph row steps aside; the logo, the slug with its pips beside it, and the small
        // pill at the right edge stay (products.home, phone).
        expect(
          await card.locator("[data-feature-icons]").first().isVisible(),
        ).toBe(false);
        // The card draws two logos (40 px, hidden on a phone; 32 px, phone only): the visible one.
        for (const sel of [
          "[data-logo]:visible",
          "[data-card-header] [data-status]",
        ])
          expect(await card.locator(sel).first().isVisible(), sel).toBe(true);
        expect(await card.getByText("djdl", { exact: true }).isVisible()).toBe(
          true,
        );
        expect(await card.getByRole("link", { name: "DJDL" }).isVisible()).toBe(
          true,
        );
        // Each pip is its service's accent, as the brand tokens define it for that section.
        const colours = await card.locator("[data-pip]").evaluateAll((els) =>
          els.map((el) => {
            const probe = document.createElement("span");
            probe.setAttribute(
              "data-service",
              el.getAttribute("data-service")!,
            );
            probe.style.color = "var(--pk-accent)";
            document.body.append(probe);
            const want = getComputedStyle(probe).color;
            probe.remove();
            return {
              service: el.getAttribute("data-service"),
              got: getComputedStyle(el).backgroundColor,
              want,
            };
          }),
        );
        // One pip per feature, in canonical order, each in its feature's accent.
        expect(colours.map((c) => c.service)).toEqual([
          "license",
          "config",
          "release",
          "identity",
          "sync",
          "commerce",
          "connect",
        ]);
        for (const c of colours) expect(c.got, c.service!).toBe(c.want);
        expect(new Set(colours.map((c) => c.got)).size).toBe(colours.length);
        expect(await axeWithin(page, CARDS)).toEqual([]);
      } finally {
        await closeContext(phone.page.context());
      }
    });
  }
});

// ── `?setting=` deep links land on their row (UX review M6) ───────────────────────────────────

describe("?setting= deep links", () => {
  const LINKS: [string, string, string][] = [
    [
      "a product row",
      "#/p/djdl/settings?setting=license.defaults.deviceLimit",
      "setting-license.defaults.deviceLimit",
    ],
    [
      "a Polaris Locker switch",
      "#/p/djdl/settings/portal?setting=identity.keyEntry.claimByKey",
      "setting-identity.keyEntry.claimByKey",
    ],
    [
      "a platform setting row",
      "#/platform/settings?setting=LAZY_DELTAS",
      "platform-setting-LAZY_DELTAS",
    ],
    [
      "the extra reserved display terms list",
      "#/platform/settings?setting=identity.reservedDisplayTerms",
      "platform-setting-identity.reservedDisplayTerms",
    ],
    [
      "the display name approval",
      "#/p/djdl/identity/app-sign-in?setting=identity.displayNameApproved",
      "setting-identity.displayNameApproved",
    ],
  ];
  for (const [what, hash, id] of LINKS) {
    it(`${what} takes the focus and scrolls into view`, async () => {
      const { page } = await open({ name: `link:${id}`, hash }, "dark", {
        width: 1440,
        height: 900,
      });
      try {
        await page.waitForFunction(
          (rowId) =>
            document.getElementById(rowId)?.contains(document.activeElement),
          id,
          { timeout: 1500 },
        );
        const box = await page.evaluate((rowId) => {
          const r = document.getElementById(rowId)!.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, h: innerHeight };
        }, id);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.bottom).toBeLessThanOrEqual(box.h);
      } finally {
        await closeContext(page.context());
      }
    });
  }
});

// ── A dialog's own <form> wraps the body and footer (B-018) ───────────────────────────────────

describe("a dialog whose form wraps its body and footer", () => {
  it("keeps the footer inside a short window; the body scrolls instead", async () => {
    const { page } = await open(
      { name: "dialog:issue-ci-token", hash: "#/p/djdl/settings/keys" },
      "dark",
      { width: 1024, height: 360 },
    );
    try {
      await page.getByRole("button", { name: "Issue token…" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Issue a CI token" });
      await dialog.waitFor();
      const box = await dialog.evaluate((el) => {
        const submit = el.querySelector<HTMLElement>("button[type=submit]")!;
        const r = submit.getBoundingClientRect();
        return { bottom: r.bottom, top: r.top, h: innerHeight };
      });
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.h);
    } finally {
      await closeContext(page.context());
    }
  });
});

// ── A typed confirmation with a reason, in a short window (CX-BUGS-2) ────────────────────────
// The L3 "Relax the device trust policy?" dialog asks for a reason and a typed word. At 844×390
// (a phone on its side) and 667×375 both fields are in view without a scroll, the footer pinned
// under them, and neither is a target under 24 px. `PK_CX_SHOTS=<dir>` writes each render.

describe("a typed confirmation with a reason in a short window", () => {
  for (const vp of [
    { width: 844, height: 390 },
    { width: 667, height: 375 },
  ])
    for (const theme of THEMES)
      it(`${vp.width}×${vp.height} · ${theme}: the reason and the typed field are both in view`, async () => {
        const { page } = await open(
          { name: "dialog:relax-trust", hash: "#/p/djdl/settings/keys" },
          theme,
          vp,
        );
        try {
          await page
            .locator("#keys-trust")
            .getByRole("button", { name: "Edit device trust" })
            .click();
          const drawer = page.getByRole("dialog", {
            name: "Device trust policy",
          });
          await drawer.waitFor();
          await drawer
            .getByRole("combobox", { name: "Device license and config" })
            .click();
          await page.getByRole("option", { name: "Any device" }).click();
          await drawer.getByRole("button", { name: "Review changes…" }).click();
          const dialog = page.getByRole("alertdialog");
          await dialog.waitFor();
          await page.waitForTimeout(500);
          const m = await dialog.evaluate((el) => {
            const box = (e: Element | null) => {
              const r = e!.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom, h: r.height };
            };
            return {
              reason: box(el.querySelector("textarea")),
              typed: box(el.querySelector("input")),
              footer: box(el.querySelector("button")!.parentElement),
              header: box(el.querySelector("[data-pk-overlay-header]")),
              body: el.querySelector<HTMLElement>("[data-pk-dialog-body]")!
                .scrollTop,
              vh: innerHeight,
            };
          });
          if (process.env.PK_CX_SHOTS) {
            mkdirSync(process.env.PK_CX_SHOTS, { recursive: true });
            await page.screenshot({
              path: `${process.env.PK_CX_SHOTS}/typed-${vp.width}x${vp.height}-${theme}.png`,
            });
          }
          for (const f of [m.reason, m.typed]) {
            expect(f.top, "below the header").toBeGreaterThanOrEqual(
              m.header.bottom,
            );
            expect(f.bottom, "above the pinned footer").toBeLessThanOrEqual(
              m.footer.top,
            );
          }
          expect(m.typed.h, "the typed field's height").toBeGreaterThanOrEqual(
            24,
          );
          expect(m.footer.bottom, "footer on screen").toBeLessThanOrEqual(m.vh);
          expect(m.body, "the body has not been scrolled").toBe(0);
        } finally {
          await closeContext(page.context());
        }
      });
});

// ── A keyboard-focused primary or danger button shows a ring (CF1 / B1) ──────────────────────
// ST-48's unlayered `box-shadow: none` on the primary variant once removed the ring from every
// main action. A focus ring is an outline or a box-shadow; "none" for both fails WCAG 2.4.7.

describe("focus ring on primary and danger buttons", () => {
  const targets = [
    {
      hash: "#/p/djdl/license/licenses",
      name: "New license",
      variant: "primary",
    },
    {
      hash: "#/p/djdl/distribution/rollouts",
      name: "Start rollout…",
      variant: "primary",
    },
    {
      hash: "#/p/djdl/settings",
      name: "Delete product…",
      variant: "danger",
    },
  ] as const;
  for (const theme of THEMES) {
    for (const t of targets) {
      it(`${t.name} · ${theme}`, async () => {
        const { page } = await open(
          { name: `focus:${t.name}`, hash: t.hash },
          theme,
          { width: 1440, height: 900 },
        );
        try {
          const button = page.getByRole("button", { name: t.name }).first();
          await button.waitFor();
          // A key press first, so the next focus() is a keyboard focus (`:focus-visible`).
          await page.keyboard.press("Shift");
          await button.focus();
          const ring = await button.evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
              visible: el.matches(":focus-visible"),
              variant: el.getAttribute("data-variant"),
              shadow: cs.boxShadow,
              outline:
                cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0,
            };
          });
          expect(ring.visible, "keyboard focus").toBe(true);
          expect(ring.variant).toBe(t.variant);
          expect(
            ring.shadow !== "none" || ring.outline,
            `ring: ${JSON.stringify(ring)}`,
          ).toBe(true);
        } finally {
          await closeContext(page.context());
        }
      });
    }
  }
});

// ── Overlays pass axe: the account menu and a tooltip (CX-FU-1) ───────────────────────────────
describe("the account menu and a tooltip pass axe at 1440 and 390", () => {
  const HOME: Case = { name: "global:home", hash: "#/" };
  for (const theme of THEMES) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      for (const what of ["menu", "tooltip"] as const) {
        it(`${what}, ${theme} at ${width}`, async () => {
          const { page } = await open(HOME, theme, { width, height });
          try {
            if (what === "menu") {
              await page.getByRole("button", { name: "Account menu" }).click();
              await page.getByRole("menu").waitFor();
            } else {
              // Keyboard focus opens a tooltip on the first control that has one.
              let found = false;
              for (let i = 0; i < 40 && !found; i++) {
                await page.keyboard.press("Tab");
                found = await page
                  .waitForSelector('[role="tooltip"]', { timeout: 400 })
                  .then(() => true)
                  .catch(() => false);
              }
              expect(found).toBe(true);
            }
            expect(await axeWithin(page, "html"), "axe").toEqual([]);
          } finally {
            await closeContext(page.context());
          }
        });
      }
    }
  }
});
