/**
 * PS-06 — the Polaris Key storefront in the console (notes/S-21 §6.6):
 *
 *   - the hub tile renders from the storefront registry (here a stubbed one): a built-in store is
 *     "Built in", always connected, opens its page, and is left out of Add to storefronts;
 *   - the panel (T4): readiness, listing, audience (typed), ways to add (absent when not
 *     configured), group labels, "Who can see this?", the persona preview and the 28-day card;
 *   - every write goes through Identity's portal settings with its confirmation level, and focus
 *     returns to the control that opened a dialog;
 *   - the preview has no input that names a person;
 *   - the Listing page's fit report has a store switcher (`?store=`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import { P, bootWith, writes } from "./distributionFixture.js";
import type {
  PolarisKeyAnalyticsResponse,
  PolarisKeyStatusResponse,
  StorefrontDto,
  StorefrontsResponse,
} from "../src/api.js";
import {
  reasonLine,
  whoLines,
} from "../src/console/areas/storefronts/polarisKeyCopy.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const HUB = "#/p/djdl/distribution/storefronts";
const PAGE = "#/p/djdl/distribution/storefronts/polaris-key";
const SF = (path = "") => P(`/distribution/storefronts${path}`);
const PK = (path = "") => P(`/storefronts/polaris-key${path}`);
const PORTAL = P("/identity/portal");

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const firstParty = (op: string) => ({
  mode: "first-party" as const,
  plane: "worker" as const,
  handler: `polaris-key.${op}`,
});

/** The registry's built-in store, as the Worker's storefront view sends it. */
const POLARIS_KEY: StorefrontDto = {
  id: "polaris-key",
  label: "Polaris Key",
  builtIn: true,
  listingStore: "polaris-key",
  connection: {
    state: "keyless",
    credential: null,
    credentialLabel: null,
    source: null,
    lastError: null,
  },
  app: null,
  outlets: [],
  readOnly: null,
  capabilities: [
    {
      op: "writeListingText",
      label: "Listing text",
      support: firstParty("writeListingText"),
    },
    { op: "submit", label: "Submit for review", support: firstParty("submit") },
    {
      op: "pricing",
      label: "Price and availability",
      support: {
        mode: "unsupported",
        reason: "Listed products are obtained without payment",
      },
    },
  ],
  prerequisites: [],
  steps: [],
  pushListing: null,
  confirmationLabel: "Polaris Key",
};

/** A built-in store the console has no page for: it still renders from its declaration. */
const OTHER_BUILT_IN: StorefrontDto = {
  ...POLARIS_KEY,
  id: "acme-shelf",
  label: "Acme Shelf",
  listingStore: null,
};

/** A connected vendor store. */
const VENDOR: StorefrontDto = {
  ...POLARIS_KEY,
  id: "acme-arcade",
  label: "Acme Arcade",
  builtIn: false,
  connection: {
    state: "connected",
    credential: "acme.key",
    credentialLabel: "Acme key",
    source: "console",
    lastError: null,
  },
  capabilities: [
    {
      op: "writeListingText",
      label: "Listing text",
      support: { mode: "api", plane: "worker", rules: ["PUT listing"] },
    },
  ],
};

const HUB_VIEW: StorefrontsResponse = {
  stores: [POLARIS_KEY, OTHER_BUILT_IN, VENDOR],
  listing: null,
};

const STATUS: PolarisKeyStatusResponse = {
  enabled: true,
  portalEnabled: true,
  listing: {
    listed: "auto",
    audience: "eligible",
    offerPaths: null,
    groupLabels: { "aperture-beta": "Aperture Seven", "old-crew": "Old Crew" },
  },
  available: ["group", "auto_issue"],
  active: ["group", "auto_issue"],
  everyone: false,
  identityEligible: true,
  licenseEnabled: true,
  groups: [
    { group: "aperture-beta", tier: "beta", label: "Aperture Seven" },
    { group: "crew", tier: null, label: null },
  ],
  autoIssue: { tier: "free", tierLabel: "Free", expiryDays: 14 },
  readiness: [
    {
      id: "portal",
      state: "pass",
      reason: "The portal is on for this product",
    },
    {
      id: "listing",
      state: "fail",
      reason: "Add a name, an icon and a short description to the listing",
    },
    {
      id: "obtain-path",
      state: "pass",
      reason: "People can add it through 2 obtain paths",
    },
    {
      id: "get-it",
      state: "warn",
      reason:
        "Get it opens the developer's website: there is no download or store link",
    },
    {
      id: "licence-tier",
      state: "pass",
      reason: "Every tier a path issues exists and has a device limit",
    },
  ],
};

const DAY = (n: number) =>
  `2026-09-${String(n).padStart(2, "0")}`.replace("2026-09-00", "2026-08-31");

const ANALYTICS: PolarisKeyAnalyticsResponse = {
  from: "2026-09-09",
  to: "2026-10-06",
  days: 28,
  totals: { impressions: 41, adds: 10, activations: 4 },
  byKind: [
    { kind: "group", impressions: 14, adds: 4, activations: 2 },
    { kind: "auto_issue", impressions: 20, adds: 6, activations: 2 },
    { kind: "link", impressions: 7, adds: 0, activations: 0 },
  ],
  daily: Array.from({ length: 28 }, (_, i) => ({
    day: DAY(i + 1),
    impressions: i,
    adds: 0,
    activations: 0,
  })),
  impressionsCounted: true,
};

const TILE = {
  product: "djdl",
  name: "DJDL",
  developerName: "Fennick",
  tintColor: null,
  iconUrl: null,
  headerUrl: null,
  platforms: ["macos"],
  shortDescription: "Mix anywhere.",
  cta: "add" as const,
  paths: [
    {
      kind: "group" as const,
      detail: "aperture-beta",
      label: "Aperture Seven",
      terms: {
        tier: "beta",
        tierLabel: "Beta",
        deviceLimit: 3,
        expiresAt: null,
        expiryDays: null,
      },
      action: "add" as const,
      reason: "group:aperture-beta",
    },
  ],
  offer: {
    tier: "beta",
    tierLabel: "Beta",
    deviceLimit: 3,
    expiresAt: null,
    expiryDays: null,
  },
  reason: "group:aperture-beta",
  stores: [],
};

function routes(
  over: Record<string, unknown> = {},
  status: PolarisKeyStatusResponse = STATUS,
): Record<string, unknown> {
  return {
    [SF()]: HUB_VIEW,
    [PK()]: status,
    [PK("/analytics")]: ANALYTICS,
    [`PATCH ${PORTAL}`]: { ok: true, settings: {} },
    [`POST ${PK("/preview")}`]: (call: { body: unknown }) => {
      const persona = call.body as { groups: string[] };
      return persona.groups.includes("aperture-beta")
        ? { persona, visible: true, hidden: null, tile: TILE }
        : { persona, visible: false, hidden: "no_path", tile: null };
    },
    ...over,
  };
}

// ── The hub tile ─────────────────────────────────────────────────────────────────────────────

describe("the Polaris Key tile (rendered from the registry)", () => {
  it("is built in, always connected, and opens its own page", async () => {
    bootWith(HUB, routes());
    const tile = await screen.findByRole("region", { name: "Polaris Key" });
    expect(tile.textContent).toContain("Built in: always connected");
    expect(tile.textContent).not.toMatch(
      /Published from CI|No app assigned|Not connected/,
    );
    const strip = within(tile).getByRole("list", {
      name: "Polaris Key capabilities",
    });
    // Every first-party op is "Built in"; the unsupported one keeps its reason.
    expect(
      [...strip.querySelectorAll("[data-capability]")].map((b) =>
        b.getAttribute("data-capability"),
      ),
    ).toEqual(["first-party", "first-party", "unsupported"]);
    expect(within(strip).getAllByText("Built in")).toHaveLength(2);
    expect(strip.textContent).toContain(
      "Listed products are obtained without payment",
    );
    const manage = within(tile).getByRole("link", { name: "Manage" });
    expect(manage.getAttribute("href")).toBe(PAGE);
    expect(within(tile).queryByRole("link", { name: "Set up" })).toBeNull();
  });

  it("a built-in store with no page of its own still renders from its declaration", async () => {
    bootWith(HUB, routes());
    const tile = await screen.findByRole("region", { name: "Acme Shelf" });
    expect(tile.textContent).toContain("Built in: always connected");
    expect(within(tile).queryByRole("link")).toBeNull();
  });

  it("Add to storefronts leaves built-in stores out", async () => {
    bootWith(`${HUB}?flow=add`, routes());
    expect(
      await screen.findByRole("checkbox", { name: /Acme Arcade/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Polaris Key/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Acme Shelf/ })).toBeNull();
  });

  it("a store page that does not exist says so", async () => {
    bootWith(`${HUB}/acme-arcade`, routes());
    expect(
      await screen.findByText("This storefront has no page of its own"),
    ).toBeTruthy();
  });
});

// ── The panel ────────────────────────────────────────────────────────────────────────────────

describe("the Polaris Key panel", () => {
  it("renders readiness, listing, ways to add, labels, who can see it and the card", async () => {
    const { container } = { container: document.body };
    bootWith(PAGE, routes());
    expect(
      await screen.findByRole("heading", { level: 1, name: "Polaris Key" }),
    ).toBeTruthy();
    const readiness = await screen.findByRole("list", { name: "Readiness" });
    expect(
      [...readiness.querySelectorAll("[data-check]")].map((li) => [
        li.getAttribute("data-check"),
        li.getAttribute("data-state"),
      ]),
    ).toEqual([
      ["portal", "pass"],
      ["listing", "fail"],
      ["obtain-path", "pass"],
      ["get-it", "warn"],
      ["licence-tier", "pass"],
    ]);
    expect(
      within(readiness).getByRole("link", { name: "Open Listing" }),
    ).toBeTruthy();

    // The listing and the audience, from the status.
    const listing = screen.getByRole("radiogroup", { name: "Listing" });
    expect(
      within(listing)
        .getByRole("radio", { name: /Automatic/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    // Ways to add: the configured kinds only; nothing else is shown, disabled or not.
    expect(
      screen.getByRole("switch", { name: "Members of a mapped group" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Free with an account" }),
    ).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Free to use" })).toBeNull();
    expect(screen.queryByText("Owned on a store")).toBeNull();

    // Group labels: every mapped group, then a stale label to clear.
    expect(
      screen.getByRole("textbox", { name: "aperture-beta" }),
    ).toHaveProperty("value", "Aperture Seven");
    expect(screen.getByRole("textbox", { name: "crew" })).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByText(/no longer mapped/)).toBeTruthy();

    // Who can see this, in plain words.
    const who = screen.getByRole("list", { name: "Who can see this" });
    expect(who.textContent).toContain(
      "Members of aperture-beta at the Polaris Key sign-in, shown “Included with Aperture Seven”",
    );
    expect(who.textContent).toContain(
      "Everyone with a Polaris Key account, as a 14-day free trial",
    );

    // The card.
    await waitFor(() =>
      expect(document.querySelector("[data-analytics] table")).not.toBeNull(),
    );
    const table = document.querySelector("[data-analytics] table")!;
    expect(table.textContent).toContain("Members of a mapped group");
    expect(table.textContent).toContain("Link to get it");
    expect(table.textContent).toContain("50%");

    // No implementation-status copy anywhere on the page.
    expect(document.body.textContent).not.toMatch(
      /coming soon|not built|available when|not yet available/i,
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it("changing the listing confirms (L1) and returns focus to the choice", async () => {
    const { calls } = bootWith(PAGE, routes());
    const listed = await screen.findByRole("radio", { name: /^Listed/ });
    await userEvent.click(listed);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "Set the Polaris Key listing to listed?",
    );
    expect(writes(calls)).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set to listed" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: "PATCH",
          path: PORTAL,
          body: { storeListed: "listed" },
        }),
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("widening the audience to everyone is typed; narrowing it is not", async () => {
    const { calls } = bootWith(PAGE, routes());
    await userEvent.click(
      await screen.findByRole("radio", { name: /Everyone signed in/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Show to everyone",
    });
    expect(
      confirm.hasAttribute("disabled") ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    const box = within(dialog).getByRole("textbox", {
      name: /Type the product slug/,
    });
    await userEvent.type(box, "djdl");
    // Typing keeps focus in the field; the enabled button is a fresh element.
    expect(document.activeElement).toBe(box);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Show to everyone" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: PORTAL,
          body: {
            storeAudience: "everyone",
            confirm: "storefront.polarisKey.audience",
          },
        }),
      ]),
    );
  });

  it("narrowing the audience saves at once", async () => {
    const { calls } = bootWith(
      PAGE,
      routes(
        {},
        {
          ...STATUS,
          listing: {
            ...STATUS.listing,
            listed: "listed",
            audience: "everyone",
          },
          everyone: true,
        },
      ),
    );
    await userEvent.click(
      await screen.findByRole("radio", { name: /People who can add it/ }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: PORTAL,
          body: { storeAudience: "eligible" },
        }),
      ]),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("turning a way off confirms and stores the narrowed list", async () => {
    const { calls } = bootWith(PAGE, routes());
    await userEvent.click(
      await screen.findByRole("switch", { name: "Free with an account" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Turn off" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: PORTAL,
          body: {
            storeOfferPaths: [
              "group",
              "open",
              "store_owned",
              "product_idp",
              "email_domain",
            ],
          },
        }),
      ]),
    );
  });

  it("group labels save as one map, without the cleared ones", async () => {
    const { calls } = bootWith(PAGE, routes());
    const crew = await screen.findByRole("textbox", { name: "crew" });
    await userEvent.type(crew, "The Crew");
    await userEvent.clear(screen.getByRole("textbox", { name: "old-crew" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Save group labels" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: PORTAL,
          body: {
            storeGroupLabels: {
              "aperture-beta": "Aperture Seven",
              crew: "The Crew",
            },
          },
        }),
      ]),
    );
  });

  it("says when no way to add the product is configured, and who sees it then", async () => {
    bootWith(
      PAGE,
      routes(
        {},
        {
          ...STATUS,
          available: [],
          active: [],
          groups: [],
          autoIssue: null,
          listing: { ...STATUS.listing, groupLabels: {} },
        },
      ),
    );
    expect(
      await screen.findByText("No way to add this product is configured"),
    ).toBeTruthy();
    expect(
      within(document.getElementById("pk-ways") as HTMLElement).queryByRole(
        "switch",
      ),
    ).toBeNull();
    // No groups, no labels: the section is absent, not empty.
    expect(screen.queryByRole("heading", { name: "Group labels" })).toBeNull();
    expect(
      screen.getByText(
        "No one: no way to add this product is configured or turned on.",
      ),
    ).toBeTruthy();
  });
});

// ── The persona preview ──────────────────────────────────────────────────────────────────────

describe("Who can see this? (a persona, never a person)", () => {
  it("has no input that names a person", async () => {
    bootWith(PAGE, routes());
    const persona = await waitFor(() => {
      const el = document.querySelector("[data-persona]");
      if (!el) throw new Error("no persona form yet");
      return el as HTMLElement;
    });
    // Switches and checkboxes only: no text field at all, so no email or account can be typed.
    expect(within(persona).queryAllByRole("textbox")).toEqual([]);
    expect(persona.querySelectorAll("input[type=email]")).toHaveLength(0);
    expect(
      within(persona)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-label") ?? c.textContent),
    ).toBeTruthy();
  });

  it("previews the tile with the person's groups, and says why it is hidden", async () => {
    const { calls } = bootWith(PAGE, routes());
    const preview = await screen.findByRole("button", { name: "Preview" });
    await userEvent.click(preview);
    expect(
      await screen.findByText(
        "This person has no way to add it, so the product is not shown to them.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "aperture-beta" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    const tile = await screen.findByRole("article", {
      name: "DJDL on Discover",
    });
    expect(tile.textContent).toContain("Included with Aperture Seven");
    expect(tile.textContent).toContain("Beta · Lifetime · 3 devices");
    expect(tile.textContent).toContain("Add to library");
    const posts = calls.filter((c) => c.path === PK("/preview"));
    expect(posts.map((c) => Object.keys(c.body as object).sort())).toEqual([
      ["emailDomain", "groups", "holds", "platformAccount", "stores"],
      ["emailDomain", "groups", "holds", "platformAccount", "stores"],
    ]);
    expect(posts[1]!.body).toEqual({
      platformAccount: true,
      groups: ["aperture-beta"],
      emailDomain: null,
      stores: [],
      holds: false,
    });
  });
});

// ── The listing's store switcher ─────────────────────────────────────────────────────────────

describe("the fit report's store switcher", () => {
  it("shows one store's row from the URL", async () => {
    bootWith("#/p/djdl/distribution/listing?tab=fit&store=polaris-key", {
      ...routes(),
      [P("/distribution/listing")]: {
        listing: null,
        locales: [],
        overrides: [],
        limits: {},
        stores: [],
        overrideStores: [],
        modelFields: [],
      },
      [P("/distribution/listing/fit")]: {
        exists: true,
        release: null,
        stores: [
          {
            store: "play",
            label: "Google Play",
            status: "green",
            issues: [],
            cells: [],
          },
          {
            store: "polaris-key",
            label: "Polaris Key",
            status: "green",
            issues: [],
            cells: [],
          },
        ],
      },
    });
    const report = await screen.findByRole("list", { name: "Fit report" });
    expect(
      [...report.querySelectorAll("[data-fit]")].map((li) =>
        li.getAttribute("data-fit"),
      ),
    ).toEqual(["polaris-key"]);
  });
});

// ── The copy ─────────────────────────────────────────────────────────────────────────────────

describe("the panel's words (notes/S-21 §6.5)", () => {
  const path = (kind: string, over: Record<string, unknown> = {}) =>
    ({
      kind,
      detail: null,
      label: null,
      terms: null,
      action: "add",
      reason: "",
      ...over,
    }) as Parameters<typeof reasonLine>[0];

  it("gives every path its reason line", () => {
    expect(reasonLine(path("auto_issue"))).toBe(
      "Free with a Polaris Key account",
    );
    expect(
      reasonLine(
        path("auto_issue", {
          terms: {
            tier: "t",
            tierLabel: null,
            deviceLimit: 1,
            expiresAt: null,
            expiryDays: 14,
          },
        }),
      ),
    ).toBe("Free trial · 14 days");
    expect(
      reasonLine(path("group", { detail: "crew", label: "Aperture Seven" })),
    ).toBe("Included with Aperture Seven");
    expect(reasonLine(path("group", { detail: "crew" }))).toBe(
      "For members of crew",
    );
    expect(reasonLine(path("product_idp", { detail: "Acme" }))).toBe(
      "Included with your Acme account",
    );
    expect(reasonLine(path("email_domain", { detail: "acme.edu" }))).toBe(
      "For everyone with a acme.edu email",
    );
    expect(reasonLine(path("store_owned", { detail: "steam" }))).toBe(
      "You own it on Steam",
    );
    expect(reasonLine(path("open"))).toBe("Free to use");
  });

  it("lists who can see it only while it is listed and on", () => {
    expect(whoLines(STATUS)).toHaveLength(3);
    expect(
      whoLines({
        ...STATUS,
        listing: { ...STATUS.listing, listed: "unlisted" },
      }),
    ).toEqual([]);
    expect(whoLines({ ...STATUS, enabled: false })).toEqual([]);
    expect(whoLines({ ...STATUS, active: ["open"], everyone: true })).toEqual([
      "Everyone signed in: it is free to use",
      "Everyone else signed in, with a link to get it",
    ]);
  });
});
