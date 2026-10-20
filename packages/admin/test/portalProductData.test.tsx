import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PortalLicenseSummary } from "../src/portal/api.js";
import {
  ACCOUNT,
  NOW_S,
  axeViolations,
  detail,
  entryItem,
  fetchedRequests,
  libraryFor,
  license,
  mockFetch,
  renderPortal,
  signedIn,
  type MockRoute,
} from "./portalHarness.js";
import {
  captureDownloads,
  deferred,
  settle,
  type DownloadCapture,
} from "./portalDataKit.js";

/**
 * Each product page's **Your data in <Product>** card (I-11; S-16 §5.5, §5.7): Download my data
 * from the product, and Remove my data from the product with the license kept unless the person
 * also chooses to remove it (D25). Everything is about one product: the account's own file and
 * its 14-day deletion are Account's, and these tests hold the two apart.
 */

const FERN = { developerName: "Little Fern" };
const STEP_UP = { status: 401, body: { error: "step_up_required" } };

/** A Mossgarden license its key can bring back, unless a test says otherwise. */
const mine = (over: Partial<PortalLicenseSummary> = {}): PortalLicenseSummary =>
  license({
    product: "mossgarden",
    productName: "Mossgarden",
    origin: "key",
    removable: true,
    productBranding: FERN,
    ...over,
  });

/** What `GET /api/products/<p>/export` answers (its shape is the Worker's). */
const fileOf = (product: string) => ({
  schema: "pkey-product-export/1",
  exportedAt: NOW_S,
  product: { slug: product },
});

/** A minimal `GET /api/products/<p>`: the seat limits and services the product page reads. */
function productView(product: string, licenses: PortalLicenseSummary[]) {
  return {
    product,
    name: product,
    developerName: null,
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: null,
    services: { license: true },
    status: "active",
    addedAt: NOW_S - 30 * 86_400,
    licenses: licenses.map((l) => ({
      id: l.id,
      tier: null,
      status: "active",
      licenseStatus: "active",
      activatedAt: l.activatedAt,
      expiresAt: null,
      maxOfflineDays: null,
      deviceLimit: 3,
      activeSeatCount: 1,
      deviceCount: 1,
      dormantCount: 0,
      entitlements: [],
      devices: [],
    })),
  };
}

/** The removal's answer when nothing refuses it: the Worker's `{ ok, product, removed, … }`. */
const REMOVED = {
  ok: true,
  product: "mossgarden",
  removed: true,
  detachedLicenses: [] as string[],
};

interface MossgardenWorker {
  routes: Record<string, MockRoute>;
  /** Each removal the Worker received, as the path and query it came in on. */
  removals: string[];
}

/**
 * The Worker as Mossgarden's page sees it: the account's library (Mossgarden's `held` licenses and
 * Ember Tactics, a product the account also holds), both products' exports, the account's own
 * export, and `DELETE /api/products/mossgarden/data`. `answer` decides that removal, with `done()`
 * making the Worker's change (the licenses leave only when `?alsoRemoveLicense=1` was sent).
 */
function worker(
  held: PortalLicenseSummary[] = [mine()],
  answer: (url: string, done: () => unknown) => MockRoute = (_url, done) =>
    done(),
): MossgardenWorker {
  const ember = license({ product: "ember", productName: "Ember Tactics" });
  let list = [...held];
  const removals: string[] = [];
  const routes = signedIn([...held, ember], {
    "/api/licenses": () => ({ licenses: [...list, ember] }),
    "/api/library": () => libraryFor([...list, ember]),
    "/api/products/mossgarden": productView("mossgarden", held),
    "/api/products/mossgarden/export": fileOf("mossgarden"),
    "/api/products/ember/export": fileOf("ember"),
    "/api/me/export": { schema: "pkey-account-export/1" },
    "DELETE /api/products/mossgarden/data": (_init: unknown, url: string) => {
      removals.push(url);
      return answer(url, () => {
        const also = url.includes("alsoRemoveLicense=1");
        const detachedLicenses = also ? list.map((l) => l.id) : [];
        if (also) list = [];
        return { ...REMOVED, detachedLicenses };
      });
    },
    ...Object.fromEntries(
      held.map((l) => [`/api/licenses/mossgarden/${l.id}`, detail(l)]),
    ),
  });
  return { routes, removals };
}

/** Open a product's page and find its data card. */
async function open(
  routes: Record<string, MockRoute>,
  slug = "mossgarden",
  name = "Mossgarden",
): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/#/p/${slug}`);
  mockFetch(routes);
  renderPortal();
  await screen.findByRole("heading", { level: 1, name });
  return screen.findByRole("region", { name: `Your data in ${name}` });
}

async function openRemove(
  card: HTMLElement,
  name = "Mossgarden",
): Promise<HTMLElement> {
  await userEvent.click(
    within(card).getByRole("button", { name: `Remove my data from ${name}` }),
  );
  return screen.findByRole("alertdialog", {
    name: `Remove your data from ${name}?`,
  });
}

const count = (request: string): number =>
  fetchedRequests().filter((r) => r === request).length;

let files: DownloadCapture;

beforeEach(() => {
  files = captureDownloads();
});

afterEach(() => {
  files.restore();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Download my data from a product (I-11)", () => {
  it("shows the product's own card, scoped in its words, and fetches nothing until pressed", async () => {
    const card = await open(worker().routes);
    expect(
      within(card).getByText("Your license, devices, settings and activity."),
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", {
        name: "Download my data from Mossgarden",
      }),
    ).toBeTruthy();
    // Account's controls are Account's: none of them is on a product page.
    expect(
      screen.queryByRole("button", { name: "Download my data" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete account" })).toBeNull();
    // It is the last section of the nav.
    expect(
      screen.getAllByRole("link", { name: "Your data" }).length,
    ).toBeGreaterThan(0);
    await settle();
    expect(fetchedRequests().filter((r) => /export|\/data$/.test(r))).toEqual(
      [],
    );
    expect(await axeViolations()).toEqual([]);
  });

  it("saves this product's file only: its route, its own name, and nothing of the account or another product", async () => {
    const card = await open(worker().routes);
    await userEvent.click(
      within(card).getByRole("button", {
        name: "Download my data from Mossgarden",
      }),
    );
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(files.saved[0]!.filename).toBe("polaris-key-mossgarden-data.json");
    expect(JSON.parse(await files.saved[0]!.text())).toEqual(
      fileOf("mossgarden"),
    );
    expect(fetchedRequests().filter((r) => /export|DELETE/.test(r))).toEqual([
      "GET /api/products/mossgarden/export",
    ]);
    const sent = vi
      .mocked(fetch)
      .mock.calls.find(
        ([url]) => String(url) === "/api/products/mossgarden/export",
      )!;
    expect(new Headers(sent[1]?.headers).get("X-PKey-Portal-CSRF")).toBe(
      "csrf-token",
    );
    expect(await screen.findByText("Your download has started")).toBeTruthy();
    expect(
      screen.getByText("It holds personal details, so keep it private."),
    ).toBeTruthy();
    expect(within(card).queryByRole("alert")).toBeNull();
  });

  it("asks for the page's own product on another page too: Ember's page names Ember", async () => {
    const card = await open(worker().routes, "ember", "Ember Tactics");
    await userEvent.click(
      within(card).getByRole("button", {
        name: "Download my data from Ember Tactics",
      }),
    );
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(files.saved[0]!.filename).toBe("polaris-key-ember-data.json");
    expect(fetchedRequests().filter((r) => /export/.test(r))).toEqual([
      "GET /api/products/ember/export",
    ]);
  });

  it("starts one request at a time: a second press while it runs does nothing", async () => {
    const answer = deferred<unknown>();
    const { routes } = worker();
    const card = await open({
      ...routes,
      "/api/products/mossgarden/export": () => answer.promise,
    });
    const button = within(card).getByRole("button", {
      name: "Download my data from Mossgarden",
    }) as HTMLButtonElement;
    await userEvent.dblClick(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    answer.resolve(fileOf("mossgarden"));
    await waitFor(() => expect(files.saved).toHaveLength(1));
    await settle();
    expect(count("GET /api/products/mossgarden/export")).toBe(1);
    expect(files.saved).toHaveLength(1);
  });

  it("keeps a refusal beside the button in plain words, and pressing again tries again", async () => {
    let asked = 0;
    const { routes } = worker();
    const card = await open({
      ...routes,
      "/api/products/mossgarden/export": () =>
        ++asked === 1
          ? { status: 429, body: { error: "rate_limited" } }
          : fileOf("mossgarden"),
    });
    const button = within(card).getByRole("button", {
      name: "Download my data from Mossgarden",
    }) as HTMLButtonElement;
    await userEvent.click(button);
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "Too many tries. Wait a minute, then try again.",
    );
    expect(files.saved).toHaveLength(0);
    expect(button.disabled).toBe(false);
    await userEvent.click(button);
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(within(card).queryByRole("alert")).toBeNull();
  });
});

describe("Remove my data from a product (I-11)", () => {
  it("asks first: it says what goes and what stays, takes focus on Keep my data, and cancelling sends nothing", async () => {
    const { routes, removals } = worker();
    const card = await open(routes);
    const libraryReads = count("GET /api/library");
    const dialog = await openRemove(card);
    expect(
      within(dialog).getByText(
        "This only affects Mossgarden. Your Polaris Locker account and your other apps stay as they are.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Polaris Locker deletes your settings and activity for Mossgarden. This can't be undone.",
      "Little Fern is told, so they can delete their own copy.",
      "Your license stays in your library. While it does, Little Fern can still connect you to your old records through it.",
    ]);
    const keep = within(dialog).getByRole("button", { name: "Keep my data" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    expect(
      within(dialog)
        .getByRole("checkbox", {
          name: "Also remove my license from my library",
        })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(card).getByRole("button", {
          name: "Remove my data from Mossgarden",
        }),
      ),
    );
    // Escape cancels too.
    await openRemove(card);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    expect(removals).toEqual([]);
    expect(count("GET /api/library")).toBe(libraryReads);
  });

  it("names the developer only when it knows one", async () => {
    const card = await open(
      worker([mine({ productBranding: undefined })]).routes,
    );
    const dialog = await openRemove(card);
    expect(
      within(dialog).getByText(
        "The developer is told, so they can delete their own copy.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Your license stays in your library. While it does, the developer can still connect you to your old records through it.",
      ),
    ).toBeTruthy();
  });

  it("removes the data and keeps the license by default: no flag sent, the page stays, and what it showed is read again", async () => {
    const { routes, removals } = worker();
    const card = await open(routes);
    const before = {
      library: count("GET /api/library"),
      licenses: count("GET /api/licenses"),
      product: count("GET /api/products/mossgarden"),
    };
    const dialog = await openRemove(card);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove my data" }),
    );
    await waitFor(() =>
      expect(removals).toEqual(["/api/products/mossgarden/data"]),
    );
    expect(
      await screen.findByText("Your data was removed from Mossgarden"),
    ).toBeTruthy();
    expect(
      screen.getByText("Your license stays in your library."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(count("GET /api/library")).toBe(before.library + 1),
    );
    expect(count("GET /api/licenses")).toBe(before.licenses + 1);
    expect(count("GET /api/products/mossgarden")).toBe(before.product + 1);
    // Still Mossgarden's page, still holding its license.
    expect(window.location.hash).toBe("#/p/mossgarden");
    expect(
      await screen.findByRole("region", { name: "Your data in Mossgarden" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Mossgarden license" }),
    ).toBeTruthy();
    // This product's route alone: not the account's deletion, not another product.
    expect(fetchedRequests().filter((r) => r.startsWith("DELETE"))).toEqual([
      "DELETE /api/products/mossgarden/data",
    ]);
  });

  it("removes the license too only when the person chooses: the button says so, and the page goes back to the Library", async () => {
    const { routes, removals } = worker();
    const card = await open(routes);
    const dialog = await openRemove(card);
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Also remove my license from my library",
      }),
    );
    expect(
      within(dialog).getByText(
        "It won't come back to this account by itself. To add it again, use its key.",
      ),
    ).toBeTruthy();
    // The license no longer stays, so that line gives way to the choice's own.
    expect(within(dialog).queryByText(/Your license stays/)).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Remove my data" }),
    ).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Remove my data and license",
      }),
    );
    await waitFor(() =>
      expect(removals).toEqual([
        "/api/products/mossgarden/data?alsoRemoveLicense=1",
      ]),
    );
    expect(
      await screen.findByText("Your data was removed from Mossgarden"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your license also left your library. To add it again, use its key.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    await screen.findByRole("heading", { level: 1, name: "Your library" });
    // Ember, held separately, stays; Mossgarden went with its license.
    expect(
      await screen.findByRole("article", { name: "Ember Tactics" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Mossgarden" })).toBeNull(),
    );
    expect(fetchedRequests().filter((r) => r.startsWith("DELETE"))).toEqual([
      "DELETE /api/products/mossgarden/data?alsoRemoveLicense=1",
    ]);
  });

  it("names every license when there are several, and removes them together", async () => {
    const { routes, removals } = worker([
      mine(),
      mine({ id: "lic_two", activatedAt: NOW_S - 90 * 86_400 }),
    ]);
    const card = await open(routes);
    expect(
      within(card).getByText("Your licenses, devices, settings and activity."),
    ).toBeTruthy();
    const dialog = await openRemove(card);
    expect(
      within(dialog).getByText(
        "Your licenses stay in your library. While they do, Little Fern can still connect you to your old records through them.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Also remove my 2 licenses from my library",
      }),
    );
    expect(
      within(dialog).getByText(
        "They won't come back to this account by themselves. To add them again, use their keys.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Remove my data and licenses",
      }),
    );
    await waitFor(() =>
      expect(removals).toEqual([
        "/api/products/mossgarden/data?alsoRemoveLicense=1",
      ]),
    );
    expect(
      await screen.findByText(
        "Your licenses also left your library. To add them again, use their keys.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });

  it.each([
    [
      "a license a key can't bring back (a sign-in license, a Discover claim)",
      [mine({ removable: false })],
      /Your license stays in your library/,
    ],
    [
      "a Worker that doesn't say which licenses can go",
      [mine({ removable: undefined })],
      /Your license stays in your library/,
    ],
    [
      "one license of two that can't be added back",
      [mine(), mine({ id: "lic_two", removable: false })],
      /Your licenses stay in your library/,
    ],
  ])(
    "offers no license choice for %s, and sends no flag",
    async (_case, held, stays) => {
      const { routes, removals } = worker(held);
      const card = await open(routes);
      const dialog = await openRemove(card);
      expect(within(dialog).queryByRole("checkbox")).toBeNull();
      expect(within(dialog).getByText(stays)).toBeTruthy();
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Remove my data" }),
      );
      await waitFor(() =>
        expect(removals).toEqual(["/api/products/mossgarden/data"]),
      );
      expect(
        await screen.findByText("Your data was removed from Mossgarden"),
      ).toBeTruthy();
      expect(window.location.hash).toBe("#/p/mossgarden");
    },
  );

  describe("a refusal (409 not_removable)", () => {
    const refuse = (reason?: string) => ({
      status: 409,
      body: {
        error: "not_removable",
        message: "this license could not be added back, so it stays",
        ...(reason ? { reason } : {}),
      },
    });
    const tail = "You can still remove your data and keep your license.";

    it("wrote nothing: it says so inline, stops offering the choice, refreshes nothing, and lets the data go alone", async () => {
      const { routes, removals } = worker([mine()], (url, done) =>
        url.includes("alsoRemoveLicense=1") ? refuse("key_claim_off") : done(),
      );
      const card = await open(routes);
      const before = count("GET /api/library");
      const dialog = await openRemove(card);
      await userEvent.click(
        within(dialog).getByRole("checkbox", {
          name: "Also remove my license from my library",
        }),
      );
      await userEvent.click(
        within(dialog).getByRole("button", {
          name: "Remove my data and license",
        }),
      );
      const alert = await within(dialog).findByRole("alert");
      expect(within(alert).getByText("Nothing was removed")).toBeTruthy();
      expect(
        within(alert).getByText(
          `Mossgarden doesn't let you add a license with its key, so it couldn't be added back later. It stays in your library. ${tail}`,
        ),
      ).toBeTruthy();
      expect(removals).toEqual([
        "/api/products/mossgarden/data?alsoRemoveLicense=1",
      ]);
      // The dialog is still there, back to the data alone: no choice, the license stays.
      expect(within(dialog).queryByRole("checkbox")).toBeNull();
      expect(
        within(dialog).getByText(/Your license stays in your library/),
      ).toBeTruthy();
      await settle();
      expect(count("GET /api/library")).toBe(before);
      expect(window.location.hash).toBe("#/p/mossgarden");
      expect(
        screen.queryByText("Your data was removed from Mossgarden"),
      ).toBeNull();

      // The data can still go, on its own.
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Remove my data" }),
      );
      expect(
        await screen.findByText("Your data was removed from Mossgarden"),
      ).toBeTruthy();
      expect(removals).toEqual([
        "/api/products/mossgarden/data?alsoRemoveLicense=1",
        "/api/products/mossgarden/data",
      ]);
      await waitFor(() => expect(count("GET /api/library")).toBe(before + 1));
      expect(window.location.hash).toBe("#/p/mossgarden");
    });

    it.each([
      [
        "no_active_key",
        "A license has no active key, so it couldn't be added back later. It stays in your library.",
      ],
      [
        undefined,
        "This license can't be added back with a key, so it stays in your library.",
      ],
    ])("says why: %s", async (reason, why) => {
      const { routes } = worker([mine()], (url, done) =>
        url.includes("alsoRemoveLicense=1") ? refuse(reason) : done(),
      );
      const card = await open(routes);
      const dialog = await openRemove(card);
      await userEvent.click(
        within(dialog).getByRole("checkbox", {
          name: "Also remove my license from my library",
        }),
      );
      await userEvent.click(
        within(dialog).getByRole("button", {
          name: "Remove my data and license",
        }),
      );
      const alert = await within(dialog).findByRole("alert");
      expect(within(alert).getByText("Nothing was removed")).toBeTruthy();
      expect(within(alert).getByText(`${why} ${tail}`)).toBeTruthy();
    });
  });

  it.each([
    [
      "too many tries",
      { status: 429, body: { error: "rate_limited" } },
      "Too many tries",
      "Wait a minute, then try again.",
    ],
    [
      "an error from the Worker",
      { status: 500, body: { error: "internal" } },
      "Something went wrong",
      "Try again. If it keeps happening, contact the developer.",
    ],
    [
      "a product the Worker says it holds nothing in",
      { status: 404, body: { error: "not_found" } },
      "That isn't here",
      "It may have been removed, or the link is out of date.",
    ],
  ])(
    "%s stays in the dialog, refreshes nothing, and pressing again tries again",
    async (_case, failure, title, description) => {
      let asked = 0;
      const { routes, removals } = worker([mine()], (_url, done) =>
        ++asked === 1 ? failure : done(),
      );
      const card = await open(routes);
      const before = count("GET /api/library");
      const dialog = await openRemove(card);
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Remove my data" }),
      );
      const alert = await within(dialog).findByRole("alert");
      expect(within(alert).getByText(title)).toBeTruthy();
      expect(within(alert).getByText(description)).toBeTruthy();
      await settle();
      expect(count("GET /api/library")).toBe(before);
      expect(window.location.hash).toBe("#/p/mossgarden");
      expect(
        screen.queryByText("Your data was removed from Mossgarden"),
      ).toBeNull();
      expect(screen.getByRole("alertdialog")).toBeTruthy();

      await userEvent.click(
        within(dialog).getByRole("button", { name: "Remove my data" }),
      );
      expect(
        await screen.findByText("Your data was removed from Mossgarden"),
      ).toBeTruthy();
      expect(removals).toEqual([
        "/api/products/mossgarden/data",
        "/api/products/mossgarden/data",
      ]);
      await waitFor(() => expect(count("GET /api/library")).toBe(before + 1));
    },
  );

  it("sends one removal at a time: nothing in the dialog changes or closes while it runs", async () => {
    const answer = deferred<unknown>();
    const { routes, removals } = worker([mine()], () => answer.promise);
    const card = await open(routes);
    const dialog = await openRemove(card);
    const choice = within(dialog).getByRole("checkbox", {
      name: "Also remove my license from my library",
    }) as HTMLButtonElement;
    const confirm = within(dialog).getByRole("button", {
      name: "Remove my data",
    }) as HTMLButtonElement;
    await userEvent.dblClick(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(choice.disabled).toBe(true);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Keep my data",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    answer.resolve(REMOVED);
    expect(
      await screen.findByText("Your data was removed from Mossgarden"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removals).toHaveLength(1);
  });

  it("is about this product alone: nothing in it speaks of the account's deletion, and only its route is called", async () => {
    const { routes, removals } = worker();
    const card = await open(routes);
    const dialog = await openRemove(card);
    expect(dialog.textContent).not.toMatch(
      /delete (your|my) account|14 days|scheduled for deletion|erase/i,
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove my data" }),
    );
    await screen.findByText("Your data was removed from Mossgarden");
    expect(removals).toEqual(["/api/products/mossgarden/data"]);
    expect(
      fetchedRequests().filter(
        (r) => r.startsWith("DELETE") || /deletion|export/.test(r),
      ),
    ).toEqual(["DELETE /api/products/mossgarden/data"]);
    expect(count("GET /api/products/ember/export")).toBe(0);
  });
});

describe("an open product's page (I-11)", () => {
  const DRIFT = entryItem("driftwood", "Driftwood Notes", {
    developerName: "Tern Studio",
  });

  /** An account holding only the open product's entry. */
  function entryWorker(
    answer: (done: () => unknown) => MockRoute = (done) => done(),
  ) {
    const removals: string[] = [];
    const routes = signedIn([], {
      "/api/library": { products: [DRIFT] },
      "/api/products/driftwood/export": fileOf("driftwood"),
      "DELETE /api/products/driftwood/data": (_init: unknown, url: string) => {
        removals.push(url);
        return answer(() => ({
          ok: true,
          product: "driftwood",
          removed: true,
          detachedLicenses: [],
        }));
      },
    });
    return { routes, removals };
  }

  it("has the same card, and speaks of no license: what the file holds, what goes, what stays", async () => {
    const { routes, removals } = entryWorker();
    const card = await open(routes, "driftwood", "Driftwood Notes");
    expect(within(card).getByText("Your settings and activity.")).toBeTruthy();
    expect(card.textContent).not.toMatch(/license/i);
    const dialog = await openRemove(card, "Driftwood Notes");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Polaris Locker deletes your settings and activity for Driftwood Notes. This can't be undone.",
      "Tern Studio is told, so they can delete their own copy.",
      "Driftwood Notes stays in your library.",
    ]);
    expect(dialog.textContent).not.toMatch(/license/i);
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove my data" }),
    );
    await waitFor(() =>
      expect(removals).toEqual(["/api/products/driftwood/data"]),
    );
    expect(
      await screen.findByText("Your data was removed from Driftwood Notes"),
    ).toBeTruthy();
    // The entry stays: the page is still its page, with its card.
    expect(
      screen.getByText("Driftwood Notes stays in your library."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(window.location.hash).toBe("#/p/driftwood");
    expect(
      screen.getByRole("region", { name: "Your data in Driftwood Notes" }),
    ).toBeTruthy();
  });

  it("saves that product's file", async () => {
    const card = await open(
      entryWorker().routes,
      "driftwood",
      "Driftwood Notes",
    );
    await userEvent.click(
      within(card).getByRole("button", {
        name: "Download my data from Driftwood Notes",
      }),
    );
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(files.saved[0]!.filename).toBe("polaris-key-driftwood-data.json");
    expect(fetchedRequests().filter((r) => /export|DELETE/.test(r))).toEqual([
      "GET /api/products/driftwood/export",
    ]);
  });

  it("keeps Remove from library apart from removing the data", async () => {
    const card = await open(
      entryWorker().routes,
      "driftwood",
      "Driftwood Notes",
    );
    // The header menu's own removal is a different action, with its own words.
    await userEvent.click(
      screen.getByRole("button", { name: "More for Driftwood Notes" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(
      within(card).getByRole("button", {
        name: "Remove my data from Driftwood Notes",
      }),
    ).toBeTruthy();
    expect(within(card).queryByText(/Remove from library/)).toBeNull();
  });
});

describe("A stale sign-in and the support code (I-11)", () => {
  const STALE = {
    methods: [
      {
        id: "lnk_mail1",
        kind: "email",
        group: "email",
        label: "Email",
        display: ACCOUNT.email,
        connectedAt: NOW_S - 90 * 86_400,
        lastUsedAt: NOW_S - 3 * 86_400,
        canRemove: false,
        reason: "last_link",
        flag: null,
        relay: false,
        tenantScoped: false,
      },
    ],
    emails: [
      {
        methodId: "lnk_mail1",
        email: ACCOUNT.email,
        primary: true,
        connectedAt: NOW_S - 90 * 86_400,
        lastUsedAt: NOW_S - 3 * 86_400,
        canRemove: false,
        reason: "last_link",
      },
    ],
    passkeys: [],
    providers: [],
    passkey: { canAdd: false, reason: null },
    primaryEmail: ACCOUNT.email,
    hideMyEmail: false,
    stepUp: {
      authenticatedAt: NOW_S - 3600,
      freshUntil: NOW_S - 3300,
      fresh: false,
      maxAgeSeconds: 300,
    },
  };

  it("remove: shows 'Confirm it's you first' in the dialog, then removes once confirmed", async () => {
    let asked = 0;
    const { routes, removals } = worker([mine()], (_url, done) =>
      ++asked === 1 ? STEP_UP : done(),
    );
    const card = await open({
      ...routes,
      "/api/me/methods": STALE,
      "POST /api/signin/email/start": {
        ok: true,
        expiresIn: 600,
        codeLength: 6,
        resendIn: 60,
      },
      "POST /api/signin/email/verify": { status: "signed_in", next: "/" },
    });
    const dialog = await openRemove(card);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove my data" }),
    );
    const prompt = await within(dialog).findByRole("group", {
      name: "Confirm it's you first",
    });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await userEvent.click(
      within(prompt).getByRole("button", {
        name: `Email a code to ${ACCOUNT.email}`,
      }),
    );
    await userEvent.type(
      await within(prompt).findByRole("textbox", { name: "6-digit code" }),
      "481920",
    );
    expect(
      await screen.findByText("Your data was removed from Mossgarden"),
    ).toBeTruthy();
    expect(removals).toHaveLength(2);
  });

  it("download: the prompt takes the refusal's place, and confirming downloads", async () => {
    let asked = 0;
    const { routes } = worker();
    const card = await open({
      ...routes,
      "/api/products/mossgarden/export": () =>
        ++asked === 1 ? STEP_UP : fileOf("mossgarden"),
      "/api/me/methods": STALE,
      "POST /api/signin/email/start": {
        ok: true,
        expiresIn: 600,
        codeLength: 6,
        resendIn: 60,
      },
      "POST /api/signin/email/verify": { status: "signed_in", next: "/" },
    });
    await userEvent.click(
      within(card).getByRole("button", {
        name: "Download my data from Mossgarden",
      }),
    );
    const prompt = await within(card).findByRole("group", {
      name: "Confirm it's you first",
    });
    expect(within(card).queryByRole("alert")).toBeNull();
    await userEvent.click(
      within(prompt).getByRole("button", {
        name: `Email a code to ${ACCOUNT.email}`,
      }),
    );
    await userEvent.type(
      await within(prompt).findByRole("textbox", { name: "6-digit code" }),
      "481920",
    );
    await waitFor(() => expect(files.saved).toHaveLength(1));
  });

  it("asks for a support code on request, then shows it with Copy", async () => {
    let code: string | null = null;
    const { routes } = worker();
    const card = await open({
      ...routes,
      "/api/products/mossgarden": () => ({
        ...productView("mossgarden", [mine()]),
        supportCode: code,
      }),
      "POST /api/products/mossgarden/support-code": () => {
        code = "K7M-4QX-9TB";
        return { supportCode: code };
      },
    });
    expect(within(card).queryByText("K7M-4QX-9TB")).toBeNull();
    await userEvent.click(
      await within(card).findByRole("button", { name: "Get a support code" }),
    );
    expect(await within(card).findByText("K7M-4QX-9TB")).toBeTruthy();
    // The one-line hint names the app, and the code is the mono, grouped, dashed string.
    expect(
      within(card).getByText(/^Give this code to .+'s support\.$/),
    ).toBeTruthy();
    expect(within(card).getByLabelText("Support code").className).toContain(
      "font-mono",
    );
    expect(
      within(card).getByRole("button", { name: "Copy support code" }),
    ).toBeTruthy();
    expect(
      within(card).queryByRole("button", { name: "Get a support code" }),
    ).toBeNull();
  });
});
