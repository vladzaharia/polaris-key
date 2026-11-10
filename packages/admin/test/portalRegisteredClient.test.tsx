import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AppConsentView,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import {
  navigation,
  stashReauthEmail,
  takeReauthEmail,
} from "../src/portal/model/signInRequest.js";
import {
  ACCOUNT,
  axeViolations,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * Sign in with <Product> on the Locker card (V5 §12.13.3, §12.13.6; I-21.8): the registered
 * client's header, the consent lines (a switch on each optional claim, "Required" on the others,
 * no licence line), a decline of a required claim being Don't allow, and the sign in again step.
 */
const HANDLE = "rq_BBBBBBBBBBBBBBBBBBBBBB";
const REQUEST = `/api/signin/requests/${HANDLE}`;

const VIEW: SignInRequestView = {
  request: HANDLE,
  client: {
    product: "forumapp",
    kind: "web",
    appName: "Forum App",
    developerName: "Forum Co",
    iconUrl: null,
    origins: [],
    services: { license: true, cloudSync: false },
    nameVerified: true,
    registered: {
      clientId: "cl_AAAAAAAAAAAAAAAAAAAAAA",
      name: "Community",
      developerName: "Partner Ltd",
      iconUrl: null,
      returnHost: "community.example.com",
      nameVerified: true,
      partner: true,
    },
  },
  deviceLabel: null,
  userCode: null,
  expiresAt: 0,
  purpose: "signin",
  licenseChoice: "card",
  scope: ["openid", "profile", "email", "offline_access"],
};

const CONSENT: AppConsentView = {
  request: HANDLE,
  person: {
    displayName: "Mara Fennick",
    email: ACCOUNT.email,
    avatarUrl: null,
  },
  items: [
    {
      kind: "profile",
      claims: ["name", "picture", "email"],
      required: ["name"],
    },
    { kind: "entitlements" },
    { kind: "offline" },
  ],
  scopeHash: "x",
  firstTime: true,
  changed: false,
};

/** Where the card tried to leave to, in order. */
const went: string[] = [];
beforeEach(() => {
  went.length = 0;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", `/signin?request=${HANDLE}`);
  vi.spyOn(navigation, "go").mockImplementation((to) => void went.push(to));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  cleanup();
});

function flow(consent: AppConsentView = CONSENT, view = VIEW) {
  mockFetch({
    ...signedIn(),
    [REQUEST]: view,
    [`${REQUEST}/consent`]: consent,
    [`POST ${REQUEST}/continue`]: {
      redirect: "https://community.example.com/cb?code=1",
    },
    [`POST ${REQUEST}/cancel`]: {
      redirect: "https://community.example.com/cb?error=access_denied",
    },
  });
}

/** The JSON the card posted to `path`, or `undefined`. */
function posted(path: string): unknown {
  const sent = vi
    .mocked(fetch)
    .mock.calls.filter(
      ([url, init]) => String(url).endsWith(path) && init?.method === "POST",
    )
    .map(([, init]) => String(init?.body ?? ""));
  return sent.length > 0 && sent[0] ? JSON.parse(sent[0]) : undefined;
}

/** Press Continue on the consent step. */
const pressContinue = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Continue to Community" }));

/** Render the card, press Continue, and wait for the card to say why it did not go. */
async function continueRefused(): Promise<void> {
  renderPortal();
  await screen.findByRole("heading", { level: 1, name: /Continue to/ });
  await pressContinue(userEvent.setup());
  expect(await screen.findByRole("alert")).toBeTruthy();
}

/** The consent step for a registered client, and a user to drive it. */
async function openConsent() {
  flow();
  renderPortal();
  await screen.findByRole("heading", {
    level: 1,
    name: /Continue to Community/,
  });
  return userEvent.setup();
}

describe("the card for a registered client", () => {
  it("names the client, the product, the developer and where it returns", async () => {
    flow();
    renderPortal();
    await screen.findByText("wants you to sign in with your", { exact: false });
    expect(screen.getByText("Community", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("by Partner Ltd")).toBeTruthy();
    expect(
      screen.getByText("Returns you to community.example.com"),
    ).toBeTruthy();
    expect(document.body.textContent).toMatch(/Forum App account/);
    expect(document.body.textContent).not.toMatch(/Polaris Key/);
  });

  it("shows what the client asks for, a switch on each optional claim and the lock on the rest", async () => {
    flow();
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: /Continue to Community as Mara/,
    });
    expect(
      screen.getByRole("heading", { level: 2, name: "Community asks for" }),
    ).toBeTruthy();
    // The screen name shows its value; the row is fixed, so it has the lock and no switch.
    expect(screen.getByText("Your screen name")).toBeTruthy();
    expect(
      screen.getAllByText("Fennick", { exact: false }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("switch", { name: /screen name/ })).toBeNull();
    // Every fixed row says so: the name, the features and staying signed in.
    expect(screen.getAllByText("Required")).toHaveLength(3);
    // The switches are named for what they do, and the whole row is their label.
    const picture = screen.getByRole("switch", {
      name: "Share your picture with Community",
    });
    expect(picture.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("switch", {
        name: "Share your email address with Community",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Which Forum App features you have")).toBeTruthy();
    expect(screen.getByText("Stay signed in while you're away")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/license|synced/i);
    expect(await axeViolations()).toEqual([]);
  });

  it("a click on a row's words switches it", async () => {
    const user = await openConsent();
    await user.click(screen.getByText("Your picture"));
    expect(
      screen
        .getByRole("switch", { name: "Share your picture with Community" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("a partner client says another company makes it; the product's own does not", async () => {
    await openConsent();
    expect(
      screen.getByText(
        "Community is made by Partner Ltd, not Forum App. It can tell you're the same person Forum App's apps know.",
      ),
    ).toBeTruthy();
    cleanup();
    flow(CONSENT, {
      ...VIEW,
      client: {
        ...VIEW.client,
        registered: { ...VIEW.client.registered!, partner: false },
      },
    });
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: /Continue to/ });
    expect(
      screen.getByText(
        "Apps you sign in to with Forum App get the same name and email, so they can tell it's you.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/is made by/);
  });

  it("asks only about what is undecided, says what is already shared, and starts a re-asked item off", async () => {
    flow({
      ...CONSENT,
      firstTime: false,
      changed: true,
      items: [
        {
          kind: "profile",
          claims: ["picture"],
          required: [],
          off: ["picture"],
        },
      ],
      shared: ["name", "email"],
    });
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: /Continue to/ });
    expect(
      screen.getByText(
        "Already shared with Community: your screen name and your email address",
        {
          exact: false,
        },
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Your email address")).toBeNull();
    const picture = screen.getByRole("switch", {
      name: "Share your picture with Community",
    });
    expect(picture.getAttribute("aria-checked")).toBe("false");
    await pressContinue(userEvent.setup());
    await waitFor(() => expect(went).toHaveLength(1));
    expect(posted(`${REQUEST}/continue`)).toEqual({ consent: { claims: [] } });
  });

  it("the product's terms are one check above Continue: unticked it asks, ticked it posts the version", async () => {
    flow({
      ...CONSENT,
      terms: { version: "t-2", url: "https://example.com/terms" },
    });
    await continueRefused();
    expect(posted(`${REQUEST}/continue`)).toBeUndefined();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox"));
    await pressContinue(user);
    await waitFor(() => expect(went).toHaveLength(1));
    expect(posted(`${REQUEST}/continue`)).toMatchObject({ terms: "t-2" });
  });

  it("a terms_required answer shows the terms from a fresh view, never the generic line", async () => {
    let calls = 0;
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`${REQUEST}/consent`]: () =>
        ++calls === 1
          ? CONSENT
          : {
              ...CONSENT,
              terms: { version: "t-2", url: "https://example.com/terms" },
            },
      [`POST ${REQUEST}/continue`]: {
        status: 409,
        body: { error: "terms_required" },
      },
    });
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: /Continue to/ });
    await pressContinue(userEvent.setup());
    expect(await screen.findByRole("checkbox")).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  it("a client switched off after the card loaded ends the request with a way out", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`${REQUEST}/consent`]: CONSENT,
      [`POST ${REQUEST}/continue`]: {
        status: 404,
        body: { error: "not_found" },
      },
    });
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: /Continue to/ });
    await pressContinue(userEvent.setup());
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Community can't sign you in right now",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /library/i })).toBeTruthy();
  });

  it("another account than the one the client expects: a step to use another account", async () => {
    flow({ ...CONSENT, wrongAccount: true });
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Community is expecting another account",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Use another account" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue to Community" }),
    ).toBeNull();
    // The primary does what "Not you?" would, so the row has no second way; and the wrong
    // account's address is not carried to the sign-in field.
    expect(screen.queryByText("Not you?")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Use another account" }));
    expect(window.sessionStorage.getItem("pk-reauth-email")).toBeNull();
  });

  it("Continue posts the claims switched on and goes to the redirect", async () => {
    const user = await openConsent();
    await user.click(
      screen.getByRole("switch", { name: "Share your picture with Community" }),
    );
    await pressContinue(user);
    await waitFor(() =>
      expect(went).toEqual(["https://community.example.com/cb?code=1"]),
    );
    expect(posted(`${REQUEST}/continue`)).toEqual({
      consent: { claims: ["name", "email"] },
    });
    // The card never asks for a licence choice for a registered client.
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([u]) => String(u).includes("/licenses")),
    ).toBe(false);
  });

  it("Don't allow is the way to decline a required claim", async () => {
    const user = await openConsent();
    await user.click(screen.getByRole("button", { name: "Don't allow" }));
    await waitFor(() =>
      expect(went).toEqual([
        "https://community.example.com/cb?error=access_denied",
      ]),
    );
  });

  it("a client name that failed the check draws the neutral frame with no developer", async () => {
    flow(CONSENT, {
      ...VIEW,
      client: {
        ...VIEW.client,
        registered: {
          ...VIEW.client.registered!,
          name: "forum",
          nameVerified: false,
        },
      },
    });
    renderPortal();
    await screen.findByText("wants you to sign in with your", { exact: false });
    expect(screen.queryByText("Partner Ltd")).toBeNull();
  });

  it("asks the person to confirm it's them when the request needs a fresh sign-in", async () => {
    flow({ ...CONSENT, reauth: true });
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Confirm it's you",
      }),
    ).toBeTruthy();
    // The account being confirmed is shown, and the app's ask is said once.
    expect(screen.getByText(ACCOUNT.email)).toBeTruthy();
    expect(
      screen.getByText("Community asks you to sign in again."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue to Community" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign in as Mara" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
    expect(screen.queryByText("Not you?")).toBeNull();
    // The same person signing in again keeps their address for the sign-in field.
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sign in as Mara" }));
    expect(window.sessionStorage.getItem("pk-reauth-email")).toContain(
      ACCOUNT.email,
    );
  });

  it("a wait after too many tries says so without naming a device", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`${REQUEST}/consent`]: CONSENT,
      [`POST ${REQUEST}/continue`]: {
        status: 429,
        body: { error: "rate_limited", retryAfter: 60 },
      },
    });
    await continueRefused();
    expect(document.body.textContent).not.toMatch(/device/i);
  });
});

describe("the address a fresh sign-in starts from", () => {
  it("is handed over once, for the same request only", () => {
    stashReauthEmail(HANDLE, "mara@fennick.studio");
    expect(takeReauthEmail("rq_other")).toBeUndefined();
    stashReauthEmail(HANDLE, "mara@fennick.studio");
    expect(takeReauthEmail(HANDLE)).toBe("mara@fennick.studio");
    expect(takeReauthEmail(HANDLE)).toBeUndefined();
  });
});
