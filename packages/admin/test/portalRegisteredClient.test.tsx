import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AppConsentView,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import { navigation } from "../src/portal/model/signInRequest.js";
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
    expect(screen.getByText("Partner Ltd")).toBeTruthy();
    expect(
      screen.getByText("Returns you to community.example.com"),
    ).toBeTruthy();
    expect(document.body.textContent).toMatch(/Forum App account/);
    expect(document.body.textContent).not.toMatch(/Polaris Key/);
  });

  it("shows the consent lines with a switch on optional claims and a Required tag, and no licence line", async () => {
    flow();
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: /Continue to Community as Mara/,
    });
    expect(screen.getByText("Your screen name")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Your picture" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Your email address" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Your screen name" }),
    ).toBeNull();
    expect(screen.getByText("Which Forum App features you have")).toBeTruthy();
    expect(
      screen.getByText("Staying signed in to Community while you're away"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/license|synced/i);
    expect(
      screen.getByText(
        "What you share is the same for every app you sign in to with Forum App.",
      ),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("Continue posts the claims switched on and goes to the redirect", async () => {
    const user = await openConsent();
    await user.click(screen.getByRole("switch", { name: "Your picture" }));
    await user.click(
      screen.getByRole("button", { name: "Continue to Community" }),
    );
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

  it("asks the person to sign in again when the request needs a fresh sign-in", async () => {
    flow({ ...CONSENT, reauth: true });
    renderPortal();
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Sign in again",
    });
    expect(heading).toBeTruthy();
    expect(
      screen.getByText(
        "Community asked you to sign in again before you continue.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue to Community" }),
    ).toBeNull();
    const card = screen
      .getByRole("button", { name: "Sign in again" })
      .closest("main, section, div")!;
    expect(
      within(card as HTMLElement).getByRole("button", { name: "Don't allow" }),
    ).toBeTruthy();
  });
});
