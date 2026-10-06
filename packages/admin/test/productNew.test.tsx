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
} from "../src/console/pages/global/ProductNew.js";
import { WELCOME_KEY } from "../src/console/pages/core/Welcome.js";
import type { Me } from "../src/api.js";
import {
  ALL_ON,
  boot,
  ME,
  productRow,
  resetConsole,
} from "./consoleHarness.js";

/**
 * New product on one screen (EXPERIENCE.md §0.4 S1, C1; UX-20): Start from, then Name with the
 * slug following it and checked as you type, Advanced license defaults, and Enter creates. No
 * result page and no toast: the product opens on Overview with a one-time welcome.
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

/** The routes a freshly created `slug` needs for its Overview to render. */
function newProductRoutes(
  slug: string,
  name: string,
  post: { path: string; body: unknown },
): Record<string, unknown> {
  return {
    [`POST ${post.path}`]: post.body,
    [`/manage/api/products/${slug}`]: {
      product: productRow(slug, name, {
        license: { enabled: true },
        config: { enabled: false },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
      }),
    },
    [`/manage/api/products/${slug}/license/licenses`]: { licenses: [] },
    [`/manage/api/products/${slug}/activity`]: { items: [], nextCursor: null },
  };
}

/**
 * Boot options for a create that succeeds: the registry (the slug check) doesn't hold the new
 * product yet, and the session refetched after the create does, so its Overview opens.
 */
function created(
  slug: string,
  name: string,
  post: { path: string; body: unknown },
): { me: { products: Me["products"] }; extra: Record<string, unknown> } {
  return {
    me: { products: [...ME.products, { slug, name, schemaVersion: 1 }] },
    extra: {
      "/manage/api/products": {
        products: ME.products.map((p) => productRow(p.slug, p.name, ALL_ON)),
      },
      ...newProductRoutes(slug, name, post),
    },
  };
}

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

describe("New product", () => {
  it("is one screen: Start from, Name, Slug and Advanced; no steps, catalog, admin group or compatibility window", async () => {
    boot("#/products/new");
    await page();
    expect(
      within(main()).queryByRole("navigation", { name: /steps/i }),
    ).toBeNull();
    expect(
      (
        within(main()).getByRole("radio", { name: /Nothing/ }) as HTMLElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(field(/^Name/)).toBeTruthy();
    expect(field(/^Slug/)).toBeTruthy();
    expect(within(main()).queryByLabelText(/Catalog/)).toBeNull();
    expect(within(main()).queryByLabelText(/Admin group/)).toBeNull();
    expect(main().textContent).not.toMatch(/compat|PLATFORM_ADMIN_GROUP/i);
    expect(main().textContent).not.toMatch(/add a repository later/i);
    expect(
      within(main()).getByRole("button", { name: /Advanced/ }),
    ).toHaveProperty("ariaExpanded", "false");
    expect(
      within(main()).getByRole("button", { name: "Create product" }),
    ).toBeTruthy();
  });

  it("derives the slug from the name until the slug is edited, and shows it is available", async () => {
    boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "Tone Box");
    expect(field(/^Slug/).value).toBe("tone-box");
    expect(await within(main()).findByText("Available")).toBeTruthy();
    expect(
      within(main()).getByRole("button", { name: "Create Tone Box" }),
    ).toBeTruthy();

    await userEvent.clear(field(/^Slug/));
    await userEvent.type(field(/^Slug/), "tb");
    await userEvent.type(field(/^Name/), "!");
    expect(field(/^Slug/).value).toBe("tb");

    // Typing the derived slug again hands it back to the name.
    await userEvent.clear(field(/^Slug/));
    expect(field(/^Slug/).value).toBe("");
    await userEvent.type(field(/^Slug/), "tone-box!");
    expect(field(/^Slug/).value).toBe("tone-box!");
    await userEvent.type(field(/^Slug/), "{Backspace}");
    await userEvent.type(field(/^Name/), "{Backspace}");
    expect(field(/^Slug/).value).toBe("tone-box");
  });

  it("says a taken slug is taken as you type and offers a free one", async () => {
    boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "DJDL");
    expect(
      await within(main()).findByText("djdl is taken. Try djdl-app."),
    ).toBeTruthy();
    expect(main().textContent).not.toMatch(/Available/);
    await userEvent.click(
      within(main()).getByRole("button", { name: "Use djdl-app" }),
    );
    expect(field(/^Slug/).value).toBe("djdl-app");
    expect(within(main()).queryByText(/is taken/)).toBeNull();
  });

  it("refuses a reserved slug before asking the server", async () => {
    const log = boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "Docs");
    expect(
      await within(main()).findByText("docs is reserved. Choose another slug."),
    ).toBeTruthy();
    await userEvent.click(
      within(main()).getByRole("button", { name: "Create Docs" }),
    );
    expect(log.calls.some((c) => c.method === "POST")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(field(/^Slug/)));
  });

  it("an empty Create names the missing field and focuses it", async () => {
    boot("#/products/new");
    await page();
    await userEvent.click(
      within(main()).getByRole("button", { name: "Create product" }),
    );
    expect(
      await within(main()).findByText("Enter the product's name."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field(/^Name/)));
  });

  it("Enter creates, once, and lands on Overview's welcome with the signing key; no toast", async () => {
    const log = boot("#/products/new", {
      ...created("tonebox", "Tonebox", {
        path: "/manage/api/products",
        body: {
          ok: true,
          slug: "tonebox",
          kid: "tonebox-2026",
          signing: { kid: "tonebox-2026", publicKey: "PUBKEY-XYZ" },
          product: null,
        },
      }),
    });
    await page();
    await userEvent.type(field(/^Name/), "Tonebox{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/p/tonebox"));
    const posts = log.calls.filter(
      (c) => c.method === "POST" && c.path === "/manage/api/products",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.json).toEqual({ slug: "tonebox", name: "Tonebox" });

    const welcome = await screen.findByTestId("product-welcome");
    expect(
      within(welcome).getByRole("heading", { name: "Tonebox is ready" }),
    ).toBeTruthy();
    expect(within(welcome).getByText("tonebox-2026")).toBeTruthy();
    expect(within(welcome).getByText(/Signed/)).toBeTruthy();
    // The key is for the app's trust pins; releases use the separate CI release key (UX-59).
    expect(welcome.textContent).toContain(
      "Pin this key in your app. Releases are signed by a separate CI release key.",
    );
    expect(
      within(welcome).getByRole("button", {
        name: /Copy the signing public key/,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Product created")).toBeNull();
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    // Consumed: a refresh or a later visit shows the ordinary Overview.
    expect(window.sessionStorage.getItem(WELCOME_KEY)).toBeNull();

    await userEvent.click(
      within(welcome).getByRole("button", { name: "Dismiss" }),
    );
    expect(screen.queryByTestId("product-welcome")).toBeNull();
  });

  it("sends the license defaults from Advanced", async () => {
    const log = boot("#/products/new", {
      ...created("new-p", "New P", {
        path: "/manage/api/products",
        body: { ok: true, slug: "new-p", kid: "new-p-2026", product: null },
      }),
    });
    await page();
    await userEvent.type(field(/^Name/), "New P");
    await userEvent.click(
      within(main()).getByRole("button", { name: /Advanced/ }),
    );
    await userEvent.type(field(/^Offline grace/), "30");
    await userEvent.type(field(/^Device limit/), "2");
    await userEvent.click(
      within(main()).getByRole("button", { name: "Create New P" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/new-p"));
    const post = log.calls.find(
      (c) => c.method === "POST" && c.path === "/manage/api/products",
    );
    expect(post!.json).toEqual({
      slug: "new-p",
      name: "New P",
      defaultMaxOfflineDays: 30,
      defaultDeviceLimit: 2,
    });
  });

  it("keeps offline grace within the worker's 365 days, on the field", async () => {
    const log = boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "New P");
    await userEvent.click(
      within(main()).getByRole("button", { name: /Advanced/ }),
    );
    await userEvent.type(field(/^Offline grace/), "400");
    await userEvent.click(
      within(main()).getByRole("button", { name: "Create New P" }),
    );
    expect(
      await within(main()).findByText(
        "Use a whole number from 1 to 365, or leave it blank.",
      ),
    ).toBeTruthy();
    expect(log.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("puts a slug the server refuses on the slug field, with a free one to take", async () => {
    boot("#/products/new", {
      extra: {
        "POST /manage/api/products": new Response(
          JSON.stringify({
            error: "bad_request",
            message: "product exists",
            fields: ["slug"],
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await userEvent.type(field(/^Name/), "Ghost{Enter}");
    expect(
      await within(main()).findByText("ghost is taken. Try ghost-app."),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/products/new");
    expect(main().textContent).not.toMatch(/409|bad_request/);
    await waitFor(() => expect(document.activeElement).toBe(field(/^Slug/)));
    await userEvent.click(
      within(main()).getByRole("button", { name: "Use ghost-app" }),
    );
    expect(field(/^Slug/).value).toBe("ghost-app");
  });

  it("links a repository and lands on the welcome with the missing secrets as the next step", async () => {
    const log = boot("#/products/new?via=github", {
      ...created("linked", "Linked", {
        path: "/manage/api/products/link-repo",
        body: {
          ok: true,
          slug: "linked",
          kid: "gh:99",
          remainingSecrets: ["GITHUB_APP_PRIVATE_KEY", "WEBHOOK_SECRET"],
        },
      }),
    });
    await page();
    expect(within(main()).queryByLabelText(/^Name/)).toBeNull();
    await userEvent.type(field(/^Repository/), "acme/linked");
    expect(
      within(main()).getByText(
        /reads .pkey\/ on acme\/linked's default branch/,
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(main()).getByRole("button", { name: "Link repository" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/linked"));
    const post = log.calls.find(
      (c) => c.method === "POST" && c.path === "/manage/api/products/link-repo",
    );
    expect(post!.json).toEqual({ repoUrl: "acme/linked" });
    const welcome = await screen.findByTestId("product-welcome");
    expect(
      within(welcome).getByText(/Registered from acme\/linked/),
    ).toBeTruthy();
    await userEvent.click(
      within(welcome).getByRole("link", { name: /Set 2 missing secrets/ }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/linked/keys"));
  });

  it("checks the repository's shape before asking the server", async () => {
    const log = boot("#/products/new?via=github");
    await page();
    await userEvent.type(field(/^Repository/), "not a repo{Enter}");
    expect(
      await within(main()).findByText(
        "Use owner/repo or the repository's GitHub URL.",
      ),
    ).toBeTruthy();
    expect(log.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("lists every problem of a refused manifest with its file and path, and Check again links again", async () => {
    const log = boot("#/products/new?via=github", {
      extra: {
        "POST /manage/api/products/link-repo": new Response(
          JSON.stringify({
            error: "bad_request",
            message: "manifest invalid",
            errors: [
              "product/name: is required",
              "product/licensing/tiers/0: must be an object",
            ],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/bad{Enter}");
    expect(
      await within(main()).findByText("2 problems in .pkey/product"),
    ).toBeTruthy();
    expect(within(main()).getByText(/is required/)).toBeTruthy();
    expect(within(main()).getByText(/must be an object/)).toBeTruthy();
    expect(
      within(main()).getByText(".pkey/product /licensing/tiers/0"),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/products/new?via=github");
    expect(main().textContent).not.toMatch(/422|api 4/);
    const posts = () =>
      log.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/link-repo"),
      ).length;
    expect(posts()).toBe(1);
    await userEvent.click(
      within(main()).getByRole("button", { name: "Check again" }),
    );
    await waitFor(() => expect(posts()).toBe(2));
  });

  it("puts a repository the GitHub App can't read on the field, with the install fix beside it", async () => {
    boot("#/products/new?via=github", {
      extra: {
        "POST /manage/api/products/link-repo": new Response(
          JSON.stringify({
            error: "bad_request",
            message: "github app is not installed on acme/private",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/private{Enter}");
    expect(
      await within(main()).findByText(
        "The Polaris Key GitHub App isn't installed on acme/private, or the repo is private.",
      ),
    ).toBeTruthy();
    expect(
      within(main()).getByRole("link", { name: /Install the GitHub App/ }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(field(/^Repository/)),
    );
    expect(main().textContent).not.toMatch(/422/);
  });

  it("says a linked manifest's slug is taken, as a change to .pkey/product, with Check again", async () => {
    const log = boot("#/products/new?via=github", {
      extra: {
        "POST /manage/api/products/link-repo": new Response(
          JSON.stringify({
            error: "bad_request",
            message: "product already exists: tonebox",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await userEvent.type(field(/^Repository/), "acme/tonebox{Enter}");
    expect(await within(main()).findByText("tonebox is taken")).toBeTruthy();
    expect(
      within(main()).getByText(
        "The slug comes from product.slug in .pkey/product: change it there, push, then check again. If it is this repository's product, resync it from that product instead.",
      ),
    ).toBeTruthy();
    expect(within(main()).queryByRole("button", { name: /^Use / })).toBeNull();
    expect(main().textContent).not.toMatch(/tonebox-app|422/);
    const posts = () =>
      log.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/link-repo"),
      ).length;
    await userEvent.click(
      within(main()).getByRole("button", { name: "Check again" }),
    );
    await waitFor(() => expect(posts()).toBe(2));
  });

  it("keeps the draft across a refresh", async () => {
    boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "Keep Me");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toContain("keep-me");
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    boot("#/products/new");
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

  it("passes axe, both sources", async () => {
    boot("#/products/new");
    await page();
    await userEvent.type(field(/^Name/), "DJDL");
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    window.sessionStorage.clear();
    boot("#/products/new?via=github");
    await page();
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});
