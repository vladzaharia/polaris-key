/**
 * LK-10: "Get a badge" offers only the labels a product backs, draws them at 320 px or wider, and
 * links the HTML to the product's Polaris Locker page; the page's Open link uses the customer
 * origin and is absent without one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { resetConsole, ME, ALL_ON } from "./consoleHarness.js";
import { channelRow, channelsView } from "./channelFixture.js";
import { P, bootWith } from "./distributionFixture.js";
import type { PolarisKeyStatusResponse } from "../src/api.js";
import {
  badgeHtml,
  lockerUrl,
  offeredBadges,
} from "../src/console/sections/storefronts/model/badges.js";

const PAGE = "#/p/djdl/distribution/channels/polaris-key/sales";

const STATUS: PolarisKeyStatusResponse = {
  enabled: true,
  portalEnabled: true,
  listing: {
    listed: "listed",
    audience: "eligible",
    offerPaths: null,
    groupLabels: {},
  },
  available: [],
  active: [],
  everyone: false,
  identityEligible: true,
  licenseEnabled: true,
  groups: [],
  autoIssue: null,
  readiness: [],
};

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const kinds = (s: PolarisKeyStatusResponse, services: object) =>
  offeredBadges(s, { services } as never).map((b) => b.kind.slice(7));
const withDownload = { ...STATUS, directDownload: true };

describe("offeredBadges", () => {
  it("offers powered-by alone for a bare, unlisted product", () => {
    const unlisted = {
      ...STATUS,
      listing: { ...STATUS.listing, listed: "unlisted" as const },
    };
    expect(kinds(unlisted, {})).toEqual(["powered-by"]);
  });
  it("adds a label per backing service, and open-in/available-on once listed", () => {
    expect(
      kinds(withDownload, {
        identity: { enabled: true },
        distribution: { enabled: true },
        commerce: { enabled: true },
        connect: { enabled: false },
        update: { enabled: true },
        sync: { enabled: true },
      }),
    ).toEqual([
      "open-in",
      "available-on",
      "sign-in-with",
      "download-from",
      "update-with",
      "sync-with",
      "powered-by",
    ]);
    expect(kinds(STATUS, { sync: { enabled: false } })).not.toContain(
      "sync-with",
    );
  });
  it("never offers Buy on or Purchase with, and Download from needs a real download", () => {
    const all = {
      identity: { enabled: true },
      commerce: { enabled: true },
      connect: { enabled: false },
      distribution: { enabled: true },
    };
    expect(kinds(STATUS, all)).not.toContain("download-from");
    expect(kinds(withDownload, all)).toContain("download-from");
    for (const k of ["buy-on", "purchase-with"])
      expect(kinds(withDownload, all)).not.toContain(k);
  });
  it("links to the product on the customer site only when there is one", () => {
    expect(lockerUrl(null, "djdl")).toBeNull();
    expect(lockerUrl("https://polaris.locker", "djdl")).toBe(
      "https://polaris.locker/#/discover/djdl",
    );
    expect(badgeHtml("<svg/>", "https://x/#/a", "Powered by")).toBe(
      '<a href="https://x/#/a" aria-label="Powered by"><svg/></a>',
    );
  });
});

describe("the Polaris Locker page", () => {
  const routes = {
    // A-22.6: the store's page is the Sales tab of its channel page.
    [P("/distribution/channels")]: channelsView(
      channelRow({
        id: "polaris-key",
        label: "Polaris Locker",
        commerce: null,
      }),
    ),
    [P("/storefronts/polaris-key")]: STATUS,
    [P("/storefronts/polaris-key/analytics")]: { rows: [] },
  };
  it("offers badges at 320 px or wider and opens the customer site", async () => {
    bootWith(PAGE, {
      "/manage/api/me": { ...ME, customerOrigin: "https://polaris.locker" },
      ...routes,
    });
    const section = (
      await screen.findByRole("heading", { name: "Get a badge" })
    ).closest("section")!;
    const svgs = [...section.querySelectorAll("svg[role=img]")];
    expect(svgs.length).toBeGreaterThan(1);
    for (const s of svgs)
      expect(Number(s.getAttribute("width"))).toBeGreaterThanOrEqual(320);
    expect(
      within(section).getAllByRole("button", { name: /^Copy HTML/ }).length,
    ).toBe(svgs.length);
    const link = screen.getByRole("link", { name: /Open in Polaris Locker/ });
    expect(link.getAttribute("href")).toBe(
      "https://polaris.locker/#/discover/djdl",
    );
  });
  it("hides the Open link when the product is not listed", async () => {
    bootWith(PAGE, {
      "/manage/api/me": { ...ME, customerOrigin: "https://polaris.locker" },
      ...routes,
      [P("/storefronts/polaris-key")]: {
        ...STATUS,
        listing: { ...STATUS.listing, listed: "unlisted" },
      },
    });
    await screen.findByRole("heading", { name: "Get a badge" });
    expect(
      screen.queryByRole("link", { name: /Open in Polaris Locker/ }),
    ).toBeNull();
  });
  it("copies only the SVG, and has no Open link, without a customer site", async () => {
    bootWith(PAGE, { "/manage/api/me": ME, ...routes }, { services: ALL_ON });
    const section = (
      await screen.findByRole("heading", { name: "Get a badge" })
    ).closest("section")!;
    expect(
      within(section).queryAllByRole("button", { name: /^Copy HTML/ }),
    ).toEqual([]);
    expect(
      screen.queryByRole("link", { name: /Open in Polaris Locker/ }),
    ).toBeNull();
  });
  it("B-228: says who can see the page the badges link to when the audience is not everyone", async () => {
    const me = { ...ME, customerOrigin: "https://polaris.locker" };
    bootWith(PAGE, { "/manage/api/me": me, ...routes });
    const section = (
      await screen.findByRole("heading", { name: "Get a badge" })
    ).closest("section")!;
    expect(section.textContent).toContain(
      "only people who can add the product",
    );
    cleanup();
    bootWith(PAGE, {
      "/manage/api/me": me,
      ...routes,
      [P("/storefronts/polaris-key")]: {
        ...STATUS,
        listing: { ...STATUS.listing, audience: "everyone" },
      },
    });
    const all = (
      await screen.findByRole("heading", { name: "Get a badge" })
    ).closest("section")!;
    expect(all.textContent).not.toContain("only people who can add");
    expect(all.textContent).toContain("Each badge links to its page");
  });
});
