import { h1, type Override } from "./portalHarness.js";
import { FIXTURE_NOW } from "./portalFixtures.js";
import type { ShippedState } from "./portalStates.js";

/**
 * The app card's states (PX-14a; SIGN-IN.md §3.1, §3.6 to §3.9): the request header on the
 * signed-out card, the licence choice, Replace a device, consent, and the key on-ramp's
 * AccountUpgrade. Fixtures are the Worker's answers (`SignInRequestView`, `LicenseChoiceView`,
 * `ReplaceView`, `AppConsentView`, `KeyPreview`).
 */
const HANDLE = "rq_AAAAAAAAAAAAAAAAAAAAAA";
const PATH = `/signin?request=${HANDLE}`;
const REQ = `/api/signin/requests/${HANDLE}`;
const KEY = `pkey_diceroll_${"A".repeat(22)}`;

const VIEW = {
  request: HANDLE,
  client: {
    product: "diceroll",
    kind: "native",
    appName: "Diceroll",
    developerName: "Example Games",
    iconUrl: null,
    origins: [],
    services: { license: true, cloudSync: true },
    nameVerified: true,
  },
  deviceLabel: "Mara's Pixel 8",
  userCode: null,
  expiresAt: 4_102_444_800,
  purpose: "signin",
  licenseChoice: "card",
  scope: ["openid"],
};
const DEVICE_VIEW = {
  ...VIEW,
  client: { ...VIEW.client, kind: "device" },
  deviceLabel: "Living room TV",
  userCode: "WDJB-MJHT",
};
const WEB_VIEW = {
  ...VIEW,
  client: {
    ...VIEW.client,
    kind: "web",
    origins: ["https://dice.example.com"],
  },
  deviceLabel: null,
};

const ROW = {
  id: "lic_std",
  tierName: "Standard",
  name: "Diceroll Standard",
  origin: "key",
  access: "seats",
  seats: { used: 1, limit: 3 },
  current: false,
  expiresAt: null,
  state: "free",
  replace: null,
  freeDeviceUrl: null,
};
const SIGNIN_ROW = {
  ...ROW,
  id: "lic_signin",
  tierName: "Free",
  name: null,
  origin: "signin",
  access: "account",
  seats: { used: 2, limit: 5 },
};
const FULL = {
  ...ROW,
  id: "lic_full",
  name: "Diceroll Family",
  tierName: "Family",
  origin: "free",
  seats: { used: 3, limit: 3 },
  state: "full",
  replace: { allowed: true, retryAfter: null },
};
const CHOICES = {
  state: "choose",
  choices: [ROW, SIGNIN_ROW],
  keep: false,
  preselected: "lic_std",
  create: null,
  getLicense: null,
};
const ALL_FULL = {
  ...CHOICES,
  choices: [
    FULL,
    {
      ...FULL,
      id: "lic_full2",
      name: "Diceroll Standard",
      tierName: "Standard",
    },
  ],
  preselected: null,
};
const NOW_S = FIXTURE_NOW;
const DEVICES = {
  licenseId: "lic_full",
  seats: { used: 3, limit: 3 },
  devices: [
    {
      id: "d1",
      label: "Work laptop",
      platform: "macOS",
      deviceType: "computer",
      lastSeen: NOW_S - 31 * 86_400,
      leastRecent: true,
      activeNow: false,
      thisBrowser: false,
    },
    {
      id: "d2",
      label: "Studio Mac mini",
      platform: "macOS",
      deviceType: "computer",
      lastSeen: NOW_S - 120,
      leastRecent: false,
      activeNow: true,
      thisBrowser: false,
    },
    {
      id: "d3",
      label: "Chrome on Windows",
      platform: "Windows",
      deviceType: "computer",
      lastSeen: NOW_S - 4 * 86_400,
      leastRecent: false,
      activeNow: false,
      thisBrowser: false,
    },
  ],
  replace: { allowed: true, retryAfter: null },
};
const CONSENT = {
  request: HANDLE,
  person: {
    displayName: "Mara Fennick",
    email: "mara@fennick.studio",
    avatarUrl: null,
  },
  items: [
    { kind: "cloudSync" },
    { kind: "profile", claims: ["name", "picture", "email"] },
  ],
  scopeHash: "x",
  firstTime: true,
  changed: false,
};
const CAPS = {
  body: {
    auth: { oidc: false, magic: true },
    modules: { licensing: true, claim: true, releases: true },
    product: {
      slug: "diceroll",
      name: "Diceroll",
      developerName: "Example Games",
    },
  },
};
const signedOutRoutes = (view: unknown): Record<string, Override> => ({
  "/api/capabilities": CAPS,
  [REQ]: { body: view },
});
const signedInRoutes = (
  choices: unknown,
  extra: Record<string, Override> = {},
): Record<string, Override> => ({
  [REQ]: { body: VIEW },
  [`${REQ}/licenses`]: { body: choices },
  [`${REQ}/consent`]: { body: CONSENT },
  [`${REQ}/licenses/lic_full/devices`]: { body: DEVICES },
  ...extra,
});

const preview = (over: Record<string, unknown>): Override => ({
  body: {
    product: {
      slug: "diceroll",
      name: "Diceroll",
      branding: null,
      developerName: "Example Games",
      iconUrl: null,
      headerUrl: null,
    },
    verdict: "addable",
    license: { tierName: "Standard", term: "perpetual" },
    keyEntries: { used: 3, limit: 5 },
    upgrade: "skippable",
    ...over,
  },
});

async function keyStep(
  p: import("playwright").Page,
  heading: string,
): Promise<void> {
  await h1(p, "Sign in");
  await p.getByRole("button", { name: "Have a license key?" }).click();
  await h1(p, "Have a license key?");
  await p.getByRole("textbox", { name: "License key" }).fill(KEY);
  await p.getByRole("button", { name: "Continue" }).click();
  await h1(p, heading);
}

export const REQUEST_STATES: ShippedState[] = [
  {
    section: "3.1",
    id: "app-signin",
    title: "App card, signed out: the request's header and footer (native)",
    scenario: "signedOut",
    path: PATH,
    routes: signedOutRoutes(VIEW),
    ready: async (p) => {
      await h1(p, "Sign in");
      await p.getByText("wants you to sign in", { exact: false }).waitFor();
    },
  },
  {
    section: "3.1",
    id: "app-signin-hint",
    title:
      "App card, signed out: the email prefilled from loginHint, purpose attach",
    scenario: "signedOut",
    path: PATH,
    routes: signedOutRoutes({
      ...VIEW,
      purpose: "attach",
      loginHint: "mara@fennick.studio",
    }),
    ready: async (p) => {
      await h1(p, "Sign in");
      await p.getByText("to your account", { exact: false }).waitFor();
      const v = await p.getByRole("textbox", { name: "Email" }).inputValue();
      if (v !== "mara@fennick.studio") throw new Error(`prefill: ${v}`);
    },
  },
  {
    section: "3.1",
    id: "app-signin-web",
    title: "App card, signed out, web app (origin)",
    scenario: "signedOut",
    path: PATH,
    routes: signedOutRoutes(WEB_VIEW),
    ready: async (p) => {
      await h1(p, "Sign in");
      await p.getByText("dice.example.com").waitFor();
    },
  },
  {
    section: "3.1",
    id: "app-signin-device",
    title: "App card, signed out, device code (code panel)",
    scenario: "signedOut",
    path: PATH,
    routes: signedOutRoutes(DEVICE_VIEW),
    ready: async (p) => {
      await h1(p, "Sign in");
      await p.getByText("WDJB-MJHT").waitFor();
    },
  },
  {
    section: "3.1",
    id: "app-signin-gone",
    title: "App card, the request has ended",
    scenario: "signedOut",
    path: PATH,
    routes: {
      "/api/capabilities": CAPS,
      [REQ]: { status: 404, body: { error: "not_found" } },
    },
    ready: (p) => h1(p, "This sign-in has ended"),
  },
  {
    section: "3.6",
    id: "app-choice",
    title: "LicenseChoiceStep, a sign-in licence beside a key licence",
    scenario: "empty",
    path: PATH,
    routes: signedInRoutes(CHOICES),
    ready: (p) => h1(p, "Choose a license for this device"),
  },
  {
    section: "3.6",
    id: "app-choice-full",
    title: "LicenseChoiceStep, every licence full",
    scenario: "empty",
    path: PATH,
    routes: signedInRoutes(ALL_FULL),
    ready: (p) => h1(p, "Choose a license for this device"),
  },
  {
    section: "3.7",
    id: "app-replace",
    title: "Replace a device, nothing preselected, the error under the group",
    scenario: "empty",
    path: PATH,
    routes: signedInRoutes(ALL_FULL),
    ready: async (p) => {
      await h1(p, "Choose a license for this device");
      await p.getByRole("radio", { name: /Diceroll Family/ }).click();
      await p.getByRole("button", { name: "Replace a device" }).click();
      await h1(p, "Replace a device");
      await p.getByRole("button", { name: "Replace and sign in" }).click();
      await p.getByText("Choose a device to replace.").waitFor();
    },
  },
  {
    section: "3.7",
    id: "app-replaced",
    title: "Replace a device, done: both devices named",
    scenario: "empty",
    path: PATH,
    routes: signedInRoutes(ALL_FULL, {
      [`POST ${REQ}/continue`]: {
        body: { redirect: "https://dice.example.com/cb?code=1" },
      },
    }),
    ready: async (p) => {
      await h1(p, "Choose a license for this device");
      await p.getByRole("radio", { name: /Diceroll Family/ }).click();
      await p.getByRole("button", { name: "Replace a device" }).click();
      await h1(p, "Replace a device");
      await p.getByRole("radio", { name: /Studio Mac mini/ }).click();
      await p.getByRole("button", { name: "Replace and sign in" }).click();
      await h1(p, "Continue to Diceroll as Mara?");
      await p.getByRole("button", { name: "Continue to Diceroll" }).click();
      await h1(p, "Device replaced");
    },
  },
  {
    section: "3.8",
    id: "app-consent",
    title: "ConsentStep, the chosen licence, Allow and Don't allow",
    scenario: "empty",
    path: PATH,
    routes: signedInRoutes(CHOICES),
    ready: async (p) => {
      await h1(p, "Choose a license for this device");
      await p.getByRole("button", { name: "Use this license" }).click();
      await h1(p, "Continue to Diceroll as Mara?");
    },
  },
  {
    section: "3.10",
    id: "app-return",
    title:
      "ReturnStep, native: signed in, Return to the app (timer on phones only)",
    scenario: "empty",
    path: PATH,
    // A hash-only redirect: where the phone's timer takes the page stays on the page.
    routes: signedInRoutes(CHOICES, {
      [`POST ${REQ}/continue`]: { body: { redirect: "#/returned" } },
    }),
    ready: async (p) => {
      await h1(p, "Choose a license for this device");
      await p.getByRole("button", { name: "Use this license" }).click();
      await h1(p, "Continue to Diceroll as Mara?");
      await p.getByRole("button", { name: "Continue to Diceroll" }).click();
      await h1(p, "You're signed in to Diceroll");
    },
  },
  {
    section: "3.9",
    id: "app-key-upgrade",
    title:
      "Key on-ramp: Keep Diceroll in an account (skippable, neutral meter)",
    scenario: "signedOut",
    path: PATH,
    routes: { ...signedOutRoutes(VIEW), "POST /api/key/preview": preview({}) },
    ready: (p) => keyStep(p, "Keep Diceroll in an account"),
  },
  {
    section: "3.9",
    id: "app-key-reasons",
    title:
      "Key on-ramp: the reasons to keep the licence in an account (frame 48)",
    scenario: "signedOut",
    path: PATH,
    routes: { ...signedOutRoutes(VIEW), "POST /api/key/preview": preview({}) },
    ready: async (p) => {
      await keyStep(p, "Keep Diceroll in an account");
      await p.getByText("Cloud Sync keeps your settings").waitFor();
    },
  },
  {
    section: "3.9",
    id: "app-key-forced",
    title: "Key on-ramp: no entries left, an account is required",
    scenario: "signedOut",
    path: PATH,
    routes: {
      ...signedOutRoutes(VIEW),
      "POST /api/key/preview": preview({
        keyEntries: { used: 5, limit: 5 },
        upgrade: "forced",
      }),
    },
    ready: (p) => keyStep(p, "Create an account to keep Diceroll"),
  },
];
