import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  EdgeMintIdentity,
  EdgeMintRecipe,
  EdgeMintRecipesResponse,
} from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { apiError, bootConfig, type Backend } from "./configHarness.js";

/**
 * Config → Edge mint (docs/design/ADMIN.md §6.6.4; P0-12), driven through the whole console. The
 * approval semantics are the ones the old Secrets-page card pinned (the approve call echoes the
 * fields, the identity trust and License as shown; a public mint needs the acknowledgement), now on
 * their own page: EMR-1 (always present), EMR-2 (distinct statuses, no re-announced alerts),
 * EMR-3 (a 409 keeps the drawer open and reloads), EMR-4 (trust shown once), EMR-5 (links).
 */

const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

const P = "/manage/api/products/djdl";

const FIELDS = {
  alg: "ES256",
  signingKeySecret: "EDGE_MINT__DJDL__APPLEMUSIC",
  kid: "KID1",
  claimsTemplateJson: '{"iss":"TEAM"}',
  ttlSeconds: 3600,
  audience: null,
};

function recipe(over: Partial<EdgeMintRecipe> = {}): EdgeMintRecipe {
  return {
    id: "applemusic",
    ...FIELDS,
    claimsTemplate: { iss: "TEAM" },
    status: "pending",
    secretUsage: "edge-mint",
    approval: null,
    changedFields: [],
    ...over,
  };
}

const APPROVAL = {
  ...FIELDS,
  openRegistrationAcknowledged: false,
  licenseEnabled: true,
  identity: null,
  approvedAt: 1_700_000_000,
  approvedBy: "op-1",
};

const IDENTITY: EdgeMintIdentity = {
  provider: "custom",
  issuer: "https://id.example",
  clientId: "djdl-client",
  groupRoleMapJson: '{"staff":{"role":"user","tier":"pro"}}',
};

function recipes(
  list: EdgeMintRecipe[],
  registration: EdgeMintRecipesResponse["registration"] = "requires-license",
  anonymousEnroll = false,
  extra: {
    identity?: EdgeMintIdentity | null;
    oidcDefault?: boolean;
    licenseEnabled?: boolean;
  } = {},
): EdgeMintRecipesResponse {
  const oidcDefault = extra.oidcDefault ?? false;
  return {
    registration,
    anonymousEnroll,
    oidcDefault,
    publicMint: registration === "open" || anonymousEnroll || oidcDefault,
    licenseEnabled: extra.licenseEnabled ?? true,
    identity: extra.identity ?? null,
    recipes: list,
  };
}

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(
  data: EdgeMintRecipesResponse | (() => unknown),
  extra: Record<string, unknown> = {},
  hash = "#/p/djdl/config/edge-mint",
): Backend {
  return bootConfig(hash, {
    [`${P}/config/mint`]: data,
    [`POST ${P}/config/mint/applemusic/approve`]: {
      ok: true,
      id: "applemusic",
      status: "approved",
    },
    [`POST ${P}/config/mint/applemusic/revoke`]: {
      ok: true,
      id: "applemusic",
      status: "pending",
    },
    ...extra,
  });
}

/** Open the approve drawer from the row's action menu. */
async function openApprove(
  label = /Approve…|Re-approve…|Review…/,
): Promise<HTMLElement> {
  await userEvent.click(
    await screen.findByRole("button", { name: "Actions for applemusic" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: label }));
  return screen.findByRole("dialog");
}

const approveBody = (backend: Backend) =>
  backend.writes().find((c) => c.path.endsWith("/approve"))?.body;

describe("Edge mint page", () => {
  it("is always there: with no recipes it explains them (EMR-1)", async () => {
    open(recipes([]));
    await screen.findByRole("heading", { level: 1, name: "Edge mint" });
    expect(await screen.findByText("No edge-mint recipes")).toBeTruthy();
    expect(
      screen.getByText(/declared in the product's .pkey\/release/),
    ).toBeTruthy();
  });

  it("shows a skeleton while loading and explains a failed load", async () => {
    let fail = true;
    let release: (v: unknown) => void = () => undefined;
    open(() =>
      fail
        ? new Promise((r) => {
            release = r;
          })
        : recipes([recipe()]),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-skeleton="table"]')).not.toBeNull(),
    );
    release(apiError(500));
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByText("applemusic")).toBeTruthy();
  });

  it("gives each status its own tone and icon (EMR-2)", async () => {
    open(
      recipes([
        recipe(),
        recipe({
          id: "maps",
          status: "changed",
          approval: APPROVAL,
          changedFields: ["ttlSeconds"],
        }),
        recipe({ id: "weather", status: "approved", approval: APPROVAL }),
      ]),
    );
    const needs = await screen.findByText("Needs approval");
    const changed = screen.getByText("Changed since approval", {
      selector: "span",
    });
    const approved = screen.getByText("Approved", { selector: "span" });
    const tone = (el: HTMLElement) =>
      el.closest("[data-tone]")!.getAttribute("data-tone");
    expect(new Set([tone(needs), tone(changed), tone(approved)]).size).toBe(3);
    // Static warnings are not alerts: nothing re-announces on every load.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("filters by status through the URL", async () => {
    open(
      recipes([
        recipe(),
        recipe({ id: "weather", status: "approved", approval: APPROVAL }),
      ]),
      {},
      "#/p/djdl/config/edge-mint?status=approved",
    );
    expect(await screen.findByText("weather")).toBeTruthy();
    expect(screen.queryByText("applemusic")).toBeNull();
  });

  it("approves a pending recipe by echoing exactly the fields shown", async () => {
    const backend = open(recipes([recipe()]));
    const drawer = await openApprove(/Approve…/);
    expect(window.location.hash).toContain("recipe=applemusic");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(approveBody(backend)).toEqual({
        ...FIELDS,
        identity: null,
        licenseEnabled: true,
      }),
    );
    // The approve invalidated the recipes.
    await waitFor(() =>
      expect(backend.reads(`${P}/config/mint`)).toBeGreaterThan(1),
    );
  });

  it("on open registration, warns and requires the acknowledgement before approving", async () => {
    const backend = open(recipes([recipe()], "open"));
    expect(await screen.findByText(/public token mint/)).toBeTruthy();
    const drawer = await openApprove();
    const approve = () =>
      within(drawer).getByRole("button", { name: "Approve" });
    expect(approve().getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(within(drawer).getByRole("checkbox"));
    await userEvent.click(approve());
    await waitFor(() =>
      expect(approveBody(backend)).toMatchObject({
        acknowledgeOpenRegistration: true,
      }),
    );
  });

  it("with anonymous enrolment on a closed product, warns and requires the acknowledgement", async () => {
    const backend = open(recipes([recipe()], "requires-license", true));
    expect(
      await screen.findByText(/Because anonymous enrolment is on/),
    ).toBeTruthy();
    const drawer = await openApprove();
    expect(
      within(drawer).getByText(/I understand anonymous enrolment is on/),
    ).toBeTruthy();
    expect(
      within(drawer)
        .getByRole("button", { name: "Approve" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(within(drawer).getByRole("checkbox"));
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(approveBody(backend)).toMatchObject({
        acknowledgeOpenRegistration: true,
      }),
    );
  });

  it("with an OIDC default tier, warns that the mint is public and requires the acknowledgement", async () => {
    const backend = open(
      recipes([recipe()], "requires-license", false, {
        identity: IDENTITY,
        oidcDefault: true,
      }),
    );
    expect(
      await screen.findByText(
        /every account that can sign in gets a default tier/,
      ),
    ).toBeTruthy();
    const drawer = await openApprove();
    await userEvent.click(within(drawer).getByRole("checkbox"));
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(approveBody(backend)).toMatchObject({
        identity: IDENTITY,
        acknowledgeOpenRegistration: true,
      }),
    );
  });

  it("shows what changed since approval, beside the approved value", async () => {
    open(
      recipes([
        recipe({
          status: "changed",
          ttlSeconds: 86400,
          approval: APPROVAL,
          changedFields: ["ttlSeconds"],
        }),
      ]),
    );
    const row = (await screen.findByText("applemusic")).closest("tr")!;
    expect(within(row).getByText("Token lifetime (seconds)")).toBeTruthy();
    const drawer = await openApprove(/Re-approve…/);
    expect(within(drawer).getByText("86400")).toBeTruthy();
    expect(within(drawer).getByText("3600")).toBeTruthy();
    expect(
      within(drawer).getByRole("columnheader", { name: "Approved as" }),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Re-approve" }),
    ).toBeTruthy();
  });

  it("explains a recipe whose approval predates open registration, and re-approves with the acknowledgement", async () => {
    const backend = open(
      recipes(
        [
          recipe({
            status: "changed",
            approval: APPROVAL,
            changedFields: ["registration"],
          }),
        ],
        "open",
      ),
    );
    const drawer = await openApprove(/Re-approve…/);
    expect(
      within(drawer).getByText(
        /The mint became public \(registration is open\) after this recipe/,
      ),
    ).toBeTruthy();
    await userEvent.click(within(drawer).getByRole("checkbox"));
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Re-approve" }),
    );
    await waitFor(() =>
      expect(approveBody(backend)).toMatchObject({
        acknowledgeOpenRegistration: true,
      }),
    );
  });

  it("flags a signing secret that is not marked edge-mint, with a link to Keys & secrets (EMR-5)", async () => {
    open(recipes([recipe({ secretUsage: "general" })]));
    expect(await screen.findByText("General: cannot sign")).toBeTruthy();
    const drawer = await openApprove();
    expect(
      within(drawer)
        .getByRole("link", { name: "Keys & secrets" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/keys");
    expect(within(drawer).queryByText(/above/)).toBeNull();
  });

  it("keeps the drawer open and reloads the recipe on a 409 (EMR-3)", async () => {
    let ttl = 3600;
    const backend = open(() => recipes([recipe({ ttlSeconds: ttl })]), {
      [`POST ${P}/config/mint/applemusic/approve`]: () => {
        ttl = 7200;
        return apiError(409);
      },
    });
    const drawer = await openApprove();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    expect(
      await within(drawer).findByText(
        "This recipe changed while you were reviewing",
      ),
    ).toBeTruthy();
    expect(await within(drawer).findByText("7200")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(drawer);
    expect(backend.reads(`${P}/config/mint`)).toBeGreaterThan(1);
  });

  it("with Identity on, shows the sign-in trust once and echoes it on approve (EMR-4)", async () => {
    const backend = open(
      recipes([recipe()], "requires-license", false, { identity: IDENTITY }),
    );
    expect(
      await screen.findByText("Signing in also hands out device tokens"),
    ).toBeTruthy();
    expect(screen.getAllByText("https://id.example")).toHaveLength(1);
    const drawer = await openApprove();
    expect(within(drawer).queryByText("https://id.example")).toBeNull();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(approveBody(backend)).toMatchObject({ identity: IDENTITY }),
    );
  });

  it("explains a recipe whose sign-in trust changed, with the approved issuer beside the new one", async () => {
    open(
      recipes(
        [
          recipe({
            status: "changed",
            approval: { ...APPROVAL, identity: IDENTITY },
            changedFields: ["identity"],
          }),
        ],
        "requires-license",
        false,
        { identity: { ...IDENTITY, issuer: "https://idp.attacker.example" } },
      ),
    );
    const drawer = await openApprove(/Re-approve…/);
    expect(
      within(drawer).getByText(
        /Sign-in now trusts a different identity provider or group map/,
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByText("Approved as https://id.example"),
    ).toBeTruthy();
  });

  it("explains a recipe whose approval predates License being turned off", async () => {
    open(
      recipes(
        [
          recipe({
            status: "changed",
            approval: APPROVAL,
            changedFields: ["license"],
          }),
        ],
        "requires-identity",
        false,
        { identity: IDENTITY, licenseEnabled: false },
      ),
    );
    const drawer = await openApprove(/Re-approve…/);
    expect(
      within(drawer).getByText(/License was turned off after this recipe/),
    ).toBeTruthy();
  });

  it("while License is off, warns on the page and in the drawer and echoes License off", async () => {
    const backend = open(
      recipes([recipe()], "requires-identity", false, {
        identity: IDENTITY,
        licenseEnabled: false,
      }),
    );
    expect(
      (await screen.findByTestId("edge-mint-license-off")).textContent,
    ).toMatch(
      /does not check device licences, so a disabled or expired licence can mint/,
    );
    const drawer = await openApprove();
    expect(
      within(drawer).getByTestId("edge-mint-approve-license-off").textContent,
    ).toMatch(/License is off: this mint does not check device licences/);
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(approveBody(backend)).toMatchObject({ licenseEnabled: false }),
    );
  });

  it("shows no License warning while License is on", async () => {
    open(recipes([recipe()]));
    await screen.findByText("applemusic");
    expect(screen.queryByTestId("edge-mint-license-off")).toBeNull();
  });

  it("revokes an approval after an L2 confirmation", async () => {
    const backend = open(
      recipes([recipe({ status: "approved", approval: APPROVAL })]),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for applemusic" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Revoke approval/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText(/Devices get 404 for this recipe at once/),
    ).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Revoke approval" }),
    );
    await waitFor(() =>
      expect(backend.writes()).toEqual([
        expect.objectContaining({ path: `${P}/config/mint/applemusic/revoke` }),
      ]),
    );
    await waitFor(() =>
      expect(backend.reads(`${P}/config/mint`)).toBeGreaterThan(1),
    );
  });

  it("passes axe", async () => {
    open(recipes([recipe()], "open", false, { identity: IDENTITY }));
    await screen.findByText("applemusic");
    const results = await axe(document.querySelector("main")!);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
