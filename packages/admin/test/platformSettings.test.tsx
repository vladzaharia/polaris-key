import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { activeSectionAt } from "../src/console/templates/Settings.js";
import { platformOverview } from "./feedsFixture.js";
import {
  ALERTS_NONE,
  PENDING,
  boot,
  resetConsole,
  type FetchLog,
  type RouteFn,
} from "./consoleHarness.js";

/**
 * Platform → Settings (notes/S-13 §9.1, chunk 4P-1) against A-13's settings API: the editable
 * four with value, source, ceiling lock, bounds, confirm levels, `expectedVersion` and the 409
 * flow, revert; the read-only inventory and secrets presence; the Keyring panel; History.
 */

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false } },
});

// The Platform section is a React.lazy chunk (shell/AppShell.tsx). Load it once up front so the
// first test does not pay its first transform and evaluation inside a findBy wait (it took ~900 ms
// of the 1 s budget alone, and missed it in a loaded deploy Verify run).
beforeAll(async () => {
  await import("../src/console/sections/platform/index.js");
});
beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const main = (): HTMLElement => screen.getByRole("main");
const nav = (): HTMLElement =>
  screen.getAllByRole("navigation", { name: "Console" })[0]!;

type Setting = Record<string, unknown>;

function lazyDeltas(over: Setting = {}): Setting {
  return {
    key: "LAZY_DELTAS",
    area: "background-jobs",
    label: "Lazy deltas",
    description:
      "Lets products opted in to lazy hot-pair deltas count demand and generate deltas.",
    kind: "switch",
    scripts: ["main", "deltas"],
    precedence: "ceiling",
    default: "off",
    deployValue: "runtime",
    value: "off",
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { on: "L1", off: "L0" },
    ...over,
  };
}

function maxBytes(over: Setting = {}): Setting {
  return {
    key: "LAZY_DELTA_MAX_BYTES",
    area: "background-jobs",
    label: "Lazy delta size cap",
    description: "The largest payload the delta consumer will encode.",
    kind: "integer",
    unit: "bytes",
    min: 1_048_576,
    max: 33_554_432,
    scripts: ["main", "deltas"],
    precedence: "runtime",
    default: 33_554_432,
    deployValue: "33554432",
    value: 33_554_432,
    source: "deploy",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { raise: "L1", lower: "L0" },
    ...over,
  };
}

function gcMode(over: Setting = {}): Setting {
  return {
    key: "BLOB_GC_MODE",
    area: "background-jobs",
    label: "Blob collector",
    description: "Runs the nightly collector.",
    kind: "switch",
    scripts: ["main"],
    precedence: "ceiling",
    default: "on",
    deployValue: null,
    value: "on",
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { on: "L1", off: "L0" },
    ...over,
  };
}

function grace(over: Setting = {}): Setting {
  return {
    key: "BLOB_GC_GRACE_DAYS",
    area: "background-jobs",
    label: "Blob collector grace period",
    description: "How long an object stays unreferenced.",
    kind: "integer",
    unit: "days",
    min: 1,
    max: 365,
    scripts: ["main"],
    precedence: "runtime",
    default: 30,
    deployValue: null,
    value: 21,
    source: "runtime",
    forcedOff: false,
    stored: {
      value: 21,
      valid: true,
      updatedAt: 1_790_000_000,
      updatedBy: "ops@x.io",
    },
    version: 3,
    confirm: { raise: "L0", lower: "L1" },
    ...over,
  };
}

function reservedNames(over: Setting = {}): Setting {
  return {
    key: "LICENSING_RESERVED_NAMES",
    area: "licensing",
    label: "Reserved entitlement names",
    description:
      "How a product catalog flag that declares a system key with an incompatible type is treated.",
    kind: "choice",
    options: [
      { value: "warn", label: "Warn" },
      { value: "error", label: "Refuse" },
    ],
    scripts: ["main"],
    precedence: "runtime",
    default: "warn",
    deployValue: null,
    value: "warn",
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { warn: "L0", error: "L1" },
    ...over,
  };
}

function reservedDisplayNames(over: Setting = {}): Setting {
  return {
    ...reservedNames(),
    key: "IDENTITY_RESERVED_DISPLAY_NAMES",
    area: "identity",
    label: "Reserved display names",
    description:
      "How a product name or listing name that uses a platform or store name is treated.",
    ...over,
  };
}

const RESERVED = {
  mode: "warn",
  keys: [
    {
      key: "channels",
      type: "string-array",
      rule: "The union of the tier's and the license's channels.",
    },
    {
      key: "deviceLimit",
      type: "integer",
      rule: "The license's own device limit, else the tier's, else the license's deviceLimit entitlement, else the product default.",
    },
  ],
  prefixes: ["license.", "app.", "pkey."],
  products: [
    {
      slug: "acme",
      name: "Acme",
      catalogVersion: 3,
      declarations: [
        {
          key: "channels",
          compatible: false,
          problem:
            'schema.type must be "array" (the system key is an array of strings)',
        },
      ],
    },
    {
      slug: "djdl",
      name: "djdl",
      catalogVersion: 7,
      declarations: [
        { key: "channels", compatible: true, problem: null },
        { key: "deviceLimit", compatible: true, problem: null },
      ],
    },
  ],
};

function view(over: Record<string, unknown> = {}) {
  return {
    settings: [
      lazyDeltas(),
      maxBytes(),
      gcMode(),
      grace(),
      reservedNames(),
      reservedDisplayNames(),
    ],
    storeAvailable: true,
    propagationSeconds: 30,
    deployTime: [
      { name: "PKEY_ENVIRONMENT", area: "deployment", value: "prod" },
      { name: "PLATFORM_ADMIN_GROUP", area: "identity", value: "pk-admins" },
      { name: "ADMIN_OIDC_ISSUER", area: "identity", value: null },
      { name: "ADMIN_OIDC_CLIENT_ID", area: "identity", value: null },
      {
        name: "PLATFORM_OIDC_ISSUER",
        area: "identity",
        value: "https://login.example.com",
      },
      {
        name: "PLATFORM_OIDC_CLIENT_ID",
        area: "identity",
        value: "console-client",
      },
      {
        name: "OIDC_ISSUER_ALLOWLIST",
        area: "identity",
        value: ["auth.acme.dev", "id.example.org"],
      },
      {
        name: "BLOB_ORIGIN",
        area: "delivery",
        value: "https://dl.example.com",
      },
      {
        name: "CONSOLE_ORIGIN",
        area: "delivery",
        value: "https://pk.example.com",
      },
      { name: "BLOBS_BUCKET_NAME", area: "delivery", value: "pk-blobs" },
      { name: "R2_ACCOUNT_ID", area: "delivery", value: null },
      { name: "GITHUB_APP_ID", area: "delivery", value: "12345" },
      {
        name: "PKG_ORIGIN",
        area: "delivery",
        value: "https://pkg.example.com",
      },
      { name: "PORTAL_EMAIL_FROM", area: "email", value: null },
      {
        name: "EMAIL_SENDER_ADDRESS",
        area: "email",
        value: "noreply@auth.example.com",
      },
      { name: "EMAIL_PRODUCT_DAILY_CAP", area: "email", value: null },
      { name: "EMAIL_APPLE_RELAY", area: "email", value: null },
      { name: "PLATFORM_KEK_ACTIVE", area: "keyring", value: "kek-2" },
      { name: "PLATFORM_KEK_ID", area: "keyring", value: null },
    ],
    secrets: [
      { name: "PLATFORM_KEK", set: false },
      { name: "PLATFORM_KEK_KEYS", set: true },
      { name: "KEY_HASH_PEPPER", set: true },
      { name: "ADMIN_SESSION_SECRET", set: true },
      { name: "PORTAL_SESSION_SECRET", set: false },
      { name: "R2_PARENT_ACCESS_KEY_ID", set: false },
    ],
    constants: [
      {
        name: "ADMIN_SESSION_TTL_SECONDS",
        label: "Console session length",
        help: "A console session ends after this, however active it is.",
        area: "Access",
        value: 28_800,
        unit: "seconds",
      },
      {
        name: "AUDIT_RETENTION_SECONDS",
        label: "Audit trail",
        help: "Audit and platform trail rows older than this are deleted nightly.",
        area: "Retention",
        value: 15_552_000,
        unit: "seconds",
      },
      {
        name: "LAZY_DELTA_MAX_BYTES_CEILING",
        label: "Lazy delta size ceiling",
        help: "The measured largest payload the delta consumer can encode.",
        area: "Storage and delivery",
        value: 33_554_432,
        unit: "bytes",
      },
    ],
    warnings: [
      {
        code: "console_oidc_shared",
        message:
          "The console signs in through the shared platform identity-provider client, the one customers use.",
        names: ["ADMIN_OIDC_ISSUER", "ADMIN_OIDC_CLIENT_ID"],
      },
      {
        code: "portal_session_secret_unset",
        message:
          "PORTAL_SESSION_SECRET is not set, so customer portal sessions cannot be signed.",
        names: ["PORTAL_SESSION_SECRET"],
      },
    ],
    ...over,
  };
}

const KEK = {
  ok: true,
  active: "kek-2",
  kids: ["kek-1", "kek-2"],
  counts: {
    keys: { "kek-2": 3, "kek-1": 1 },
    secrets: { "kek-2": 5 },
    managed: {},
  },
  remaining: 1,
  unopenable: 0,
  countsComplete: true,
  countsTruncated: [] as string[],
};

const HISTORY = {
  items: [
    {
      id: "pa2",
      at: 1_790_000_100,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "platform.setting.set",
      target: { kind: "setting", id: "BLOB_GC_GRACE_DAYS" },
      summary: "Set BLOB_GC_GRACE_DAYS to 21",
      before: { stored: null, version: 0, effective: 30, source: "default" },
      after: { stored: 21, version: 1, effective: 21, source: "runtime" },
    },
    {
      id: "pa1",
      at: 1_790_000_000,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "kek.reseal",
      target: { kind: "kek", id: "kek-2" },
      summary: "Re-sealed 12 value(s) under KEK kek-2 (0 remaining)",
      before: null,
      after: null,
    },
  ],
  nextCursor: null,
};

function routes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/manage/api/platform/version": {
      releaseTag: "v0.8.6",
      gitSha: null,
      cloudflare: null,
      protocolVersion: 4,
      discoveryVersion: 2,
      latestMigration: "0057_platform_operations.sql",
      environment: "prod",
    },
    "/manage/api/platform/settings": view(),
    "/manage/api/platform/reserved-names": RESERVED,
    "/manage/api/products/kek": KEK,
    "/manage/api/platform/activity": HISTORY,
    "/manage/api/platform/feeds": platformOverview(),
    "/manage/api/platform/alerts": ALERTS_NONE,
    ...over,
  };
}

/** A settings route that answers writes with `write` and GETs with the current view. */
function writable(
  write: (req: { method: string; path: string; body?: string }) => unknown,
  views: () => unknown = () => view(),
): RouteFn {
  return (_q, req) => (req.method === "GET" ? views() : write(req));
}

async function settingsPage(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  return main();
}

/** Advanced is folded; the sections inside it open it first. */
const IN_ADVANCED = ["Limits", "Keyring", "Secrets", "Identity provider"];

async function section(name: string): Promise<HTMLElement> {
  const page = await settingsPage();
  if (IN_ADVANCED.includes(name)) {
    const adv = await within(page).findByRole("region", { name: "Advanced" });
    const show = within(adv).queryByRole("button", { name: "Show" });
    if (show) await userEvent.click(show);
  }
  return within(page).findByRole("region", { name });
}

function writes(log: FetchLog, method: string) {
  return log.calls.filter(
    (c) =>
      c.method === method &&
      c.path.startsWith("/manage/api/platform/settings/"),
  );
}

const conflict = () =>
  new Response(
    JSON.stringify({
      error: {
        code: "bad_request",
        message:
          "the setting changed since it was loaded; reload and review it",
        reason: "version_conflict",
        currentVersion: 4,
      },
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );

describe("the Settings page in the Platform section", () => {
  it("is listed in the sidebar, open and current, and #/platform lands on it", async () => {
    boot("#/platform", { extra: routes() });
    await settingsPage();
    await waitFor(() =>
      expect(window.location.hash).toBe("#/platform/settings"),
    );
    const link = within(nav()).getByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("#/platform/settings");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.querySelector("svg[data-nav-icon]")).not.toBeNull();
    expect(document.title).toBe("Settings · Polaris Key Console");
  });

  it("shows a skeleton while loading, then a retryable error", async () => {
    boot("#/platform/settings", {
      extra: routes({ "/manage/api/platform/settings": PENDING }),
    });
    const page = await settingsPage();
    expect(page.querySelector("[data-skeleton='form']")).not.toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": new Response("{}", { status: 500 }),
      }),
    });
    const failed = await settingsPage();
    const alert = await within(failed).findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("the sections, ordered by use (ST-09)", () => {
  it("lists them in order, Platform ready first and Recently changed last", async () => {
    boot("#/platform/settings", { extra: routes() });
    const page = await settingsPage();
    await within(page).findByRole("region", { name: "Recently changed" });
    const titles = within(page)
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    const banner = within(page).getByRole("region", { name: "Platform ready" });
    const signin = within(page).getByRole("region", { name: "Sign-in" });
    expect(
      banner.compareDocumentPosition(signin) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const order = [
      "Sign-in",
      "Storefront and hosting",
      "Email and alerts",
      "Licensing",
      "Jobs",
      "Advanced",
      "Recently changed",
    ];
    expect(titles.filter((t) => order.includes(t ?? ""))).toEqual(order);
  });

  it("shows no area dropped: an unknown area falls to Advanced", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": view({
          settings: [
            lazyDeltas(),
            lazyDeltas({
              key: "FUTURE_SWITCH",
              area: "somewhere-new",
              label: "Future switch",
            }),
          ],
        }),
      }),
    });
    const page = await settingsPage();
    const advanced = await within(page).findByText("Future switch");
    expect(advanced.closest("#platform-advanced")).not.toBeNull();
  });

  it("says the platform is ready, or lists what is left to fix", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": view({ warnings: [] }),
      }),
    });
    await settingsPage();
    await section("Sign-in");
    // Complete: the banner goes.
    expect(
      within(main()).queryByRole("region", { name: "Platform ready" }),
    ).toBeNull();
  });

  it("the header's History button jumps to the trail", async () => {
    boot("#/platform/settings", { extra: routes() });
    const page = await settingsPage();
    await within(page).findByRole("region", { name: "Recently changed" });
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    fireEvent.click(
      await within(page).findByRole("button", { name: "History" }),
    );
    expect(scroll).toHaveBeenCalled();
  });

  it("lists every code limit the Worker reports", async () => {
    boot("#/platform/settings", { extra: routes() });
    const limits = await section("Limits");
    await userEvent.click(within(limits).getByRole("button", { name: /Show/ }));
    const reported = (view().constants as { name: string }[]).filter(
      (c) => c.name !== "ADMIN_SESSION_TTL_SECONDS",
    );
    for (const c of reported)
      expect(within(limits).getByText(c.name)).toBeTruthy();
  });
});

describe("Reserved display names (PX-W13)", () => {
  it("is an editable row in Sign-in, not in Jobs", async () => {
    boot("#/platform/settings", { extra: routes() });
    const identity = await section("Sign-in");
    const group = within(identity).getByRole("radiogroup", {
      name: "Reserved display names",
    });
    expect(
      within(group)
        .getByRole("radio", { name: "Warn" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const jobs = await section("Jobs");
    expect(within(jobs).queryByText("Reserved display names")).toBeNull();
  });
});

describe("Hosted assets (HA-10)", () => {
  const hosting = (over: Setting = {}): Setting =>
    gcMode({
      key: "ASSET_HOSTING",
      area: "delivery",
      label: "Hosted assets",
      description:
        "Serves Polaris Key's own copies of products' images from the image host and mirrors their release files.",
      precedence: "runtime",
      confirm: { on: "L1", off: "L1" },
      ...over,
    });
  const withHosting = (over: Setting = {}) =>
    view({
      settings: [
        lazyDeltas(),
        maxBytes(),
        gcMode(),
        grace(),
        reservedNames(),
        reservedDisplayNames(),
        hosting(over),
      ],
    });

  it("the switch is an editable row in Storefront and hosting, and turning it off asks first (L1)", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(
          () => hosting({ value: "off", source: "runtime", version: 1 }),
          () => withHosting(),
        ),
      }),
    });
    const delivery = await section("Storefront and hosting");
    const toggle = within(delivery).getByRole("switch", {
      name: "Hosted assets",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const jobs = await section("Jobs");
    expect(within(jobs).queryByText("Hosted assets")).toBeNull();
    await userEvent.click(toggle);
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/goes back to the developer's own image URLs/),
    ).toBeTruthy();
    expect(writes(log, "PATCH")).toHaveLength(0);
    await userEvent.click(
      within(dialog).getByRole("button", { name: /hosted assets$/ }),
    );
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    expect(writes(log, "PATCH")[0]!.path).toBe(
      "/manage/api/platform/settings/ASSET_HOSTING",
    );
    expect(JSON.parse(writes(log, "PATCH")[0]!.body!)).toEqual({
      value: "off",
      expectedVersion: 0,
    });
  });
});

describe("Licensing (LX-05)", () => {
  it("shows the reserved-names severity, the reserved keys and each declaring product", async () => {
    boot("#/platform/settings", { extra: routes() });
    const licensing = await section("Licensing");
    const group = within(licensing).getByRole("radiogroup", {
      name: "Reserved entitlement names",
    });
    expect(
      within(group)
        .getByRole("radio", { name: "Warn" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const keys = await within(licensing).findByRole("list", {
      name: "Reserved keys",
    });
    expect(within(keys).getByText("deviceLimit")).toBeTruthy();
    expect(within(keys).getByText("array of strings")).toBeTruthy();
    // Only an issue gets a pill; a compatible product reads plainly.
    expect(within(licensing).getByText("1 incompatible")).toBeTruthy();
    expect(within(licensing).getByText("Compatible")).toBeTruthy();
    expect(
      within(licensing).getByText(/schema.type must be "array"/),
    ).toBeTruthy();
    // The background-jobs section does not carry the licensing setting.
    const jobs = await section("Jobs");
    expect(within(jobs).queryByText("Reserved entitlement names")).toBeNull();
  });

  it("confirms switching to refuse (L1), then saves it with expectedVersion", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(() =>
          reservedNames({ value: "error", source: "runtime", version: 1 }),
        ),
      }),
    });
    const licensing = await section("Licensing");
    await userEvent.click(
      within(licensing).getByRole("radio", { name: "Refuse" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        /fails its next resync until its catalog is fixed/,
      ),
    ).toBeTruthy();
    expect(writes(log, "PATCH")).toHaveLength(0);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set to refuse" }),
    );
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    expect(writes(log, "PATCH")[0]!.path).toBe(
      "/manage/api/platform/settings/LICENSING_RESERVED_NAMES",
    );
    expect(JSON.parse(writes(log, "PATCH")[0]!.body!)).toEqual({
      value: "error",
      expectedVersion: 0,
    });
  });

  it("says so when no product declares a reserved name", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/reserved-names": { ...RESERVED, products: [] },
      }),
    });
    const licensing = await section("Licensing");
    expect(
      await within(licensing).findByText("No product declares a reserved name"),
    ).toBeTruthy();
  });
});

describe("Background jobs", () => {
  it("shows each setting's effective value and where it comes from", async () => {
    boot("#/platform/settings", { extra: routes() });
    const jobs = await section("Jobs");
    expect(
      within(jobs).getByRole("switch", { name: "Lazy deltas" }),
    ).toHaveProperty("ariaChecked", "false");
    expect(
      within(jobs).getByRole("switch", { name: "Blob collector" }),
    ).toHaveProperty("ariaChecked", "true");
    expect(within(jobs).getAllByText("Code default").length).toBe(2);
    expect(within(jobs).getByText("Deploy var")).toBeTruthy();
    expect(within(jobs).getByText("Set in console")).toBeTruthy();
    // The byte cap is shown in MiB, with the exact bytes in effect.
    expect(
      (within(jobs).getByLabelText(/\(MiB\)$/) as HTMLInputElement).value,
    ).toBe("32");
    expect(within(jobs).getByText("In effect: 33,554,432 bytes.")).toBeTruthy();
    expect(
      (within(jobs).getByLabelText(/\(days\)$/) as HTMLInputElement).value,
    ).toBe("21");
  });

  it("locks a kill switch that the deploy var forces off, and says why", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": view({
          settings: [
            lazyDeltas({
              deployValue: "off",
              source: "deploy",
              forcedOff: true,
              stored: {
                value: "on",
                valid: true,
                updatedAt: 1_790_000_000,
                updatedBy: "ops@x.io",
              },
              version: 2,
            }),
            maxBytes(),
            gcMode(),
            grace(),
          ],
        }),
      }),
    });
    const jobs = await section("Jobs");
    const toggle = within(jobs).getByRole("switch", { name: "Lazy deltas" });
    expect(toggle).toHaveProperty("disabled", true);
    expect(within(jobs).getByText("Locked off by deploy var")).toBeTruthy();
    expect(within(jobs).getByText("Turned off at deploy time")).toBeTruthy();
    expect(
      within(jobs).getByText(/A console value of On is stored/),
    ).toBeTruthy();
  });

  it("turns a switch off at once (L0) with expectedVersion, then Undo reverts it", async () => {
    let version = 0;
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(
          (req) => {
            version += 1;
            return req.method === "PATCH"
              ? gcMode({
                  value: "off",
                  source: "runtime",
                  version,
                  stored: {
                    value: "off",
                    valid: true,
                    updatedAt: 1_790_000_200,
                    updatedBy: "u1",
                  },
                })
              : gcMode({ version: 0 });
          },
          () => view(),
        ),
      }),
    });
    const jobs = await section("Jobs");
    const settingsReads = () =>
      log.calls.filter(
        (c) => c.method === "GET" && c.path === "/manage/api/platform/settings",
      ).length;
    const before = settingsReads();
    await userEvent.click(
      within(jobs).getByRole("switch", { name: "Blob collector" }),
    );
    // No confirmation for an L0 change.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    const patch = writes(log, "PATCH")[0]!;
    expect(patch.path).toBe("/manage/api/platform/settings/BLOB_GC_MODE");
    expect(JSON.parse(patch.body!)).toEqual({
      value: "off",
      expectedVersion: 0,
    });
    // The settings list and the platform trail are refetched.
    await waitFor(() => expect(settingsReads()).toBeGreaterThan(before));
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    await waitFor(() => expect(writes(log, "DELETE")).toHaveLength(1));
    expect(writes(log, "DELETE")[0]!.query).toBe("expectedVersion=1");
  });

  it("a switch flipped while the write fails shows the value in force, plus the error", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(
          () => new Response("{}", { status: 500 }),
          () => view(),
        ),
      }),
    });
    const jobs = await section("Jobs");
    const sw = within(jobs).getByRole("switch", { name: "Blob collector" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(jobs)
          .getByRole("switch", { name: "Blob collector" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(await within(jobs).findAllByRole("alert")).not.toHaveLength(0);
  });

  it("a switch refused with a 409 goes back to the value in force", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(
          () => conflict(),
          () => view(),
        ),
      }),
    });
    const jobs = await section("Jobs");
    await userEvent.click(
      within(jobs).getByRole("switch", { name: "Blob collector" }),
    );
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    expect(
      await within(jobs).findByText("This setting changed since you loaded it"),
    ).toBeTruthy();
    expect(
      within(jobs)
        .getByRole("switch", { name: "Blob collector" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("asks before turning lazy deltas on (L1), and cancelling sends nothing", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(() =>
          lazyDeltas({ value: "on", source: "runtime", version: 1 }),
        ),
      }),
    });
    const jobs = await section("Jobs");
    await userEvent.click(
      within(jobs).getByRole("switch", { name: "Lazy deltas" }),
    );
    let dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/start counting demand and generating deltas/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(writes(log, "PATCH")).toHaveLength(0);

    await userEvent.click(
      within(jobs).getByRole("switch", { name: "Lazy deltas" }),
    );
    dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Turn on lazy deltas" }),
    );
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    expect(JSON.parse(writes(log, "PATCH")[0]!.body!)).toEqual({
      value: "on",
      expectedVersion: 0,
    });
  });

  it("keeps the byte cap at or under the 32 MiB ceiling, and saves a lower value (L0)", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(() =>
          maxBytes({ value: 16_777_216, source: "runtime", version: 1 }),
        ),
      }),
    });
    const jobs = await section("Jobs");
    const input = within(jobs).getByLabelText(/\(MiB\)$/);
    await userEvent.clear(input);
    await userEvent.type(input, "40");
    const bar = await within(jobs).findByRole("region", {
      name: "Unsaved changes in Lazy delta size cap",
    });
    await userEvent.click(within(bar).getByRole("button", { name: "Save…" }));
    expect(await within(jobs).findByText("Use 32 or less.")).toBeTruthy();
    expect(writes(log, "PATCH")).toHaveLength(0);

    await userEvent.clear(input);
    await userEvent.type(input, "16");
    await userEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    expect(JSON.parse(writes(log, "PATCH")[0]!.body!)).toEqual({
      value: 16_777_216,
      expectedVersion: 0,
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirms lowering the collector's grace (L1) before saving it", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(() =>
          grace({ value: 14, version: 4 }),
        ),
      }),
    });
    const jobs = await section("Jobs");
    const input = within(jobs).getByLabelText(/\(days\)$/);
    await userEvent.clear(input);
    await userEvent.type(input, "14");
    const bar = await within(jobs).findByRole("region", {
      name: "Unsaved changes in Blob collector grace period",
    });
    await userEvent.click(within(bar).getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/unreferenced for 14 days become eligible/),
    ).toBeTruthy();
    expect(writes(log, "PATCH")).toHaveLength(0);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save 14 days" }),
    );
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    expect(JSON.parse(writes(log, "PATCH")[0]!.body!)).toEqual({
      value: 14,
      expectedVersion: 3,
    });
  });

  it("explains a 409, reloads, and retries the draft with the new version", async () => {
    let current = grace();
    let answer: () => unknown = conflict;
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(
          () => answer(),
          () =>
            view({ settings: [lazyDeltas(), maxBytes(), gcMode(), current] }),
        ),
      }),
    });
    const jobs = await section("Jobs");
    const input = within(jobs).getByLabelText(/\(days\)$/);
    await userEvent.clear(input);
    await userEvent.type(input, "60");
    const bar = await within(jobs).findByRole("region", {
      name: "Unsaved changes in Blob collector grace period",
    });
    // Raising the grace is L0: no dialog.
    await userEvent.click(within(bar).getByRole("button", { name: "Save" }));
    expect(
      await within(jobs).findByText("This setting changed since you loaded it"),
    ).toBeTruthy();

    // Someone else set 45 meanwhile (version 4).
    current = grace({
      value: 45,
      version: 4,
      stored: {
        value: 45,
        valid: true,
        updatedAt: 1_790_000_300,
        updatedBy: "grace@x.io",
      },
    });
    answer = () => grace({ value: 60, version: 5 });
    await userEvent.click(within(jobs).getByRole("button", { name: "Reload" }));
    expect(await within(jobs).findByText("Reloaded")).toBeTruthy();
    expect(
      within(jobs).getByText(/It now reads 45 days, set by grace@x.io/),
    ).toBeTruthy();
    // The draft survived the reload.
    expect((input as HTMLInputElement).value).toBe("60");
    await userEvent.click(
      within(
        within(jobs).getByRole("region", {
          name: "Unsaved changes in Blob collector grace period",
        }),
      ).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(2));
    expect(JSON.parse(writes(log, "PATCH")[1]!.body!)).toEqual({
      value: 60,
      expectedVersion: 4,
    });
  });

  it("reverts a console value to the default after a confirmation", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(() =>
          grace({ value: 30, source: "default", stored: null, version: 0 }),
        ),
      }),
    });
    const jobs = await section("Jobs");
    await userEvent.click(
      within(jobs).getByRole("button", {
        name: "Revert blob collector grace period…",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/becomes 30 days, from the code default/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revert to 30 days" }),
    );
    await waitFor(() => expect(writes(log, "DELETE")).toHaveLength(1));
    const del = writes(log, "DELETE")[0]!;
    expect(del.path).toBe("/manage/api/platform/settings/BLOB_GC_GRACE_DAYS");
    expect(del.query).toBe("expectedVersion=3");
  });

  it("says when the store cannot be read and disables the controls", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": view({
          storeAvailable: false,
          settings: [
            lazyDeltas({ source: "failsafe" }),
            maxBytes(),
            gcMode({ value: "off", source: "failsafe" }),
            grace({ source: "deploy", stored: null, version: 0 }),
          ],
        }),
      }),
    });
    const jobs = await section("Jobs");
    expect(
      within(jobs).getByText("The settings store cannot be read"),
    ).toBeTruthy();
    expect(
      within(jobs).getByRole("switch", { name: "Blob collector" }),
    ).toHaveProperty("disabled", true);
    expect(within(jobs).getAllByText("Off: store unreadable")).toHaveLength(2);
  });

  it("flags a stored value that is out of bounds", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": view({
          settings: [
            lazyDeltas(),
            maxBytes({
              stored: {
                value: 99_999_999,
                valid: false,
                updatedAt: 1,
                updatedBy: "u1",
              },
              version: 2,
            }),
            gcMode(),
            grace(),
          ],
        }),
      }),
    });
    const jobs = await section("Jobs");
    expect(within(jobs).getByText("Stored value not applied")).toBeTruthy();
    expect(
      within(jobs).getByText(/uses the deploy var \(32 MiB\)/),
    ).toBeTruthy();
  });
});

describe("the read-only inventory", () => {
  it("shows deploy-time values, the console-client fallback and the warnings", async () => {
    boot("#/platform/settings", { extra: routes() });
    const signin = await section("Sign-in");
    expect(within(signin).getByText("8 hours")).toBeTruthy();
    const identity = await section("Identity provider");
    expect(within(identity).getByText("pk-admins")).toBeTruthy();
    expect(
      within(identity).getAllByText(
        "Not set: the console uses the platform client",
      ),
    ).toHaveLength(2);
    expect(
      within(identity).getByText("https://login.example.com"),
    ).toBeTruthy();
    expect(within(identity).getByText("auth.acme.dev")).toBeTruthy();
    const delivery = await section("Storefront and hosting");
    expect(within(delivery).getByText("Production")).toBeTruthy();
    expect(within(delivery).getByText("https://dl.example.com")).toBeTruthy();
    // ST-02: the deploy vars the inventory added are read out too.
    expect(within(delivery).getByText("https://pkg.example.com")).toBeTruthy();
    const email = await section("Email and alerts");
    expect(within(email).getByText("noreply@auth.example.com")).toBeTruthy();
    expect(within(email).getByText("Not set: 500")).toBeTruthy();
    expect(within(email).getByText("Not registered")).toBeTruthy();
    const warnings = within(main()).getByRole("region", {
      name: "Platform ready",
    });
    await userEvent.click(
      within(warnings).getByRole("button", { name: /^Show all/ }),
    );
    expect(
      within(warnings).getByText("Polaris Locker sessions cannot be signed"),
    ).toBeTruthy();
    expect(
      within(warnings).getByText(/The console shares the customer sign-in/),
    ).toBeTruthy();
    // Each warning goes where it is fixed.
    expect(
      within(warnings)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(
      expect.arrayContaining(["Go to Identity provider", "Go to Secrets"]),
    );
  });

  it("collapses the code limits until asked", async () => {
    boot("#/platform/settings", { extra: routes() });
    const limits = await section("Limits");
    expect(within(limits).queryByText("Audit retention")).toBeNull();
    await userEvent.click(
      within(limits).getByRole("button", { name: "Show 2" }),
    );
    expect(within(limits).getByText("Audit trail")).toBeTruthy();
    expect(within(limits).getByText("180 days")).toBeTruthy();
    expect(within(limits).getByText("32 MiB")).toBeTruthy();
  });

  it("lists secrets as set or not set, never a value", async () => {
    boot("#/platform/settings", { extra: routes() });
    const secrets = await section("Secrets");
    const list = within(secrets).getByRole("list", { name: "Worker secrets" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    const pepper = rows.find((r) =>
      r.textContent?.includes("KEY_HASH_PEPPER"),
    )!;
    expect(within(pepper).getByText("Set")).toBeTruthy();
    const portal = rows.find((r) =>
      r.textContent?.includes("PORTAL_SESSION_SECRET"),
    )!;
    expect(within(portal).getByText("Not set")).toBeTruthy();
    expect(
      within(portal).getByText(/Falls back to ADMIN_SESSION_SECRET/),
    ).toBeTruthy();
    const r2 = rows.find((r) => r.textContent?.includes("R2_PARENT_ACCESS"))!;
    expect(within(r2).getByText(/Trusted publishing is off/)).toBeTruthy();
  });
});

describe("Keyring", () => {
  it("shows the active key, the ring, re-seal progress and the runbook link", async () => {
    boot("#/platform/settings", { extra: routes() });
    const keyring = await section("Keyring");
    expect(await within(keyring).findByText("Active")).toBeTruthy();
    const ring = within(keyring).getByRole("list", {
      name: "Keys in the ring",
    });
    expect(within(ring).getByText("kek-1")).toBeTruthy();
    expect(within(ring).getByText("1 sealed")).toBeTruthy();
    expect(within(ring).getByText("8 sealed")).toBeTruthy();
    expect(within(keyring).getByText("1 still on an older key")).toBeTruthy();
    expect(
      within(keyring)
        .getByRole("link", { name: /Keyring runbook/ })
        .getAttribute("href"),
    ).toBe("/docs/admin/kek/");
    // Read-only: nothing to press but the link.
    expect(within(keyring).queryAllByRole("button")).toEqual([]);
  });

  it("shows PLATFORM_KEK beside the ring as the legacy key, open only, until nothing is under it", async () => {
    const legacyKek = {
      ok: true,
      active: "kek-2",
      kids: ["kek-2", "default"],
      counts: {
        keys: { "kek-2": 3, default: 2 },
        platformCredentials: { default: 1 },
      },
      remaining: 3,
      unopenable: 0,
      countsComplete: true,
      countsTruncated: [],
      legacy: {
        kid: "default",
        openOnly: true,
        remaining: 3,
        workerSecrets: ["SIGNIN_STEAM_WEB_API_KEY"],
        safeToDelete: false,
      },
    };
    boot("#/platform/settings", {
      extra: routes({ "/manage/api/products/kek": legacyKek }),
    });
    const keyring = await section("Keyring");
    const ring = await within(keyring).findByRole("list", {
      name: "Keys in the ring",
    });
    const legacyRow = within(ring)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("default"))!;
    expect(within(legacyRow).getByText("Legacy, open only")).toBeTruthy();
    expect(within(keyring).getByText("3 still under default")).toBeTruthy();
    expect(within(keyring).getByText("SIGNIN_STEAM_WEB_API_KEY")).toBeTruthy();
    // The store-credential bucket is labelled, not shown by its API name.
    expect(
      within(keyring).getByText("Store connection credentials"),
    ).toBeTruthy();
    const results = await axe(keyring);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("says when PLATFORM_KEK can be deleted", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/products/kek": {
          ...KEK,
          kids: ["kek-1", "kek-2", "default"],
          legacy: {
            kid: "default",
            openOnly: true,
            remaining: 0,
            workerSecrets: [],
            safeToDelete: true,
          },
        },
      }),
    });
    const keyring = await section("Keyring");
    expect(
      await within(keyring).findByText("Safe to delete PLATFORM_KEK"),
    ).toBeTruthy();
  });

  it("never reads a cut-short scan as done: the counts are minimums and a notice names the tables", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/products/kek": {
          ...KEK,
          remaining: 1,
          countsComplete: false,
          countsTruncated: ["profiles", "licenses"],
        },
      }),
    });
    const keyring = await section("Keyring");
    expect(
      await within(keyring).findByText("At least 1 still on an older key"),
    ).toBeTruthy();
    expect(
      within(keyring).getByText("These counts are not complete"),
    ).toBeTruthy();
    expect(within(keyring).getByText(/profiles, licenses/)).toBeTruthy();
    // Nothing on the panel claims the ring is finished.
    expect(
      within(keyring).queryByText("Every value is under the active key"),
    ).toBeNull();
    expect(
      within(keyring).queryByText("Safe to delete PLATFORM_KEK"),
    ).toBeNull();
  });

  it("shows no incompleteness notice when the scan covered every row", async () => {
    boot("#/platform/settings", { extra: routes({}) });
    const keyring = await section("Keyring");
    expect(
      await within(keyring).findByText("1 still on an older key"),
    ).toBeTruthy();
    expect(
      within(keyring).queryByText("These counts are not complete"),
    ).toBeNull();
  });

  it("says when the keyring is unusable", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/products/kek": new Response(
          JSON.stringify({
            error: {
              code: "bad_request",
              message: "platform KEK keyring is unusable: ring did not parse",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      }),
    });
    const keyring = await section("Keyring");
    expect(
      await within(keyring).findByText("The platform keyring is unusable"),
    ).toBeTruthy();
    expect(within(keyring).getByText(/ring did not parse/)).toBeTruthy();
  });
});

describe("History", () => {
  it("lists only setting changes from the platform trail, with before and after", async () => {
    boot("#/platform/settings", { extra: routes() });
    const history = await section("Recently changed");
    expect(await within(history).findByText("Ada Lovelace")).toBeTruthy();
    // The old value is struck through, the new one plain.
    const old = within(history).getByText("30 days", { selector: "del" });
    expect(old.tagName).toBe("DEL");
    expect(within(history).getByText(/21 days/)).toBeTruthy();
    expect(within(history).queryByText(/Re-sealed/)).toBeNull();
  });

  it("explains an empty history", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/activity": { items: [], nextCursor: null },
      }),
    });
    const history = await section("Recently changed");
    expect(
      await within(history).findByText("No setting changes yet"),
    ).toBeTruthy();
  });
});

describe("accessibility", () => {
  it("passes axe", async () => {
    boot("#/platform/settings", { extra: routes() });
    const page = await settingsPage();
    await section("Keyring");
    await within(page).findByText("Ada Lovelace");
    await within(page).findByText("Active");
    const results = await axe(page);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Package feeds policy in Storefront and hosting (ST-09)", () => {
  const policyPut = (log: FetchLog) =>
    log.calls.filter(
      (c) => c.method === "PUT" && c.path.endsWith("/feeds/npm/policy"),
    );

  it("moved here: a switch and a size ceiling per ecosystem", async () => {
    boot("#/platform/settings", { extra: routes() });
    const hosting = await section("Storefront and hosting");
    const sw = within(hosting).getByRole("switch", { name: "Serve npm" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(
      within(hosting).getByLabelText("npm size ceiling (MiB)"),
    ).toBeTruthy();
    expect(
      within(hosting).getByRole("switch", { name: "Serve Godot" }),
    ).toBeTruthy();
  });

  it("stopping an ecosystem names every product (L2) before it saves with expectedVersion", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "PUT /manage/api/platform/feeds/npm/policy": {
          ok: true,
          policy: {
            enabled: false,
            maxPackageBytesCeiling: 52_428_800,
            version: 2,
            updatedAt: 1,
            updatedBy: "ada",
          },
        },
      }),
    });
    const hosting = await section("Storefront and hosting");
    await userEvent.click(
      within(hosting).getByRole("switch", { name: "Serve npm" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Stop serving npm for every product?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Every product's npm feed.*not-found/),
    ).toBeTruthy();
    expect(policyPut(log)).toHaveLength(0);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stop serving npm" }),
    );
    await waitFor(() => expect(policyPut(log)).toHaveLength(1));
    expect(JSON.parse(policyPut(log)[0]!.body!)).toEqual({
      expectedVersion: 1,
      enabled: false,
    });
  });

  it("Escape backs out of the confirmation and focus returns to the switch (keyboard)", async () => {
    const log = boot("#/platform/settings", { extra: routes() });
    const hosting = await section("Storefront and hosting");
    const sw = within(hosting).getByRole("switch", { name: "Serve npm" });
    sw.focus();
    await userEvent.keyboard(" ");
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(sw);
    expect(policyPut(log)).toHaveLength(0);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("is read-only without Platform edit, and says who to ask", async () => {
    boot("#/platform/settings", {
      extra: routes(),
      me: {
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console", "platform"], edit: ["console"] },
          products: {},
        },
      },
    });
    const hosting = await section("Storefront and hosting");
    // A view-only value is text with a lock, never a faint disabled control.
    expect(within(hosting).queryByRole("switch")).toBeNull();
    expect(within(hosting).getAllByText("On").length).toBeGreaterThan(0);
    const jobs = await section("Jobs");
    expect(within(jobs).queryByRole("switch")).toBeNull();
    expect(within(jobs).getByText("Off")).toBeTruthy();
    // One notice for the page, not one reason per row; the row keeps a lock.
    const notice = within(main()).getByText("You can view these settings");
    expect(notice).toBeTruthy();
    expect(
      within(notice.closest("[data-tone]") as HTMLElement).getByText(
        /Platform edit access/,
      ),
    ).toBeTruthy();
    expect(
      within(main()).queryByRole("button", { name: /^Revert/ }),
    ).toBeNull();
  });
});

describe("Limits (ST-09)", () => {
  it("has one h1 and an axe-clean page with every group open", async () => {
    boot("#/platform/settings", { extra: routes() });
    const limits = await section("Limits");
    await userEvent.click(within(limits).getByRole("button", { name: /Show/ }));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });

  it("groups the Worker's inventory by area, one named group each", async () => {
    boot("#/platform/settings", { extra: routes() });
    const limits = await section("Limits");
    await userEvent.click(within(limits).getByRole("button", { name: /Show/ }));
    for (const name of ["Retention", "Storage and delivery"])
      expect(within(limits).getByRole("group", { name })).toBeTruthy();
  });
});

describe("fix round (ST-09 UX review)", () => {
  it("a ceiling is checked as you type and Save waits for a valid one", async () => {
    boot("#/platform/settings", { extra: routes() });
    const hosting = await section("Storefront and hosting");
    const input = within(hosting).getByLabelText("npm size ceiling (MiB)");
    await userEvent.clear(input);
    await userEvent.type(input, "6000");
    expect(within(hosting).getByText("Enter 5,120 MiB or less.")).toBeTruthy();
    expect(
      (
        within(hosting).getByRole("button", {
          name: "Save",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    expect(within(hosting).getByText("Enter at least 1 MiB.")).toBeTruthy();
  });

  it("Platform ready leads with the most severe item and uses the danger tone", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": view({
          warnings: [
            {
              code: "portal_session_secret_unset",
              message: "PORTAL_SESSION_SECRET is not set.",
              names: [],
            },
            {
              code: "kek_keyring_unusable",
              message: "The keyring does not load.",
              names: [],
            },
          ],
        }),
      }),
    });
    const banner = await section("Platform ready");
    const callout = banner.querySelector("[data-tone]")!;
    expect(callout.getAttribute("data-tone")).toBe("danger");
    expect(callout.textContent).toContain("The KEK keyring does not load");
    expect(within(banner).getByText(/^2 to fix/)).toBeTruthy();
    expect(
      within(banner).getByRole("link", { name: "Go to Keyring" }),
    ).toBeTruthy();
  });

  it("a viewer's page has no Revert, shows values as text, and passes axe", async () => {
    boot("#/platform/settings", {
      extra: routes(),
      me: {
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console", "platform"], edit: ["console"] },
          products: {},
        },
      },
    });
    const jobs = await section("Jobs");
    expect(within(jobs).queryByRole("button", { name: /^Revert/ })).toBeNull();
    expect(within(jobs).queryByLabelText(/\(days\)$/)).toBeNull();
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("section navigation (ST-09 UX review)", () => {
  it("has a picker on phone and pills on tablet, and a click puts the section in the address", async () => {
    boot("#/platform/settings", { extra: routes() });
    await settingsPage();
    await section("Jobs");
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const picker = screen.getByRole("combobox", { name: "Jump to section" });
    expect(picker).toBeTruthy();
    const pills = screen.getByRole("navigation", { name: "Jump to section" });
    await userEvent.click(within(pills).getByRole("link", { name: "Jobs" }));
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/platform/settings?section=platform-jobs",
      ),
    );
    expect(document.activeElement?.id).toBe("platform-jobs");
    // The current section is marked in the rail and the pills; the first until the scroll moves.
    expect(
      within(nav()).queryAllByRole("link", { current: "location" }).length,
    ).toBeLessThanOrEqual(1);
  });

  it("a shared link opens at its section", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    boot("#/platform/settings?section=platform-licensing", {
      extra: routes(),
    });
    await section("Licensing");
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("platform-licensing"),
    );
  });
});

describe("section navigation: current section and unsaved edits (ST-09)", () => {
  it("activeSectionAt marks the last section whose top is above the line, and the last at the foot", () => {
    expect(activeSectionAt([-900, -300, 40, 700], 96, false)).toBe(2);
    expect(activeSectionAt([200, 500, 900], 96, false)).toBe(0);
    // A short last section never reaches the line: at the foot it is the current one.
    expect(activeSectionAt([-900, -300, 40, 700], 96, true)).toBe(3);
    expect(activeSectionAt([], 96, true)).toBe(-1);
  });

  it("a jump marks the chosen section at once, in the pills and the picker, and a deep link marks its section", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    boot("#/platform/settings", { extra: routes() });
    await settingsPage();
    await section("Jobs");
    const pills = screen.getByRole("navigation", { name: "Jump to section" });
    await userEvent.click(within(pills).getByRole("link", { name: "Jobs" }));
    expect(
      within(pills)
        .getAllByRole("link", { current: "location" })
        .map((a) => a.textContent),
    ).toEqual(["Jobs"]);
    expect(
      (
        screen.getByRole("combobox", {
          name: "Jump to section",
        }) as HTMLSelectElement
      ).value,
    ).toBe("platform-jobs");
    // The last section (Recently changed) is markable too.
    await userEvent.click(
      within(pills).getByRole("link", { name: "Recently changed" }),
    );
    expect(
      within(pills)
        .getAllByRole("link", { current: "location" })
        .map((a) => a.textContent),
    ).toEqual(["Recently changed"]);
    cleanup();
    resetConsole();
    boot("#/platform/settings?section=platform-licensing", { extra: routes() });
    await settingsPage();
    const again = await screen.findByRole("navigation", {
      name: "Jump to section",
    });
    await waitFor(() =>
      expect(
        within(again)
          .getAllByRole("link", { current: "location" })
          .map((a) => a.textContent),
      ).toEqual(["Licensing"]),
    );
  });

  it("a jump with a draft in a field asks nothing and keeps the draft", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    boot("#/platform/settings", { extra: routes() });
    const hosting = await section("Storefront and hosting");
    const input = within(hosting).getByLabelText("npm size ceiling (MiB)");
    await userEvent.clear(input);
    await userEvent.type(input, "80");
    const pills = screen.getByRole("navigation", { name: "Jump to section" });
    await userEvent.click(within(pills).getByRole("link", { name: "Jobs" }));
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/platform/settings?section=platform-jobs",
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((input as HTMLInputElement).value).toBe("80");
  });
});

describe("Advanced is folded (ST-09)", () => {
  it("opens from a Go to link inside it", async () => {
    boot("#/platform/settings", { extra: routes() });
    const page = await settingsPage();
    const adv = await within(page).findByRole("region", { name: "Advanced" });
    expect(within(adv).queryByRole("region", { name: "Keyring" })).toBeNull();
    await within(page).findByRole("region", { name: "Platform ready" });
    await userEvent.click(
      within(page).getByRole("button", { name: /^Show all/ }),
    );
    HTMLElement.prototype.scrollIntoView = vi.fn();
    await userEvent.click(
      within(page).getByRole("link", { name: "Go to Secrets" }),
    );
    await within(adv).findByRole("region", { name: "Secrets" });
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("platform-secrets"),
    );
  });
});

describe("Product defaults (ST-16)", () => {
  const keyLimit = (over: Setting = {}): Setting => ({
    key: "identity.keyEntry.limit",
    area: "product-defaults",
    label: "Key-entry limit ceiling",
    description: "The most key entries any product may allow.",
    kind: "integer",
    unit: "count",
    min: 1,
    max: 100,
    scripts: ["main"],
    precedence: "runtime",
    default: 100,
    deployValue: null,
    value: 100,
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    link: "bound",
    fleet: { kind: "bound", total: 3, count: 0, products: [] },
    confirm: { raise: "L2", lower: "L2" },
    ...over,
  });
  const quota = (over: Setting = {}): Setting => ({
    key: "assets.quota.mediaBytes",
    area: "product-defaults",
    label: "Default media quota",
    description: "How many bytes of hosted images a product may hold.",
    kind: "integer",
    unit: "bytes",
    min: 0,
    max: 1_099_511_627_776,
    scripts: ["main"],
    precedence: "runtime",
    default: 536_870_912,
    deployValue: null,
    value: 536_870_912,
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    link: "default",
    fleet: {
      kind: "default",
      total: 14,
      inheriting: 12,
      own: [{ product: "acme", name: "Acme", value: 8_589_934_592 }],
    },
    confirm: { raise: "L2", lower: "L2" },
    ...over,
  });
  const withDefaults = (k: Setting = keyLimit()) =>
    view({ settings: [lazyDeltas(), k, quota()] });
  const withQuota = (q: Setting) =>
    view({ settings: [lazyDeltas(), keyLimit(), q] });
  const REACH = "/manage/api/platform/settings/identity.keyEntry.limit/reach";
  const lowerReach = {
    kind: "bound",
    direction: "lower",
    total: 14,
    reaches: 4,
    from: 100,
    to: 10,
    products: [
      { product: "acme", name: "Acme", from: 30, to: 10, inherited: false },
      { product: "tide", name: "Tidewater", from: 10, to: 5, inherited: true },
    ],
  };

  async function openKeyDialog(to: string) {
    const defaults = await section("Product defaults");
    const input = within(defaults).getByLabelText(/Key-entry limit ceiling/);
    await userEvent.clear(input);
    await userEvent.type(input, to);
    const bar = await within(defaults).findByRole("region", {
      name: "Unsaved changes in Key-entry limit ceiling",
    });
    await userEvent.click(within(bar).getByRole("button", { name: "Save…" }));
    return screen.findByRole("alertdialog");
  }

  it("is a section with its rows and pills; a default says who uses it", async () => {
    boot("#/platform/settings", {
      extra: routes({ "/manage/api/platform/settings": withDefaults() }),
    });
    const defaults = await section("Product defaults");
    expect(within(defaults).getByText("Key-entry limit ceiling")).toBeTruthy();
    expect(
      within(defaults).getByText(
        "12 of 14 products use this · \u2068Acme\u2069 sets 8 GiB",
      ),
    ).toBeTruthy();
    // The unit sits under the field with the bounds, never inside a phone-width input.
    expect(within(defaults).getByText("1 to 100 per license.")).toBeTruthy();
    expect(within(defaults).getByText("0 to 1,024 GiB.")).toBeTruthy();
    const pills = screen.getByRole("navigation", { name: "Jump to section" });
    expect(
      within(pills)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(expect.arrayContaining(["Product defaults", "Jobs"]));
  });

  it("the dialog leads with the count and names, and the button carries the count (L2)", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(
          () => keyLimit({ value: 10, version: 1 }),
          () => withDefaults(),
        ),
        [REACH]: lowerReach,
      }),
    });
    const dialog = await openKeyDialog("10");
    expect(
      await within(dialog).findByText("Lowers 4 of 14 products to 10:"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Tidewater").closest("li")!.textContent,
    ).toMatch(/10 → 5 \(default\)/);
    // A default is listed once; the list names an inheritor, so no "each keeps" line.
    expect(within(dialog).queryByText(/Each keeps the value/)).toBeNull();
    expect(within(dialog).queryByText(/Acme.*\(default\)/)).toBeNull();
    expect(writes(log, "PATCH")).toHaveLength(0);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Lower 4 products to 10" }),
    );
    await waitFor(() => expect(writes(log, "PATCH")).toHaveLength(1));
    expect(JSON.parse(writes(log, "PATCH")[0]!.body!)).toEqual({
      value: 10,
      expectedVersion: 0,
      confirm: "identity.keyEntry.limit",
    });
  });

  it("a raise says which products it releases, not that it reaches nothing", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withDefaults(
          keyLimit({ value: 20, version: 2, source: "runtime" }),
        ),
        [REACH]: {
          kind: "bound",
          direction: "raise",
          total: 14,
          reaches: 3,
          from: 20,
          to: 60,
          products: [
            {
              product: "djdl",
              name: "DJDL",
              from: 20,
              to: 50,
              inherited: false,
            },
          ],
        },
      }),
    });
    const dialog = await openKeyDialog("60");
    expect(
      await within(dialog).findByText(
        "Raises 3 of 14 products to their own values:",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", {
        name: "Raise the ceiling for 3 products",
      }),
    ).toBeTruthy();
  });

  it("holds Confirm until the count resolves, and Try again retries a failed count", async () => {
    let fail = true;
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withDefaults(),
        [REACH]: () =>
          fail
            ? new Response(JSON.stringify({ error: { code: "internal" } }), {
                status: 500,
                headers: { "content-type": "application/json" },
              })
            : lowerReach,
      }),
    });
    const dialog = await openKeyDialog("10");
    expect(
      await within(dialog).findByText(
        "Couldn't count the products this reaches, so you can't save yet.",
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: /^Save/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fail = false;
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Try again" }),
    );
    expect(
      await within(dialog).findByText("Lowers 4 of 14 products to 10:"),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Lower 4 products to 10",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("isolates product names so an RTL name cannot reorder its numbers", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withQuota(
          quota({
            fleet: {
              kind: "default",
              total: 2,
              inheriting: 1,
              own: [{ product: "lumen", name: "لومن الاستوديو", value: 1 }],
            },
          }),
        ),
        [REACH]: {
          ...lowerReach,
          products: [
            {
              product: "lumen",
              name: "لومن الاستوديو",
              from: 20,
              to: 10,
              inherited: false,
            },
          ],
        },
      }),
    });
    const defaults = await section("Product defaults");
    expect(
      within(defaults).getByText(/ sets /, { selector: "p" }).textContent,
    ).toContain("\u2068لومن الاستوديو\u2069");
    const dialog = await openKeyDialog("10");
    const name = await within(dialog).findByText("لومن الاستوديو");
    expect(name.tagName).toBe("BDI");
    expect(
      name.closest("li")!.querySelector(".whitespace-nowrap"),
    ).toBeTruthy();
  });

  it("says one product and no inheritor plainly", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withQuota(
          quota({
            fleet: { kind: "default", total: 1, inheriting: 0, own: [] },
          }),
        ),
        [REACH]: {
          kind: "bound",
          direction: "raise",
          total: 14,
          reaches: 1,
          from: 20,
          to: 60,
          products: [
            {
              product: "djdl",
              name: "DJDL",
              from: 20,
              to: 50,
              inherited: false,
            },
          ],
        },
      }),
    });
    const defaults = await section("Product defaults");
    expect(within(defaults).getByText("No product uses this")).toBeTruthy();
    const dialog = await openKeyDialog("60");
    expect(
      await within(dialog).findByText(
        "Raises 1 of 14 products to its own value:",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Each keeps/)).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: "Raise the ceiling for 1 product",
      }),
    ).toBeTruthy();
  });

  it("a revert's button is short", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withDefaults(
          keyLimit({
            value: 20,
            version: 2,
            source: "runtime",
            stored: { value: 20, valid: true, updatedAt: 1, updatedBy: "ada" },
          }),
        ),
        [REACH]: {
          kind: "bound",
          direction: "raise",
          total: 14,
          reaches: 3,
          from: 20,
          to: 100,
          products: [],
        },
      }),
    });
    const defaults = await section("Product defaults");
    await userEvent.click(
      within(defaults).getByRole("button", {
        name: "Revert key-entry limit ceiling…",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      await within(dialog).findByRole("button", {
        name: "Revert: raise 3 products",
      }),
    ).toBeTruthy();
  });

  it("lowering the media quota says a product over it is refused new files", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withDefaults(),
        "/manage/api/platform/settings/assets.quota.mediaBytes/reach": {
          kind: "default",
          direction: "lower",
          total: 14,
          reaches: 12,
          from: 536_870_912,
          to: 268_435_456,
          products: [],
        },
      }),
    });
    const defaults = await section("Product defaults");
    const input = within(defaults).getByLabelText(/Default media quota/);
    await userEvent.clear(input);
    await userEvent.type(input, "0.25");
    const bar = await within(defaults).findByRole("region", {
      name: "Unsaved changes in Default media quota",
    });
    await userEvent.click(within(bar).getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      await within(dialog).findByText(
        /A product over 256 MiB can't add new ones until it's under/,
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/\(default\)/)).toBeNull();
  });

  it("a revert shows its count too", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withDefaults(
          keyLimit({
            value: 20,
            version: 2,
            source: "runtime",
            stored: { value: 20, valid: true, updatedAt: 1, updatedBy: "ada" },
          }),
        ),
        [REACH]: {
          kind: "bound",
          direction: "raise",
          total: 14,
          reaches: 3,
          from: 20,
          to: 100,
          products: [],
        },
      }),
    });
    const defaults = await section("Product defaults");
    await userEvent.click(
      within(defaults).getByRole("button", {
        name: "Revert key-entry limit ceiling…",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      await within(dialog).findByText(/Raises 3 of 14 products/),
    ).toBeTruthy();
  });

  it("a clamped product shows what it set and what is in effect, from the list", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": withDefaults(
          keyLimit({
            value: 20,
            fleet: {
              kind: "bound",
              total: 3,
              count: 2,
              products: [
                {
                  product: "alpha",
                  name: "Alpha",
                  set: 50,
                  effective: 20,
                  inherited: false,
                },
                {
                  product: "gamma",
                  name: "Gamma",
                  set: 10,
                  effective: 20,
                  inherited: true,
                },
              ],
            },
          }),
        ),
      }),
    });
    const defaults = await section("Product defaults");
    expect(
      within(defaults).getByText("Clamped by Platform: 2 of 3 products"),
    ).toBeTruthy();
    expect(
      within(defaults).getByText("Alpha").closest("li")!.textContent,
    ).toMatch(/set 50, in effect 20/);
    expect(
      within(defaults).getByText("Gamma").closest("li")!.textContent,
    ).toMatch(/default 10, in effect 20/);
  });

  it("a viewer sees the values and no editing", async () => {
    boot("#/platform/settings", {
      extra: routes({ "/manage/api/platform/settings": withDefaults() }),
      me: {
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console", "platform"], edit: ["console"] },
          products: {},
        },
      },
    });
    const defaults = await section("Product defaults");
    expect(within(defaults).queryByRole("spinbutton")).toBeNull();
    expect(within(defaults).queryByRole("textbox")).toBeNull();
  });

  it("focus returns to the field after a save that unmounts the Save bar", async () => {
    let saved = false;
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(
          () => {
            saved = true;
            return keyLimit({ value: 10, version: 1 });
          },
          () =>
            withDefaults(
              saved ? keyLimit({ value: 10, version: 1 }) : keyLimit(),
            ),
        ),
        [REACH]: lowerReach,
      }),
    });
    const dialog = await openKeyDialog("10");
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: "Lower 4 products to 10",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(
        "platform-setting-identity.keyEntry.limit",
      ),
    );
  });
});

describe("Alert destinations in Email and alerts (ST-27)", () => {
  const NOW_S = Math.floor(Date.now() / 1000);
  const FRESH = { authAt: NOW_S - 30, stepUpMaxAgeSeconds: 300 };
  const STALE = { authAt: NOW_S - 3600, stepUpMaxAgeSeconds: 300 };
  const ALL = [
    "auto_halt",
    "store_connection",
    "commerce",
    "access_changed",
    "notifications_failing",
  ];
  const WEBHOOK = {
    id: "dst_hook000001",
    scope: "_platform",
    kind: "webhook",
    target: "https://hooks.example.com/…",
    label: "Ops channel",
    alerts: ["auto_halt", "commerce"],
    enabled: true,
    version: 1,
    lastStatus: "failed",
    lastAt: 1_700_000_000,
    lastError: "HTTP 404 from hooks.example.com",
    failures: 2,
  };
  const EMAIL = {
    ...WEBHOOK,
    id: "dst_mail000001",
    kind: "email",
    target: "ops@example.com",
    label: null,
    alerts: ALL,
    lastStatus: "ok",
    lastError: null,
    failures: 0,
  };
  const listOf = (...destinations: unknown[]) => ({
    ...ALERTS_NONE,
    destinations,
  });

  it("lists rows by name, with the reason a delivery failed and never a URL or secret", async () => {
    boot("#/platform/settings", {
      me: FRESH,
      extra: routes({
        "/manage/api/platform/alerts": listOf(WEBHOOK, EMAIL),
      }),
    });
    const email = await section("Email and alerts");
    const panel = await within(email).findByTestId("alert-destinations");
    expect(within(panel).getByText("Ops channel")).toBeTruthy();
    expect(within(panel).getByText(/2 in a row/)).toBeTruthy();
    expect(
      within(panel).getByText(/HTTP 404 from hooks\.example\.com\./),
    ).toBeTruthy();
    expect(within(panel).getByText("All alerts")).toBeTruthy();
    expect(
      within(panel).getByRole("switch", { name: "Send alerts to Ops channel" }),
    ).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: "Actions for Ops channel" }),
    ).toBeTruthy();
    expect(panel.textContent).not.toContain("whsec_");
    // No callout until an action needs it.
    expect(within(panel).queryByText("Sign in again to continue")).toBeNull();
  });

  it("adds a webhook: checks https on the spot, puts the server's refusal under the field, shows the secret once", async () => {
    let posts = 0;
    const log = boot("#/platform/settings", {
      me: FRESH,
      extra: routes({
        "/manage/api/platform/alerts": ALERTS_NONE,
        "POST /manage/api/platform/alerts": () => {
          posts += 1;
          if (posts === 1)
            return new Response(
              JSON.stringify({
                error: { code: "bad_request", reason: "url_refused" },
                reason: "url_refused",
              }),
              { status: 422, headers: { "content-type": "application/json" } },
            );
          return {
            destination: { ...WEBHOOK, lastStatus: null, failures: 0 },
            secret: "whsec_TESTSECRETVALUE",
          };
        },
      }),
    });
    const email = await section("Email and alerts");
    await userEvent.click(
      await within(email).findByRole("button", { name: "Add destination" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Webhook" }),
    );
    const url = within(dialog).getByLabelText(/Webhook URL/);
    await userEvent.type(url, "http://hooks.example.com/x");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add destination" }),
    );
    expect(
      await within(dialog).findByText(
        "A webhook URL must start with https://.",
      ),
    ).toBeTruthy();
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(log.calls.filter((c) => c.method === "POST")).toHaveLength(0);

    await userEvent.clear(url);
    await userEvent.type(url, "https://10.0.0.1/x");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add destination" }),
    );
    expect(
      await within(dialog).findByText(/That URL cannot be used/),
    ).toBeTruthy();
    await userEvent.clear(url);
    await userEvent.type(url, "https://hooks.example.com/t/abc");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add destination" }),
    );
    expect(await screen.findByText("whsec_TESTSECRETVALUE")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Signing secret for Ops channel" }),
    ).toBeTruthy();
  });

  it("shows one sign-in callout, only when an action needs it, and sends nothing", async () => {
    const log = boot("#/platform/settings", {
      me: STALE,
      extra: routes({
        "/manage/api/platform/alerts": listOf(WEBHOOK, EMAIL),
      }),
    });
    const email = await section("Email and alerts");
    const panel = await within(email).findByTestId("alert-destinations");
    expect(within(panel).queryByText("Sign in again to continue")).toBeNull();
    // Turning an email destination off is a step-up action too.
    await userEvent.click(
      within(panel).getByRole("switch", {
        name: "Send alerts to ops@example.com",
      }),
    );
    expect(
      await within(panel).findAllByText("Sign in again to continue"),
    ).toHaveLength(1);
    expect(log.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    // The same single callout serves a second action.
    await userEvent.click(
      within(panel).getByRole("switch", { name: "Send alerts to Ops channel" }),
    );
    expect(
      within(panel).getAllByText("Sign in again to continue"),
    ).toHaveLength(1);
  });

  it("asks for a fresh sign-in when Add is pressed, announces it and focuses its link", async () => {
    const log = boot("#/platform/settings", {
      me: STALE,
      extra: routes({ "/manage/api/platform/alerts": ALERTS_NONE }),
    });
    const email = await section("Email and alerts");
    const panel = await within(email).findByTestId("alert-destinations");
    expect(within(panel).queryByText("Sign in again to continue")).toBeNull();
    await userEvent.click(
      await within(panel).findByRole("button", { name: "Add destination" }),
    );
    const callout = await within(panel).findByRole("status");
    expect(within(callout).getByText("Sign in again to continue")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(callout).getByRole("link", { name: "Sign in again" }),
      ),
    );
    expect(log.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("at the limit says why, and a throttled test counts down", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      ...WEBHOOK,
      id: `dst_hook00000${i}`,
      label: `Hook ${i}`,
    }));
    boot("#/platform/settings", {
      me: FRESH,
      extra: routes({
        "/manage/api/platform/alerts": listOf(...five),
        "POST /manage/api/platform/alerts/dst_hook000000/test": () =>
          new Response(
            JSON.stringify({
              error: { code: "bad_request", reason: "too_soon" },
              reason: "too_soon",
              retryAfter: 18,
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          ),
      }),
    });
    const email = await section("Email and alerts");
    const panel = await within(email).findByTestId("alert-destinations");
    expect(
      within(panel).getByText("5 of 5 · Remove one to add another."),
    ).toBeTruthy();
    await userEvent.click(
      within(panel).getByRole("button", { name: "Actions for Hook 0" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Send test/ }),
    );
    await userEvent.click(
      within(panel).getByRole("button", { name: "Actions for Hook 0" }),
    );
    expect(await screen.findByText("Try again in 18 s")).toBeTruthy();
    // The throttle is per scope: every row counts down, and the tapped row says so in words.
    await userEvent.keyboard("{Escape}");
    expect(
      within(panel).getByText("Test not sent. Try again in 18 s."),
    ).toBeTruthy();
    expect(within(panel).getAllByRole("status").length).toBeGreaterThan(0);
    await userEvent.click(
      within(panel).getByRole("button", { name: "Actions for Hook 3" }),
    );
    expect(await screen.findByText("Try again in 18 s")).toBeTruthy();
  });

  it("edits kinds and label without asking for the URL again", async () => {
    const log = boot("#/platform/settings", {
      me: FRESH,
      extra: routes({
        "/manage/api/platform/alerts": listOf(WEBHOOK),
        "PATCH /manage/api/platform/alerts/dst_hook000001": {
          destination: { ...WEBHOOK, label: "Renamed" },
        },
      }),
    });
    const email = await section("Email and alerts");
    const panel = await within(email).findByTestId("alert-destinations");
    await userEvent.click(
      within(panel).getByRole("button", { name: "Actions for Ops channel" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Edit/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/Webhook URL/)).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Replace URL" }),
    ).toBeTruthy();
    const label = within(dialog).getByLabelText(/Label/);
    await userEvent.clear(label);
    await userEvent.type(label, "Renamed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(log.calls.filter((c) => c.method === "PATCH")).toHaveLength(1),
    );
    const sent = log.calls.find((c) => c.method === "PATCH")!.json as Record<
      string,
      unknown
    >;
    expect(sent.label).toBe("Renamed");
    expect("target" in sent).toBe(false);
    expect(sent.expectedVersion).toBe(1);
  });
});

describe("Alert destinations: focus and refusals (ST-27)", () => {
  const FRESH = {
    authAt: Math.floor(Date.now() / 1000) - 30,
    stepUpMaxAgeSeconds: 300,
  };
  const MAIL = {
    id: "dst_mail000001",
    scope: "_platform",
    kind: "email",
    target: "ops@example.com",
    label: null,
    alerts: ["auto_halt"],
    enabled: true,
    version: 1,
    lastStatus: null,
    lastAt: null,
    lastError: null,
    failures: 0,
  };

  it("an empty submit puts focus on the first invalid field", async () => {
    boot("#/platform/settings", {
      me: FRESH,
      extra: routes({ "/manage/api/platform/alerts": ALERTS_NONE }),
    });
    const email = await section("Email and alerts");
    await userEvent.click(
      await within(email).findByRole("button", { name: "Add destination" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add destination" }),
    );
    const field = within(dialog).getByLabelText(/Email address/);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("a step-up refusal inside Remove closes it and shows the one sign-in callout", async () => {
    boot("#/platform/settings", {
      me: FRESH,
      extra: routes({
        "/manage/api/platform/alerts": { ...ALERTS_NONE, destinations: [MAIL] },
        "DELETE /manage/api/platform/alerts/dst_mail000001": () =>
          new Response(
            JSON.stringify({
              error: { code: "step_up_required" },
              code: "step_up_required",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      }),
    });
    const email = await section("Email and alerts");
    const panel = await within(email).findByTestId("alert-destinations");
    await userEvent.click(
      within(panel).getByRole("button", {
        name: "Actions for ops@example.com",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Remove/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove" }),
    );
    expect(
      await within(panel).findByText("Sign in again to continue"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("A product's alert routing (ST-27)", () => {
  it("says which alerts go to the product and which to the platform", async () => {
    boot("#/p/djdl/settings", {
      me: {
        authAt: Math.floor(Date.now() / 1000) - 30,
        stepUpMaxAgeSeconds: 300,
      },
      extra: {
        "/manage/api/products/djdl/alerts": {
          ...ALERTS_NONE,
          destinations: [
            {
              id: "dst_mail000001",
              scope: "djdl",
              kind: "email",
              target: "team@example.com",
              label: null,
              alerts: ["auto_halt"],
              enabled: true,
              version: 1,
              lastStatus: null,
              lastAt: null,
              lastError: null,
              failures: 0,
            },
          ],
          inherited: 2,
          inheritedByKind: {
            auto_halt: 2,
            store_connection: 2,
            commerce: 2,
            access_changed: 2,
            notifications_failing: 0,
          },
        },
      },
    });
    const summary = await screen.findByTestId("alert-routing");
    const lines = [...summary.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual([
      "This product: Auto-halt tripped",
      "Platform (2): Store connection failing, Commerce problem, Access changed",
      // The failing-destination alert stays in the product, so the platform never covers it.
      "Audit trail only: A destination is failing",
      "Not sent yet: Store connection failing, Commerce problem, Access changed.",
    ]);
  });
});
