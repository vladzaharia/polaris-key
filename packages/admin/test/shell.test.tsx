import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import { resetCache } from "../src/context.js";
import { setLoginRedirectForTests } from "../src/api.js";

/**
 * The suite shell: nav grouped by service and FILTERED by what the product runs (D-15), plus the
 * per-section accent attribute the theming hangs off (D-17).
 *
 * These drive the whole `App`, not `Shell` in isolation, because the property that matters spans
 * both: the sidebar must hide a section AND a deep link into that section must land on an
 * explanation rather than on a view that will fire requests the worker answers with 404s. Testing
 * the sidebar alone would pass while the second half was broken, which is exactly the failure an
 * operator meets — they do not click the nav to get there, they follow a bookmark.
 */

/** A scripted fetch: longest-prefix match on the path, so one map serves a whole render. */
function mockFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = url.replace("http://localhost", "").split("?")[0]!;
      const key =
        path in routes
          ? path
          : (Object.keys(routes)
              .filter((k) => path.startsWith(k))
              .sort((a, b) => b.length - a.length)[0] ?? "");
      return new Response(JSON.stringify(routes[key] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const ME = {
  sub: "u1",
  name: "Ada Lovelace",
  email: "ada@x.io",
  csrf: "csrf-token",
  platformAdmin: true,
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }],
};

type Enablement = Record<string, { enabled: boolean }>;

const ALL_ON: Enablement = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  update: { enabled: true },
  identity: { enabled: true },
};

/** The product row the shell reads its enablement off (worker `admin/lib/shape.ts`). */
function productWith(services: Enablement | undefined): unknown {
  return {
    product: {
      slug: "djdl",
      name: "DJDL",
      signingKid: "kid-1",
      compatMin: "1.0.0",
      compatMax: "2.0.0",
      defaultMaxOfflineDays: 14,
      defaultDeviceLimit: 3,
      adminGroup: null,
      createdAt: 0,
      modifiedAt: 0,
      ...(services
        ? {
            services,
            registration: null,
            effectiveRegistration: "requires-license",
            servicesSource: "manifest",
          }
        : {}),
    },
  };
}

function boot(services: Enablement | undefined, hash: string): void {
  window.location.hash = hash;
  mockFetch({
    "/manage/api/me": ME,
    "/manage/api/products/djdl": productWith(services),
    "/manage/api/products/djdl/devices": { devices: [], nextCursor: null },
    "/manage/api/products/djdl/devices/summary": {
      total: 0,
      byStatus: [],
      licensed: { licensed: 0, licenseFree: 0 },
      byPlatform: [],
      byArch: [],
      bySdkName: [],
      byAppVersion: [],
    },
  });
  render(<App />);
}

/** The sidebar's section headers, in render order. */
function sectionHeaders(): string[] {
  const nav = screen.getByRole("navigation", { name: "Primary" });
  return within(nav)
    .queryAllByText(
      /^(Platform|License|Config|Release|Update|Identity)$/,
      // The headers are <p>, not headings — Radix owns the roles in this tree.
      { selector: "p" },
    )
    .map((el) => el.textContent ?? "");
}

beforeEach(() => {
  window.location.hash = "";
  resetCache();
  setLoginRedirectForTests(() => undefined);
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
  // The product switcher is a Radix Select, whose size hook reaches for ResizeObserver on mount.
  // jsdom has none, and the throw lands in a layout effect where it escapes the test that caused
  // it — the run still reports every test green and exits non-zero on an "unhandled error".
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("service-grouped nav (D-15)", () => {
  it("draws one group per enabled service, platform first", async () => {
    boot(ALL_ON, "#/p/djdl/overview");
    await screen.findByRole("navigation", { name: "Primary" });
    expect(sectionHeaders()).toEqual([
      "Platform",
      "License",
      "Config",
      "Release",
      "Update",
      "Identity",
    ]);
  });

  it("omits a disabled service's group entirely rather than greying it out", async () => {
    // A dimmed row invites a click that can only ever fail. The operator already has one honest
    // place to turn a service on, and it is in the section that is never hidden.
    boot(
      { ...ALL_ON, release: { enabled: false }, update: { enabled: false } },
      "#/p/djdl/overview",
    );
    await screen.findByRole("navigation", { name: "Primary" });
    expect(sectionHeaders()).toEqual([
      "Platform",
      "License",
      "Config",
      "Identity",
    ]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("button", { name: /Releases/ })).toBeNull();
    expect(
      within(nav).queryByRole("button", { name: /Update settings/ }),
    ).toBeNull();
  });

  it("keeps Platform → Services reachable for a product that runs nothing", async () => {
    // The recovery path. If the platform group were filtered like the rest, an all-off product
    // would have no nav entry that could ever turn a service back on.
    boot(
      {
        license: { enabled: false },
        config: { enabled: false },
        release: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
      },
      "#/p/djdl/overview",
    );
    await screen.findByRole("navigation", { name: "Primary" });
    expect(sectionHeaders()).toEqual(["Platform"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("button", { name: /Services/ })).toBeTruthy();
  });

  it("keeps Platform → Devices for a product with License disabled", async () => {
    // A free, license-less game is exactly the product this tab exists for: its devices hold no
    // license, so the License section (which is gone) could never have listed them.
    boot({ ...ALL_ON, license: { enabled: false } }, "#/p/djdl/devices");
    await screen.findByRole("navigation", { name: "Primary" });
    expect(sectionHeaders()).not.toContain("License");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("button", { name: /Devices/ })).toBeTruthy();
    // The deep link renders the view, not the "service not enabled" explanation.
    expect(
      await screen.findByRole("heading", { name: "Devices" }),
    ).toBeTruthy();
    expect(screen.queryByText(/isn.t enabled|not enabled/i)).toBeNull();
  });

  it("shows every group while enablement is unknown", async () => {
    // Fail-open: the worker gates each endpoint itself, so this filter is an affordance. Hiding
    // first and revealing on load would make the nav jump under the cursor.
    boot(undefined, "#/p/djdl/overview");
    await screen.findByRole("navigation", { name: "Primary" });
    expect(sectionHeaders()).toEqual([
      "Platform",
      "License",
      "Config",
      "Release",
      "Update",
      "Identity",
    ]);
  });
});

describe("per-section accents (D-17)", () => {
  it("tags each sidebar group with its brand token — License is `key`, Identity is `id`", async () => {
    boot(ALL_ON, "#/p/djdl/overview");
    await screen.findByRole("navigation", { name: "Primary" });
    const nav = screen.getByRole("navigation", { name: "Primary" });
    // These attribute values ARE the CSS contract (`[data-service="…"]` in styles.css); a
    // rename on either side is a silent theming regression with no type to catch it.
    expect(
      [...nav.querySelectorAll("[data-service]")].map((el) =>
        el.getAttribute("data-service"),
      ),
    ).toEqual(["core", "key", "config", "release", "update", "id"]);
  });

  it("accents the content area from the ACTIVE route's section", async () => {
    boot(ALL_ON, "#/p/djdl/tiers");
    await screen.findByRole("navigation", { name: "Primary" });
    const main = screen.getByRole("main");
    expect(
      main.querySelector("[data-service]")?.getAttribute("data-service"),
    ).toBe("key");
  });

  it("falls back to the core accent off a product route", async () => {
    boot(ALL_ON, "#/");
    await screen.findByText(/Welcome, Ada/);
    const main = screen.getByRole("main");
    expect(
      main.querySelector("[data-service]")?.getAttribute("data-service"),
    ).toBe("core");
  });
});

describe("deep links into a disabled section", () => {
  it("explains rather than crashing, and offers the way to turn it on", async () => {
    boot({ ...ALL_ON, release: { enabled: false } }, "#/p/djdl/releases");
    expect(
      await screen.findByText(/The Release service isn’t enabled/),
    ).toBeTruthy();
    expect(screen.getByText(/Platform → Services/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Enable services" }),
    ).toBeTruthy();
  });

  it("the enable affordance navigates to the Services view", async () => {
    boot({ ...ALL_ON, update: { enabled: false } }, "#/p/djdl/updates");
    await screen.findByText(/The Update service isn’t enabled/);
    await userEvent.click(
      screen.getByRole("button", { name: "Enable services" }),
    );
    expect(window.location.hash).toBe("#/p/djdl/services");
  });

  it("gates a LICENSE DETAIL deep link on the section its list belongs to", async () => {
    // `#/p/x/licenses/<id>` is not a nav tab, so a check written against tabs alone would let a
    // bookmark sail straight past it into a view whose every request 404s.
    boot({ ...ALL_ON, license: { enabled: false } }, "#/p/djdl/licenses/lic_1");
    expect(
      await screen.findByText(/The License service isn’t enabled/),
    ).toBeTruthy();
  });

  // The ENABLED side of that gate is deliberately not re-tested through the whole App here.
  // Rendering LicenseDetail needs its full detail payload plus the catalog its overrides editor
  // compiles against, and a shell test that carried those fixtures would fail for reasons that
  // have nothing to do with the nav. The two halves it would assert are already owned elsewhere:
  // `route.test.ts` pins that a license detail maps back to the `licenses` tab (so the gate
  // consults the License section), and `licenses.test.tsx` drives LicenseDetail and its
  // OfflineBundleDialog end to end against realistic responses.

  it("still renders a platform view for a product running no services", async () => {
    boot(
      {
        license: { enabled: false },
        config: { enabled: false },
        release: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
      },
      "#/p/djdl/settings",
    );
    await screen.findByRole("navigation", { name: "Primary" });
    expect(screen.queryByText(/isn’t enabled/)).toBeNull();
  });
});

describe("topbar", () => {
  it("qualifies a product view with its section", async () => {
    // "Licenses" alone does not say which of six groups the operator is standing in; the console
    // is now deep enough that the breadcrumb has to be in the title.
    boot(ALL_ON, "#/p/djdl/profiles");
    await screen.findByRole("navigation", { name: "Primary" });
    expect(
      screen.getByRole("heading", { name: "Config · Profiles" }),
    ).toBeTruthy();
  });

  it("leaves the sectionless routes exactly as they were", async () => {
    boot(ALL_ON, "#/products");
    // Level 1 is the topbar's; the registry view has its own h2 with the same words, and it is
    // the topbar that the section qualifier was added to.
    expect(
      await screen.findByRole("heading", { name: "Products", level: 1 }),
    ).toBeTruthy();
  });
});
