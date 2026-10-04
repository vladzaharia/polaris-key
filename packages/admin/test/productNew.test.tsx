import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { DRAFT_KEY } from "../src/console/pages/global/ProductNew.js";
import { boot, resetConsole } from "./consoleHarness.js";

/**
 * New product (ADMIN.md §2.3, T6; replaces `products/CreateProductDialog.tsx`). Closes PRD-7 to
 * PRD-10 and PRD-12 for the create flow; the three create tests moved here from products.test.tsx.
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

async function wizard(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "New product" });
  return main();
}

/** The current step's heading (the section the step renders in is labelled by it). */
const stepTitle = (): string =>
  main().querySelector("#wizard-step-title")?.textContent ?? "";

const click = (name: string | RegExp) =>
  userEvent.click(within(main()).getByRole("button", { name }));

describe("New product wizard", () => {
  it("starts on Source, with Continue explained until a source is chosen", async () => {
    boot("#/products/new");
    await wizard();
    expect(stepTitle()).toBe("Source");
    expect(
      within(main())
        .getByRole("button", { name: /Continue/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(
      within(main()).getByRole("radio", { name: /Start manually/ }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/products/new?via=manual"),
    );
    await click(/Continue/);
    await waitFor(() => expect(stepTitle()).toBe("Basics"));
    expect(window.location.hash).toBe("#/products/new?via=manual&step=basics");
  });

  it("asks for no compatibility window: it lives in Update → Feed now (PRD-7)", async () => {
    boot("#/products/new?via=manual&step=basics");
    await wizard();
    // One flat step list, no tabs inside tabs.
    expect(within(main()).queryByRole("tab")).toBeNull();
    expect(
      within(main()).getByRole("navigation", { name: "New product steps" }),
    ).toBeTruthy();
    await userEvent.type(within(main()).getByLabelText(/^Slug/), "newp");
    for (const next of ["Catalog", "License defaults", "Review"]) {
      expect(main().textContent).not.toMatch(/compat/i);
      await click(/Continue/);
      await waitFor(() => expect(stepTitle()).toBe(next));
    }
    expect(main().textContent).not.toMatch(/compat/i);
  });

  it("validates a step before moving on, and focuses the field", async () => {
    boot("#/products/new?via=manual&step=basics");
    await wizard();
    await userEvent.type(within(main()).getByLabelText(/^Slug/), "Not A Slug");
    await click(/Continue/);
    expect(
      await within(main()).findByText(
        "Use lowercase letters, digits, and hyphens.",
      ),
    ).toBeTruthy();
    expect(stepTitle()).toBe("Basics");
    expect(document.activeElement).toBe(within(main()).getByLabelText(/^Slug/));
  });

  it("a deep link past an incomplete step lands on that step", async () => {
    boot("#/products/new?via=manual&step=review");
    await wizard();
    expect(stepTitle()).toBe("Basics");
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/products/new?via=manual&step=basics",
      ),
    );
  });

  it("keeps the draft across a refresh, and Back keeps values", async () => {
    boot("#/products/new?via=manual&step=basics");
    await wizard();
    await userEvent.type(within(main()).getByLabelText(/^Slug/), "keepme");
    await click(/Continue/);
    await waitFor(() => expect(stepTitle()).toBe("Catalog"));
    await click("Back");
    await waitFor(() => expect(stepTitle()).toBe("Basics"));
    expect(
      (within(main()).getByLabelText(/^Slug/) as HTMLInputElement).value,
    ).toBe("keepme");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toContain("keepme");

    // A refresh: a fresh console, same tab.
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    boot("#/products/new?via=manual&step=catalog");
    await wizard();
    expect(stepTitle()).toBe("Catalog");
  });

  it("creates a manual product after a Review step, once, and shows the key with copy (PRD-9, PRD-10)", async () => {
    const log = boot("#/products/new?via=manual&step=basics", {
      extra: {
        "/manage/api/products": (q: URLSearchParams) => {
          void q;
          return { products: [] };
        },
      },
    });
    await wizard();
    await userEvent.type(within(main()).getByLabelText(/^Slug/), "newp");
    await userEvent.type(within(main()).getByLabelText(/^Name/), "New P");
    await click(/Continue/);
    await waitFor(() => expect(stepTitle()).toBe("Catalog"));
    await click(/Continue/);
    await waitFor(() => expect(stepTitle()).toBe("License defaults"));
    await click(/Continue/);
    await waitFor(() => expect(stepTitle()).toBe("Review"));
    expect(within(main()).getByText("newp")).toBeTruthy();

    // The create answers with the new product (the harness serves POST /products with this).
    vi.stubGlobal(
      "fetch",
      wrapFetch(log, {
        POST: {
          ok: true,
          slug: "newp",
          kid: "manual:42",
          signing: { kid: "manual:42", publicKey: "PUBKEY-XYZ" },
          product: null,
        },
      }),
    );
    const meReads = log.calls.filter((c) => c.path === "/manage/api/me").length;
    await click("Create product");
    await waitFor(() => expect(stepTitle()).toBe("New P is registered"));
    const posts = log.calls.filter(
      (c) => c.method === "POST" && c.path === "/manage/api/products",
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ slug: "newp", name: "New P" });
    expect(body).not.toHaveProperty("compatMin");
    expect(within(main()).getByText("PUBKEY-XYZ")).toBeTruthy();
    expect(
      within(main()).getByRole("button", { name: /Copy signing key/ }),
    ).toBeTruthy();
    // Invalidation: the session (switcher, Home) refetches.
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.path === "/manage/api/me").length,
      ).toBeGreaterThan(meReads),
    );
    await click("Open product");
    await waitFor(() => expect(window.location.hash).toBe("#/p/newp"));
  });

  it("links a repository and offers the missing secrets as the next step (PRD-8)", async () => {
    const log = boot("#/products/new?via=github&step=repository");
    await wizard();
    await userEvent.type(
      within(main()).getByLabelText(/Repository URL/),
      "https://github.com/acme/linked",
    );
    await click(/Continue/);
    await waitFor(() => expect(stepTitle()).toBe("Review"));
    vi.stubGlobal(
      "fetch",
      wrapFetch(log, {
        POST: {
          ok: true,
          slug: "linked",
          kid: "gh:99",
          remainingSecrets: ["GITHUB_APP_PRIVATE_KEY", "WEBHOOK_SECRET"],
        },
      }),
    );
    await click("Link repository");
    expect(
      await within(main()).findByText("GITHUB_APP_PRIVATE_KEY"),
    ).toBeTruthy();
    expect(within(main()).getByText("WEBHOOK_SECRET")).toBeTruthy();
    const post = log.calls.find(
      (c) => c.method === "POST" && c.path === "/manage/api/products/link-repo",
    );
    expect(JSON.parse(post!.body!)).toEqual({
      repoUrl: "https://github.com/acme/linked",
    });
    await click("Set 2 missing secrets");
    await waitFor(() => expect(window.location.hash).toBe("#/p/linked/keys"));
  });

  it("shows every problem of a refused manifest inline and stays on Review (PRD-12)", async () => {
    const log = boot("#/products/new?via=github&step=repository");
    await wizard();
    await userEvent.type(
      within(main()).getByLabelText(/Repository URL/),
      "https://github.com/acme/bad",
    );
    await click(/Continue/);
    await waitFor(() => expect(stepTitle()).toBe("Review"));
    vi.stubGlobal(
      "fetch",
      wrapFetch(log, {
        POST: new Response(
          JSON.stringify({
            error: "bad_request",
            message: "manifest invalid",
            fields: ["name missing", "bad schema"],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      }),
    );
    await click("Link repository");
    expect(await within(main()).findByText("name missing")).toBeTruthy();
    expect(within(main()).getByText("bad schema")).toBeTruthy();
    expect(stepTitle()).toBe("Review");
    expect(within(main()).queryByText(/api 422/)).toBeNull();
  });

  it("asks before leaving with a draft, and Discard clears it", async () => {
    boot("#/products/new?via=manual&step=basics");
    await wizard();
    await userEvent.type(within(main()).getByLabelText(/^Slug/), "draft");
    await userEvent.click(within(main()).getByRole("link", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Discard this new product?")).toBeTruthy();
    expect(window.location.hash).toContain("#/products/new");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Discard" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/products"));
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("passes axe", async () => {
    boot("#/products/new?via=github&step=repository");
    await wizard();
    const results = await axe(main());
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

/**
 * Serve POSTs with `responses.POST` and everything else from the harness's own fetch, logging
 * every call into the harness's log.
 */
function wrapFetch(
  log: {
    calls: { path: string; method: string; query: string; body?: string }[];
  },
  responses: { POST: unknown },
): typeof fetch {
  const inner = globalThis.fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const url = typeof input === "string" ? input : input.toString();
      const [path = "", query = ""] = url
        .replace("http://localhost", "")
        .split("?");
      log.calls.push({
        path,
        method: "POST",
        query,
        ...(typeof init.body === "string" ? { body: init.body } : {}),
      });
      const r = responses.POST;
      if (r instanceof Response) return r.clone();
      return new Response(JSON.stringify(r), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(input, init);
  }) as typeof fetch;
}
