import type { Page } from "playwright";
import { h1, type Override } from "./portalHarness.js";
import type { PortalScenario } from "./portalFixtures.js";

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
      await p.getByRole("button", { name: "Continue with Steam" }).waitFor();
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
      "POST /api/magic/start": {
        status: 429,
        body: { error: "rate_limited" },
      },
    },
    ready: async (p) => {
      await typeEmail(p, "mara@fennick.studio");
      await p.getByText("Too many sign-in emails").first().waitFor();
    },
  },
  {
    section: "4.1",
    id: "signin-sent",
    title: "Login card, the email link sent",
    scenario: "signedOut",
    path: "/",
    ready: async (p) => {
      await typeEmail(p, "mara@fennick.studio");
      await h1(p, "Check your email");
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
    title: "Library, empty",
    scenario: "empty",
    path: "/",
    ready: (p) => h1(p, "Your library"),
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
  // §4.16 Discover (PX-02's empty state until PX-16).
  {
    section: "4.16",
    id: "discover-empty",
    title: "Discover, nothing to add",
    scenario: "three",
    path: "/#/discover",
    ready: (p) => h1(p, "Nothing to add right now"),
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
    section: "4.18",
    id: "activate-link",
    title: "Activate license: deep link, key prefilled",
    scenario: "three",
    path: `/activate?key=${KEY}`,
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
      const dialog = p.getByRole("dialog", { name: /Activate a license|Mossgarden/ });
      await dialog.getByRole("button", { name: "Continue" }).click();
      await p.getByText(/already in your library/).first().waitFor();
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
      await p
        .getByRole("button", { name: "Remove Work laptop and continue" })
        .click();
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
  // §4.26 Account (PX-07).
  {
    section: "4.26",
    id: "account",
    title: "Account v1",
    scenario: "three",
    path: "/#/account",
    ready: (p) => h1(p, "Account"),
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
  // §4.27 Jump to a product (PX-03).
  {
    section: "4.27",
    id: "switcher",
    title: "Jump to a product (⌘K)",
    scenario: "twelve",
    path: "/",
    ready: async (p) => {
      await h1(p, "Your library");
      await p.keyboard.press("Control+k");
      await p.getByRole("dialog", { name: "Jump to a product" }).waitFor();
      await p.keyboard.type("glyph");
      await p.getByRole("option", { name: /Glyphsmith/ }).first().waitFor();
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
  { section: "4.1", title: "Login card: passkey button and conditional UI", wp: ["PX-12"] },
  { section: "4.3", title: "Known account: \"You usually sign in with Steam\"", wp: ["PX-12"] },
  { section: "4.4", title: "Enter the code (wrong, expired, too many tries, resend)", wp: ["PX-12", "PX-W4"] },
  { section: "4.5", title: "Use a license key", wp: ["PX-12"] },
  { section: "4.6", title: "Key entry: account upgrade, skippable", wp: ["PX-12", "PX-W9"] },
  { section: "4.6", title: "Key entry: account upgrade, forced", wp: ["PX-12", "PX-W9"] },
  { section: "4.7", title: "App sign-in: web app card header", wp: ["PX-14"] },
  { section: "4.8", title: "App sign-in: native app (known account, code, create, confirm, return)", wp: ["PX-14"] },
  { section: "4.9", title: "App sign-in: device code (method choice, TV signed in)", wp: ["PX-14"] },
  { section: "4.10", title: "Add another way to sign in (nudge)", wp: ["PX-15"] },
  { section: "4.11", title: "Link an existing account: join", wp: ["PX-15"] },
  { section: "4.12", title: "Library, empty, with the Discover teaser", wp: ["PX-16"] },
  { section: "4.16", title: "Discover, offers", wp: ["PX-16"] },
  { section: "4.16", title: "Discover, just added", wp: ["PX-16"] },
  { section: "4.18", title: "Activate license: deep link from an app (product= notice)", wp: ["PX-17"] },
  { section: "4.19", title: "Activate license: owned elsewhere, email mismatch, no entries left, portal off", wp: ["PX-17"] },
  { section: "4.20", title: "Product page with Cloud Sync", wp: ["PX-18"] },
  { section: "4.20", title: "Product page: Get it complete (Change platform, Extras, phone actions, Email me the download)", wp: ["PX-09"] },
  { section: "4.20", title: "Product page: \"<Product> knows you as\" identity card", wp: ["PX-13"] },
  { section: "4.23", title: "Sign in with another device: QR and code", wp: ["PX-15"] },
  { section: "4.24", title: "Approve a new device", wp: ["PX-15"] },
  { section: "4.26", title: "Account: sign-in methods, sessions, connected products", wp: ["PX-13"] },
  { section: "4.26", title: "Account: disconnect with step-up", wp: ["PX-13"] },
  { section: "4.26", title: "Account: last-method guard", wp: ["PX-13"] },
  { section: "4.29", title: "Email gate: provider verified, typed code, Steam empty, product terms", wp: ["PX-21"] },
  { section: "4.29", title: "Email gate in an app: Hide My Email, TV with terms, real email instead", wp: ["PX-21"] },
  { section: "4.30", title: "Account → Profile, editing", wp: ["PX-22"] },
];
