/**
 * A-22.3a: a channel's Setup tab (`distribution/channels/<id>/setup`): the store credential editors
 * moved from Distribution → Channel credentials (ST-12). Each credential's state, the write-only
 * rule (a value is sent once, never read back, rendered or put in a URL), save, rotate, pin and
 * delete, and the out-of-scope flag (A-20 R6). Closes OUT-1 to OUT-7 for the channel's keys.
 */

import { describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChannelRow, ChannelsView } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";
import {
  expectGoogleKeyWrite,
  fillGoogleKey,
  openSetDrawer,
  pick,
  resetAround,
  VIEW_ONLY,
  rowAction,
} from "./credentialsKit.js";
import {
  apiError,
  bootWith,
  CREDENTIALS,
  P,
  writes,
  type Answer,
} from "./distributionFixture.js";

const H = "#/p/djdl/distribution/channels";
const HASH_APP = `${H}/app-store/setup`;
const HASH_PLAY = `${H}/google-play/setup`;

resetAround();

const BASE = {
  inScope: true,
  declared: true,
  oneClick: false,
  notUsing: false,
};

const row = (
  id: string,
  label: string,
  over: Partial<ChannelRow> = {},
): ChannelRow => ({
  ...BASE,
  id,
  label,
  delivery: { state: "live", attention: [], platforms: [] },
  commerce: null,
  identity: null,
  ...over,
});

const VIEW: ChannelsView = {
  product: "djdl",
  now: 1,
  platforms: [],
  kinds: [],
  channels: [
    row("app-store", "App Store"),
    row("google-play", "Google Play"),
    row("itch", "itch.io"),
    row("steam", "Steam", { inScope: false }),
  ],
};

const boot = (hash: string, routes: Record<string, Answer> = {}) =>
  bootWith(hash, { [P("/distribution/channels")]: VIEW, ...routes });

async function table(): Promise<HTMLElement> {
  const t = await screen.findByRole("table", { name: "App Store credentials" });
  await within(t).findByText("asc-team-key");
  return t;
}

async function playTable(): Promise<HTMLElement> {
  const t = await screen.findByRole("table", {
    name: "Google Play credentials",
  });
  await within(t).findByText("play");
  return t;
}

describe("a channel's Setup tab: credentials", () => {
  it("shows Setup only for a channel with store keys", async () => {
    boot(`${H}/itch`);
    await screen.findByRole("heading", { level: 1, name: "itch.io" });
    await screen.findByRole("tab", { name: "Releases" });
    expect(screen.queryByRole("tab", { name: "Setup" })).toBeNull();
    cleanup();
    resetConsole();
    boot(`${H}/app-store`);
    await screen.findByRole("heading", { level: 1, name: "App Store" });
    await userEvent.click(await screen.findByRole("tab", { name: "Setup" }));
    expect(window.location.hash).toBe(HASH_APP);
    await table();
  });

  it("lists this channel's keys only, as metadata and health, never a value (OUT-1, OUT-6)", async () => {
    boot(HASH_APP, {
      [P("/outlet-credentials")]: {
        ...CREDENTIALS,
        credentials: [
          ...CREDENTIALS.credentials,
          {
            ...CREDENTIALS.credentials[0]!,
            id: "sentry",
            kind: "sentry-integration",
            meta: {},
          },
        ],
      },
    });
    const t = await table();
    expect(
      screen.getByRole("heading", { level: 2, name: "Credentials" }),
    ).toBeTruthy();
    expect(within(t).getByText("App Store Connect API key")).toBeTruthy();
    expect(within(t).getByText("ABC123DEFG · issuer-1")).toBeTruthy();
    // The pin is shown apart from the key's metadata (P5-02f).
    expect(within(t).getByText("1234567890")).toBeTruthy();
    expect(within(t).getByText("OK")).toBeTruthy();
    // The Google key and Sentry's secret belong to other pages; the channel is already named.
    expect(within(t).queryByText("play")).toBeNull();
    expect(within(t).queryByText("sentry")).toBeNull();
    expect(
      within(t).queryByRole("columnheader", { name: "Channel" }),
    ).toBeNull();
    expect(screen.queryByText(/BEGIN PRIVATE KEY/)).toBeNull();
  });

  it("shows a failed key's last error as text, and an unused one as not used", async () => {
    boot(HASH_PLAY, {
      [P("/outlet-credentials")]: {
        ...CREDENTIALS,
        credentials: [
          ...CREDENTIALS.credentials,
          {
            ...CREDENTIALS.credentials[1]!,
            id: "play-new",
            lastError: null,
            lastUsedAt: null,
            lastOkAt: null,
          },
        ],
      },
    });
    const t = await playTable();
    expect(within(t).getByText(/403 from Google Play/)).toBeTruthy();
    expect(within(t).getAllByText("Failed")).toHaveLength(1);
    expect(within(t).getByText("Not used yet")).toBeTruthy();
    expect(within(t).getAllByText("Not pinned").length).toBeGreaterThan(0);
  });

  it("explains an empty channel with one action, and shows errors with Retry", async () => {
    boot(HASH_APP, {
      [P("/outlet-credentials")]: { ...CREDENTIALS, credentials: [] },
    });
    expect(
      await screen.findByText("No App Store credentials yet"),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Set credential…" }),
    ).toHaveLength(1);
    cleanup();
    resetConsole();
    let fail = true;
    boot(HASH_APP, {
      [P("/outlet-credentials")]: () =>
        fail ? apiError(500, "internal") : CREDENTIALS,
    });
    const retry = (
      await screen.findAllByRole("button", { name: "Try again" })
    )[0]!;
    fail = false;
    await userEvent.click(retry);
    expect(await table()).toBeTruthy();
  });

  it("offers this channel's kinds only", async () => {
    boot(HASH_APP);
    await table();
    const drawer = await openSetDrawer();
    await userEvent.click(
      within(drawer).getByRole("combobox", { name: /Kind/ }),
    );
    const names = (await screen.findAllByRole("option")).map(
      (o) => o.textContent ?? "",
    );
    expect(names.some((n) => /App Store Connect API key/.test(n))).toBe(true);
    expect(names.some((n) => /Google service account/.test(n))).toBe(false);
    expect(names.some((n) => /Sentry/.test(n))).toBe(false);
  });

  it("re-pins a credential without its value (P5-02f)", async () => {
    const { calls } = boot(HASH_APP, {
      [`PUT ${P("/outlet-credentials/asc-team-key")}`]: {
        ok: true,
        id: "asc-team-key",
      },
    });
    await table();
    await rowAction("asc-team-key", "Pin…");
    const dialog = await screen.findByRole("dialog", {
      name: /Pin “asc-team-key”/,
    });
    const input = within(dialog).getByLabelText(
      /App Store Connect app id/,
    ) as HTMLInputElement;
    expect(input.value).toBe("1234567890");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    await userEvent.clear(input);
    await userEvent.type(input, "5555555555");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/outlet-credentials/asc-team-key"),
          method: "PUT",
          body: { kind: "asc-api-key", pin: "5555555555" },
        }),
      ]),
    );
  });

  it("words the platform store connection's refusal on a pin (A-16)", async () => {
    boot(HASH_APP, {
      [`PUT ${P("/outlet-credentials/asc-team-key")}`]: () =>
        apiError(
          409,
          "app_assigned_elsewhere",
          { fields: ["pin"], product: "acme" },
          "5555555555 is assigned to product acme through the platform store connection; unassign it there first",
        ),
    });
    await table();
    await rowAction("asc-team-key", "Pin…");
    const dialog = await screen.findByRole("dialog", {
      name: /Pin “asc-team-key”/,
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Pin" }));
    expect(
      await within(dialog).findByText("That app belongs to another product"),
    ).toBeTruthy();
    expect(within(dialog).getByText(/assigned to product acme/)).toBeTruthy();
  });

  it("sets an App Store Connect key kind-first, with every missing field at once (OUT-3, OUT-5)", async () => {
    const { calls } = boot(HASH_APP, {
      [`PUT ${P("/outlet-credentials/asc-new")}`]: { ok: true, id: "asc-new" },
    });
    await table();
    const drawer = await openSetDrawer();
    // Kind comes first; nothing else until it is chosen.
    expect(within(drawer).queryByLabelText(/Credential ID/)).toBeNull();
    await pick(drawer, /Kind/, /App Store Connect API key/);
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "asc-new",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set credential" }),
    );
    expect(await within(drawer).findByText("Enter the Key ID.")).toBeTruthy();
    expect(within(drawer).getByText("Enter the Issuer ID.")).toBeTruthy();
    expect(within(drawer).getByText("Enter the .p8 private key.")).toBeTruthy();
    expect(
      within(drawer).getByText(/Enter the App Store Connect app id/),
    ).toBeTruthy();
    expect(writes(calls)).toEqual([]);
    await userEvent.type(within(drawer).getByLabelText(/Key ID/), "ABC123DEFG");
    await userEvent.type(
      within(drawer).getByLabelText(/Issuer ID/),
      "issuer-1",
    );
    await userEvent.type(
      within(drawer).getByLabelText(/\.p8 private key/),
      "PEM",
    );
    await userEvent.type(
      within(drawer).getByLabelText(/App Store Connect app id/),
      "1234567890",
    );
    // The channel is known on its own page: there is no channel field, and the key is for any.
    expect(
      within(drawer).queryByRole("combobox", { name: /Channel/ }),
    ).toBeNull();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set credential" }),
    );
    // Write-only: the value was sent once, and is nowhere on the page or in the address.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("PEM");
    expect(window.location.hash).not.toContain("PEM");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/outlet-credentials/asc-new"),
          body: {
            kind: "asc-api-key",
            value: { keyId: "ABC123DEFG", issuerId: "issuer-1", p8: "PEM" },
            pin: "1234567890",
            outletId: null,
          },
        }),
      ]),
    );
  });

  it("sends a Google key as its JSON file with a text keyboard for the package pin (OUT-4)", async () => {
    const { calls } = boot(HASH_PLAY, {
      [`PUT ${P("/outlet-credentials/play-2")}`]: { ok: true, id: "play-2" },
    });
    await playTable();
    const drawer = await openSetDrawer();
    // The only kind this channel has: said, not asked.
    expect(within(drawer).queryByRole("combobox", { name: /Kind/ })).toBeNull();
    expect(within(drawer).getByText("Google service account")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Set a Google Play key" }),
    ).toBeTruthy();
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "play-2",
    );
    await fillGoogleKey(drawer);
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set credential" }),
    );
    await expectGoogleKeyWrite(calls);
  });

  it("generates an App Store webhook secret without a value", async () => {
    const { calls } = boot(HASH_APP, {
      [`PUT ${P("/outlet-credentials/asc-hook")}`]: {
        ok: true,
        id: "asc-hook",
      },
    });
    await table();
    const drawer = await openSetDrawer();
    await pick(drawer, /Kind/, /App Store webhook secret/);
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "asc-hook",
    );
    expect(within(drawer).queryByLabelText(/^Secret/)).toBeNull();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          body: { kind: "asc-webhook-secret", generate: true, outletId: null },
        }),
      ]),
    );
  });

  it("deletes at L2 and refreshes only after the server confirms (OUT-7)", async () => {
    const { calls } = boot(HASH_APP, {
      [`DELETE ${P("/outlet-credentials/asc-team-key")}`]: {
        ok: true,
        id: "asc-team-key",
      },
    });
    await table();
    const before = calls.filter(
      (c) => c.path === P("/outlet-credentials"),
    ).length;
    await rowAction("asc-team-key", "Delete…");
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete asc-team-key" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: "DELETE",
          path: P("/outlet-credentials/asc-team-key"),
        }),
      ]),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === P("/outlet-credentials")).length,
      ).toBeGreaterThan(before),
    );
  });

  it("opens a credential's detail from ?credential= with its last error", async () => {
    boot(`${HASH_PLAY}?credential=play`);
    const drawer = await screen.findByRole("dialog", { name: "play" });
    expect(within(drawer).getByText("The last use failed")).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Rotate…" }),
    ).toBeTruthy();
  });

  it("warns that reusing an id rotates it, and confirms first (OUT-2)", async () => {
    const { calls } = boot(HASH_PLAY, {
      [`PUT ${P("/outlet-credentials/play")}`]: { ok: true, id: "play" },
    });
    await playTable();
    const drawer = await openSetDrawer();
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "play",
    );
    expect(
      await within(drawer).findByText("A credential with this id exists"),
    ).toBeTruthy();
    await fillGoogleKey(drawer);
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Rotate credential…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(writes(calls)).toEqual([]);
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Rotate credential" }),
    );
    await expectGoogleKeyWrite(calls);
  });

  it("keeps a rotated key's channel binding without showing it", async () => {
    const { calls } = boot(HASH_APP, {
      [`PUT ${P("/outlet-credentials/asc-team-key")}`]: {
        ok: true,
        id: "asc-team-key",
      },
    });
    await table();
    await rowAction("asc-team-key", "Rotate…");
    const drawer = await screen.findByRole("dialog", {
      name: /Rotate “asc-team-key”/,
    });
    expect(within(drawer).queryByText("app-store")).toBeNull();
    for (const [label, value] of [
      [/Key ID/, "KEY2"],
      [/Issuer ID/, "issuer-2"],
      [/\.p8 private key/, "PEM2"],
    ] as const)
      await userEvent.type(within(drawer).getByLabelText(label), value);
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Rotate credential…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Rotate credential" }),
    );
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    // No channel is sent: the binding is the server's, and unchanged.
    expect(writes(calls)[0]!.body).toEqual({
      kind: "asc-api-key",
      value: { keyId: "KEY2", issuerId: "issuer-2", p8: "PEM2" },
    });
    expect(document.body.textContent).not.toContain("PEM2");
    expect(window.location.hash).not.toContain("PEM2");
  });

  it("never reads a value back: the detail shows facts only", async () => {
    const { calls } = boot(`${HASH_APP}?credential=asc-team-key`);
    const drawer = await screen.findByRole("dialog", { name: "asc-team-key" });
    expect(within(drawer).getByText("Active")).toBeTruthy();
    expect(within(drawer).queryByText("Channel")).toBeNull();
    // The only credential reads are the list; none asks for a value.
    expect(
      calls
        .filter((c) => c.path.includes("/outlet-credentials"))
        .every((c) => c.method === "GET"),
    ).toBe(true);
    expect(document.body.textContent).not.toMatch(/PRIVATE KEY/);
  });

  it("has no Setup tab on an out-of-scope channel", async () => {
    const out = {
      ...VIEW,
      channels: VIEW.channels.map((c) =>
        c.id === "app-store" ? { ...c, inScope: false } : c,
      ),
    };
    boot(HASH_APP, { [P("/distribution/channels")]: out });
    await screen.findByRole("heading", { level: 1, name: "App Store" });
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Setup" })).toBeNull(),
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("is read-only without Ship edit: every change is off with its reason", async () => {
    boot(`${HASH_APP}?credential=asc-team-key`, {
      "/manage/api/me": VIEW_ONLY,
    });
    const drawer = await screen.findByRole("dialog", { name: "asc-team-key" });
    for (const n of ["Pin…", "Rotate…"])
      expect(
        within(drawer)
          .getByRole("button", { name: n })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    await userEvent.keyboard("{Escape}");
    await table();
    expect(
      screen
        .getByRole("button", { name: "Set credential…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for asc-team-key" }),
    );
    for (const n of ["Rotate…", "Pin…", "Delete…"])
      expect(
        (
          await screen.findByRole("menuitem", { name: new RegExp(`^${n}`) })
        ).getAttribute("aria-disabled"),
      ).toBe("true");
  });

  it("names the other channel a shared key serves, in the section and in the confirms", async () => {
    boot(HASH_PLAY);
    await playTable();
    expect(
      screen.getByText(
        /Also used by Play testing|Also used by Google Play testing/,
      ),
    ).toBeTruthy();
    await rowAction("play", "Delete…");
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/also used by .*testing/i)).toBeTruthy();
  });

  it("shows a failing key as Failing, with a human label for its facts", async () => {
    boot(`${HASH_PLAY}?credential=play`);
    const drawer = await screen.findByRole("dialog", { name: "play" });
    expect(within(drawer).getByText("Failing")).toBeTruthy();
    expect(within(drawer).queryByText("Active")).toBeNull();
    expect(within(drawer).getByText("Client email")).toBeTruthy();
    expect(within(drawer).queryByText(/by u1/)).toBeNull();
  });

  it("passes axe", async () => {
    boot(HASH_APP);
    await table();
    await expectNoAxeViolations(document.body);
  });
});
