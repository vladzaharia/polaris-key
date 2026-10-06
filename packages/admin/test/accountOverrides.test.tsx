/**
 * U-03: the account override editor on a user's record, through the whole console, so the slot
 * the Core section fills at module load (`accountOverridesSlot.tsx`) is the one that renders. It
 * edits the catalog's config and secret keys only (entitlements stay on the licence), saves the
 * batch with PUT, lands a 422's `fields` on the rows and reloads after a 409 conflict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  AccountOverridesView,
  ProductCatalog,
  ProductUserDetail,
} from "../src/api.js";
import {
  ALL_ON,
  NONE,
  boot,
  resetConsole,
  type FetchLog,
} from "./consoleHarness.js";
import { API, CATALOG, NOW_S, writes } from "./licenseFixture.js";
import {
  accountOverrideCatalog,
  accountPayload,
} from "../src/console/pages/core/accountOverrides.js";

const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const USER = `${API}/users/${SUBJECT}`;
const OVERRIDES = `${USER}/overrides`;

function detail(): ProductUserDetail {
  return {
    subject: SUBJECT,
    createdAt: NOW_S - 1000,
    identityOn: false,
    contact: { email: "buyer@x.io", source: "license" },
    name: null,
    mergedFrom: [],
    licenses: [],
    devices: [],
    data: { bytes: 0, stores: [] },
    events: [],
    relinks: [],
    audit: [],
  };
}

function view(over: Partial<AccountOverridesView> = {}): AccountOverridesView {
  return {
    subject: SUBJECT,
    configOn: true,
    overrides: {
      config: {
        "feature.timeout": { state: "default", value: 30, updatedAt: NOW_S },
      },
      secrets: {
        "api.token": { state: "enforced", configured: true, updatedAt: NOW_S },
      },
    },
    updatedAt: NOW_S - 60,
    updatedBy: "u1",
    licenseLayerRetired: false,
    ...over,
  };
}

function bootUser(
  routes: Record<string, unknown> = {},
  services = ALL_ON,
): FetchLog {
  return boot(`#/p/djdl/users/${SUBJECT}`, {
    services,
    extra: {
      [USER]: { user: detail() },
      [OVERRIDES]: view(),
      [`${API}/config/catalog`]: CATALOG,
      [`PUT ${OVERRIDES}`]: { ok: true, subject: SUBJECT },
      ...routes,
    },
  });
}

async function editor(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", {
    name: "Account overrides",
  });
  return heading.closest("section")!;
}

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account overrides: the model", () => {
  it("edits the catalog's config and secret entries, never a flag", () => {
    const scoped = accountOverrideCatalog(CATALOG);
    expect(scoped.entries.map((e) => e.key)).toEqual([
      "feature.timeout",
      "api.token",
    ]);
    expect(scoped.schemaVersion).toBe(CATALOG.schemaVersion);
    // The original catalog is left alone: the licence editor still reads its flags.
    expect(CATALOG.entries).toHaveLength(3);
  });

  it("reads the GET as a payload with no entitlements, even a partial one", () => {
    expect(accountPayload(view())).toMatchObject({
      config: { "feature.timeout": { value: 30 } },
      secrets: { "api.token": { configured: true } },
      entitlements: {},
    });
    expect(accountPayload(undefined)).toEqual({
      config: {},
      secrets: {},
      entitlements: {},
    });
    expect(
      accountPayload({ subject: SUBJECT } as unknown as AccountOverridesView),
    ).toEqual({ config: {}, secrets: {}, entitlements: {} });
  });
});

describe("account overrides on a user's record", () => {
  it("draws config and secret keys on Overview, and no entitlement", async () => {
    bootUser();
    const section = await editor();
    expect(await within(section).findByText("feature.timeout")).toBeTruthy();
    expect(within(section).getByText("api.token")).toBeTruthy();
    expect(within(section).queryByText("flag.pro")).toBeNull();
    expect(
      within(section).getByText(
        /reach every device signed in to this account on this product/,
      ),
    ).toBeTruthy();
    expect(
      within(section).getByText(/Entitlements stay on each license/),
    ).toBeTruthy();
    const results = await axe(section);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("saves the batch with PUT", async () => {
    const log = bootUser();
    const section = await editor();
    const timeout = await within(section).findByLabelText(/^Timeout/);
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "60");
    await userEvent.click(
      await screen.findByRole("button", { name: /Save account overrides/ }),
    );
    await waitFor(() =>
      expect(writes(log)[0]).toMatchObject({
        path: OVERRIDES,
        method: "PUT",
        body: {
          updates: [{ key: "feature.timeout", state: "default", value: 60 }],
        },
      }),
    );
    expect(await screen.findByText("Account overrides saved")).toBeTruthy();
  });

  it("places a 422's fields on the rows that caused them", async () => {
    bootUser({
      [`PUT ${OVERRIDES}`]: new Response(
        JSON.stringify({
          error: { code: "bad_request", message: "validation failed" },
          fields: ["feature.timeout must be <= 120"],
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    });
    const section = await editor();
    const timeout = await within(section).findByLabelText(/^Timeout/);
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "60");
    await userEvent.click(
      await screen.findByRole("button", { name: /Save account overrides/ }),
    );
    expect(await screen.findByText("must be <= 120")).toBeTruthy();
  });

  it("says the overrides changed and reloads them after a 409 conflict", async () => {
    const log = bootUser({
      [`PUT ${OVERRIDES}`]: new Response(
        JSON.stringify({
          error: {
            code: "conflict",
            message:
              "These account overrides changed in the meantime. Reload and try again.",
          },
          code: "conflict",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    });
    const section = await editor();
    const timeout = await within(section).findByLabelText(/^Timeout/);
    const reads = () =>
      log.calls.filter((c) => c.method === "GET" && c.path === OVERRIDES)
        .length;
    const before = reads();
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "60");
    await userEvent.click(
      await screen.findByRole("button", { name: /Save account overrides/ }),
    );
    expect(
      await screen.findByText(
        "These account overrides changed in the meantime",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("says so when the catalog declares only entitlements", async () => {
    const flagsOnly: ProductCatalog = {
      schemaVersion: 3,
      entries: CATALOG.entries.filter((e) => e.kind === "flag"),
    };
    bootUser({ [`${API}/config/catalog`]: flagsOnly });
    const section = await editor();
    expect(
      await within(section).findByText("No config or secret keys to set"),
    ).toBeTruthy();
  });

  it("is not drawn while Config is off", async () => {
    const log = bootUser({}, { ...NONE, license: { enabled: true } });
    await screen.findByRole("heading", { level: 1, name: SUBJECT });
    await screen.findByRole("heading", { name: "Summary" });
    expect(
      screen.queryByRole("heading", { name: "Account overrides" }),
    ).toBeNull();
    expect(log.calls.some((c) => c.path === OVERRIDES)).toBe(false);
  });
});
