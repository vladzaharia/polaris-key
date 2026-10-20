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
  starterTier: "free",
  problems: [],
};

describe("slug and repository helpers", () => {
  it("derives a slug from a name", () => {
    expect(slugFromName("Tonebox")).toBe("tonebox");
    expect(slugFromName("  Beat Grid Pro! ")).toBe("beat-grid-pro");
    expect(slugFromName("Café Über")).toBe("cafe-uber");
    expect(slugFromName("---")).toBe("");
    expect(slugFromName("Øresund Æble")).toBe("oresund-aeble");
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
    // The card says what it is for, in one line.
    expect(
      within(main()).getByText(/Gate Tonebox on a license\./),
    ).toBeTruthy();
    // The Free tier row and the rail follow the answers.
    expect(within(main()).getByText("Start with a Free tier")).toBeTruthy();
    expect(within(main()).getAllByText("The Free tier").length).toBeGreaterThan(
      0,
    );
    await userEvent.click(
      within(main()).getByRole("checkbox", { name: "macOS" }),
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
    expect(post.json).not.toHaveProperty("defaultMaxOfflineDays");
    expect(post.json).not.toHaveProperty("defaultDeviceLimit");
  });

  it("locks what needs another feature, and clearing one clears what needs it", async () => {
    boot("#/products/new", {
      extra: { "/manage/api/products/slug-check": slugCheck() },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox{Enter}");
    await screen.findByRole("heading", { level: 2, name: "What is it for?" });
    const box = (label: RegExp) =>
      within(main()).getByRole("checkbox", { name: label });
    // Cloud Sync needs Managed config and Sign-in; Commerce needs Licensing.
    expect(box(/^Cloud Sync/).getAttribute("aria-disabled")).toBe("true");
    expect(within(main()).getAllByText(/Needs/).length).toBeGreaterThan(0);
    await userEvent.click(box(/^Cloud Sync/));
    expect(box(/^Cloud Sync/).getAttribute("aria-checked")).toBe("false");
    await userEvent.click(box(/^Managed config/));
    await userEvent.click(box(/^Sign-in/));
    expect(box(/^Cloud Sync/).getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(box(/^Cloud Sync/));
    expect(box(/^Cloud Sync/).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(box(/^Commerce/));
    expect(box(/^Commerce/).getAttribute("aria-checked")).toBe("true");
    // Clearing Licensing clears Commerce, says so, and the Free tier row goes with Licensing.
    await userEvent.click(box(/^Licensing/));
    expect(box(/^Commerce/).getAttribute("aria-checked")).toBe("false");
    expect(
      within(main()).getByText(/Commerce is off too: it needs Licensing\./),
    ).toBeTruthy();
    expect(within(main()).queryByText("Start with a Free tier")).toBeNull();
    expect(within(main()).queryByText("The Free tier")).toBeNull();
    // Clearing Managed config clears Cloud Sync.
    await userEvent.click(box(/^Managed config/));
    expect(box(/^Cloud Sync/).getAttribute("aria-checked")).toBe("false");
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

  it("says so when the slug can't be checked, and hints at a name with no Latin letters", async () => {
    boot("#/products/new", {
      extra: {
        "/manage/api/products/slug-check": () => {
          throw new TypeError("Failed to fetch");
        },
      },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox");
    expect(
      await within(main()).findByText(
        /Could not check the slug\. The server checks it when you create\./,
      ),
    ).toBeTruthy();
    await userEvent.clear(field(/^Name/));
    await userEvent.type(field(/^Name/), "مرحبا");
    expect(
      await within(main()).findByText(
        "Type a slug: lowercase letters, digits and hyphens.",
      ),
    ).toBeTruthy();
  });

  it("a failed create keeps the draft and moves focus to the refusal", async () => {
    boot("#/products/new", {
      extra: {
        "/manage/api/products/slug-check": slugCheck(),
        "POST /manage/api/products": new Response(
          JSON.stringify({ error: "boom" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox{Enter}");
    await userEvent.click(
      await screen.findByRole("button", { name: "Create Tonebox" }),
    );
    await waitFor(() => {
      const el = document.activeElement as HTMLElement;
      expect(el.getAttribute("tabindex")).toBe("-1");
      expect(main().contains(el)).toBe(true);
      expect(el.textContent?.length).toBeGreaterThan(0);
    });
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toContain("tonebox");
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
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

describe("New product from a repository", () => {
  const routes = (over: Record<string, unknown> = {}) => ({
    "/manage/api/github/repositories": REPOS,
    ...createdRoutes("tonebox", "Tonebox", {
      path: "/manage/api/products/link-repo",
      body: { ok: true, slug: "tonebox", kid: "gh:1", product: null },
    }),
    "POST /manage/api/products/link-repo": (q: URLSearchParams) =>
      q.get("dryRun") === "1"
        ? DRY
        : { ok: true, slug: "tonebox", kid: "gh:1", product: null },
    ...over,
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("opens on the repository: one radiogroup of rows, the same shape each, no inner scroll", async () => {
    boot("#/products/new?via=github", { extra: routes() });
    await page();
    expect(within(main()).queryByLabelText(/^Name/)).toBeNull();
    const group = await within(main()).findByRole("radiogroup", {
      name: "Repositories the Polaris Key app can read",
    });
    const rows = within(group).getAllByRole("radio");
    expect(rows).toHaveLength(3);
    expect(within(group).getByText("Has .pkey/")).toBeTruthy();
    expect(within(group).getByText("No .pkey/ yet")).toBeTruthy();
    expect(
      within(group).getByText(/Already a product · beatgrid/),
    ).toBeTruthy();
    expect(group.className).not.toMatch(/overflow-y|max-h-/);
    // The source is a segmented control above the stepper.
    const source = within(main()).getByRole("radiogroup", {
      name: "Start from",
    });
    expect(
      source.compareDocumentPosition(
        within(main()).getByRole("navigation", { name: "New product" }),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("a repository that is a product already: Open <slug> is the primary", async () => {
    boot("#/products/new?via=github", { extra: routes() });
    await page();
    await userEvent.click(
      await within(main()).findByRole("radio", { name: /acme\/beatgrid/ }),
    );
    const open = within(main()).getByRole("link", { name: "Open beatgrid" });
    expect(open.getAttribute("href")).toBe("#/p/beatgrid");
    expect(within(main()).queryByRole("button", { name: /^Read/ })).toBeNull();
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
    const log = boot("#/products/new?via=github", { extra: routes() });
    await page();
    await userEvent.click(
      await within(main()).findByRole("radio", { name: /acme\/tonebox/ }),
    );
    await userEvent.click(next("Read acme/tonebox"));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Check it" }),
    ).toBeTruthy();
    expect(await within(main()).findByLabelText("The product")).toBeTruthy();
    expect(within(main()).getByText("Available")).toBeTruthy();
    // Feature and platform names, never ids.
    expect(within(main()).getByText("Licensing, Managed config")).toBeTruthy();
    expect(within(main()).getByText("macOS")).toBeTruthy();
    expect(within(main()).getByText(/SENTRY_AUTH_TOKEN/)).toBeTruthy();
    // The Free tier line is the dry run's answer, not a hedge.
    expect(within(main()).getAllByText("The Free tier").length).toBeGreaterThan(
      0,
    );
    expect(main().textContent).not.toMatch(/if the manifest declares/);
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

  it("a long name wraps inside the Create button", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": () => ({
          ...DRY,
          product: { slug: "x", name: "A".repeat(80), presentation: null },
        }),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    const create = await within(main()).findByRole("button", {
      name: /^Create A/,
    });
    expect(create.className).toMatch(/whitespace-normal/);
    expect(create.className).toMatch(/max-w-full/);
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
    expect(next(/^Create/).getAttribute("aria-disabled")).toBe("true");
    expect(
      within(main()).getAllByText("Fix the problems first.").length,
    ).toBeGreaterThan(0);
    await userEvent.click(next("Check again"));
    await waitFor(() =>
      expect(within(main()).queryByText("Fix these in one commit")).toBeNull(),
    );
    expect(next("Create Tonebox").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
    // Focus lands on the result, not on the page's top.
    await waitFor(() =>
      expect(main().contains(document.activeElement)).toBe(true),
    );
  });

  it("an already-registered repository hides the plan; Open <slug> is the primary", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": () => ({
          ...DRY,
          registeredAs: "tonebox",
          slug: {
            slug: "tonebox",
            status: "taken",
            message: "tonebox is taken.",
            suggestion: "tonebox-app",
          },
        }),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    expect(
      await within(main()).findByText("Already a product: tonebox"),
    ).toBeTruthy();
    expect(within(main()).queryByText("tonebox is taken.")).toBeNull();
    expect(within(main()).queryByText("Creates")).toBeNull();
    expect(within(main()).queryByText(/^Features/)).toBeNull();
    expect(
      within(main()).getByRole("link", { name: "Open tonebox" }),
    ).toBeTruthy();
    expect(
      within(main()).queryByRole("button", { name: /^Create/ }),
    ).toBeNull();
  });

  it("a .pkey/ that changed after the check: reads again, holds Create, plain words", async () => {
    let reads = 0;
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": (q: URLSearchParams) => {
          if (q.get("dryRun") === "1") {
            reads += 1;
            return DRY;
          }
          return json(409, {
            error:
              "the repository's .pkey/ changed since the check; check again",
            reason: "manifest",
          });
        },
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    await userEvent.click(
      await within(main()).findByRole("button", { name: "Create Tonebox" }),
    );
    await waitFor(() => expect(reads).toBe(2));
    expect(main().textContent).not.toMatch(/since the check; check again/);
    // Once it has been read again, Create works.
    await waitFor(() =>
      expect(next("Create Tonebox").getAttribute("aria-disabled")).not.toBe(
        "true",
      ),
    );
  });

  it("the App can't read the repository: Install goes to the App's page, in a new tab", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "/manage/api/github/repositories": {
          ...REPOS,
          installations: [{ ...REPOS.installations[0]!, account: "someone" }],
        },
        "POST /manage/api/products/link-repo": json(422, {
          error: "bad_request",
          message: "github app is not installed on acme/other",
        }),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/other{Enter}");
    const install = await within(main()).findByRole("link", {
      name: "Install on GitHub",
    });
    expect(install.getAttribute("href")).toBe(REPOS.app.installUrl);
    expect(install.getAttribute("target")).toBe("_blank");
    expect(main().textContent).not.toMatch(/or the repo is private/);
    expect(
      within(main()).getAllByText("Polaris Key can't read the repository.")[0],
    ).toBeTruthy();
  });

  it("a mistyped repository on an account the App is on says to check the name", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": json(422, {
          error: "bad_request",
          message: "github app is not installed on acme/tonebxo",
        }),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebxo{Enter}");
    expect(
      await within(main()).findByText("acme/tonebxo wasn't found"),
    ).toBeTruthy();
    expect(within(main()).getByText(/Check the name/)).toBeTruthy();
  });

  it("a network failure says so in the footer, not 'fix the problems'", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    expect(
      (
        await within(main()).findAllByText(
          "Check again to read the repository.",
        )
      )[0],
    ).toBeTruthy();
    expect(main().textContent).not.toMatch(/Fix the problems first/);
  });

  it("a repository with no .pkey/ shows pkey init, the docs and a way out", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": () => ({
          ...DRY,
          ready: false,
          product: null,
          slug: null,
          problems: [
            {
              check: "manifest",
              file: "product",
              path: "/",
              message: ".pkey/product is required at ingest.",
            },
          ],
        }),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    expect(await within(main()).findByText("No .pkey/ yet")).toBeTruthy();
    expect(main().textContent).toContain(
      'pkey init --product tonebox --name "tonebox"',
    );
    expect(
      within(main()).getByRole("link", { name: /How .pkey\/ works/ }),
    ).toBeTruthy();
    await userEvent.click(
      within(main()).getByRole("button", {
        name: "Start from scratch instead",
      }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "What is it called?",
      }),
    ).toBeTruthy();
    expect(field(/^Name/).value).toBe("tonebox");
  });
});

describe("New product: leaving, focus and the edges (re-review)", () => {
  const routes = (over: Record<string, unknown> = {}) => ({
    "/manage/api/github/repositories": REPOS,
    ...createdRoutes("tonebox", "Tonebox", {
      path: "/manage/api/products/link-repo",
      body: { ok: true, slug: "tonebox", kid: "gh:1", product: null },
    }),
    "/manage/api/products/beatgrid": {
      product: productRow("beatgrid", "Beatgrid", ALL_ON),
    },
    "POST /manage/api/products/link-repo": (q: URLSearchParams) =>
      q.get("dryRun") === "1" ? DRY : { ok: true, slug: "tonebox" },
    ...over,
  });

  it("N1: Open <slug> opens the product without asking to discard", async () => {
    boot("#/products/new?via=github", { extra: routes() });
    await page();
    await userEvent.click(
      await within(main()).findByRole("radio", { name: /acme\/beatgrid/ }),
    );
    await userEvent.click(
      within(main()).getByRole("link", { name: "Open beatgrid" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/beatgrid"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("N1: Enter on a registered repository opens it too", async () => {
    boot("#/products/new?via=github", { extra: routes() });
    await page();
    await userEvent.click(
      await within(main()).findByRole("radio", { name: /acme\/beatgrid/ }),
    );
    await userEvent.type(field(/^Repository/), "{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/p/beatgrid"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("N3: no .pkey/ has Check again and its own footer reason", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": () => ({
          ...DRY,
          ready: false,
          product: null,
          slug: null,
          problems: [
            {
              check: "manifest",
              file: "product",
              path: "/",
              message: ".pkey/product is required at ingest.",
            },
          ],
        }),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    await within(main()).findByText("No .pkey/ yet");
    expect(
      within(main()).getByRole("button", { name: "Check again" }),
    ).toBeTruthy();
    expect(
      within(main()).getAllByText("Add .pkey/ first.").length,
    ).toBeGreaterThan(0);
    expect(main().textContent).toContain("Terminal");
  });

  it("N4: after a 409 the note stays until the next Create, and focus stays in the result", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "POST /manage/api/products/link-repo": (q: URLSearchParams) =>
          q.get("dryRun") === "1"
            ? DRY
            : new Response(
                JSON.stringify({ error: "changed", reason: "manifest" }),
                {
                  status: 409,
                  headers: { "content-type": "application/json" },
                },
              ),
      }),
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    await userEvent.click(
      await within(main()).findByRole("button", { name: "Create Tonebox" }),
    );
    expect(
      await within(main()).findByText("The repository changed after the check"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(next("Create Tonebox").getAttribute("aria-disabled")).not.toBe(
        "true",
      ),
    );
    expect(within(main()).getByText(/Nothing was created\./)).toBeTruthy();
    expect(main().contains(document.activeElement)).toBe(true);
  });

  it("N5: Show more focuses the first row it adds", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "/manage/api/github/repositories": {
          ...REPOS,
          repositories: Array.from({ length: 8 }, (_, i) => ({
            ...REPOS.repositories[0]!,
            name: `r${i}`,
            fullName: `acme/r${i}`,
          })),
        },
      }),
    });
    await page();
    const group = await within(main()).findByRole("radiogroup", {
      name: "Repositories the Polaris Key app can read",
    });
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
    await userEvent.click(
      within(main()).getByRole("button", { name: /Show more/ }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(group).getAllByRole("radio")[5],
      ),
    );
  });

  it("N7: an unconfigured App says it isn't set up, not 'install it'", async () => {
    boot("#/products/new?via=github", {
      extra: routes({
        "/manage/api/github/repositories": {
          configured: false,
          app: null,
          installations: [],
          repositories: [],
          total: 0,
          nextCursor: null,
        },
      }),
    });
    await page();
    expect(
      await within(main()).findByText("The GitHub App isn't set up"),
    ).toBeTruthy();
    expect(within(main()).queryByText(/Install on GitHub/)).toBeNull();
    expect(
      within(main()).getByRole("link", { name: /Open Platform/ }),
    ).toBeTruthy();
  });

  it("N8: a feature card is named by its title; its line is the description", async () => {
    boot("#/products/new", {
      extra: { "/manage/api/products/slug-check": slugCheck() },
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox{Enter}");
    await screen.findByRole("heading", { level: 2, name: "What is it for?" });
    const box = within(main()).getByRole("checkbox", { name: "Licensing" });
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(box.getAttribute("aria-describedby")!)!
        .textContent,
    ).toMatch(/Gate Tonebox/);
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
    await within(main()).findByRole("radiogroup", {
      name: "Repositories the Polaris Key app can read",
    });
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});
