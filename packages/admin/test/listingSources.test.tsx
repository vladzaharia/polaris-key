/**
 * A-27.12: Presentation's base rows, the source pill per listing field, Revert to manifest (the
 * existing import, one field) and Use Presentation (the existing PUT).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetConsole } from "./consoleHarness.js";
import { P, apiError, bootWith, type Call } from "./distributionFixture.js";

const PRES = "#/p/djdl/settings/presentation";
const LISTING = "#/p/djdl/settings/presentation/listing";

const listing = (over: Record<string, unknown> = {}) => ({
  listing: {
    app: { defaultLocale: "en-US", name: "Typed Name", developerName: "Dev" },
    source: "admin",
    provenance: { developerName: "app-store" },
    modifiedAt: 1,
    modifiedBy: "u1",
  },
  locales: [
    {
      locale: "en-US",
      description: "From the repo.",
      source: "import",
      provenance: { description: "manifest" },
      modifiedAt: 1,
      modifiedBy: "u1",
    },
  ],
  overrides: [],
  limits: {},
  ...over,
});

/** No typed name, so developerName holds the only Revert button. */
const noName = () =>
  listing({
    listing: {
      app: { defaultLocale: "en-US", developerName: "Dev" },
      source: "admin",
      provenance: { developerName: "app-store" },
      modifiedAt: 1,
      modifiedBy: "u1",
    },
    inherited: { name: "presentation" },
  });

const settings = {
  settings: [
    {
      key: "core.presentation",
      value: { accent: "#AABBCC", accentDark: "#112233" },
    },
  ],
};

const base = (extra: Record<string, unknown> = {}) => ({
  [P("/assets")]: { assets: [] },
  [P("/assets/usage")]: {
    hosting: true,
    media: { full: false },
    release: { full: false },
    settings: [],
  },
  [P("/distribution/storefronts")]: { stores: [], listing: null },
  [P("/settings/effective")]: settings,
  [P("/distribution/listing")]: listing(),
  ...extra,
});

beforeEach(() => {
  resetConsole();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Presentation base rows", () => {
  it("manifest-only: name, accent swatches, the description with its source, and the Edit listing link", async () => {
    bootWith(PRES, base());
    expect(await screen.findByText("#aabbcc")).toBeTruthy();
    expect(screen.getByText("#112233")).toBeTruthy();
    expect(
      screen.getByText(
        "Used by every storefront's listing unless it sets its own.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("From the repo.")).toBeTruthy();
    const section = document.getElementById("presentation-base")!;
    expect(within(section).getAllByText(".pkey/distribution")).toHaveLength(1);
    const edit = within(section).getByRole("link", { name: "Edit listing" });
    expect(edit.getAttribute("href")).toContain(
      "settings/presentation/listing",
    );
  });

  it("a typed description says Console", async () => {
    bootWith(
      PRES,
      base({
        [P("/distribution/listing")]: listing({
          locales: [
            {
              locale: "en-US",
              description: "Typed here.",
              source: "admin",
              provenance: {},
              modifiedAt: 1,
              modifiedBy: "u1",
            },
          ],
        }),
      }),
    );
    expect(await screen.findByText("Typed here.")).toBeTruthy();
    expect(screen.getByText("Console")).toBeTruthy();
  });

  it("no accent declared: Not set; a failed listing read: Retry", async () => {
    bootWith(
      PRES,
      base({
        [P("/settings/effective")]: { settings: [] },
        [P("/distribution/listing")]: () => apiError(500, "internal"),
      }),
    );
    expect(await screen.findAllByText("Not set")).not.toHaveLength(0);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("listing field sources", () => {
  it("each field shows its source; an empty name reads From Presentation", async () => {
    bootWith(
      LISTING,
      base({
        [P("/distribution/listing")]: listing({
          listing: {
            app: { defaultLocale: "en-US", developerName: "Dev" },
            source: "admin",
            provenance: { developerName: "app-store" },
            modifiedAt: 1,
            modifiedBy: "u1",
          },
          inherited: { name: "presentation" },
        }),
      }),
    );
    expect(await screen.findByText("From Presentation")).toBeTruthy();
    expect(screen.getByText("App Store")).toBeTruthy();
    expect(screen.getByText(".pkey/distribution")).toBeTruthy();
  });

  it("Use Presentation clears the name through the listing PUT", async () => {
    const { calls } = bootWith(LISTING, base());
    await userEvent.click(
      await screen.findByRole("button", { name: "Use Presentation" }),
    );
    await waitFor(() =>
      expect(calls.find((c: Call) => c.method === "PUT")).toMatchObject({
        body: { app: { name: null } },
      }),
    );
  });

  const preview = (digest = "d1") => ({
    ...listing(),
    import: {
      applied: false,
      digest,
      createsListing: false,
      defaultLocale: "en-US",
      sources: [{ source: "manifest", ref: "root", ok: true }],
      changes: [
        {
          field: "developerName",
          locale: null,
          action: "replace",
          current: "Dev",
          currentSource: "app-store",
          proposed: "Repo Dev",
          proposedSource: "manifest",
          reason: null,
        },
      ],
      refused: [],
      skipped: [],
      written: [],
    },
  });

  it("Revert to manifest: preview, confirm, then apply that one field with the digest", async () => {
    const { calls } = bootWith(
      LISTING,
      base({
        [P("/distribution/listing")]: noName(),
        [`POST ${P("/distribution/listing/import")}`]: preview(),
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Revert to manifest" }),
    );
    expect(await screen.findByText("Manifest: Repo Dev")).toBeTruthy();
    expect(screen.getByText("Now: Dev")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({
        sources: [{ source: "manifest" }],
        overwrite: true,
        fields: ["developerName"],
        confirm: "d1",
      }),
    );
    // The first call was the preview: nothing written before the confirm.
    expect(calls.filter((c) => c.method === "POST")[0]!.body).toEqual({
      sources: [{ source: "manifest" }],
      overwrite: true,
    });
  });

  it("a changed digest (409) says so and Reload fetches the new preview", async () => {
    let n = 0;
    const { calls } = bootWith(
      LISTING,
      base({
        [P("/distribution/listing")]: noName(),
        [`POST ${P("/distribution/listing/import")}`]: (c: Call) => {
          const b = c.body as { confirm?: string };
          if (b.confirm) return apiError(409, "import_changed");
          n += 1;
          return preview(`d${n}`);
        },
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Revert to manifest" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Revert" }),
    );
    expect(
      await screen.findByText("The manifest changed since you looked."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(
        calls.filter(
          (c) =>
            c.method === "POST" && !(c.body as { confirm?: string }).confirm,
        ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("The manifest changed since you looked."),
      ).toBeNull(),
    );
  });

  it("a failed save keeps what was typed", async () => {
    const { calls } = bootWith(
      LISTING,
      base({
        [`PUT ${P("/distribution/listing")}`]: () => apiError(500, "internal"),
      }),
    );
    const input = (await screen.findByLabelText(
      /^Developer name/,
    )) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "New Dev");
    await userEvent.click(screen.getByRole("button", { name: "Save listing" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true),
    );
    expect(
      (screen.getByLabelText(/^Developer name/) as HTMLInputElement).value,
    ).toBe("New Dev");
  });
});
