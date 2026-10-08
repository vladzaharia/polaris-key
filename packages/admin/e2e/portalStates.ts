import type { Page } from "playwright";
import { h1, type Override } from "./portalHarness.js";
import {
  PROFILE_STEAM,
  identityOn,
  profileRoutes,
  samRoutes,
  type PortalScenario,
} from "./portalFixtures.js";

/**
 * Every state of PORTAL.md §4, the customer site's screens (PX-20, the quality bar).
 *
 * `SHIPPED` are the states the portal renders today: `portalQuality.e2e.test.ts` opens each one in
 * both themes at 1440 and 390 px and checks it under the Worker's CSP (zero violations), with axe
 * (zero violations), exactly one `h1`, no horizontal scroll at 360 px, and its visual baseline.
 *
 * `PENDING` are the states whose work package has not landed. Each names the §4 section and the
 * owning package(s), and the suite lists it as a todo, so the gap is visible in every run rather
 * than silently missing. **The suite grows with each PX front-end package:** the package that
 * builds a state moves it from `PENDING` to `SHIPPED` (with fixtures in `portalFixtures.ts` and its
 * linux baselines), and PX-20 is done when `PENDING` is empty.
 */

export interface ShippedState {
  /** The §4 section, e.g. `"4.13"`. */
  section: string;
  /** A stable kebab-case id; also the baseline file stem. */
  id: string;
  title: string;
  scenario: PortalScenario;
  path: string;
  routes?: Record<string, Override>;
  /** Drive the page into the state and wait until it shows. */
  ready: (page: Page) => Promise<void>;
}

export interface PendingState {
  section: string;
  title: string;
  /** The work package(s) that build it (docs/design/PORTAL.md §11). */
  wp: string[];
}

const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
const NO_METHODS = {
  body: {
    auth: { oidc: false, magic: false },
    modules: { licensing: true, claim: true, releases: true },
  },
};
const WITH_PROVIDERS = {
  body: {
    auth: {
      oidc: false,
      magic: true,
      providers: ["apple", "google", "steam"],
    },
    modules: { licensing: true, claim: true, releases: true },
  },
};
const NIGHTFALL_CONTEXT = {
  body: {
    auth: { oidc: false, magic: true, providers: ["google", "steam"] },
    product: {
      slug: "nightfall",
      name: "Nightfall",
      developerName: "Lanternworks",
    },
    modules: { licensing: true, claim: true, releases: true },
  },
};
const SERVER_ERROR = { status: 500, body: { error: "internal" } };
const MOSSGARDEN = {
  slug: "mossgarden",
  name: "Mossgarden",
  developerName: "Little Fern",
  iconUrl: null,
  headerUrl: null,
};
/** `POST /api/activate/preview` answering with one §4.19 refusal (PX-17). */
const previewSays = (answer: Record<string, unknown>) => ({
  "POST /api/activate/preview": {
    body: { product: MOSSGARDEN, entries: null, ...answer },
  },
});

async function typeEmail(page: Page, email: string): Promise<void> {
  await h1(page, /Sign in/);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function openActivate(page: Page): Promise<void> {
  await h1(page, "Your library");
  // The header action on desktop, the bar's middle pill on a phone: the same name.
  await page
    .getByRole("button", { name: /Activate( a)? license|^Activate$/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Activate a license" });
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "License key" }).fill(KEY);
  await dialog.getByText("Key format is valid").waitFor();
}

async function toConfirm(page: Page): Promise<void> {
  await openActivate(page);
  await page
    .getByRole("dialog", { name: "Activate a license" })
    .getByRole("button", { name: "Continue" })
    .click();
  await page
    .getByRole("dialog", { name: "Add Mossgarden to your account?" })
    .getByText("Lifetime · up to 5 devices")
    .waitFor();
}

/** The License card's **License source** fact, once it reads `text` (owner, 2026-10-06). */
export function licenseSourceIs(page: Page, text: string) {
  return page
    .locator('dt:text-is("License source") + dd')
    .filter({
      hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    })
    .first()
    .waitFor();
}

/** PX-23: the preview of a floating key that is already on two devices, with Cloud Sync. */
export const FLOATING_ON_TWO = {
  "POST /api/activate/preview": {
    body: {
      verdict: "addable",
      product: MOSSGARDEN,
      entries: null,
      license: {
        tier: "standard",
        tierLabel: "Standard",
        status: "active",
        usable: true,
        expiresAt: null,
        deviceLimit: 5,
      },
      platforms: ["macos", "windows", "linux"],
      devices: 2,
      cloudSync: true,
    },
  },
};

/** The modal from `#/?activate=<KEY>`: press Continue, wait for `copy` (a §4.19 verdict). */
async function continueTo(page: Page, copy: RegExp): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Activate a license" });
  await dialog.getByText("Key format is valid").waitFor();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByText(copy).waitFor();
}

/**
 * The product page's section nav marks the section on screen through an IntersectionObserver,
 * which can lag a deep-link scroll or a layout change (more so under CI's emulation). Wait until
 * the marked section and the scroll position have held for 750 ms so the shot is deterministic.
 */
async function sectionNavSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __navKey?: string; __navAt?: number };
      const key = `${[
        ...document.querySelectorAll('a[aria-current="location"]'),
      ]
        .map((a) => a.textContent)
        .join("|")}@${window.scrollY}`;
      const now = performance.now();
      if (w.__navKey !== key) {
        w.__navKey = key;
        w.__navAt = now;
        return false;
      }
      return now - (w.__navAt ?? now) >= 750;
    },
    null,
    { polling: 100 },
  );
}

export const SHIPPED: ShippedState[] = [
  // §4.1 The login card (PX-05).
  {
    section: "4.1",
    id: "signin",
    title: "Login card, email first",
    scenario: "signedOut",
    path: "/",
    ready: (p) => h1(p, "Sign in to Polaris Key"),
  },
  {
    section: "4.1",
    id: "signin-providers",
    title: "Login card with the provider row (Apple, Google, Steam)",
    scenario: "signedOut",
    path: "/",
    routes: { "/api/capabilities": WITH_PROVIDERS },
    ready: async (p) => {
      await h1(p, "Sign in to Polaris Key");
      await p.getByRole("link", { name: "Continue with Steam" }).waitFor();
    },
  },
  {
    section: "4.1",
    id: "signin-invalid",
    title: "Login card, email invalid",
    scenario: "signedOut",
    path: "/",
    ready: async (p) => {
      await typeEmail(p, "mara");
      await p.getByText("Enter a full email address").first().waitFor();
    },
  },
  {
    section: "4.1",
    id: "signin-rate-limited",
    title: "Login card, rate-limited",
    scenario: "signedOut",
    path: "/",
    routes: {
      "POST /api/signin/email/start": {
        status: 429,
        body: { error: "rate_limited" },
      },
    },
    ready: async (p) => {
      await typeEmail(p, "mara@fennick.studio");
      await p.getByText("Too many codes").first().waitFor();
    },
  },
  {
    section: "4.1",
    id: "signin-sent",
    title: "Login card, the code and link sent (six-cell code)",
    scenario: "signedOut",
    path: "/",
    ready: async (p) => {
      await typeEmail(p, "mara@fennick.studio");
      await h1(p, "Check your email");
      await p.getByRole("textbox", { name: "6-digit code" }).waitFor();
    },
  },
  {
    section: "4.1",
    id: "signin-key",
    title: "Login card, Have a license key? (the on-ramp)",
    scenario: "signedOut",
    path: "/",
    ready: async (p) => {
      await h1(p, "Sign in to Polaris Key");
      await p.getByRole("button", { name: "Have a license key?" }).click();
      await h1(p, "Have a license key?");
    },
  },
  {
    section: "4.1",
    id: "signin-off",
    title: "Login card, no method enabled",
    scenario: "signedOut",
    path: "/",
    routes: { "/api/capabilities": NO_METHODS },
    ready: (p) => h1(p, "Sign-in is turned off"),
  },
  {
    section: "4.1",
    id: "signin-unreachable",
    title: "Login card, network error",
    scenario: "signedOut",
    path: "/",
    routes: { "/api/capabilities": "abort" },
    ready: (p) => h1(p, "Can't reach Polaris Key"),
  },
  // §4.2 Product context (PX-05).
  {
    section: "4.2",
    id: "signin-context",
    title: "Login card with product context",
    scenario: "signedOut",
    path: "/?product=nightfall",
    routes: { "/api/capabilities": NIGHTFALL_CONTEXT },
    ready: async (p) => {
      await p.getByRole("heading", { level: 1 }).first().waitFor();
      await p.getByText("Nightfall", { exact: false }).first().waitFor();
    },
  },
  // §4.12–4.15 Library (PX-02, PX-03, PX-08).
  {
    section: "4.12",
    id: "library-empty",
    title: "Library, empty, with the Discover teaser",
    scenario: "empty",
    path: "/",
    ready: async (p) => {
      await h1(p, "Your library");
      await p.getByRole("region", { name: /Ready to add/ }).waitFor();
    },
  },
  {
    section: "4.13",
    id: "library-1",
    title: "Library, one product (hero)",
    scenario: "one",
    path: "/",
    ready: (p) => h1(p, "Your library"),
  },
  {
    section: "4.14",
    id: "library-3",
    title: "Library, three products",
    scenario: "three",
    path: "/",
    ready: (p) => h1(p, "Your library"),
  },
  {
    section: "4.15",
    id: "library-12",
    title: "Library, twelve products (desktop grid, phone list)",
    scenario: "twelve",
    path: "/",
    ready: (p) => h1(p, "Your library"),
  },
  {
    section: "4.15",
    id: "library-12-list",
    title: "Library, twelve products, list",
    scenario: "twelve",
    path: "/#/?view=list",
    ready: (p) => h1(p, "Your library"),
  },
  {
    section: "4.15",
    id: "library-12-search",
    title: "Library, twelve products, searched",
    scenario: "twelve",
    path: "/#/?q=orbit",
    ready: async (p) => {
      await h1(p, "Your library");
      await p.getByText("Showing 1 of 12 ·").waitFor();
    },
  },
  {
    section: "4.15",
    id: "library-sign-in",
    title: "Library with key and sign-in licences, list",
    scenario: "signIn",
    path: "/#/?view=list",
    ready: (p) => h1(p, "Your library"),
  },
  // §4.16 Discover (PX-16).
  {
    section: "4.16",
    id: "discover",
    title: "Discover, offers",
    scenario: "three",
    path: "/#/discover",
    ready: async (p) => {
      await h1(p, "Discover");
      await p.getByRole("article", { name: "Pixel Forge SDK" }).waitFor();
    },
  },
  {
    section: "4.16",
    id: "discover-added",
    title: "Discover, just added",
    scenario: "three",
    path: "/#/discover",
    ready: async (p) => {
      await h1(p, "Discover");
      await p
        .getByRole("button", { name: "Add to library: Mossgarden" })
        .click();
      await p.getByRole("link", { name: "Open Mossgarden" }).waitFor();
      // The toast is part of the state: wait for it, so the screenshot never races it.
      await p.getByText("Mossgarden is in your library").waitFor();
    },
  },
  {
    section: "4.16",
    id: "discover-empty",
    title: "Discover, nothing to add",
    scenario: "twelve",
    path: "/#/discover",
    ready: async (p) => {
      await h1(p, "Discover");
      await p
        .getByRole("heading", { level: 2, name: "Nothing to add right now" })
        .waitFor();
    },
  },
  // §4.16 Discover as the Polaris Key storefront (PS-05, notes/S-21 §6.5): multi-path, open and
  // link-only tiles, the storefront product page and its one not-found state.
  {
    section: "4.16",
    id: "discover-storefront",
    title: "Discover, every way to add, open and link-only tiles",
    scenario: "storefront",
    path: "/#/discover",
    ready: async (p) => {
      await h1(p, "Discover");
      await p.getByRole("article", { name: "Starfall Arena" }).waitFor();
    },
  },
  {
    section: "4.16",
    id: "storefront-page",
    title: "Storefront product page, two ways to add",
    scenario: "storefront",
    path: "/#/discover/lumen-raw",
    ready: async (p) => {
      await h1(p, "Lumen RAW");
      await p.getByRole("region", { name: "Ways to add it" }).waitFor();
    },
  },
  {
    section: "4.16",
    id: "storefront-open",
    title: "Storefront product page, an open product",
    scenario: "storefront",
    path: "/#/discover/driftwood",
    ready: async (p) => {
      await h1(p, "Driftwood Notes");
      await p.getByRole("region", { name: "Why you can add it" }).waitFor();
    },
  },
  {
    section: "4.16",
    id: "storefront-link",
    title: "Storefront product page, link only",
    scenario: "storefront",
    path: "/#/discover/starfall",
    ready: async (p) => {
      await h1(p, "Starfall Arena");
      await p
        .getByRole("link", { name: /Get it on Steam/ })
        .first()
        .waitFor();
    },
  },
  {
    section: "4.16",
    id: "storefront-not-found",
    title: "Storefront product page, nothing to add here",
    scenario: "storefront",
    path: "/#/discover/not-a-product",
    ready: (p) => h1(p, "There's nothing to add here"),
  },
  {
    section: "4.14",
    id: "library-entry",
    title: "Library with an open product (Free to use)",
    scenario: "storefront",
    path: "/",
    ready: async (p) => {
      await h1(p, "Your library");
      await p.getByRole("article", { name: "Kestrel Maps" }).waitFor();
    },
  },
  {
    section: "4.14",
    id: "library-entry-remove",
    title: "Library, Remove from library confirmed inline",
    scenario: "storefront",
    path: "/",
    ready: async (p) => {
      await h1(p, "Your library");
      await p.getByRole("button", { name: "More for Kestrel Maps" }).click();
      await p.getByRole("menuitem", { name: "Remove from library" }).click();
      await p
        .getByRole("group", { name: "Remove Kestrel Maps from your library?" })
        .waitFor();
      await p.getByRole("menu").waitFor({ state: "detached" });
      // Checked from the top, like every state: focus on Keep it scrolls the page, and a tile's
      // name link under the sticky header reads to axe as an obscured target. Focus can land on
      // Keep it a task after the menu has gone (the menu hands focus back first), so wait for it
      // before scrolling: otherwise its scroll can come after ours and the sticky header and tab
      // bar are captured mid-page.
      await p.waitForFunction(() =>
        document.activeElement?.textContent?.includes("Keep it"),
      );
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForFunction(() => window.scrollY === 0);
    },
  },
  {
    section: "4.20",
    id: "product-entry",
    title: "Product page of an open product (no license)",
    scenario: "storefront",
    path: "/#/p/kestrel-maps",
    ready: async (p) => {
      await h1(p, "Kestrel Maps");
      await p.getByRole("region", { name: "Get Kestrel Maps" }).waitFor();
    },
  },
  // §4.17–4.19 Activate license (PX-06, PX-W5's preview).
  {
    section: "4.17",
    id: "activate-enter",
    title: "Activate license: enter key",
    scenario: "three",
    path: "/",
    ready: openActivate,
  },
  {
    section: "4.17",
    id: "activate-confirm",
    title: "Activate license: confirm",
    scenario: "three",
    path: "/",
    ready: toConfirm,
  },
  {
    section: "4.17",
    id: "activate-done",
    title: "Activate license: done",
    scenario: "three",
    path: "/",
    ready: async (p) => {
      await toConfirm(p);
      await p
        .getByRole("dialog", { name: "Add Mossgarden to your account?" })
        .getByRole("button", { name: "Add Mossgarden" })
        .click();
      await p
        .getByRole("dialog", { name: "Mossgarden is in your library" })
        .waitFor();
    },
  },
  {
    // PX-23 (S-24 §10, frame 80): a floating key already on two devices.
    section: "4.17",
    id: "activate-confirm-devices",
    title: "Activate license: confirm, a floating key with its devices",
    scenario: "three",
    path: "/",
    routes: FLOATING_ON_TWO,
    ready: async (p) => {
      await toConfirm(p);
      await p.getByText("It's on 2 devices already.").waitFor();
    },
  },
  {
    section: "4.17",
    id: "activate-done-devices",
    title: "Activate license: done, its devices came with it",
    scenario: "three",
    path: "/",
    routes: FLOATING_ON_TWO,
    ready: async (p) => {
      await toConfirm(p);
      await p
        .getByRole("dialog", { name: "Add Mossgarden to your account?" })
        .getByRole("button", { name: "Add Mossgarden" })
        .click();
      await p
        .getByRole("dialog", { name: "Mossgarden is in your library" })
        .getByText("Its 2 devices came with it.")
        .waitFor();
    },
  },
  {
    section: "4.18",
    id: "activate-link",
    title: "Activate license: deep link, key prefilled",
    scenario: "three",
    path: `/activate#key=${KEY}`,
    ready: async (p) => {
      const dialog = p.getByRole("dialog", { name: "Activate a license" });
      await dialog.getByText("Filled in from your link").waitFor();
    },
  },
  {
    section: "4.19",
    id: "activate-error-steam",
    title: "Activate license: not a license key (Steam shape)",
    scenario: "three",
    path: "/#/?activate=5XKQ7-B2M9P-HT4LZ",
    ready: (p) =>
      p
        .getByRole("dialog", { name: "Activate a license" })
        .getByText(/looks like a Steam key/)
        .waitFor(),
  },
  {
    section: "4.19",
    id: "activate-error-short",
    title: "Activate license: incomplete key",
    scenario: "three",
    path: "/#/?activate=pkey_mossgarden_Q7xZr2Lk9vT3mN8",
    ready: (p) =>
      p
        .getByRole("dialog", { name: "Activate a license" })
        .getByText(/cut short/)
        .waitFor(),
  },
  {
    section: "4.19",
    id: "activate-error-unknown",
    title: "Activate license: unknown key",
    scenario: "three",
    path: "/#/?activate=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4z",
    ready: async (p) => {
      const dialog = p.getByRole("dialog", { name: "Activate a license" });
      await dialog.getByText("Key format is valid").waitFor();
      await dialog.getByRole("button", { name: "Continue" }).click();
      await dialog.getByText(/We couldn't find that key/).waitFor();
    },
  },
  {
    section: "4.19",
    id: "activate-error-already-yours",
    title: "Activate license: already yours",
    scenario: "twelve",
    path: `/#/?activate=${KEY}`,
    ready: async (p) => {
      const dialog = p.getByRole("dialog", {
        name: /Activate a license|Mossgarden/,
      });
      await dialog.getByRole("button", { name: "Continue" }).click();
      await p
        .getByText(/already in your library/)
        .first()
        .waitFor();
    },
  },
  // §4.18 and §4.19 from PX-17: the app's link, and the preview's refusals.
  {
    section: "4.18",
    id: "activate-link-app",
    title: "Activate license: deep link from an app (product= notice)",
    scenario: "three",
    path: `/activate?product=mossgarden#key=${KEY}`,
    ready: (p) =>
      p
        .getByRole("dialog", { name: "Activate a license" })
        .getByText(/Mossgarden sent you here/)
        .waitFor(),
  },
  {
    section: "4.19",
    id: "activate-error-owned",
    title: "Activate license: owned by another account",
    scenario: "three",
    path: `/#/?activate=${KEY}`,
    routes: previewSays({ verdict: "license_owned" }),
    ready: (p) => continueTo(p, /already in another Polaris Key account/),
  },
  {
    section: "4.19",
    id: "activate-error-email",
    title: "Activate license: verified-email mismatch",
    scenario: "three",
    path: `/#/?activate=${KEY}`,
    routes: previewSays({
      verdict: "email_mismatch",
      maskedEmail: "m•••@proton.me",
    }),
    ready: (p) => continueTo(p, /was bought with m•••@proton\.me/),
  },
  {
    section: "4.19",
    id: "activate-error-portal-off",
    title: "Activate license: product portal off",
    scenario: "three",
    path: `/#/?activate=${KEY}`,
    routes: previewSays({ verdict: "portal_off" }),
    ready: (p) => continueTo(p, /manages this license elsewhere/),
  },
  {
    section: "4.19",
    id: "activate-entries",
    title: "Activate license: no key entries left (a warning on confirm)",
    scenario: "three",
    path: `/#/?activate=${KEY}`,
    routes: previewSays({
      verdict: "addable",
      entries: { used: 5, limit: 5 },
      license: {
        tier: "standard",
        tierLabel: "Standard",
        status: "active",
        usable: true,
        expiresAt: null,
        deviceLimit: 5,
      },
      platforms: ["macos", "windows", "linux"],
    }),
    ready: async (p) => {
      const dialog = p.getByRole("dialog", { name: "Activate a license" });
      await dialog.getByText("Key format is valid").waitFor();
      await dialog.getByRole("button", { name: "Continue" }).click();
      await p
        .getByRole("dialog", { name: "Add Mossgarden to your account?" })
        .getByText(/no entries left in Mossgarden/)
        .waitFor();
    },
  },
  // §4.20 Product page (PX-04, PX-08, PX-11).
  {
    section: "4.20",
    id: "product",
    title: "Product page without Cloud Sync (Nightfall)",
    scenario: "three",
    path: "/#/p/nightfall",
    ready: (p) => h1(p, "Nightfall"),
  },
  {
    // No art at all: the letter tile alone beside the name, no banner.
    section: "4.20",
    id: "product-no-cover",
    title: "Product page without cover art (Hollow Pines)",
    scenario: "twelve",
    path: "/#/p/hollow-pines",
    ready: (p) => h1(p, "Hollow Pines"),
  },
  {
    // Cover art and no icon: the letter tile in front of the cover.
    section: "4.20",
    id: "product-no-icon",
    title: "Product page with a cover and no icon (Glyphsmith)",
    scenario: "twelve",
    path: "/#/p/glyphsmith",
    ready: (p) => h1(p, "Glyphsmith"),
  },
  {
    section: "4.20",
    id: "product-package",
    title: "Product page with Package access (Tidewater Studio)",
    scenario: "three",
    path: "/#/p/tidewater/package",
    ready: async (p) => {
      await h1(p, "Tidewater Studio");
      await p.getByRole("heading", { name: /Package access/ }).waitFor();
    },
  },
  {
    section: "4.20",
    id: "product-expired",
    title: "Product page, license expired",
    scenario: "three",
    path: "/#/p/ember-tactics",
    ready: (p) => h1(p, "Ember Tactics"),
  },
  {
    section: "4.20",
    id: "product-account-bound",
    title: "Product page, account-bound product (Quill)",
    scenario: "twelve",
    path: "/#/p/quill",
    ready: (p) => h1(p, "Quill"),
  },
  {
    // A sign-in licence: the Standard pill with "1 of 5 devices", "From signing in", its devices.
    section: "4.20",
    id: "product-sign-in",
    title: "Product page, sign-in licence with its devices (Quill)",
    scenario: "signIn",
    path: "/#/p/quill",
    ready: async (p) => {
      await h1(p, "Quill");
      await p.getByText("1 of 5 devices").first().waitFor();
      await licenseSourceIs(p, "From signing in");
      await p.getByText("Living room PC").first().waitFor();
    },
  },
  {
    // Held by a Steam key and by signing in: the key licence drops its counter, keeps its devices.
    section: "4.20",
    id: "product-both-key",
    title:
      "Product page, Steam key and sign-in licences, key selected (Drift Kart)",
    scenario: "signIn",
    path: "/#/p/drift-kart",
    ready: async (p) => {
      await h1(p, "Drift Kart");
      await p.getByText("Activated").first().waitFor();
      await p
        .getByRole("button", { name: /^Remove / })
        .first()
        .waitFor();
    },
  },
  {
    section: "4.20",
    id: "product-both-sign-in",
    title:
      "Product page, Steam key and sign-in licences, sign-in selected (Drift Kart)",
    scenario: "signIn",
    path: "/#/p/drift-kart?license=lic_drift-kart-acct",
    ready: async (p) => {
      await h1(p, "Drift Kart");
      await licenseSourceIs(p, "From signing in");
    },
  },
  {
    // PX-23 (S-24 D21, frame 81): a key Mara added to a licence nobody was named for.
    section: "4.20",
    id: "product-origin-key",
    title:
      "Product page, licence source: a key the person added (Tidewater Studio)",
    scenario: "origins",
    path: "/#/p/tidewater",
    ready: async (p) => {
      await h1(p, "Tidewater Studio");
      await licenseSourceIs(p, "Added with a key");
    },
  },
  {
    // A licence the developer assigned reads "From <Developer>", even though it has a key.
    section: "4.20",
    id: "product-origin-developer",
    title:
      "Product page, licence source: assigned by the developer (Tidewater Studio)",
    scenario: "origins",
    path: "/#/p/tidewater?license=lic_tidewater-free",
    ready: async (p) => {
      await h1(p, "Tidewater Studio");
      await licenseSourceIs(p, "From Harbor Audio");
    },
  },
  {
    // PX-23 (S-24 D19): Remove from my library, from the header's overflow menu.
    section: "4.20",
    id: "product-remove-license",
    title: "Product page, Remove from my library",
    scenario: "origins",
    path: "/#/p/tidewater?license=lic_tidewater-free",
    ready: async (p) => {
      await h1(p, "Tidewater Studio");
      await licenseSourceIs(p, "From Harbor Audio");
      await p
        .getByRole("button", { name: "More for Tidewater Studio" })
        .click();
      await p.getByRole("menuitem", { name: "Remove from my library" }).click();
      await p
        .getByRole("alertdialog", {
          name: "Remove this Tidewater Studio license from your library?",
        })
        .getByRole("button", { name: "Remove from my library" })
        .waitFor();
    },
  },
  {
    section: "4.20",
    id: "product-load-error",
    title: "Product page, load error",
    scenario: "three",
    path: "/#/p/nightfall",
    routes: { "/api/library": SERVER_ERROR, "/api/licenses": SERVER_ERROR },
    ready: (p) => h1(p, "Something went wrong"),
  },
  // §4.21 Package token created (PX-11).
  {
    section: "4.21",
    id: "product-token",
    title: "Package token created",
    scenario: "three",
    path: "/#/p/tidewater/package",
    ready: async (p) => {
      await h1(p, "Tidewater Studio");
      await p.getByRole("button", { name: "Create token" }).click();
      const form = p.getByRole("dialog", { name: "Create a token" });
      await form.getByLabel("Name").fill("Laptop 2");
      await form.getByRole("button", { name: "Create token" }).click();
      await p.getByRole("dialog", { name: "Copy your token now" }).waitFor();
    },
  },
  // §4.22 Remove a device, inline (PX-04).
  {
    section: "4.22",
    id: "product-remove-device",
    title: "Remove a device, inline confirmation",
    scenario: "three",
    path: "/#/p/nightfall/devices",
    ready: async (p) => {
      await h1(p, "Nightfall");
      await p.getByRole("button", { name: "Remove Studio PC" }).first().click();
      await p.getByRole("heading", { name: "Remove Studio PC?" }).waitFor();
      await sectionNavSettled(p);
    },
  },
  // §4.25 Focused flows (PX-10).
  {
    section: "4.25",
    id: "device-limit",
    title: "Device limit, focused flow",
    scenario: "twelve",
    path: "/#/p/orbit-survey/free-device?for=Mara%E2%80%99s%20Steam%20Deck&return=orbitsurvey%3A%2F%2Fretry",
    ready: (p) => h1(p, "Your license is on 2 of 2 devices"),
  },
  {
    section: "4.25",
    id: "device-limit-done",
    title: "Device limit, device removed",
    scenario: "twelve",
    path: "/#/p/orbit-survey/free-device?return=orbitsurvey%3A%2F%2Fretry",
    ready: async (p) => {
      await h1(p, "Your license is on 2 of 2 devices");
      await p.getByRole("button", { name: "Remove Work laptop" }).click();
      await h1(p, "Work laptop was removed");
    },
  },
  {
    section: "4.25",
    id: "download-flow",
    title: "Download, focused flow",
    scenario: "three",
    path: "/#/p/nightfall/download?platform=linux",
    ready: (p) => h1(p, "Download Nightfall for Linux"),
  },
  // §4.26 Account (PX-07; Sign-in methods and Where you're signed in, PX-13).
  {
    section: "4.26",
    id: "account",
    title: "Account: profile, sign-in methods, where you're signed in",
    scenario: "three",
    path: "/#/account",
    ready: async (p) => {
      await h1(p, "Account");
      await p.getByRole("heading", { name: "Accounts" }).waitFor();
      await p.getByText("This browser").waitFor();
    },
  },
  {
    section: "4.26",
    id: "account-disconnect",
    title: "Account: disconnect with step-up",
    scenario: "three",
    path: "/#/account/methods",
    ready: async (p) => {
      await h1(p, "Account");
      await p.getByRole("button", { name: "Disconnect Steam" }).click();
      await p.getByRole("group", { name: "Confirm it's you first" }).waitFor();
    },
  },
  {
    section: "4.26",
    id: "account-last-method",
    title: "Account: last-method guard and the Hide My Email notice (Sam)",
    scenario: "one",
    path: "/#/account",
    routes: samRoutes(),
    ready: async (p) => {
      await h1(p, "Account");
      await p.getByText("Only method").waitFor();
    },
  },
  {
    section: "4.26",
    id: "account-delete",
    title: "Account, delete with typed confirmation",
    scenario: "three",
    path: "/#/account/data",
    ready: async (p) => {
      await h1(p, "Account");
      await p.getByRole("button", { name: "Delete account" }).click();
      await p
        .getByRole("heading", { name: "Delete your Polaris Key account?" })
        .waitFor();
    },
  },
  // §4.30 Account → Profile (PX-22).
  {
    section: "4.30",
    id: "account-profile",
    title: "Account → Profile, a typed name and the Steam picture",
    scenario: "three",
    path: "/#/account",
    routes: profileRoutes(PROFILE_STEAM),
    ready: async (p) => {
      await h1(p, "Account");
      await p
        .getByText("Name typed by you · picture from Steam (marafox)")
        .waitFor();
    },
  },
  {
    section: "4.30",
    id: "account-profile-edit",
    title: "Account → Profile, editing (Google picked, Steam in use)",
    scenario: "three",
    path: "/#/account",
    routes: profileRoutes(PROFILE_STEAM),
    ready: async (p) => {
      await h1(p, "Account");
      await p.getByRole("button", { name: "Edit profile" }).click();
      await p.getByRole("textbox", { name: "Display name" }).waitFor();
      await p
        // The tile (its label) takes the click; the native radio inside is visually hidden.
        .locator('[data-tile="link:lnk_google"]')
        .click();
    },
  },
  // §4.20 The product sign-in card (PX-13): Nightfall with Identity on.
  {
    section: "4.20",
    id: "product-identity",
    title: "Product page: the sign-in card (Identity on)",
    scenario: "three",
    path: "/#/p/nightfall",
    routes: identityOn("three", "nightfall"),
    ready: async (p) => {
      await h1(p, "Nightfall");
      await p.getByRole("heading", { name: "Sign in to Nightfall" }).waitFor();
    },
  },
  // §4.27 Jump to a product (PX-03).
  {
    section: "4.27",
    id: "switcher",
    title: "Jump to a product (⌘K)",
    scenario: "twelve",
    path: "/",
    ready: async (p) => {
      await h1(p, "Your library");
      // ⌘K listens only once the library has loaded (8+ products), after the h1 shows.
      await p.getByText("Glyphsmith").first().waitFor();
      await p.keyboard.press("Control+k");
      await p.getByRole("dialog", { name: "Jump to a product" }).waitFor();
      await p.keyboard.type("glyph");
      await p
        .getByRole("option", { name: /Glyphsmith/ })
        .first()
        .waitFor();
    },
  },
  // §4.28 Not found and errors (PX-01, PX-04).
  {
    section: "4.28",
    id: "product-not-found",
    title: "Product not in your library",
    scenario: "three",
    path: "/#/p/unknown-thing",
    ready: (p) => h1(p, "That product isn't in your library"),
  },
  {
    section: "4.28",
    id: "boot-unreachable",
    title: "Can't reach Polaris Key",
    scenario: "three",
    path: "/",
    routes: { "/api/me": "abort" },
    ready: (p) => h1(p, "Can't reach Polaris Key"),
  },
  {
    section: "4.28",
    id: "boot-error",
    title: "Something went wrong",
    scenario: "three",
    path: "/",
    routes: { "/api/me": SERVER_ERROR },
    ready: (p) => h1(p, "Something went wrong"),
  },
  {
    section: "4.28",
    id: "library-error",
    title: "Library, load error",
    scenario: "three",
    path: "/",
    routes: { "/api/library": SERVER_ERROR, "/api/licenses": SERVER_ERROR },
    ready: async (p) => {
      await h1(p, "Your library");
      await p.getByRole("alert").getByText("Something went wrong").waitFor();
    },
  },
];

export const PENDING: PendingState[] = [
  {
    section: "4.1",
    title: "Login card: passkey button and conditional UI",
    wp: ["PX-12"],
  },
  {
    section: "4.3",
    title: 'Known account: "You usually sign in with Steam"',
    wp: ["PX-12"],
  },
  {
    section: "4.4",
    title: "Enter the code (wrong, expired, too many tries, resend)",
    wp: ["PX-12", "PX-W4"],
  },
  { section: "4.5", title: "Use a license key", wp: ["PX-12"] },
  {
    section: "4.6",
    title: "Key entry: account upgrade, skippable",
    wp: ["PX-12", "PX-W9"],
  },
  {
    section: "4.6",
    title: "Key entry: account upgrade, forced",
    wp: ["PX-12", "PX-W9"],
  },
  { section: "4.7", title: "App sign-in: web app card header", wp: ["PX-14"] },
  {
    section: "4.8",
    title:
      "App sign-in: native app (known account, code, create, confirm, return)",
    wp: ["PX-14"],
  },
  {
    section: "4.9",
    title: "App sign-in: device code (method choice, TV signed in)",
    wp: ["PX-14"],
  },
  {
    section: "4.10",
    title: "Add another way to sign in (nudge)",
    wp: ["PX-15"],
  },
  { section: "4.11", title: "Link an existing account: join", wp: ["PX-15"] },
  { section: "4.20", title: "Product page with Cloud Sync", wp: ["PX-18"] },
  {
    section: "4.20",
    title:
      "Product page: Get it complete (Change platform, Extras, phone actions, Email me the download)",
    wp: ["PX-09"],
  },
  {
    section: "4.20",
    title:
      'Product page: "<Product> knows you as" the method it uses (needs the product users on the portal API)',
    wp: ["PX-13 follow-up"],
  },
  {
    section: "4.23",
    title: "Sign in with another device: QR and code",
    wp: ["PX-15"],
  },
  { section: "4.24", title: "Approve a new device", wp: ["PX-15"] },
  {
    section: "4.26",
    title:
      "Account: connected products, Download my data, Make primary, passkey Rename (need their API)",
    wp: ["PX-13 follow-up"],
  },
  {
    section: "4.29",
    title:
      "Email gate: provider verified, typed code, Steam empty, product terms",
    wp: ["PX-21"],
  },
  {
    section: "4.29",
    title:
      "Email gate in an app: Hide My Email, TV with terms, real email instead",
    wp: ["PX-21"],
  },
];
