import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AppConsentView,
  KeyPreview,
  LicenseChoice,
  LicenseChoiceView,
  ReplaceView,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import { navigation } from "../src/portal/model/signInRequest.js";
import {
  ACCOUNT,
  axeViolations,
  CAPS_ALL,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

const HANDLE = "rq_AAAAAAAAAAAAAAAAAAAAAA";
const REQUEST = `/api/signin/requests/${HANDLE}`;

const VIEW: SignInRequestView = {
  request: HANDLE,
  client: {
    product: "diceroll",
    kind: "native",
    appName: "Diceroll",
    developerName: "Example Games",
    iconUrl: null,
    origins: [],
    services: { license: true, cloudSync: true },
    nameVerified: true,
  },
  deviceLabel: "Mara's Pixel 8",
  userCode: null,
  expiresAt: 0,
  purpose: "signin",
  licenseChoice: "card",
  scope: ["openid"],
};

const ROW: LicenseChoice = {
  id: "lic_std",
  tierName: "Standard",
  name: "Diceroll Standard",
  origin: "key",
  access: "seats",
  seats: { used: 1, limit: 3 },
  current: false,
  expiresAt: null,
  state: "free",
  replace: null,
  freeDeviceUrl: null,
};
const FULL: LicenseChoice = {
  ...ROW,
  id: "lic_full",
  name: "Diceroll Family",
  tierName: "Family",
  origin: "free",
  seats: { used: 3, limit: 3 },
  state: "full",
  replace: { allowed: true, retryAfter: null },
};

function choices(over: Partial<LicenseChoiceView> = {}): LicenseChoiceView {
  return {
    state: "choose",
    choices: [ROW],
    keep: false,
    preselected: ROW.id,
    create: null,
    getLicense: null,
    ...over,
  };
}

const CONSENT: AppConsentView = {
  request: HANDLE,
  person: {
    displayName: "Mara Fennick",
    email: ACCOUNT.email,
    avatarUrl: null,
  },
  items: [
    { kind: "cloudSync" },
    { kind: "profile", claims: ["name", "picture", "email"] },
  ],
  scopeHash: "x",
  firstTime: true,
  changed: false,
};

const DEVICES: ReplaceView = {
  licenseId: FULL.id,
  seats: { used: 3, limit: 3 },
  devices: [
    {
      id: "d1",
      label: "Work laptop",
      platform: "macOS",
      deviceType: "computer",
      lastSeen: Math.floor(Date.now() / 1000) - 30 * 86400,
      leastRecent: true,
      activeNow: false,
      thisBrowser: false,
    },
    {
      id: "d2",
      label: "Studio Mac mini",
      platform: "macOS",
      deviceType: "computer",
      lastSeen: Math.floor(Date.now() / 1000) - 60,
      leastRecent: false,
      activeNow: true,
      thisBrowser: false,
    },
  ],
  replace: { allowed: true, retryAfter: null },
};

let went: string[] = [];
beforeEach(() => {
  went = [];
  vi.spyOn(navigation, "go").mockImplementation((u) => void went.push(u));
  window.history.replaceState(null, "", `/signin?request=${HANDLE}`);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function flow(
  licenses: LicenseChoiceView,
  extra: Record<string, unknown> = {},
) {
  mockFetch({
    ...signedIn(),
    [REQUEST]: VIEW,
    [`${REQUEST}/licenses`]: licenses,
    [`${REQUEST}/consent`]: CONSENT,
    [`${REQUEST}/licenses/${FULL.id}/devices`]: DEVICES,
    [`POST ${REQUEST}/continue`]: { redirect: "https://app.example/cb?code=1" },
    [`POST ${REQUEST}/cancel`]: {
      redirect: "https://app.example/cb?error=access_denied",
    },
    ...extra,
  });
}

function posted(path: string): unknown {
  const call = vi
    .mocked(fetch)
    .mock.calls.find(
      ([u, init]) =>
        String(u).endsWith(path) && (init?.method ?? "GET") === "POST",
    );
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined;
}

describe("the app card, signed out (SIGN-IN.md §3.1)", () => {
  it("shows the request's header and footer from data alone, and ignores a spoofed name", async () => {
    window.history.replaceState(
      null,
      "",
      `/signin?request=${HANDLE}&appName=Evil&developer=Mallory`,
    );
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: VIEW,
    });
    renderPortal();
    expect(
      await screen.findByText("wants you to sign in", { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText("Diceroll", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Example Games")).toBeTruthy();
    expect(screen.getByText("on Mara's Pixel 8")).toBeTruthy();
    expect(
      screen.getByText(
        "Polaris Locker signs you in for Diceroll. Example Games never sees your codes or passkeys.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Evil|Mallory/);
    expect(document.body.textContent).not.toMatch(/Polaris Key/);
    // Help and Privacy stay under the card in an app's context too (SIGN-IN §3.1).
    const nav = screen.getByRole("navigation", { name: "Help and policies" });
    expect(within(nav).getByRole("link", { name: "Help" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Privacy" })).toBeTruthy();
  });

  it("an unverified name draws the neutral frame, not a developer", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: {
        ...VIEW,
        client: { ...VIEW.client, appName: "diceroll", nameVerified: false },
      },
    });
    renderPortal();
    await screen.findByText("wants you to sign in", { exact: false });
    expect(screen.queryByText("Example Games")).toBeNull();
  });

  it("a request that is gone says so and offers no sign-in", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: { status: 404, body: { error: "not_found" } },
    });
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This sign-in has ended",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
  });

  it("Identity off: the product card says so (identity_disabled)", async () => {
    window.history.replaceState(
      null,
      "",
      "/signin?product=diceroll&error=identity_disabled",
    );
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": {
        ...CAPS_ALL,
        product: {
          slug: "diceroll",
          name: "Diceroll",
          developerName: "Example Games",
        },
      },
    });
    renderPortal();
    expect(
      await screen.findByText(
        "Diceroll doesn't use Polaris Locker sign-in. Open Diceroll and enter your license key there.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("wants you to sign in", { exact: false }),
    ).toBeNull();
  });
});

describe("the request's hints and purpose (UK-42.14)", () => {
  const out = (view: SignInRequestView = VIEW) =>
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: view,
    });
  const gate = (over: Record<string, unknown> = {}) => ({
    status: "gate",
    provider: "email",
    stage: "choose",
    expiresAt: 0,
    emailRequired: false,
    email: {
      provider: null,
      providerVerified: false,
      relay: false,
      pending: null,
      confirmed: "ada@example.com",
    },
    profile: {
      name: null,
      nameExplicit: false,
      suggestions: [{ name: "ada", source: "email" }],
      picture: null,
    },
    terms: null,
    platformTerms: null,
    product: null,
    ...over,
  });

  it("prefills the email from loginHint and sends nothing by itself", async () => {
    out({ ...VIEW, loginHint: "ada@example.com" });
    renderPortal();
    const field = await screen.findByRole("textbox", { name: "Email" });
    expect((field as HTMLInputElement).value).toBe("ada@example.com");
    await new Promise((r) => setTimeout(r, 50));
    const sent = vi
      .mocked(fetch)
      .mock.calls.filter(([u]) => String(u).includes("/email/start"));
    expect(sent).toHaveLength(0);
  });

  it("leaves the email empty without a hint", async () => {
    out();
    renderPortal();
    const field = await screen.findByRole("textbox", { name: "Email" });
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("purpose attach: the header reads Add <app> to your account", async () => {
    out({ ...VIEW, purpose: "attach" });
    renderPortal();
    expect(
      await screen.findByText("to your account", { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText("Diceroll", { selector: "strong" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/wants you to sign in/);
  });

  const finish = async (newAccount: boolean) => {
    window.history.replaceState(
      null,
      "",
      `/signin?request=${HANDLE}&signin=confirm-email`,
    );
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: { ...VIEW, nameHint: "Ada Lovelace" },
      "/api/signin/confirm-email": gate({ newAccount }),
    });
    renderPortal();
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([u]) => String(u).endsWith("/confirm-email")),
      ).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 100));
    const field = screen.queryByRole("textbox", { name: /name/i });
    return (field as HTMLInputElement | null)?.value ?? "";
  };

  it("FinishStep starts the name from nameHint for a new account only", async () => {
    expect(await finish(true)).toBe("Ada Lovelace");
  });

  it("an existing account's finish step ignores nameHint", async () => {
    expect(await finish(false)).not.toBe("Ada Lovelace");
  });
});

describe("LicenseChoiceStep (§3.6)", () => {
  it("lists the licences, preselects the server's pick and goes on to consent with it", async () => {
    flow(choices());
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Choose a license for this device",
      }),
    ).toBeTruthy();
    const radio = screen.getByRole("radio", { name: /Diceroll Standard/ });
    expect(radio.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("1 of 3 devices")).toBeTruthy();
    expect(screen.getByText("Added with a key · Lifetime")).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      screen.getByRole("button", { name: "Use this license" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Continue to Diceroll as Mara?",
      }),
    ).toBeTruthy();
    expect(
      // The seat position is a nowrap span (LF3), so the text is read from the paragraph.
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" &&
          el.textContent === "Lifetime · Mara's Pixel 8 becomes device 2 of 3",
      ),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to Diceroll" }),
    );
    await waitFor(() =>
      expect(posted(`${REQUEST}/continue`)).toEqual({
        choice: { kind: "license", licenseId: "lic_std" },
      }),
    );
    // A native app gets the ReturnStep (SIGN-IN.md §3.10): nothing leaves until Return, or the timer.
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "You're signed in to Diceroll",
      }),
    ).toBeTruthy();
    expect(went).toEqual([]);
    await userEvent.click(
      screen.getByRole("button", { name: "Return to Diceroll" }),
    );
    await waitFor(() =>
      expect(went).toEqual(["https://app.example/cb?code=1"]),
    );
  });

  it("the ReturnStep's Stay here stops the timer, and the app is never left by itself", async () => {
    const { ReturnStep } =
      await import("../src/portal/components/signin/ReturnStep.js");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onReturn = vi.fn();
      render(
        <ReturnStep
          app="Diceroll"
          product="Diceroll"
          yours
          onReturn={onReturn}
        />,
      );
      expect(
        screen.getByRole("heading", { level: 1, name: "Diceroll is yours" }),
      ).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Stay here" }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onReturn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the ReturnStep returns by itself after three seconds", async () => {
    const { ReturnStep } =
      await import("../src/portal/components/signin/ReturnStep.js");
    vi.useFakeTimers();
    try {
      const onReturn = vi.fn();
      render(
        <ReturnStep
          app="Diceroll"
          product="Diceroll"
          yours={false}
          onReturn={onReturn}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(onReturn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nothing chosen: an enabled primary and the error under the group", async () => {
    flow(
      choices({
        preselected: null,
        choices: [ROW, { ...ROW, id: "lic_b", name: "Other" }],
      }),
    );
    renderPortal();
    const primary = await screen.findByRole("button", {
      name: "Use this license",
    });
    expect((primary as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(primary);
    const group = screen.getByRole("radiogroup");
    expect(
      await screen.findByText("Choose a license to continue."),
    ).toBeTruthy();
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      fetchedRequests().some(
        (r) => r.startsWith("POST") && r.includes("/continue"),
      ),
    ).toBe(false);
  });

  it("every licence full: Replace a device, the safety line, nothing preselected, then a done state naming both devices", async () => {
    flow(
      choices({
        choices: [FULL, { ...FULL, id: "lic_full2", name: "Other" }],
        preselected: null,
      }),
    );
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Choose a license for this device",
    });
    expect(screen.getAllByText("All devices in use").length).toBeGreaterThan(0);
    await userEvent.click(
      screen.getByRole("radio", { name: /Diceroll Family/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Replace a device" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Replace a device",
      }),
    ).toBeTruthy();
    // Nothing preselected, an enabled primary, the error at the group.
    const devices = screen.getAllByRole("radio");
    expect(
      devices.every((d) => d.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    expect(
      screen.getByText(
        "The device you choose signs out of Diceroll. It can sign in again later if there's room. We'll email you about it.",
      ),
    ).toBeTruthy();
    const primary = screen.getByRole("button", { name: "Replace and sign in" });
    expect((primary as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(primary);
    expect(await screen.findByText("Choose a device to replace.")).toBeTruthy();
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(
      screen.getByRole("radio", { name: /Studio Mac mini/ }),
    );
    expect(
      screen.getByText("Studio Mac mini is in use right now."),
    ).toBeTruthy();
    await userEvent.click(primary);
    // Consent names what replaces what.
    expect(await screen.findByText("replaces Studio Mac mini")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to Diceroll" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Device replaced" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Studio Mac mini signed out of Diceroll. Mara's Pixel 8 is signed in.",
      ),
    ).toBeTruthy();
    expect(posted(`${REQUEST}/continue`)).toEqual({
      choice: { kind: "license", licenseId: "lic_full", replaceDeviceId: "d2" },
    });
  });

  it("D4: with no licence and an automatic grant, choice is skipped and consent says New", async () => {
    flow(
      choices({
        state: "autoIssue",
        choices: [],
        preselected: null,
        create: { tierName: "Free", access: "account" },
      }),
    );
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Continue to Diceroll as Mara?",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("New: Free license, created when you continue"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("Don't allow returns access_denied; consent has equal buttons and no toggles", async () => {
    flow(choices());
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Use this license",
      }),
    );
    await screen.findByRole("heading", {
      level: 1,
      name: "Continue to Diceroll as Mara?",
    });
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    const main = screen.getByRole("main");
    const allow = within(main).getByRole("button", {
      name: "Continue to Diceroll",
    });
    const deny = within(main).getByRole("button", { name: "Don't allow" });
    expect(allow.className).toContain("min-h-12");
    expect(deny.className).toContain("min-h-12");
    expect(allow.className).toContain("w-full");
    expect(deny.className).toContain("w-full");
    await userEvent.click(deny);
    await waitFor(() => expect(posted(`${REQUEST}/cancel`)).toBeDefined());
    await waitFor(() =>
      expect(went).toEqual(["https://app.example/cb?error=access_denied"]),
    );
  });

  it("Change goes back to the list with the selection kept", async () => {
    flow(choices());
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Use this license",
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Change" }),
    );
    expect(
      (
        await screen.findByRole("radio", { name: /Diceroll Standard/ })
      ).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("fix round", () => {
  it("Change keeps the person's pick, even one the server did not preselect", async () => {
    const other = {
      ...ROW,
      id: "lic_b",
      name: "Diceroll Plus",
      tierName: "Plus",
    };
    flow(choices({ preselected: null, choices: [ROW, other] }));
    renderPortal();
    await userEvent.click(
      await screen.findByRole("radio", { name: /Diceroll Plus/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Use this license" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Change" }),
    );
    expect(
      (
        await screen.findByRole("radio", { name: /Diceroll Plus/ })
      ).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("the all-full callout shows only when every licence is full", async () => {
    flow(choices({ preselected: ROW.id, choices: [ROW, FULL] }));
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Choose a license for this device",
    });
    expect(document.querySelector("[data-callout]")).toBeNull();
  });

  it("a rate-limited Replace says the wait in minutes and offers no primary that cannot act", async () => {
    const limited = { ...FULL, replace: { allowed: false, retryAfter: 600 } };
    flow(choices({ choices: [limited], preselected: null }));
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Choose a license for this device",
    });
    expect(
      screen.getByText("Too many device changes. Try again in 10 minutes."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Replace a device" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use this license" }),
    ).toBeNull();
  });

  it("with Replace rate-limited and Create offered, Create is chosen and the primary does not say Replace", async () => {
    const limited = { ...FULL, replace: { allowed: false, retryAfter: 600 } };
    flow(
      choices({
        choices: [limited],
        preselected: null,
        create: { tierName: "Free", access: "account" },
      }),
    );
    renderPortal();
    expect(
      (
        await screen.findByRole("radio", { name: /Create a new free license/ })
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.queryByRole("button", { name: "Replace a device" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Use this license" }),
    ).toBeTruthy();
  });

  it("Back from Replace a device keeps the row", async () => {
    flow(
      choices({
        choices: [FULL, { ...FULL, id: "lic_full2", name: "Other" }],
        preselected: null,
      }),
    );
    renderPortal();
    await userEvent.click(
      await screen.findByRole("radio", { name: /Diceroll Family/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Replace a device" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(
      (
        await screen.findByRole("radio", { name: /Diceroll Family/ })
      ).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("an unverified name's footer names the app, not an empty band", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: {
        ...VIEW,
        client: { ...VIEW.client, appName: "diceroll", nameVerified: false },
      },
    });
    renderPortal();
    expect(
      await screen.findByText("Polaris Locker signs you in for diceroll."),
    ).toBeTruthy();
  });
});

describe("AccountUpgrade on the key step (§3.9)", () => {
  const KEY = `pkey_diceroll_${"A".repeat(22)}`;
  function preview(over: Partial<KeyPreview> = {}): KeyPreview {
    return {
      product: {
        slug: "diceroll",
        name: "Diceroll",
        branding: null,
        developerName: "Example Games",
        iconUrl: null,
        headerUrl: null,
      },
      verdict: "addable",
      license: { tierName: "Standard", term: "perpetual" },
      keyEntries: { used: 3, limit: 5 },
      upgrade: "skippable",
      ...over,
    };
  }
  async function enter(handle: boolean, p: KeyPreview) {
    if (!handle) window.history.replaceState(null, "", "/");
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: VIEW,
      "POST /api/key/preview": p,
    });
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Have a license key?" }),
    );
    await userEvent.click(await screen.findByRole("textbox"));
    await userEvent.paste(KEY);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  it("skippable while entries remain: the meter is neutral, never amber, and Sign in instead sits beside Create account", async () => {
    await enter(true, preview());
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Keep Diceroll in an account",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("2 of 5 key entries left · This will be entry 4"),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "3 of 5 key entries used" }).innerHTML,
    ).not.toMatch(/warning|amber|danger/);
    expect(
      screen.getByRole("button", { name: "Sign in instead" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign in without the key" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("lists the reasons to keep the licence: Cloud Sync when the app has it, plus recover and devices", async () => {
    await enter(true, preview());
    await screen.findByRole("heading", {
      level: 1,
      name: "Keep Diceroll in an account",
    });
    expect(
      screen.getByText(
        "Cloud Sync keeps your settings and saves on every device",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Get your license back if you lose the key or this device",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Move it to a new device yourself, without asking Example Games",
      ),
    ).toBeTruthy();
  });

  it("leaves the Cloud Sync reason out when the app has no Cloud Sync, and on the standalone on-ramp", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      [REQUEST]: {
        ...VIEW,
        client: {
          ...VIEW.client,
          services: { license: true, cloudSync: false },
        },
      },
      "POST /api/key/preview": preview(),
    });
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Have a license key?" }),
    );
    await userEvent.click(await screen.findByRole("textbox"));
    await userEvent.paste(KEY);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      level: 1,
      name: "Keep Diceroll in an account",
    });
    expect(screen.queryByText(/Cloud Sync keeps/)).toBeNull();
    expect(screen.getByText(/Get your license back/)).toBeTruthy();
  });

  it("Sign in instead keeps the key: the sign-in card says it is carried", async () => {
    await enter(false, preview());
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in instead" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to add Diceroll",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign in without the key" }),
    ).toBeTruthy();
  });

  it("forced at zero entries: a neutral callout, Create account, Sign in instead", async () => {
    await enter(
      true,
      preview({ keyEntries: { used: 5, limit: 5 }, upgrade: "forced" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Create an account to keep Diceroll",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/This key has no entries left in Diceroll/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign in without the key" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign in instead" }),
    ).toBeTruthy();
  });

  it("a key in another account is refused under the field", async () => {
    await enter(false, preview({ verdict: "license_owned", license: null }));
    expect(
      await screen.findByText(/Sign in to the .* account that has this/i),
    ).toBeTruthy();
  });
});

describe("Not you? (the sign-out can fail)", () => {
  const meReads = () =>
    fetchedRequests().filter((r) => r === "GET /api/me").length;

  it("re-reads the session whether the sign-out was confirmed or not", async () => {
    for (const logout of [{ status: 200 }, "network"] as const) {
      cleanup();
      flow(choices(), { "POST /logout": logout });
      renderPortal();
      await screen.findByRole("heading", {
        level: 1,
        name: "Choose a license for this device",
      });
      const before = meReads();
      await userEvent.click(screen.getByRole("button", { name: "Not you?" }));
      await waitFor(() => expect(meReads()).toBeGreaterThan(before));
      expect(fetchedRequests()).toContain("POST /logout");
    }
  });
});
