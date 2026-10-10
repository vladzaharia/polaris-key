/**
 * The console's view of authorization (ST-29): `useCan` reads `/me.permissions`, the sidebar,
 * palette and attention lists leave out what the member cannot open, and NoAccessPage answers a
 * deep link into an area the member lacks, naming who can help. None of it is a control: the
 * worker's route table refuses every one of these routes on its own (`rbacRouteMatrix.test.ts`).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { Me, MePermissions } from "../src/api.js";
import {
  AREA_NAMES,
  PAGE_AREAS,
  canIn,
  canOpenHref,
  type AreaId,
} from "../src/console/access/can.js";
import { askReason } from "../src/console/access/useCan.js";
import { ALL_PAGES } from "../src/console/nav.js";
import { ALL_ON, ME, boot, resetConsole } from "./consoleHarness.js";

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const here = dirname(fileURLToPath(import.meta.url));

const TEN: AreaId[] = [
  "members",
  "core",
  "license",
  "config",
  "ship",
  "signin",
  "sync",
  "commerce",
  "keys",
  "settings",
];

/** A Superadmin's permissions, as the worker sends them (root rule). */
const ROOT: MePermissions = {
  roles: [
    { role: "superadmin", scope: "platform", areas: null, source: "root" },
  ],
  platform: {
    view: ["console", "platform", "members", "docs"],
    edit: ["console", "platform", "members", "docs"],
  },
  products: {
    djdl: { view: TEN, edit: TEN },
    acme: { view: TEN, edit: TEN },
  },
};

/** DJDL's admin narrowed to Ship builds and Commerce (the mockup's Lucía). */
const SHIP_ONLY: Partial<Me> = {
  platformAdmin: false,
  email: "lucia@example.com",
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }],
  permissions: {
    roles: [
      {
        role: "product_admin",
        scope: "product:djdl",
        areas: ["ship", "commerce"],
        source: "grant",
      },
    ],
    platform: { view: ["console"], edit: ["console"] },
    products: {
      djdl: { view: ["ship", "commerce"], edit: ["ship", "commerce"] },
    },
  },
};

/** Console access only (the mockup's Noor). */
const CONSOLE_ONLY: Partial<Me> = {
  platformAdmin: false,
  email: "noor@studio.example.com",
  products: [],
  permissions: {
    roles: [
      {
        role: "console_access",
        scope: "platform",
        areas: null,
        source: "rule",
      },
    ],
    platform: { view: ["console"], edit: ["console"] },
    products: {},
  },
};

const ADMINS = {
  scope: "product:djdl",
  area: "license",
  admins: [
    { name: "Kenji Mori", email: "kenji@example.com", role: "product_admin" },
    { name: "Ada Lindqvist", email: "ada@example.com", role: "superadmin" },
  ],
};

describe("the page areas", () => {
  it("name an area for every console page", () => {
    for (const page of ALL_PAGES)
      expect(PAGE_AREAS[page.page], page.page).toBeDefined();
  });

  it("use the worker's area ids and names, in its order", () => {
    const pinned = JSON.parse(
      readFileSync(
        join(here, "..", "..", "worker", "test", "fixtures", "rbac-areas.json"),
        "utf8",
      ),
    ) as { id: AreaId; name: string }[];
    expect(Object.entries(AREA_NAMES)).toEqual(
      pinned.map((a) => [a.id, a.name]),
    );
  });
});

describe("canIn", () => {
  it("reads the permissions the worker sent, per product and at platform scope", () => {
    const me = { ...ME, ...SHIP_ONLY } as Me;
    expect(canIn(me, "ship", "djdl")).toBe(true);
    expect(canIn(me, "license", "djdl")).toBe(false);
    expect(canIn(me, "ship", "acme")).toBe(false);
    expect(canIn(me, "console")).toBe(true);
    expect(canIn(me, "platform")).toBe(false);
    expect(canOpenHref(me, "#/p/djdl/release/releases")).toBe(true);
    expect(canOpenHref(me, "#/p/djdl/license/licenses")).toBe(false);
    expect(canOpenHref(me, "#/platform/settings")).toBe(false);
    expect(canOpenHref(me, "/docs/")).toBe(true);
  });

  it("treats a worker without permissions as before: a platform admin holds every area", () => {
    expect(canIn(ME, "keys", "djdl", "edit")).toBe(true);
    expect(canIn({ ...ME, platformAdmin: false }, "keys", "djdl")).toBe(false);
    expect(canIn({ ...ME, platformAdmin: false }, "console")).toBe(true);
    expect(canIn(undefined, "console")).toBe(false);
  });

  it("names the same people in a disabled control's reason", () => {
    expect(askReason("license", ADMINS.admins as never)).toBe(
      "Ask Kenji Mori (kenji@example.com) or Ada Lindqvist for Licensing access.",
    );
    expect(askReason("platform", [])).toBe(
      "You don't have Platform access. A Superadmin can give it to you.",
    );
  });
});

describe("today's operator (the root rule)", () => {
  it("sees every section and the Platform group, as before", async () => {
    boot("#/", { me: { permissions: ROOT } });
    const nav = await screen.findByRole("navigation", { name: "Console" });
    expect(within(nav).getByText("Platform")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Products" })).toBeTruthy();
  });
});

describe("NoAccessPage", () => {
  it("answers a deep link into an area the member lacks: the area, the role, who can help, where to go", async () => {
    const log = boot("#/p/djdl/license/licenses", {
      me: SHIP_ONLY,
      services: ALL_ON,
      extra: { "/manage/api/access/admins": ADMINS },
    });
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("You don’t have access to DJDL → Licensing");
    expect(screen.getByText("lucia@example.com")).toBeTruthy();
    expect(screen.getByText("DJDL admin")).toBeTruthy();
    expect(screen.getByText("Ship builds, Commerce")).toBeTruthy();
    // Who can help: the people, each with an address to copy; no request button.
    expect(await screen.findByText("Kenji Mori")).toBeTruthy();
    expect(screen.getByText("DJDL admin", { selector: "li *" })).toBeTruthy();
    expect(screen.getByText("kenji@example.com")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy Kenji Mori's email" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /request/i })).toBeNull();
    const call = log.calls.find((c) => c.path === "/manage/api/access/admins");
    expect(call?.query).toBe("scope=product%3Adjdl&area=license");
    // Where to go: the member's real destinations, and the library.
    expect(
      screen.getByRole("link", { name: "DJDL releases" }).getAttribute("href"),
    ).toBe("#/p/djdl/release/releases");
    expect(
      screen.getByRole("link", { name: /Open your library/ }),
    ).toBeTruthy();
    // Nothing from the refused page is read.
    expect(
      log.calls.some((c) =>
        c.path.startsWith("/manage/api/products/djdl/license"),
      ),
    ).toBe(false);
  });

  it("leaves what the member cannot open out of the sidebar, rather than disabling it", async () => {
    boot("#/p/djdl/release/releases", {
      me: SHIP_ONLY,
      services: ALL_ON,
      extra: { "/manage/api/access/admins": ADMINS },
    });
    const nav = await screen.findByRole("navigation", { name: "Console" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "Releases" })).toBeTruthy(),
    );
    for (const name of ["Overview", "Licenses", "Catalog", "Keys & secrets"])
      expect(within(nav).queryByRole("link", { name }), name).toBeNull();
  });

  it("is Home for a member with no product yet: the facts, the Superadmins, the library", async () => {
    boot("#/", {
      me: CONSOLE_ONLY,
      extra: {
        "/manage/api/access/admins": {
          scope: "platform",
          area: "console",
          admins: [
            {
              name: "Ada Lindqvist",
              email: "ada@example.com",
              role: "superadmin",
            },
          ],
        },
      },
    });
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("You don’t have access to any product yet");
    expect(screen.getByText("Console access")).toBeTruthy();
    expect(await screen.findByText("Ada Lindqvist")).toBeTruthy();
    expect(screen.getByText("Superadmins can give you any role.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Your library/ })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Console" });
    expect(within(nav).queryByText("Platform")).toBeNull();
    // Home is the only page: there is no product to list.
    expect(within(nav).queryByRole("link", { name: "Products" })).toBeNull();
  });

  it("answers a Platform page for a member without the Platform area", async () => {
    boot("#/platform/settings", {
      me: SHIP_ONLY,
      extra: { "/manage/api/access/admins": { ...ADMINS, admins: [] } },
    });
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("You don’t have access to Platform");
    expect(
      await screen.findByText(
        "No one can be named yet. A Superadmin of this Polaris Key can give you access.",
      ),
    ).toBeTruthy();
  });

  it("disables New product for a member without the Platform area, naming who can help", async () => {
    boot("#/products", {
      me: SHIP_ONLY,
      extra: { "/manage/api/access/admins": ADMINS },
    });
    const create = await screen.findByRole("link", { name: /New product/ });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Ask Kenji Mori (kenji@example.com) or Ada Lindqvist for Platform access.",
      ),
    );
  });
});
