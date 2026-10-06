import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
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
    settings: [lazyDeltas(), maxBytes(), gcMode(), grace(), reservedNames()],
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
        area: "sessions",
        value: 28_800,
        unit: "seconds",
      },
      {
        name: "AUDIT_RETENTION_SECONDS",
        area: "retention",
        value: 15_552_000,
        unit: "seconds",
      },
      {
        name: "LAZY_DELTA_MAX_BYTES_CEILING",
        area: "lazy-deltas",
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
          "PORTAL_SESSION_SECRET is not set, so customer portal sessions are signed with ADMIN_SESSION_SECRET and the two realms share key material.",
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

async function section(name: string): Promise<HTMLElement> {
  return within(await settingsPage()).findByRole("region", { name });
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
    expect(document.title).toBe("Settings · Polaris Key");
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
    const jobs = await section("Background jobs");
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
    const jobs = await section("Background jobs");
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
    const jobs = await section("Background jobs");
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
    const jobs = await section("Background jobs");
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

  it("asks before turning lazy deltas on (L1), and cancelling sends nothing", async () => {
    const log = boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/settings": writable(() =>
          lazyDeltas({ value: "on", source: "runtime", version: 1 }),
        ),
      }),
    });
    const jobs = await section("Background jobs");
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
    const jobs = await section("Background jobs");
    const input = within(jobs).getByLabelText(/\(MiB\)$/);
    await userEvent.clear(input);
    await userEvent.type(input, "40");
    const bar = await within(jobs).findByRole("region", {
      name: "Unsaved changes in Lazy delta size cap",
    });
    await userEvent.click(within(bar).getByRole("button", { name: "Save" }));
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
    const jobs = await section("Background jobs");
    const input = within(jobs).getByLabelText(/\(days\)$/);
    await userEvent.clear(input);
    await userEvent.type(input, "14");
    const bar = await within(jobs).findByRole("region", {
      name: "Unsaved changes in Blob collector grace period",
    });
    await userEvent.click(within(bar).getByRole("button", { name: "Save" }));
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
    const jobs = await section("Background jobs");
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
    const jobs = await section("Background jobs");
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
    const jobs = await section("Background jobs");
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
    const jobs = await section("Background jobs");
    expect(within(jobs).getByText("Stored value not applied")).toBeTruthy();
    expect(
      within(jobs).getByText(/uses the deploy var \(32 MiB\)/),
    ).toBeTruthy();
  });
});

describe("the read-only inventory", () => {
  it("shows deploy-time values, the console-client fallback and the warnings", async () => {
    boot("#/platform/settings", { extra: routes() });
    const identity = await section("Identity & access");
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
    expect(within(identity).getByText("8 hours")).toBeTruthy();
    const delivery = await section("Delivery");
    expect(within(delivery).getByText("Production")).toBeTruthy();
    expect(within(delivery).getByText("https://dl.example.com")).toBeTruthy();
    // ST-02: the deploy vars the inventory added are read out too.
    expect(within(delivery).getByText("https://pkg.example.com")).toBeTruthy();
    const email = await section("Email");
    expect(within(email).getByText("noreply@auth.example.com")).toBeTruthy();
    expect(within(email).getByText("Not set: 500")).toBeTruthy();
    expect(within(email).getByText("Not registered")).toBeTruthy();
    const warnings = within(main()).getByRole("region", { name: "Warnings" });
    expect(
      within(warnings).getByText("Portal sessions share the admin secret"),
    ).toBeTruthy();
    expect(
      within(warnings).getByText(
        "The console shares the customer sign-in client",
      ),
    ).toBeTruthy();
  });

  it("collapses the code limits until asked", async () => {
    boot("#/platform/settings", { extra: routes() });
    const limits = await section("Limits");
    expect(within(limits).queryByText("Audit retention")).toBeNull();
    await userEvent.click(
      within(limits).getByRole("button", { name: "Show 2" }),
    );
    expect(within(limits).getByText("Audit retention")).toBeTruthy();
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
    const history = await section("History");
    expect(await within(history).findByText("Ada Lovelace")).toBeTruthy();
    expect(within(history).getByText(/\(30 days → 21 days\)/)).toBeTruthy();
    expect(within(history).queryByText(/Re-sealed/)).toBeNull();
  });

  it("explains an empty history", async () => {
    boot("#/platform/settings", {
      extra: routes({
        "/manage/api/platform/activity": { items: [], nextCursor: null },
      }),
    });
    const history = await section("History");
    expect(
      await within(history).findByText("No setting changes yet"),
    ).toBeTruthy();
  });
});

describe("accessibility", () => {
  it("passes axe", async () => {
    boot("#/platform/settings", { extra: routes() });
    const page = await settingsPage();
    await within(page).findByText("Ada Lovelace");
    await within(page).findByText("Active");
    const results = await axe(page);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
