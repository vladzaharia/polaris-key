/**
 * Distribution → Outlet credentials (admin chunk 9, ADMIN.md §6.4): moved from Keys & secrets
 * (the "Outlet credentials card (P5-01)" suite lived in `secrets.test.tsx`). Write-only values,
 * pins, kind-first drawer, rotate, delete, the platform store connection's refusal (A-16) and the
 * connector cards. Closes OUT-1 to OUT-7.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import {
  apiError,
  bootWith,
  CONNECTORS,
  CREDENTIALS,
  P,
  writes,
} from "./distributionFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/distribution/credentials";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function table(): Promise<HTMLElement> {
  const t = await screen.findByRole("table", { name: "Outlet credentials" });
  await within(t).findByText("asc-team-key");
  return t;
}

async function pick(
  container: HTMLElement,
  name: RegExp,
  option: RegExp,
): Promise<void> {
  await userEvent.click(within(container).getByRole("combobox", { name }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Distribution → Outlet credentials", () => {
  it("lists metadata and health, never a value, with the last result as text (OUT-1, OUT-6)", async () => {
    bootWith(HASH);
    const t = await table();
    expect(
      screen.getByRole("heading", { level: 1, name: "Outlet credentials" }),
    ).toBeTruthy();
    expect(within(t).getByText("App Store Connect API key")).toBeTruthy();
    expect(within(t).getByText("ABC123DEFG · issuer-1")).toBeTruthy();
    // The pin is shown apart from the key's metadata (P5-02f).
    expect(within(t).getByText("1234567890")).toBeTruthy();
    expect(within(t).getByText("Not pinned")).toBeTruthy();
    expect(within(t).getByText(/403 from Google Play/)).toBeTruthy();
    expect(within(t).getByText("Failed")).toBeTruthy();
    expect(screen.queryByText(/BEGIN PRIVATE KEY/)).toBeNull();
  });

  it("says Sentry is one of the kinds (OUT-7)", async () => {
    bootWith(HASH);
    await table();
    expect(screen.getByText(/the Sentry secret/)).toBeTruthy();
  });

  it("re-pins a credential without its value (P5-02f)", async () => {
    const { calls } = bootWith(HASH, {
      [`PUT ${P("/outlet-credentials/asc-team-key")}`]: {
        ok: true,
        id: "asc-team-key",
      },
    });
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for asc-team-key" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Pin…" }),
    );
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
    bootWith(HASH, {
      [`PUT ${P("/outlet-credentials/asc-team-key")}`]: () =>
        apiError(
          409,
          "app_assigned_elsewhere",
          { fields: ["pin"], product: "acme" },
          "5555555555 is assigned to product acme through the platform store connection; unassign it there first",
        ),
    });
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for asc-team-key" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Pin…" }),
    );
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
    const { calls } = bootWith(HASH, {
      [`PUT ${P("/outlet-credentials/asc-new")}`]: { ok: true, id: "asc-new" },
    });
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Set credential…" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Set an outlet credential",
    });
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
    await pick(drawer, /Outlet/, /app-store/);
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/outlet-credentials/asc-new"),
          body: {
            kind: "asc-api-key",
            value: { keyId: "ABC123DEFG", issuerId: "issuer-1", p8: "PEM" },
            pin: "1234567890",
            outletId: "app-store",
          },
        }),
      ]),
    );
  });

  it("sends a Google key as its JSON file with a text keyboard for the package pin (OUT-4)", async () => {
    const { calls } = bootWith(HASH, {
      [`PUT ${P("/outlet-credentials/play-2")}`]: { ok: true, id: "play-2" },
    });
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Set credential…" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Set an outlet credential",
    });
    await pick(drawer, /Kind/, /Google service account/);
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "play-2",
    );
    await userEvent.type(within(drawer).getByLabelText(/JSON key file/), "{{}");
    const pin = within(drawer).getByLabelText(/Google Play package name/);
    expect(pin.getAttribute("inputmode")).toBe("text");
    await userEvent.type(pin, "gg.acme.djdl");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          body: {
            kind: "google-service-account",
            value: "{}",
            pin: "gg.acme.djdl",
            outletId: null,
          },
        }),
      ]),
    );
  });

  it("warns that reusing an id rotates it, and confirms first (OUT-2)", async () => {
    const { calls } = bootWith(HASH, {
      [`PUT ${P("/outlet-credentials/asc-team-key")}`]: {
        ok: true,
        id: "asc-team-key",
      },
    });
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Set credential…" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Set an outlet credential",
    });
    await pick(drawer, /Kind/, /Sentry internal integration/);
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "asc-team-key",
    );
    expect(
      await within(drawer).findByText("A credential with this id exists"),
    ).toBeTruthy();
    await userEvent.type(
      within(drawer).getByLabelText(/Client secret/),
      "s3cret",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Rotate credential…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(writes(calls)).toEqual([]);
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Rotate credential" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          body: {
            kind: "sentry-integration",
            value: { clientSecret: "s3cret" },
            outletId: null,
          },
        }),
      ]),
    );
  });

  it("generates an App Store webhook secret without a value", async () => {
    const { calls } = bootWith(HASH, {
      [`PUT ${P("/outlet-credentials/asc-hook")}`]: {
        ok: true,
        id: "asc-hook",
      },
    });
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Set credential…" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Set an outlet credential",
    });
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
    const { calls } = bootWith(HASH, {
      [`DELETE ${P("/outlet-credentials/asc-team-key")}`]: {
        ok: true,
        id: "asc-team-key",
      },
    });
    await table();
    const before = calls.filter(
      (c) => c.path === P("/outlet-credentials"),
    ).length;
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for asc-team-key" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete…" }),
    );
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
    bootWith(`${HASH}?credential=play`);
    const drawer = await screen.findByRole("dialog", { name: "play" });
    expect(within(drawer).getByText("The last use failed")).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Rotate…" }),
    ).toBeTruthy();
  });

  it("round-trips the kind facet through the URL", async () => {
    bootWith(`${HASH}?kind=google-service-account`);
    const t = await screen.findByRole("table", { name: "Outlet credentials" });
    await waitFor(() => expect(within(t).getAllByRole("row")).toHaveLength(2));
    expect(within(t).getByText("play")).toBeTruthy();
  });

  describe("store connectors", () => {
    it("shows each connector's state, and an inert one's reason", async () => {
      bootWith(HASH);
      await table();
      const asc = await screen.findByRole("region", {
        name: "App Store Connect",
      });
      expect(within(asc).getByText("Connected")).toBeTruthy();
      const ms = screen.getByRole("region", { name: "Microsoft Store" });
      expect(within(ms).getByText(/Not running/)).toBeTruthy();
      expect(within(ms).getByText(/Declare an ms-store outlet/)).toBeTruthy();
    });

    it("says when App Store Connect uses the platform's team key (A-16)", async () => {
      bootWith(HASH, {
        [P("/distribution/connectors")]: {
          connectors: [
            {
              ...CONNECTORS.connectors[0],
              setup: {
                ...CONNECTORS.connectors[0]!.setup,
                apiKeyCredential: null,
                credentialSource: "platform",
                platformSource: "console",
              },
            },
          ],
        },
      });
      await table();
      const asc = await screen.findByRole("region", {
        name: "App Store Connect",
      });
      expect(
        within(asc).getByText("The platform's team key (set in the console)"),
      ).toBeTruthy();
      expect(within(asc).queryByText("API key credential")).toBeNull();
    });

    /** Open the release dialog and pick 2.4.0. */
    async function openRelease(): Promise<HTMLElement> {
      await table();
      const asc = await screen.findByRole("region", {
        name: "App Store Connect",
      });
      await userEvent.click(
        within(asc).getByRole("button", { name: "Release this version…" }),
      );
      const confirm = await screen.findByRole("alertdialog");
      await userEvent.click(
        within(confirm).getByRole("button", { name: /^Release Required/ }),
      );
      await userEvent.click(
        await screen.findByRole("option", { name: /^2\.4\.0 / }),
      );
      return confirm;
    }

    it("releases a held App Store version at L3, with the app's name typed (A-17a)", async () => {
      const { calls } = bootWith(HASH, {
        [`POST ${P("/distribution/connectors/asc/release")}`]: { ok: true },
      });
      const confirm = await openRelease();
      const go = within(confirm).getByRole("button", {
        name: "Release version",
      });
      // A release is picked, but the name is not typed yet: still disabled.
      expect((go as HTMLButtonElement).disabled).toBe(true);
      await userEvent.click(go);
      expect(writes(calls)).toEqual([]);
      const name = within(confirm).getByRole("textbox", { name: /App name/ });
      await userEvent.type(name, "   ");
      expect((go as HTMLButtonElement).disabled).toBe(true);
      await userEvent.clear(name);
      await userEvent.type(name, " DJDL Mobile ");
      expect((go as HTMLButtonElement).disabled).toBe(false);
      await userEvent.click(go);
      await waitFor(() =>
        expect(writes(calls)).toEqual([
          expect.objectContaining({
            path: P("/distribution/connectors/asc/release"),
            body: { releaseId: "rel_240", confirm: "DJDL Mobile" },
          }),
        ]),
      );
    });

    it("words a name that doesn't match App Store Connect and stays open (A-17a)", async () => {
      bootWith(HASH, {
        [`POST ${P("/distribution/connectors/asc/release")}`]: () =>
          apiError(
            422,
            "invalid_body",
            { reason: "confirmation_mismatch", fields: ["confirm"] },
            "confirm does not match the app's name in App Store Connect",
          ),
      });
      const confirm = await openRelease();
      await userEvent.type(
        within(confirm).getByRole("textbox", { name: /App name/ }),
        "Wrong name",
      );
      await userEvent.click(
        within(confirm).getByRole("button", { name: "Release version" }),
      );
      expect(
        await within(confirm).findByText(
          /doesn't match the app's name in App Store Connect/,
        ),
      ).toBeTruthy();
    });
  });

  it("explains credentials when there are none, and shows errors with Retry", async () => {
    bootWith(HASH, {
      [P("/outlet-credentials")]: { ...CREDENTIALS, credentials: [] },
    });
    expect(await screen.findByText("No outlet credentials yet")).toBeTruthy();
    cleanup();
    resetConsole();
    let fail = true;
    bootWith(HASH, {
      [P("/outlet-credentials")]: () =>
        fail ? apiError(500, "internal") : CREDENTIALS,
    });
    const retry = (await screen.findAllByRole("button", { name: "Retry" }))[0]!;
    fail = false;
    await userEvent.click(retry);
    expect(await table()).toBeTruthy();
  });

  it("passes axe", async () => {
    bootWith(HASH);
    await table();
    await screen.findByRole("region", { name: "App Store Connect" });
    const results = await axe(document.body);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
