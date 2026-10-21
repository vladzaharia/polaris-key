/**
 * ST-08: Settings → All settings sends each key to the page whose control edits it (by key, not by
 * area), and a key with no console editor names the file or API that does and links nowhere.
 * The mapping itself is pinned in settingHomes.test.ts; this renders the table and follows links.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as ApiModule from "../src/api.js";
import type { Me, ProductDetail } from "../src/api.js";
import {
  anchorOf,
  SETTING_HOMES,
} from "../src/console/sections/core/model/settingHomes.js";
import { SettingsAllPage } from "../src/console/sections/core/pages/SettingsAll.js";
import { productPage } from "../src/console/routes.js";
import { SETTINGS_INDEX } from "../src/console/settings.generated.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  me: vi.fn(),
  product: vi.fn(),
  productSettings: vi.fn(),
}));

vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../src/api.js");
  return {
    ...actual,
    api: Object.fromEntries(
      Object.keys(fns).map((k) => [
        k,
        (...a: unknown[]) =>
          (fns as Record<string, (...x: unknown[]) => unknown>)[k]!(...a),
      ]),
    ),
  };
});

const NOW = 1_800_000_000;

const ME: Me = {
  sub: "u1",
  name: "Ada",
  email: "ada@example.test",
  csrf: "csrf",
  platformAdmin: true,
  products: [],
};

const PRODUCT: ProductDetail = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "djdl-a",
  jwksUrl: "/djdl/.well-known/jwks.json",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 30,
  defaultDeviceLimit: 5,
  adminGroup: null,
  createdAt: NOW - 1000,
  modifiedAt: NOW - 10,
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: true },
    sync: { enabled: true },
    commerce: { enabled: true },
  },
};

const mount = () =>
  renderAt("#/p/djdl/settings/all", <SettingsAllPage slug="djdl" />);

/** The table row of one registry key. */
async function rowOf(key: string): Promise<HTMLElement> {
  const row = (await screen.findByText(key)).closest("tr");
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  fns.me.mockResolvedValue(ME);
  fns.product.mockResolvedValue({ product: PRODUCT });
  fns.productSettings.mockResolvedValue({ settings: [] });
});
afterEach(cleanup);

describe("All settings → Edit in", () => {
  it.each([
    // [key, where it reads, its section, where the link goes]
    [
      "license.defaults.deviceLimit",
      "Settings → Features",
      "License defaults",
      "#/p/djdl/settings?at=settings-license",
    ],
    [
      "license.fingerprint",
      "License → Enrollment",
      "Fingerprint policy",
      "#/p/djdl/license/enrollment",
    ],
    [
      "licensing.clampGraceToExpiry",
      "License → Settings",
      null,
      "#/p/djdl/license/settings",
    ],
    [
      "release.github",
      "Settings → Features",
      "Repository",
      "#/p/djdl/settings?at=settings-repository",
    ],
    [
      "release.compatWindow",
      "Update → Feed",
      "Compatibility window",
      "#/p/djdl/update/feed",
    ],
    [
      "update.operatorPolicy",
      "Update → Feed",
      "Artifact policy",
      "#/p/djdl/update/feed",
    ],
    [
      "storefront.polarisKey.listed",
      "Distribution → Storefronts",
      "Polaris Locker → Listing",
      "#/p/djdl/distribution/storefronts/polaris-key",
    ],
    [
      "identity.keyEntry.claimByKey",
      "Identity → App sign-in",
      "License keys",
      "#/p/djdl/identity/app-sign-in",
    ],
  ])("%s links to %s and opens it", async (key, where, section, hash) => {
    mount();
    const row = await rowOf(key);
    const link = within(row).getByRole("link");
    // The cell, not the row: a label can equal its section ("Fingerprint policy").
    const cell = link.closest("td")!.textContent ?? "";
    expect(cell).toContain(where);
    if (section) expect(cell).toContain(section);
    await userEvent.setup().click(link);
    expect(window.location.hash).toBe(hash);
  });

  it.each([
    ["release.binaryName", ".pkey/release"],
    ["release.summaryMarker", ".pkey/release"],
    // Update → Feed's "Artifact policy" is `update.operatorPolicy`, a different key.
    ["release.artifactPolicy", ".pkey/release"],
    // Enrollment has no auto-issue control.
    ["license.autoIssue", ".pkey/product"],
    ["identity.keyEntry.limit", ".pkey/product"],
    ["distribution.outlets", ".pkey/distribution"],
  ])(
    "%s has no console editor: it names %s and links nowhere",
    async (key, file) => {
      mount();
      const row = await rowOf(key);
      expect(within(row).queryByRole("link")).toBeNull();
      expect(within(row).getByText(file)).toBeTruthy();
      expect(row.textContent).toContain("in the repository");
    },
  );

  it("names the admin API for a key only the API writes", async () => {
    mount();
    const row = await rowOf("core.trustPolicy");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).getByText("Admin API only")).toBeTruthy();
  });

  it("links every row the way its home says, and no other row", async () => {
    mount();
    await screen.findByText("core.name");
    const rows = SETTINGS_INDEX.filter(
      (e) =>
        e.scope === "product" && e.pending === null && e.deprecated === null,
    );
    for (const e of rows) {
      const row = await rowOf(e.key);
      const home = SETTING_HOMES[e.key]!;
      const links = within(row).queryAllByRole("link");
      if (home.kind === "page")
        expect(
          links.map((l) => l.getAttribute("href")),
          e.key,
        ).toEqual([
          productPage("djdl", home.page, {
            id: home.id,
            ...(anchorOf(home) ? { query: { at: anchorOf(home)! } } : {}),
          }),
        ]);
      else expect(links, e.key).toEqual([]);
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = mount();
    await screen.findByText("core.name");
    await expectNoAxeViolations(container);
  });
});
