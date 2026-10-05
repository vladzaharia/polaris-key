/**
 * Distribution → Storefronts and Distribution → Listing (A-18j; notes/S-15 §8): the tiles and the
 * flow are rendered from the server's plan (a store the console has never heard of renders like
 * any other); every step's request is the plan's, with one Idempotency-Key per intent; submit is
 * typed; the slot board accepts exactly the bytes shown; "Push listing" stages where the store can.
 * No "coming soon" copy and no delete control anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import { P, bootWith, writes } from "./distributionFixture.js";
import type {
  StorefrontDto,
  StorefrontStepDto,
  StorefrontsResponse,
} from "../src/api.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const PAGE = "#/p/djdl/distribution/storefronts";
const LISTING = "#/p/djdl/distribution/listing";
const SF = (path = "") => P(`/distribution/storefronts${path}`);

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function step(
  over: Partial<StorefrontStepDto> & { id: string },
): StorefrontStepDto {
  return {
    ops: [over.id],
    phase: "listing",
    label: over.id,
    mode: "api",
    typed: false,
    state: "todo",
    stateAt: null,
    writes: [],
    link: null,
    ci: null,
    pr: null,
    run: null,
    assert: null,
    next: null,
    handoff: null,
    copy: [],
    detail: null,
    blockedBy: null,
    ...over,
  };
}

const PLAY: StorefrontDto = {
  id: "google-play",
  label: "Google Play",
  listingStore: "play",
  connection: {
    state: "connected",
    credential: "google-play.service-account",
    credentialLabel: "Google Play service account",
    source: "console",
    lastError: null,
  },
  app: { id: "gg.djdl.app", name: "DJDL" },
  outlets: ["android"],
  readOnly: null,
  capabilities: [
    {
      op: "writeListingText",
      label: "Listing text",
      support: { mode: "api", plane: "worker", rules: ["PATCH listings"] },
    },
    {
      op: "contentRating",
      label: "Content rating",
      support: {
        mode: "deep-link",
        link: "google-play.content-rating",
        verify: "operator-assertion",
      },
    },
    {
      op: "uploadBuild",
      label: "Build upload",
      support: {
        mode: "unsupported",
        reason: "AABs reach Google Play from CI.",
      },
    },
  ],
  prerequisites: [
    {
      id: "connection",
      label: "Team connection",
      state: "met",
      detail: "Stored.",
      page: "platform-stores",
    },
    {
      id: "permissions",
      label: "Write permissions",
      state: "unknown",
      detail: "Confirmed by the first write.",
      page: null,
    },
  ],
  steps: [
    step({
      id: "createApp",
      phase: "setup",
      label: "App record",
      mode: "deep-link",
      state: "done",
      stateAt: 1_790_000_000,
    }),
    step({
      id: "contentRating",
      label: "Content rating",
      mode: "deep-link",
      link: {
        url: "https://play.google.com/console/x",
        verify: "operator-assertion",
        every: null,
        until: null,
        missing: [],
      },
      copy: [{ label: "App name", value: "DJDL" }],
    }),
    step({
      id: "writeListingText",
      label: "Store listing text",
      writes: ["PATCH listings", "POST commit"],
      run: {
        method: "POST",
        path: "/manage/api/products/djdl/distribution/storefronts/google-play/steps/writeListingText",
        body: {},
        fields: [],
        confirm: "plain",
        verb: "Send the listing text",
        consequences: ["Google Play receives every locale's text."],
      },
    }),
    step({
      id: "submit",
      phase: "submit",
      label: "Send for review",
      typed: true,
      writes: ["POST commit"],
      run: {
        method: "POST",
        path: "/manage/api/products/djdl/distribution/storefronts/google-play/steps/submit",
        body: {},
        fields: [],
        confirm: "typed",
        verb: "Send the changes for review",
        consequences: ["Google Play sends every staged change for review."],
      },
    }),
  ],
  pushListing: { stageOnly: true },
  confirmationLabel: "Google Play",
};

/** A store this console has no code for: it renders from its declaration alone. */
const NEW_STORE: StorefrontDto = {
  ...PLAY,
  id: "acme-arcade",
  label: "Acme Arcade",
  listingStore: null,
  connection: {
    state: "not-configured",
    credential: "acme.key",
    credentialLabel: "Acme key",
    source: null,
    lastError: null,
  },
  app: null,
  outlets: [],
  readOnly:
    "Acme Arcade has no team connection: a platform admin stores its credential in Platform → Store connections.",
  capabilities: [
    {
      op: "writeListingText",
      label: "Listing text",
      support: { mode: "ci", plane: "ci", tool: "arcade", commands: ["push"] },
    },
    {
      op: "contentRating",
      label: "Content rating",
      support: { mode: "pr", plane: "pr", repo: "acme/meta" },
    },
  ],
  steps: [
    step({
      id: "writeListingText",
      mode: "ci",
      label: "Listing text",
      ci: { tool: "arcade", commands: ["push"] },
      writes: ["arcade push"],
    }),
  ],
  pushListing: null,
  confirmationLabel: "Acme Arcade",
};

const VIEW: StorefrontsResponse = {
  stores: [PLAY, NEW_STORE],
  listing: { name: "DJDL", defaultLocale: "en-US", locales: ["en-US"] },
};

const SLOTS = {
  slots: [
    {
      slot: "key-art",
      locale: null,
      group: "masters",
      kind: "human",
      state: "missing",
      spec: "16:9, at least 3840×2160, no logo or text",
      textAllowed: "none",
      asset: null,
    },
    {
      slot: "play:icon",
      locale: null,
      group: "play",
      kind: "derived",
      state: "review",
      spec: "512×512 PNG",
      textAllowed: "free",
      asset: {
        sha256: "a".repeat(64),
        width: 512,
        height: 512,
        alpha: true,
        derivedFrom: "icon-master",
        source: "import",
        modifiedAt: 1_790_000_000,
        image:
          "/manage/api/products/djdl/distribution/storefronts/slots/image?slot=play%3Aicon&locale=",
        acceptedAt: null,
        acceptedBy: null,
      },
    },
  ],
};

const FIT = {
  exists: true,
  release: null,
  stores: [
    {
      store: "play",
      label: "Google Play",
      status: "red",
      issues: [
        {
          store: "play",
          field: "title",
          from: "name",
          locale: "en-US",
          issue: "too_long",
          severity: "block",
          limit: 30,
          actual: 34,
          unit: "chars",
        },
      ],
      cells: [],
    },
  ],
};

const LISTING_VIEW = {
  listing: {
    app: { defaultLocale: "en-US", name: "DJDL" },
    source: "admin",
    provenance: {},
    modifiedAt: 1,
    modifiedBy: "u1",
  },
  locales: [
    {
      locale: "en-US",
      name: "DJDL",
      description: "Mix.",
      source: "admin",
      provenance: {},
      modifiedAt: 1,
      modifiedBy: "u1",
    },
  ],
  overrides: [],
  limits: {
    name: 30,
    subtitle: 30,
    shortDescription: 78,
    description: 4000,
    promotionalText: 170,
  },
  stores: [{ store: "play", label: "Google Play" }],
  overrideStores: ["play"],
  modelFields: ["name"],
};

function routes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [SF()]: VIEW,
    [SF("/slots")]: SLOTS,
    [P("/distribution/listing")]: LISTING_VIEW,
    [P("/distribution/listing/fit")]: FIT,
    [`POST ${SF("/google-play/steps/writeListingText")}`]: {
      ok: true,
      outcome: "written",
      opId: "op1",
      resultIds: {},
      after: [],
    },
    [`POST ${SF("/google-play/steps/submit")}`]: {
      ok: true,
      outcome: "written",
      opId: "op2",
      resultIds: {},
      after: [],
    },
    [`POST ${SF("/google-play/steps/contentRating/check")}`]: {
      ok: true,
      state: "done",
      satisfied: true,
    },
    [`POST ${SF("/slots/accept")}`]: { ok: true, accepted: true },
    [`POST ${SF("/google-play/push-listing")}`]: {
      ok: true,
      outcome: "written",
      opId: "op3",
      resultIds: {},
      after: [],
    },
    ...over,
  };
}

const main = () => screen.getByRole("main");
const NO_STATUS_COPY = /coming soon|not built yet|available when/i;

describe("Distribution → Storefronts", () => {
  it("one tile per registered store, from its declaration: a store the console has no code for renders too", async () => {
    bootWith(PAGE, routes());
    await screen.findByRole("heading", { level: 1, name: "Storefronts" });
    const play = await within(main()).findByRole("region", {
      name: "Google Play",
    });
    const arcade = within(main()).getByRole("region", { name: "Acme Arcade" });
    // The capability strip: API, link and not offered (with its reason), as badges.
    const strip = within(play).getByRole("list", {
      name: "Google Play capabilities",
    });
    expect(
      [...strip.querySelectorAll("[data-capability]")].map((b) =>
        b.getAttribute("data-capability"),
      ),
    ).toEqual(["api", "deep-link", "unsupported"]);
    expect(strip.textContent).toContain("AABs reach Google Play from CI.");
    expect(
      within(arcade).getByRole("list", { name: "Acme Arcade capabilities" })
        .textContent,
    ).toContain("CI");
    // A pill only for what needs attention: the healthy store has none.
    expect(within(arcade).getByText("Not connected")).toBeTruthy();
    expect(within(play).queryByText("Not connected")).toBeNull();
    expect(main().textContent).not.toMatch(NO_STATUS_COPY);
  });

  it("Add to storefronts: the step and the stores are in the URL; nothing chosen holds the flow at the first step", async () => {
    bootWith(`${PAGE}?flow=add&step=plan`, routes());
    await screen.findByRole("heading", {
      level: 1,
      name: "Add to storefronts",
    });
    // No store chosen: the asked step waits on the first.
    expect(
      await screen.findByRole("group", { name: /Storefronts to add/ }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Google Play/ }),
    );
    await waitFor(() =>
      expect(window.location.hash).toContain("stores=google-play"),
    );
  });

  it("the plan lists every step with its mode and every external write before anything runs", async () => {
    const { calls } = bootWith(
      `${PAGE}?flow=add&step=plan&stores=google-play`,
      routes(),
    );
    const panel = await within(await screen.findByRole("main")).findByRole(
      "region",
      { name: "Google Play" },
    );
    expect(panel.textContent).toContain("Store listing text");
    expect(panel.textContent).toContain("typed confirmation");
    expect(panel.textContent).toContain("PATCH listings");
    expect(writes(calls)).toEqual([]);
  });

  it("runs an API step through its plan's request with an Idempotency-Key", async () => {
    const { calls } = bootWith(
      `${PAGE}?flow=add&step=run&stores=google-play`,
      routes(),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Send the listing text" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("every locale's text");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Send the listing text" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: SF("/google-play/steps/writeListingText"),
          method: "POST",
          body: { input: {} },
          idempotencyKey: expect.stringMatching(/^[A-Za-z0-9-]{8,128}$/),
        }),
      ]),
    );
  });

  it("a link step shows the copy card and the store's page; Mark as done records the operator's word", async () => {
    const { calls } = bootWith(
      `${PAGE}?flow=add&step=run&stores=google-play`,
      routes(),
    );
    const card = (
      await screen.findByText("Content rating", { selector: "h4" })
    ).closest("li")!;
    expect(within(card as HTMLElement).getByText("DJDL")).toBeTruthy();
    const open = within(card as HTMLElement).getByRole("link", {
      name: /Open Google Play/,
    });
    expect(open.getAttribute("href")).toBe("https://play.google.com/console/x");
    expect(open.getAttribute("rel")).toContain("noreferrer");
    await userEvent.click(
      within(card as HTMLElement).getByRole("button", { name: "Mark as done" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: SF("/google-play/steps/contentRating/check"),
          body: { assert: true },
        }),
      ]),
    );
  });

  it("submit is typed: the app's name is required and sent as confirm", async () => {
    const { calls } = bootWith(
      `${PAGE}?flow=add&step=submit&stores=google-play`,
      routes(),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Send the changes for review",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Send the changes for review",
    });
    expect(
      confirm.hasAttribute("disabled") ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /App name/ }),
      "DJDL",
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: SF("/google-play/steps/submit"),
          body: { input: {}, confirm: "DJDL" },
        }),
      ]),
    );
  });

  it("a store without a connection is read-only, with the reason", async () => {
    bootWith(
      `${PAGE}?flow=add&step=prerequisites&stores=acme-arcade`,
      routes(),
    );
    expect(await screen.findByText(/has no team connection/)).toBeTruthy();
  });

  it("the slot board: a missing master names its size; an output is accepted by its digest", async () => {
    const { calls } = bootWith(
      `${PAGE}?flow=add&step=assets&stores=google-play`,
      routes(),
    );
    expect(await screen.findByText(/3840×2160/)).toBeTruthy();
    expect(screen.getByText("Needed")).toBeTruthy();
    const img = screen.getByRole("img", { name: "Preview of play:icon" });
    expect(img.getAttribute("src")).toContain(
      "/storefronts/slots/image?slot=play%3Aicon",
    );
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: SF("/slots/accept"),
          body: { slot: "play:icon", locale: null, sha256: "a".repeat(64) },
        }),
      ]),
    );
    expect(screen.queryByRole("button", { name: /delete|remove/i })).toBeNull();
  });

  it("passes axe on the tiles and on a run step", async () => {
    bootWith(PAGE, routes());
    await within(await screen.findByRole("main")).findByRole("region", {
      name: "Google Play",
    });
    const r = await axe(main());
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Distribution → Listing", () => {
  it("the fit report names what does not fit and offers an override", async () => {
    bootWith(`${LISTING}?tab=fit`, routes());
    expect(
      await screen.findByText(/title \(en-US\) too long: 34 of 30/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Override…" })).toBeTruthy();
  });

  it("Push listing stages on Google Play with one Idempotency-Key", async () => {
    const { calls } = bootWith(`${LISTING}?tab=push`, routes());
    await userEvent.click(
      await screen.findByRole("button", { name: "Push listing" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    // A push is never a review submission: no control can unstage it.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(
      within(dialog).getByText(/nothing is sent for review until you submit/),
    ).toBeTruthy();
    expect(
      within(dialog).queryByText(/sends the change for review/),
    ).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Push listing" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: SF("/google-play/push-listing"),
          body: {},
          idempotencyKey: expect.stringMatching(/^[A-Za-z0-9-]{8,128}$/),
        }),
      ]),
    );
  });

  it("saves only what changed in the locale", async () => {
    const { calls } = bootWith(
      LISTING,
      routes({ [`PUT ${P("/distribution/listing")}`]: LISTING_VIEW }),
    );
    const box = await screen.findByRole("textbox", { name: "Subtitle" });
    await userEvent.type(box, "Mix anywhere");
    await userEvent.click(screen.getByRole("button", { name: /Save listing/ }));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: "PUT",
          path: P("/distribution/listing"),
          body: { locales: { "en-US": { subtitle: "Mix anywhere" } } },
        }),
      ]),
    );
    expect(main().textContent).not.toMatch(NO_STATUS_COPY);
  });
});
