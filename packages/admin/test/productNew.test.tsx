import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  DRAFT_KEY,
  repoOf,
  slugFromName,
  slugVerdict,
  suggestSlug,
} from "../src/console/sections/global/pages/ProductNew.js";
import { ALL_ON, boot, productRow, resetConsole } from "./consoleHarness.js";

/**
 * New product (ST-43; FLOWS.md §3) on the wizard kit: from scratch (Name, What it's for) or from a
 * repository (Repository, Check), then Create lands on Integration with the product's moment.
 */

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false } },
});

beforeEach(() => {
  resetConsole();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const main = (): HTMLElement => screen.getByRole("main");

async function page(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "New product" });
  return main();
}

const field = (label: RegExp): HTMLInputElement =>
  within(main()).getByLabelText(label) as HTMLInputElement;

const integrationView = (slug: string) => ({
  product: slug,
  now: 1,
  snippet: {
    slug,
    services: ["license"],
    pins: [{ kid: `${slug}-2026`, publicKey: "PUBKEY" }],
    releaseKeys: [],
  },
  features: [],
  server: [],
  sightings: [],
  verified: false,
});

/** The routes a freshly created `slug` needs for Integration to render. */
function createdRoutes(
  slug: string,
  name: string,
  post: { path: string; body: unknown },
): Record<string, unknown> {
  return {
    [`POST ${post.path}`]: post.body,
    [`/manage/api/products/${slug}`]: {
      product: productRow(slug, name, ALL_ON),
    },
    [`/manage/api/products/${slug}/integration`]: integrationView(slug),
  };
}

const AVAILABLE = (slug: string) => ({ slug, status: "available" });

/** A slug check that answers from the registry in the scripted `taken` set. */
const slugCheck =
  (taken: Record<string, string> = {}) =>
  (query: URLSearchParams) => {
    const slug = query.get("slug") ?? "";
    return taken[slug]
      ? {
          slug,
          status: "taken",
          message: `${slug} is taken.`,
          suggestion: taken[slug],
        }
      : AVAILABLE(slug);
  };

const REPOS = {
  configured: true,
  app: {
    slug: "polaris-key",
    installUrl: "https://github.com/apps/polaris-key/installations/new",
  },
  installations: [
    {
      id: 1,
      account: "acme",
      repositorySelection: "all",
      repositoryCount: 3,
      listingError: null,
    },
  ],
  repositories: [
    {
      installationId: 1,
      owner: "acme",
      name: "tonebox",
      fullName: "acme/tonebox",
      language: "TypeScript",
      pushedAt: 1_700_000_000,
      private: false,
      defaultBranch: "main",
      product: null,
      hasManifest: true,
    },
    {
      installationId: 1,
      owner: "acme",
      name: "beatgrid",
      fullName: "acme/beatgrid",
      language: null,
      pushedAt: null,
      private: true,
      defaultBranch: "main",
      product: "beatgrid",
      hasManifest: true,
    },
    {
      installationId: 1,
      owner: "acme",
      name: "empty",
      fullName: "acme/empty",
      language: null,
      pushedAt: null,
      private: false,
      defaultBranch: "main",
      product: null,
      hasManifest: false,
    },
  ],
  total: 3,
  nextCursor: null,
};

const DRY = {
  ok: true,
  dryRun: true,
  repository: "acme/tonebox",
  installationId: 1,
  commit: "abcdef1234567890",
  manifestDigest: "digest-1",
  ready: true,
  product: { slug: "tonebox", name: "Tonebox", presentation: null },
  slug: AVAILABLE("tonebox"),
  registeredAs: null,
  services: ["license", "config"],
  catalog: { entries: 4 },
  platforms: { values: ["macos"], source: "artifact-map" },
  secrets: ["SENTRY_AUTH_TOKEN"],
  releaseWorkflow: true,
  problems: [],
};

describe("slug and repository helpers", () => {
  it("derives a slug from a name", () => {
    expect(slugFromName("Tonebox")).toBe("tonebox");
    expect(slugFromName("  Beat Grid Pro! ")).toBe("beat-grid-pro");
    expect(slugFromName("Café Über")).toBe("cafe-uber");
    expect(slugFromName("---")).toBe("");
  });

  it("checks a slug against the registry and the reserved list", () => {
    const taken = new Set(["tonebox", "tonebox-app"]);
    expect(slugVerdict("", taken)).toEqual({ kind: "empty" });
    expect(slugVerdict("Not A Slug", taken).kind).toBe("invalid");
    expect(slugVerdict("docs", taken)).toEqual({ kind: "reserved" });
    // P0-14: the server's one slug rule — admin actions and the system product are reserved,
    // a leading hyphen and a 65th character are invalid.
    expect(slugVerdict("slug-check", taken)).toEqual({ kind: "reserved" });
    expect(slugVerdict("polaris-key", taken)).toEqual({ kind: "reserved" });
    expect(slugVerdict("-acme", taken).kind).toBe("invalid");
    expect(slugVerdict("a".repeat(65), taken)).toEqual({
      kind: "invalid",
      message: "A slug has at most 64 characters.",
    });
    expect(slugVerdict("tonebox", taken)).toEqual({
      kind: "taken",
      suggestion: "tonebox-2",
    });
    expect(slugVerdict("beatgrid", taken)).toEqual({ kind: "available" });
    expect(slugVerdict("beatgrid", null)).toEqual({ kind: "unknown" });
    expect(suggestSlug("djdl", new Set(["djdl"]))).toBe("djdl-app");
  });

  it("reads owner/repo from what link-repo accepts", () => {
    expect(repoOf("acme/tonebox")).toBe("acme/tonebox");
    expect(repoOf("https://github.com/acme/tonebox/")).toBe("acme/tonebox");
    expect(repoOf("git@github.com:acme/tonebox.git")).toBe("acme/tonebox");
    expect(repoOf("tonebox")).toBeNull();
  });
});

const next = (name: RegExp | string) =>
  within(main()).getByRole("button", { name });

describe("New product from scratch", () => {
  it("has two steps: Name it, What it's for; no steps for catalog, admin group, or licence defaults", async () => {
    boot("#/products/new", {
      extra: { "/manage/api/products/slug-check": slugCheck() },
    });
    await page();
    const list = within(main()).getByRole("navigation", {
      name: "New product",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(main()).getByRole("heading", { level: 2 }).textContent).toBe(
      "What is it called?",
    );
    expect(within(main()).queryByText(/Advanced/)).toBeNull();
    expect(within(main()).queryByLabelText(/Offline grace/)).toBeNull();
    expect(within(main()).queryByLabelText(/Device limit/)).toBeNull();
  });

  it("derives the slug from the name until it is edited, and says it is available", async () => {
    boot("#/products/new", {
      extra: { "/manage/api/products/slug-check": slugCheck() },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tone Box");
    expect(field(/^Slug/).value).toBe("tone-box");
    expect(await within(main()).findByText("Available")).toBeTruthy();
    await userEvent.clear(field(/^Slug/));
    await userEvent.type(field(/^Slug/), "tonebox");
    await userEvent.type(field(/^Name/), "x");
    expect(field(/^Slug/).value).toBe("tonebox");
  });

  it("says a taken slug is taken (W24) and offers a free one", async () => {
    boot("#/products/new", {
      extra: {
        "/manage/api/products/slug-check": slugCheck({
          tonebox: "tonebox-app",
        }),
      },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox");
    expect(
      await within(main()).findByText("tonebox is taken. Try tonebox-app."),
    ).toBeTruthy();
    await userEvent.click(next("Use tonebox-app"));
    expect(field(/^Slug/).value).toBe("tonebox-app");
  });

  it("refuses a reserved slug before asking the server", async () => {
    const log = boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "Docs");
    expect(
      await within(main()).findByText("docs is reserved. Choose another slug."),
    ).toBeTruthy();
    expect(log.calls.some((c) => c.path.endsWith("/slug-check"))).toBe(false);
  });

  it("an empty Continue names the missing field and focuses it", async () => {
    boot("#/products/new");
    await page();
    await userEvent.click(next("Continue"));
    expect(
      await within(main()).findByText("Enter the product's name."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field(/^Name/)));
  });

  it("asks what it is for, with Licensing and Ship builds recommended, then creates", async () => {
    const log = boot("#/products/new", {
      extra: {
        "/manage/api/products/slug-check": slugCheck(),
        ...createdRoutes("tonebox", "Tonebox", {
          path: "/manage/api/products",
          body: {
            ok: true,
            slug: "tonebox",
            kid: "tonebox-2026",
            signing: { kid: "tonebox-2026", publicKey: "PUBKEY" },
            product: null,
          },
        }),
      },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox{Enter}");
    expect(
      await screen.findByRole("heading", { level: 2, name: "What is it for?" }),
    ).toBeTruthy();
    const box = (label: RegExp) =>
      within(main()).getByRole("checkbox", { name: label });
    expect(box(/^Licensing/).getAttribute("aria-checked")).toBe("true");
    expect(box(/^Ship builds/).getAttribute("aria-checked")).toBe("true");
    expect(box(/^Managed config/).getAttribute("aria-checked")).toBe("false");
    // The plan reads in the future tense and follows the answers.
    expect(within(main()).getByText("Create the Free tier")).toBeTruthy();
    await userEvent.click(box(/^Cloud Sync/));
    expect(
      within(main()).getByText("Managed config comes with Cloud Sync"),
    ).toBeTruthy();
    await userEvent.click(box(/^Cloud Sync/));
    await userEvent.click(
      within(main()).getByRole("button", { name: "macos" }),
    );
    await userEvent.click(next("Create Tonebox"));
    await waitFor(() =>
      expect(window.location.hash).toMatch(/^#\/p\/tonebox\/integration/),
    );
    const post = log.calls.find(
      (c) => c.method === "POST" && c.path === "/manage/api/products",
    )!;
    expect(post.json).toEqual({
      slug: "tonebox",
      name: "Tonebox",
      services: ["license", "release", "distribution"],
      intendedPlatforms: ["macos"],
      starterTier: "free",
    });
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    // Licence defaults are not asked: no offline grace, no device limit.
    expect(post.json).not.toHaveProperty("defaultMaxOfflineDays");
    expect(post.json).not.toHaveProperty("defaultDeviceLimit");
  });

  it("I'll choose later creates with no services and no tier", async () => {
    const log = boot("#/products/new", {
      extra: {
        "/manage/api/products/slug-check": slugCheck(),
        ...createdRoutes("tonebox", "Tonebox", {
          path: "/manage/api/products",
          body: { ok: true, slug: "tonebox", kid: "k", product: null },
        }),
      },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox{Enter}");
    await userEvent.click(
      await screen.findByRole("button", { name: "I'll choose later" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toMatch(/^#\/p\/tonebox\/integration/),
    );
    const post = log.calls.find((c) => c.method === "POST")!;
    expect(post.json).toEqual({
      slug: "tonebox",
      name: "Tonebox",
      services: [],
      starterTier: "none",
    });
  });

  it("puts a slug the server refuses back on the Name step, with a free one to take", async () => {
    boot("#/products/new", {
      extra: {
        "/manage/api/products/slug-check": slugCheck(),
        "POST /manage/api/products": new Response(
          JSON.stringify({ error: "product exists", fields: ["slug"] }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox{Enter}");
    await userEvent.click(
      await screen.findByRole("button", { name: "Create Tonebox" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "What is it called?",
      }),
    ).toBeTruthy();
    expect(await within(main()).findByText(/tonebox is taken/)).toBeTruthy();
    expect(
      within(main()).getByRole("button", { name: /^Use tonebox/ }),
    ).toBeTruthy();
  });

  it("keeps the draft across a refresh", async () => {
    boot("#/products/new", {
      extra: { "/manage/api/products/slug-check": slugCheck() },
    });
    await page();
    await userEvent.type(field(/^Name/), "Keep Me");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toContain("keep-me");
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    boot("#/products/new", {
      extra: { "/manage/api/products/slug-check": slugCheck() },
    });
    await page();
    expect(field(/^Name/).value).toBe("Keep Me");
    expect(field(/^Slug/).value).toBe("keep-me");
  });

  it("asks before leaving with a draft, and Discard clears it", async () => {
    boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "Draft");
    await userEvent.click(within(main()).getByRole("link", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Discard this new product?")).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Discard" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/products"));
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

describe("New product from a repository", () => {
  const routes = (over: Record<string, unknown> = {}) => ({
    "/manage/api/github/repositories": REPOS,
    "POST /manage/api/products/link-repo": (
      _q: URLSearchParams,
      req: { json?: unknown },
    ) =>
      (req as { path: string }).path.length && false
        ? null
        : { ok: true, slug: "tonebox", kid: "gh:1", product: null },
    ...createdRoutes("tonebox", "Tonebox", {
      path: "/manage/api/products/link-repo",
      body: { ok: true, slug: "tonebox", kid: "gh:1", product: null },
    }),
    ...over,
  });

  it("opens on the repository, lists what the app can read, and opens a registered one", async () => {
    boot("#/products/new?via=github", { extra: routes() });
    await page();
    expect(within(main()).queryByLabelText(/^Name/)).toBeNull();
    const list = await within(main()).findByRole("list", {
      name: "Repositories the Polaris Key app can read",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Has .pkey/")).toBeTruthy();
    expect(within(list).getByText("No .pkey/ yet")).toBeTruthy();
    expect(within(list).getByText("Already a product · beatgrid")).toBeTruthy();
    expect(
      within(list).getByRole("link", { name: "Open product" }),
    ).toBeTruthy();
  });

  it("says when the app is not installed, with the install link", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "/manage/api/github/repositories": {
          ...REPOS,
          installations: [],
          repositories: [],
        },
      }),
    });
    await page();
    expect(
      await within(main()).findByText(
        "The Polaris Key app is not installed on GitHub",
      ),
    ).toBeTruthy();
    expect(
      within(main())
        .getByRole("link", { name: /Install on GitHub/ })
        .getAttribute("href"),
    ).toContain("installations/new");
  });

  it("checks the repository's shape before reading it", async () => {
    const log = boot("#/products/new?via=github", { extra: routes() });
    await page();
    await userEvent.type(field(/^Repository/), "nope{Enter}");
    expect(
      await within(main()).findByText(
        "Use owner/repo or the repository's GitHub URL.",
      ),
    ).toBeTruthy();
    expect(log.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("picks a repository, checks it (W23), and creates it with the digest", async () => {
    const log = boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": (q: URLSearchParams) =>
          q.get("dryRun") === "1"
            ? DRY
            : { ok: true, slug: "tonebox", kid: "gh:1", product: null },
      }),
    });
    await page();
    await userEvent.click(
      await within(main()).findByRole("button", { name: /acme\/tonebox/ }),
    );
    await userEvent.click(next("Read acme/tonebox"));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Check it" }),
    ).toBeTruthy();
    expect(await within(main()).findByText("Tonebox")).toBeTruthy();
    expect(within(main()).getByText("Available")).toBeTruthy();
    expect(within(main()).getByText(/SENTRY_AUTH_TOKEN/)).toBeTruthy();
    expect(
      within(main()).getByText("Polaris Key will set this up"),
    ).toBeTruthy();
    await userEvent.click(next("Create Tonebox"));
    await waitFor(() =>
      expect(window.location.hash).toMatch(/^#\/p\/tonebox\/integration/),
    );
    const dry = log.calls.find((c) => c.query === "dryRun=1")!;
    expect(dry.json).toEqual({ repoUrl: "acme/tonebox" });
    const post = log.calls.find(
      (c) =>
        c.method === "POST" && c.path.endsWith("/link-repo") && c.query === "",
    )!;
    expect(post.json).toEqual({
      repoUrl: "acme/tonebox",
      manifestDigest: "digest-1",
      trustReleaseWorkflow: true,
    });
  });

  it("lists every problem with its file and path, holds Create, and Check again reads again", async () => {
    let reads = 0;
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": () => {
          reads += 1;
          return reads === 1
            ? {
                ...DRY,
                ready: false,
                problems: [
                  {
                    check: "manifest",
                    file: "product",
                    path: "/slug",
                    message: "slug must be lowercase",
                  },
                  {
                    check: "manifest",
                    file: "schema",
                    path: "/entries/0",
                    message: "unknown kind",
                  },
                ],
              }
            : DRY;
        },
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    expect(
      await within(main()).findByText("Fix these in one commit"),
    ).toBeTruthy();
    expect(
      within(main()).getByText("slug must be lowercase", { exact: false }),
    ).toBeTruthy();
    expect(
      within(main()).getByText(/\.pkey\/schema \/entries\/0/),
    ).toBeTruthy();
    const create = next(/^Create/);
    expect(create.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(next("Check again"));
    await waitFor(() =>
      expect(within(main()).queryByText("Fix these in one commit")).toBeNull(),
    );
    expect(next("Create Tonebox").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
  });

  it("puts a repository the GitHub App can't read on the Check step, with the install fix", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": new Response(
          JSON.stringify({
            error: "bad_request",
            message: "github app is not installed on acme/other",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/other{Enter}");
    expect(
      await within(main()).findByRole("button", { name: "Check again" }),
    ).toBeTruthy();
    expect(within(main()).getByRole("link", { name: /Install/ })).toBeTruthy();
  });
});

describe("New product accessibility", () => {
  it("passes axe, both sources", async () => {
    boot("#/products/new", {
      extra: { "/manage/api/products/slug-check": slugCheck() },
    });
    await page();
    await userEvent.type(field(/^Name/), "DJDL{Enter}");
    await screen.findByRole("heading", { level: 2, name: "What is it for?" });
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    window.sessionStorage.clear();
    boot("#/products/new?via=github", {
      extra: { "/manage/api/github/repositories": REPOS },
    });
    await page();
    await within(main()).findByRole("list", {
      name: "Repositories the Polaris Key app can read",
    });
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});
