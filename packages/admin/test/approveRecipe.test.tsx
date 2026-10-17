import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  EdgeMintIdentity,
  EdgeMintRecipe,
  EdgeMintRecipesResponse,
} from "../src/api.js";
import { ME, resetConsole } from "./consoleHarness.js";
import { apiError, bootConfig, type Backend } from "./configHarness.js";

/**
 * The approve drawer of a minted token (U-31, admin-2-16; P0-12), driven through the catalog editor.
 * The approval semantics are the old Edge mint page's (the approve call echoes the fields, the
 * identity trust and License as shown; a public mint needs the acknowledgement); what is new is
 * where it lives, the step-up before approving, and the changed-while-open callout.
 */

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const P = "/manage/api/products/djdl";
const NOW_S = Math.floor(Date.now() / 1000);
const FRESH = { ...ME, authAt: NOW_S - 30, stepUpMaxAgeSeconds: 300 };
const STALE = { ...ME, authAt: NOW_S - 3600, stepUpMaxAgeSeconds: 300 };

const FIELDS = {
  alg: "ES256",
  signingKeySecret: "EDGE_MINT__DJDL__APPLEMUSIC",
  kid: "KID1",
  claimsTemplateJson: '{"iss":"TEAM"}',
  ttlSeconds: 3600,
  audience: null,
  requires: "licensed" as const,
  requiredEntitlement: null,
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

const CATALOG = {
  schemaVersion: 8,
  entries: [
    {
      key: "applemusic",
      kind: "secret",
      category: "Tokens",
      label: "Apple Music",
      description: "About applemusic",
      schema: { type: "string" },
      delivery: "edgeMint",
    },
  ],
};

beforeEach(() => {
  resetConsole();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(
  data: EdgeMintRecipesResponse | (() => unknown),
  extra: Record<string, unknown> = {},
  hash = "#/p/djdl/config/catalog/edit?entry=applemusic",
  me: unknown = FRESH,
): Backend {
  return bootConfig(hash, {
    "/manage/api/me": me as never,
    [`${P}/config/catalog`]: CATALOG,
    [`${P}/config/catalog/usage`]: { keys: {} },
    [`${P}/config/mint`]: data as never,
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

/** Open the drawer from the entry's own link. */
async function openApprove(
  label = /Review and approve|View approval/,
): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: label }));
  return screen.findByRole("dialog", { name: /applemusic/ });
}

const approveBody = (backend: Backend) =>
  backend.writes().find((c) => c.path.endsWith("/approve"))?.body;

describe("Approve a minted token's recipe", () => {
  it("opens from the entry and approves by echoing exactly the fields shown", async () => {
    const backend = open(recipes([recipe()]));
    const drawer = await openApprove();
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
    await waitFor(() =>
      expect(backend.reads(`${P}/config/mint`)).toBeGreaterThan(1),
    );
    await waitFor(() => expect(window.location.hash).not.toContain("recipe="));
  });

  it("on a public mint, requires the acknowledgement before approving", async () => {
    const backend = open(recipes([recipe()], "open"));
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

  it("names why an anonymous-enrollment mint is public", async () => {
    open(recipes([recipe()], "requires-license", true));
    const drawer = await openApprove();
    expect(
      within(drawer).getByText(/I understand anonymous enrollment is on/),
    ).toBeTruthy();
  });

  it("echoes the sign-in trust it was shown", async () => {
    const backend = open(
      recipes([recipe()], "requires-license", false, { identity: IDENTITY }),
    );
    const drawer = await openApprove();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(approveBody(backend)).toMatchObject({ identity: IDENTITY }),
    );
  });

  it("puts changed fields first, old value struck, new value marked, and warns on a wider one", async () => {
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
    const drawer = await openApprove();
    expect(within(drawer).getByTestId("was-ttlSeconds").textContent).toContain(
      "3600",
    );
    expect(within(drawer).getByText("86400")).toBeTruthy();
    expect(
      within(drawer).getByText(
        /A leaked token works for 24 hours instead of 1 hour/,
      ),
    ).toBeTruthy();
    // The rest sits behind one disclosure.
    expect(within(drawer).getByText("7 fields unchanged")).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Re-approve" }),
    ).toBeTruthy();
  });

  it("has no widening warning for a narrowing change", async () => {
    open(
      recipes([
        recipe({
          status: "changed",
          ttlSeconds: 60,
          approval: APPROVAL,
          changedFields: ["ttlSeconds"],
        }),
      ]),
    );
    const drawer = await openApprove();
    expect(within(drawer).queryByText(/leaked token/)).toBeNull();
  });

  it("explains a recipe whose approval predates a public mint, and re-approves with the acknowledgement", async () => {
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
    const drawer = await openApprove();
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

  it("explains changed sign-in trust and License", async () => {
    open(
      recipes(
        [
          recipe({
            status: "changed",
            approval: { ...APPROVAL, identity: IDENTITY },
            changedFields: ["identity", "license"],
          }),
        ],
        "requires-license",
        false,
        {
          identity: { ...IDENTITY, issuer: "https://idp.attacker.example" },
          licenseEnabled: false,
        },
      ),
    );
    const drawer = await openApprove();
    expect(
      within(drawer).getByText("Approved as https://id.example"),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(/License was turned off after this recipe/),
    ).toBeTruthy();
    expect(
      within(drawer).getByTestId("edge-mint-approve-license-off"),
    ).toBeTruthy();
  });

  it("links an unmarked signing secret to Keys & secrets", async () => {
    open(recipes([recipe({ secretUsage: "general" })]));
    const drawer = await openApprove();
    expect(
      within(drawer)
        .getByRole("link", { name: "Keys & secrets" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/settings/keys");
  });

  it("keeps the drawer open on a 409, with an info callout and the new recipe, approving nothing", async () => {
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
    const callout = await within(drawer).findByText(
      "The recipe changed while you were reviewing",
    );
    expect(callout.closest("[data-tone]")!.getAttribute("data-tone")).toBe(
      "info",
    );
    expect(await within(drawer).findByText("7200")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(drawer);
    expect(backend.reads(`${P}/config/mint`)).toBeGreaterThan(1);
    // It never auto-dismisses and Approve stays, for the new recipe.
    expect(
      within(drawer).getByRole("button", { name: "Approve" }),
    ).toBeTruthy();
  });

  it("swaps the comparison when the recipe changes under an open drawer", async () => {
    let ttl = 3600;
    const backend = open(() =>
      recipes([
        recipe({
          ttlSeconds: ttl,
          status: "changed",
          approval: APPROVAL,
          changedFields: ttl === 3600 ? ["kid"] : ["ttlSeconds"],
        }),
      ]),
    );
    const drawer = await openApprove();
    expect(
      within(drawer).queryByText(/changed while you were reviewing/),
    ).toBeNull();
    ttl = 7200;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(
      await within(drawer).findByText(
        "The recipe changed while you were reviewing",
      ),
    ).toBeTruthy();
    expect(within(drawer).getByText("7200")).toBeTruthy();
    expect(backend.writes()).toEqual([]);
  });

  it("asks for a fresh sign-in first, and comes back to this recipe", async () => {
    const backend = open(recipes([recipe()]), {}, undefined, STALE);
    const drawer = await openApprove();
    expect(
      within(drawer).getByText(
        /Approving needs a sign-in from the last five minutes/,
      ),
    ).toBeTruthy();
    const link = within(drawer).getByRole("link", {
      name: "Sign in to approve",
    });
    const href = link.getAttribute("href")!;
    expect(href).toContain("/manage/login?stepUp=1&returnTo=");
    expect(decodeURIComponent(href)).toContain(
      "#/p/djdl/config/catalog/edit?entry=applemusic&recipe=applemusic",
    );
    expect(approveBody(backend)).toBeUndefined();
  });

  it("when the server refuses the step-up, says nothing was approved and offers Try again", async () => {
    const backend = open(recipes([recipe()]), {
      [`POST ${P}/config/mint/applemusic/approve`]: apiError(403, {
        error: "step_up_required",
      }),
    });
    const drawer = await openApprove();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve" }),
    );
    const strip = await within(drawer).findByRole("alert");
    expect(strip.textContent).toMatch(/Nothing was approved/);
    expect(
      within(drawer).getByRole("link", { name: "Try again" }),
    ).toBeTruthy();
    // The comparison is still there.
    expect(
      within(drawer).getAllByText("EDGE_MINT__DJDL__APPLEMUSIC")[0],
    ).toBeTruthy();
    expect(backend.writes()).toHaveLength(1);
  });

  it("revokes an approval after a confirmation", async () => {
    const backend = open(
      recipes([recipe({ status: "approved", approval: APPROVAL })]),
    );
    const drawer = await openApprove();
    await userEvent.click(
      within(drawer).getByRole("button", { name: /Revoke approval/ }),
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
  });

  it("redirects the old Edge mint URL to the entry's drawer", async () => {
    open(
      recipes([recipe()]),
      {},
      "#/p/djdl/config/edge-mint?recipe=applemusic",
    );
    await screen.findByRole("dialog", { name: /applemusic/ });
    expect(window.location.hash).toBe(
      "#/p/djdl/config/catalog/edit?entry=applemusic&recipe=applemusic",
    );
  });

  it("passes axe with the drawer open", async () => {
    open(recipes([recipe()], "open", false, { identity: IDENTITY }));
    const drawer = await openApprove();
    const results = await axe(drawer);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
