import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalMethod,
  PortalMethods,
  PortalSession,
} from "../src/portal/api.js";
import { browser } from "../src/portal/browser.js";
import {
  passkeyName,
  passkeyProvider,
  remainingAfter,
  sessionMethodText,
  stepUpFresh,
} from "../src/portal/model/methods.js";
import {
  ACCOUNT,
  axeViolations,
  CAPS_ALL,
  DAY,
  fetchedRequests,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
  type MockRoute,
} from "./portalHarness.js";

/**
 * Account v2 (PX-13; PORTAL.md §4.26): Sign-in methods on PX-W12's API (connect, disconnect with
 * step-up, the last-method guard, Hide My Email), passkeys on I-16's, and Where you're signed in
 * on I-07's account sessions.
 */

const ICLOUD = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd";

function method(
  over: Partial<PortalMethod> & { id: string; kind: string },
): PortalMethod {
  const group =
    over.kind === "email"
      ? "email"
      : over.kind === "passkey"
        ? "passkeys"
        : "accounts";
  return {
    group,
    label:
      {
        google: "Google",
        apple: "Apple",
        steam: "Steam",
        email: "Email",
        passkey: "Passkey",
      }[over.kind] ?? over.kind,
    display: null,
    connectedAt: NOW_S - 60 * DAY,
    lastUsedAt: NOW_S - 3 * DAY,
    canRemove: true,
    reason: null,
    flag: null,
    relay: false,
    tenantScoped: false,
    ...over,
  };
}

/** Mara: Google, Steam, two addresses and an iCloud Keychain passkey. */
function maraMethods(over: Partial<PortalMethods> = {}): PortalMethods {
  const methods = [
    method({
      id: "lnk_google",
      kind: "google",
      display: "mara.fennick@gmail.com",
    }),
    method({ id: "lnk_steam", kind: "steam", display: "marafox" }),
    method({ id: "lnk_mail1", kind: "email", display: ACCOUNT.email }),
    method({
      id: "lnk_mail2",
      kind: "email",
      display: "mara.f@proton.me",
      lastUsedAt: null,
    }),
    method({ id: "lnk_pk", kind: "passkey", display: "Safari on macOS" }),
  ];
  return {
    methods,
    emails: [
      {
        methodId: "lnk_mail1",
        email: ACCOUNT.email,
        primary: true,
        connectedAt: NOW_S - 90 * DAY,
        lastUsedAt: NOW_S - 14 * DAY,
        canRemove: true,
        reason: null,
      },
      {
        methodId: "lnk_mail2",
        email: "mara.f@proton.me",
        primary: false,
        connectedAt: NOW_S - 20 * DAY,
        lastUsedAt: null,
        canRemove: true,
        reason: null,
      },
    ],
    passkeys: [
      {
        id: "Y3JlZC0x",
        methodId: "lnk_pk",
        createdAt: NOW_S - 30 * DAY,
        lastUsedAt: NOW_S - 3600,
        transports: ["internal", "hybrid"],
        synced: true,
        aaguid: ICLOUD,
        addedFrom: "Safari on macOS",
        canRemove: true,
        reason: null,
      },
    ],
    providers: [
      { kind: "apple", connected: false, available: true },
      { kind: "google", connected: true, available: true },
      { kind: "steam", connected: true, available: true },
    ],
    passkey: { canAdd: true, reason: null },
    primaryEmail: ACCOUNT.email,
    hideMyEmail: false,
    stepUp: {
      authenticatedAt: NOW_S - 3600,
      freshUntil: NOW_S - 3300,
      fresh: false,
      maxAgeSeconds: 300,
    },
    ...over,
  };
}

/** Sam: Apple only, through Hide My Email. */
const RELAY = "x7k2mq9p4d@privaterelay.appleid.com";
function samMethods(): PortalMethods {
  return {
    methods: [
      method({
        id: "lnk_apple",
        kind: "apple",
        display: RELAY,
        relay: true,
        canRemove: false,
        reason: "last_link",
      }),
    ],
    emails: [],
    passkeys: [],
    providers: [
      { kind: "apple", connected: true, available: true },
      { kind: "google", connected: false, available: true },
      { kind: "steam", connected: false, available: true },
    ],
    passkey: { canAdd: false, reason: "email_unverified" },
    primaryEmail: RELAY,
    hideMyEmail: true,
    stepUp: {
      authenticatedAt: NOW_S - 60,
      freshUntil: NOW_S + 240,
      fresh: true,
      maxAgeSeconds: 300,
    },
  };
}

const SESSIONS: PortalSession[] = [
  {
    id: "sess_this_browser_0001",
    createdAt: NOW_S - 3600,
    lastSeenAt: NOW_S - 30,
    expiresAt: NOW_S + 30 * DAY,
    browser: "Safari on macOS",
    methods: ["passkey"],
    current: true,
  },
  {
    id: "sess_other_phone_0002",
    createdAt: NOW_S - 2 * DAY,
    lastSeenAt: NOW_S - DAY,
    expiresAt: NOW_S + 28 * DAY,
    browser: "Chrome on Android",
    methods: ["google"],
    current: false,
  },
];

/** The account page on these routes, with the methods and sessions given. */
function routes(
  view: PortalMethods,
  extra: Record<string, MockRoute> = {},
): Record<string, MockRoute> {
  return signedIn([], {
    "/api/me/methods": view,
    "/api/sessions": { sessions: SESSIONS },
    ...extra,
  });
}

async function methodsRegion(): Promise<HTMLElement> {
  const region = await screen.findByRole("region", { name: "Sign-in methods" });
  await within(region).findByRole("heading", { name: "Accounts" });
  return region;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/#/account");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sign-in methods (PX-13)", () => {
  it("lists accounts, addresses and passkeys, each with when it was used", async () => {
    mockFetch(routes(maraMethods()));
    renderPortal();
    const region = await methodsRegion();
    // Apple is offered (this deploy can connect it); Google and Steam are connected.
    expect(
      within(region).getByRole("button", { name: "Connect Apple" }),
    ).toBeTruthy();
    expect(within(region).getByText("mara.fennick@gmail.com")).toBeTruthy();
    expect(
      within(region).getByRole("button", { name: "Disconnect Steam" }),
    ).toBeTruthy();
    // The primary is said as text; an unused address says so.
    expect(within(region).getByText(/^Primary · added/)).toBeTruthy();
    expect(within(region).getByText(/never used to sign in/)).toBeTruthy();
    // The passkey is named by its provider (AAGUID), with where it came from.
    expect(within(region).getByText("iCloud Keychain")).toBeTruthy();
    expect(within(region).getByText(/added on Safari on macOS/)).toBeTruthy();
    expect(
      within(region).getByRole("button", { name: "Add an email" }),
    ).toBeTruthy();
    expect(
      within(region).getByText(
        `Changing a method asks you to confirm it's you. Every change is recorded and emailed to ${ACCOUNT.email}.`,
      ),
    ).toBeTruthy();
    // No Make primary or Rename until the Worker has them (PX-13's brief).
    expect(
      within(region).queryByRole("button", { name: /Make primary|Rename/ }),
    ).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("refuses to remove the only method: Only method, a disabled Disconnect and why", async () => {
    mockFetch(routes(samMethods()));
    renderPortal();
    const region = await methodsRegion();
    expect(within(region).getByText("Only method")).toBeTruthy();
    const disconnect = within(region).getByRole("button", {
      name: "Disconnect Apple",
    });
    expect(disconnect.getAttribute("aria-disabled")).toBe("true");
    const why =
      "This is your only way to sign in. Connect another one first, then you can remove Apple.";
    expect(within(region).getByText(why)).toBeTruthy();
    expect(
      document.getElementById(disconnect.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toContain(why);
    await userEvent.click(disconnect);
    expect(
      within(region).queryByRole("heading", { name: "Disconnect Apple?" }),
    ).toBeNull();
    expect(
      fetchedRequests().some((r) => r.startsWith("DELETE /api/me/methods")),
    ).toBe(false);
    // The relay is named, and Add a passkey waits for an email with its reason as text.
    expect(within(region).getByText(`${RELAY} · Hide My Email`)).toBeTruthy();
    const addPasskey = within(region).getByRole("button", {
      name: "Add a passkey",
    });
    expect(addPasskey.getAttribute("aria-disabled")).toBe("true");
    expect(
      within(region).getByText(
        "Add an email first: it's how you get back in if a passkey is lost.",
      ),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("shows the Hide My Email notice, whose action opens Add an email", async () => {
    mockFetch(routes(samMethods()));
    renderPortal();
    const region = await methodsRegion();
    expect(
      within(region).getByText(/Hide My Email gave us a private address/),
    ).toBeTruthy();
    await userEvent.click(
      within(region).getByRole("button", { name: "Add your real email" }),
    );
    const field = await within(region).findByRole("textbox", {
      name: "Email address",
    });
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("asks for step-up before it disconnects: an email code, then the removal", async () => {
    let view = maraMethods();
    let fresh = false;
    mockFetch(
      routes(view, {
        "/api/me/methods": () => view,
        "POST /api/signin/email/start": {
          ok: true,
          expiresIn: 600,
          codeLength: 6,
          resendIn: 60,
        },
        "POST /api/signin/email/verify": () => {
          fresh = true;
          view = maraMethods({
            stepUp: {
              authenticatedAt: NOW_S,
              freshUntil: NOW_S + 300,
              fresh: true,
              maxAgeSeconds: 300,
            },
          });
          return { status: "signed_in", next: "/" };
        },
        // The sign-in opened a new session for this browser; the old row is still live.
        "/api/sessions": () => ({
          sessions: fresh
            ? [
                { ...SESSIONS[0]!, id: "sess_after_step_up_03" },
                { ...SESSIONS[0]!, current: false },
                SESSIONS[1]!,
              ]
            : SESSIONS,
        }),
        "DELETE /api/sessions/sess_this_browser_0001": {
          ok: true,
          current: false,
        },
        "DELETE /api/me/methods/lnk_steam": () => {
          if (!fresh)
            return { status: 401, body: { error: "step_up_required" } };
          view = maraMethods();
          view.methods = view.methods.filter((m) => m.id !== "lnk_steam");
          return { ok: true, removed: { id: "lnk_steam", kind: "steam" } };
        },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Disconnect Steam" }),
    );
    const heading = await within(region).findByRole("heading", {
      name: "Disconnect Steam?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      within(region).getByText(
        "You won't sign in with Steam any more. You still have Google, 2 emails and 1 passkey.",
      ),
    ).toBeTruthy();
    expect(
      within(region).getByText(
        `We record the change and email ${ACCOUNT.email}.`,
      ),
    ).toBeTruthy();
    // Not fresh: "Confirm it's you first", and nothing is removed yet. jsdom has no WebAuthn, so
    // the way in is an email code to the account's own address.
    const prompt = within(region).getByRole("group", {
      name: "Confirm it's you first",
    });
    expect(
      within(region).queryByRole("button", { name: "Disconnect Steam" }),
    ).toBeNull();
    expect(fetchedRequests()).not.toContain("DELETE /api/me/methods/lnk_steam");
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(prompt).getByRole("button", {
        name: `Email a code to ${ACCOUNT.email}`,
      }),
    );
    const code = await within(prompt).findByRole("textbox", {
      name: "6-digit code",
    });
    await waitFor(() => expect(document.activeElement).toBe(code));
    await userEvent.type(code, "481920");
    await waitFor(() =>
      expect(fetchedRequests()).toContain("DELETE /api/me/methods/lnk_steam"),
    );
    const order = fetchedRequests();
    // Signed in again first, the session re-read for its new CSRF token, then the change.
    const verifyAt = order.indexOf("POST /api/signin/email/verify");
    const deleteAt = order.indexOf("DELETE /api/me/methods/lnk_steam");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(deleteAt);
    expect(order.slice(verifyAt, deleteAt)).toContain("GET /api/me");
    // The session the sign-in replaced is ended, so this browser is listed once.
    expect(order).toContain("DELETE /api/sessions/sess_this_browser_0001");
    expect(await screen.findByText("Steam was disconnected")).toBeTruthy();
    // Focus goes to the group, never to body, as the row leaves.
    const accounts = within(region).getByRole("heading", { name: "Accounts" });
    await waitFor(() => expect(document.activeElement).toBe(accounts));
    await waitFor(() =>
      expect(
        within(region).queryByRole("button", { name: "Disconnect Steam" }),
      ).toBeNull(),
    );
  });

  it("removes at once with a fresh sign-in, and asks after all when the Worker says it's stale", async () => {
    const view = maraMethods({
      stepUp: {
        authenticatedAt: NOW_S - 30,
        freshUntil: NOW_S + 270,
        fresh: true,
        maxAgeSeconds: 300,
      },
    });
    mockFetch(
      routes(view, {
        "DELETE /api/me/methods/lnk_mail2": {
          status: 401,
          body: { error: "step_up_required" },
        },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Remove mara.f@proton.me" }),
    );
    await within(region).findByRole("heading", {
      name: "Remove mara.f@proton.me?",
    });
    await userEvent.click(
      within(region).getByRole("button", { name: "Remove mara.f@proton.me" }),
    );
    // The Worker checks as the change lands: step-up after all, focused for the person.
    const label = await within(region).findByText("Confirm it's you first");
    await waitFor(() => expect(document.activeElement).toBe(label));
    // Keep it closes the panel and hands focus back to the row's button.
    await userEvent.click(
      within(region).getByRole("button", { name: "Keep it" }),
    );
    const again = await within(region).findByRole("button", {
      name: "Remove mara.f@proton.me",
    });
    await waitFor(() => expect(document.activeElement).toBe(again));
  });

  it("confirms with a passkey, offering only this account's passkeys", async () => {
    let fresh = false;
    const get = vi.fn(async () => ({
      id: "Y3JlZC0x",
      rawId: new Uint8Array([99, 114, 101, 100, 45, 49]).buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
        authenticatorData: new Uint8Array([4, 5, 6]).buffer,
        signature: new Uint8Array([7, 8, 9]).buffer,
        userHandle: new Uint8Array([10, 11]).buffer,
      },
    }));
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get, create: vi.fn() },
    });
    let verified: unknown = null;
    mockFetch(
      routes(maraMethods(), {
        "POST /api/signin/passkey/options": {
          options: { challenge: "Y2hhbGxlbmdl", rpId: "localhost" },
          expiresIn: 300,
        },
        "POST /api/signin/passkey/verify": (init: RequestInit | undefined) => {
          verified = JSON.parse(String(init?.body));
          fresh = true;
          return { status: "signed_in", next: "/" };
        },
        "DELETE /api/me/methods/lnk_google": () =>
          fresh
            ? { ok: true, removed: { id: "lnk_google", kind: "google" } }
            : { status: 401, body: { error: "step_up_required" } },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Disconnect Google" }),
    );
    await userEvent.click(
      await within(region).findByRole("button", {
        name: "Use your passkey to disconnect",
      }),
    );
    await waitFor(() =>
      expect(fetchedRequests()).toContain("DELETE /api/me/methods/lnk_google"),
    );
    const asked = (
      get.mock.calls[0] as unknown as [CredentialRequestOptions]
    )[0].publicKey!;
    expect(asked.allowCredentials).toHaveLength(1);
    expect(
      new Uint8Array(asked.allowCredentials![0]!.id as ArrayBuffer),
    ).toEqual(new Uint8Array([99, 114, 101, 100, 45, 49]));
    expect(verified).toMatchObject({
      response: {
        id: "Y3JlZC0x",
        rawId: "Y3JlZC0x",
        type: "public-key",
        response: { clientDataJSON: "AQID", signature: "BwgJ" },
      },
    });
    expect(await screen.findByText("Google was disconnected")).toBeTruthy();
    Reflect.deleteProperty(navigator, "credentials");
  });

  it("connects a provider through its redirect, after step-up", async () => {
    let fresh = false;
    const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    mockFetch(
      routes(maraMethods(), {
        "POST /api/signin/email/start": { ok: true, expiresIn: 600 },
        "POST /api/signin/email/verify": () => {
          fresh = true;
          return { status: "signed_in" };
        },
        "POST /api/me/methods/apple/start": () =>
          fresh
            ? { redirect: "https://appleid.apple.com/auth?x=1", expiresIn: 600 }
            : { status: 401, body: { error: "step_up_required" } },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Connect Apple" }),
    );
    const prompt = await within(region).findByRole("group", {
      name: "Confirm it's you first",
    });
    await userEvent.click(
      within(prompt).getByRole("button", {
        name: `Email a code to ${ACCOUNT.email}`,
      }),
    );
    await userEvent.type(
      await within(prompt).findByRole("textbox", { name: "6-digit code" }),
      "123456",
    );
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith("https://appleid.apple.com/auth?x=1"),
    );
  });

  it("says what a provider's callback came back with, once", async () => {
    window.history.replaceState(
      null,
      "",
      "/#/account/methods?error=link_conflict&method=google",
    );
    mockFetch(routes(maraMethods()));
    renderPortal();
    const region = await methodsRegion();
    expect(
      await within(region).findByText(
        /That Google account is connected to another Polaris Key account/,
      ),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/account/methods"));
  });

  it("adds an email with a code, after step-up", async () => {
    let fresh = false;
    let view = maraMethods();
    mockFetch(
      routes(view, {
        "/api/me/methods": () => view,
        "POST /api/signin/email/start": { ok: true, expiresIn: 600 },
        "POST /api/signin/email/verify": () => {
          fresh = true;
          return { status: "signed_in" };
        },
        "POST /api/me/methods/email/start": () =>
          fresh
            ? {
                status: "code_sent",
                email: "mara@studio.example",
                expiresIn: 600,
                codeLength: 6,
              }
            : { status: 401, body: { error: "step_up_required" } },
        "POST /api/me/methods/email/verify": () => {
          view = maraMethods();
          return {
            status: "connected",
            already: false,
            email: "mara@studio.example",
          };
        },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Add an email" }),
    );
    const field = await within(region).findByRole("textbox", {
      name: "Email address",
    });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.type(field, "mara@studio.example");
    await userEvent.click(
      within(region).getByRole("button", { name: "Send code" }),
    );
    const prompt = await within(region).findByRole("group", {
      name: "Confirm it's you first",
    });
    await userEvent.click(
      within(prompt).getByRole("button", {
        name: `Email a code to ${ACCOUNT.email}`,
      }),
    );
    await userEvent.type(
      await within(prompt).findByRole("textbox", { name: "6-digit code" }),
      "111111",
    );
    // Confirmed: the address's own code now.
    await within(region).findByText(/We sent a 6-digit code to/);
    const code = within(region).getByRole("textbox", { name: "6-digit code" });
    await waitFor(() => expect(document.activeElement).toBe(code));
    await userEvent.type(code, "222222");
    expect(
      await screen.findByText("mara@studio.example was added"),
    ).toBeTruthy();
    expect(fetchedRequests()).toContain("POST /api/me/methods/email/verify");
    const email = within(region).getByRole("heading", { name: /^Email/ });
    await waitFor(() => expect(document.activeElement).toBe(email));
  });

  it("adds a passkey: the challenge, the browser's prompt, the attestation", async () => {
    const create = vi.fn(async () => ({
      id: "bmV3LWNyZWQ",
      rawId: new Uint8Array([110, 101, 119, 45, 99, 114, 101, 100]).buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        attestationObject: new Uint8Array([2]).buffer,
        getTransports: () => ["internal"],
      },
    }));
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: vi.fn(), create },
    });
    let added: unknown = null;
    mockFetch(
      routes(
        maraMethods({
          stepUp: {
            authenticatedAt: NOW_S,
            freshUntil: NOW_S + 300,
            fresh: true,
            maxAgeSeconds: 300,
          },
        }),
        {
          "POST /api/me/methods/passkey/start": {
            options: {
              challenge: "Y2hhbGxlbmdl",
              rp: { id: "localhost", name: "Polaris Key" },
              user: {
                id: "dXNlcg",
                name: ACCOUNT.email,
                displayName: ACCOUNT.name,
              },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
              excludeCredentials: [{ id: "Y3JlZC0x", type: "public-key" }],
            },
            expiresIn: 300,
          },
          "POST /api/me/passkeys": (init: RequestInit | undefined) => {
            added = JSON.parse(String(init?.body));
            return {
              status: 201,
              body: {
                ok: true,
                passkey: { id: "bmV3LWNyZWQ", methodId: "lnk_new" },
              },
            };
          },
        },
      ),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Add a passkey" }),
    );
    expect(await screen.findByText("Passkey added")).toBeTruthy();
    const asked = (
      create.mock.calls[0] as unknown as [CredentialCreationOptions]
    )[0].publicKey!;
    expect(new Uint8Array(asked.user.id as ArrayBuffer)).toEqual(
      new Uint8Array([117, 115, 101, 114]),
    );
    expect(asked.excludeCredentials).toHaveLength(1);
    expect(added).toMatchObject({
      response: {
        id: "bmV3LWNyZWQ",
        rawId: "bmV3LWNyZWQ",
        response: {
          clientDataJSON: "AQ",
          attestationObject: "Ag",
          transports: ["internal"],
        },
      },
    });
    const passkeys = within(region).getByRole("heading", { name: "Passkeys" });
    await waitFor(() => expect(document.activeElement).toBe(passkeys));
    Reflect.deleteProperty(navigator, "credentials");
  });

  it("guards the only email address with its reason", async () => {
    const view = maraMethods();
    view.emails = [
      { ...view.emails[0]!, canRemove: false, reason: "only_email" },
    ];
    view.methods = view.methods
      .filter((m) => m.id !== "lnk_mail2")
      .map((m) =>
        m.id === "lnk_mail1"
          ? { ...m, canRemove: false, reason: "only_email" }
          : m,
      );
    mockFetch(routes(view));
    renderPortal();
    const region = await methodsRegion();
    const remove = within(region).getByRole("button", {
      name: `Remove ${ACCOUNT.email}`,
    });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(
      within(region).getByText(
        "This is your account's only email address. Add another one first, then you can remove it.",
      ),
    ).toBeTruthy();
  });

  it("falls back to the session's email on a Worker without the methods list", async () => {
    mockFetch(signedIn());
    renderPortal();
    const region = await screen.findByRole("region", {
      name: "Sign-in methods",
    });
    expect(await within(region).findByText(ACCOUNT.email)).toBeTruthy();
    expect(
      within(region).queryByRole("heading", { name: "Accounts" }),
    ).toBeNull();
  });
});

describe("step-up ways and returns (PX-13 review)", () => {
  /** Mara without passkeys: an email and Google (and Steam) to confirm with. */
  function noPasskeys(over: Partial<PortalMethods> = {}): PortalMethods {
    const view = maraMethods(over);
    return {
      ...view,
      methods: view.methods.filter((m) => m.group !== "passkeys"),
      passkeys: [],
    };
  }

  it("with Turnstile on, offers signing in again with a provider, never an email code", async () => {
    mockFetch(
      routes(noPasskeys(), {
        "/api/capabilities": { ...CAPS_ALL, turnstileSiteKey: "0x4AAAAAAA" },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Disconnect Steam" }),
    );
    const prompt = await within(region).findByRole("group", {
      name: "Confirm it's you first",
    });
    const google = within(prompt).getByRole("link", {
      name: "Sign in again with Google",
    });
    // It comes back to finish this removal.
    expect(google.getAttribute("href")).toBe(
      `/login/google?return_to=${encodeURIComponent(
        `${window.location.origin}/#/account/methods?remove=lnk_steam`,
      )}`,
    );
    expect(
      within(prompt).queryByRole("button", { name: /Email a code/ }),
    ).toBeNull();
    expect(fetchedRequests()).not.toContain("POST /api/signin/email/start");
  });

  it("falls back to the providers when the email start fails its security check", async () => {
    mockFetch(
      routes(noPasskeys(), {
        "POST /api/signin/email/start": {
          status: 403,
          body: { error: "turnstile_failed" },
        },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Disconnect Steam" }),
    );
    const prompt = await within(region).findByRole("group", {
      name: "Confirm it's you first",
    });
    await userEvent.click(
      within(prompt).getByRole("button", {
        name: `Email a code to ${ACCOUNT.email}`,
      }),
    );
    expect(
      await within(prompt).findByText(
        "The security check didn't run here. Confirm it's you another way.",
      ),
    ).toBeTruthy();
    expect(
      within(prompt).getByRole("link", { name: "Sign in again with Google" }),
    ).toBeTruthy();
    expect(
      within(prompt).queryByRole("button", { name: /Email a code/ }),
    ).toBeNull();
  });

  it("sends a new code with the resend, not a second start", async () => {
    mockFetch(
      routes(noPasskeys(), {
        "POST /api/signin/email/start": { ok: true, expiresIn: 600 },
        "POST /api/signin/email/resend": { ok: true, expiresIn: 600 },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    await userEvent.click(
      within(region).getByRole("button", { name: "Disconnect Steam" }),
    );
    const prompt = await within(region).findByRole("group", {
      name: "Confirm it's you first",
    });
    await userEvent.click(
      within(prompt).getByRole("button", {
        name: `Email a code to ${ACCOUNT.email}`,
      }),
    );
    await userEvent.click(
      await within(prompt).findByRole("button", { name: "Send a new code" }),
    );
    await waitFor(() =>
      expect(fetchedRequests()).toContain("POST /api/signin/email/resend"),
    );
    expect(
      fetchedRequests().filter((r) => r === "POST /api/signin/email/start"),
    ).toHaveLength(1);
  });

  it("back from a provider's step-up to remove: the panel is open, focused, and waits for a click", async () => {
    window.history.replaceState(
      null,
      "",
      "/#/account/methods?remove=lnk_steam",
    );
    mockFetch(
      routes(
        maraMethods({
          stepUp: {
            authenticatedAt: NOW_S - 10,
            freshUntil: NOW_S + 290,
            fresh: true,
            maxAgeSeconds: 300,
          },
        }),
      ),
    );
    renderPortal();
    const region = await methodsRegion();
    const heading = await within(region).findByRole("heading", {
      name: "Disconnect Steam?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      within(region).getByRole("button", { name: "Disconnect Steam" }),
    ).toBeTruthy();
    expect(
      fetchedRequests().some((r) => r.startsWith("DELETE /api/me/methods")),
    ).toBe(false);
    await waitFor(() => expect(window.location.hash).toBe("#/account/methods"));
  });

  it("back from a provider's step-up to connect: Connect takes focus, the page doesn't leave", async () => {
    window.history.replaceState(null, "", "/#/account/methods?connect=apple");
    const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    mockFetch(routes(maraMethods()));
    renderPortal();
    const region = await methodsRegion();
    const connect = within(region).getByRole("button", {
      name: "Connect Apple",
    });
    await waitFor(() => expect(document.activeElement).toBe(connect));
    await waitFor(() => expect(window.location.hash).toBe("#/account/methods"));
    expect(go).not.toHaveBeenCalled();
  });

  it("a step-up started from Connect or Add an email comes back to it", async () => {
    mockFetch(
      routes(noPasskeys(), {
        "/api/capabilities": { ...CAPS_ALL, turnstileSiteKey: "0x4AAAAAAA" },
        "POST /api/me/methods/apple/start": {
          status: 401,
          body: { error: "step_up_required" },
        },
        "POST /api/me/methods/email/start": {
          status: 401,
          body: { error: "step_up_required" },
        },
      }),
    );
    renderPortal();
    const region = await methodsRegion();
    const back = (target: string) =>
      `/login/google?return_to=${encodeURIComponent(
        `${window.location.origin}/#/account/methods?${target}`,
      )}`;
    await userEvent.click(
      within(region).getByRole("button", { name: "Connect Apple" }),
    );
    let prompt = await within(region).findByRole("group", {
      name: "Confirm it's you first",
    });
    expect(
      within(prompt)
        .getByRole("link", { name: "Sign in again with Google" })
        .getAttribute("href"),
    ).toBe(back("connect=apple"));
    await userEvent.click(
      within(region).getByRole("button", { name: "Cancel" }),
    );
    await userEvent.click(
      within(region).getByRole("button", { name: "Add an email" }),
    );
    await userEvent.type(
      await within(region).findByRole("textbox", { name: "Email address" }),
      "mara@studio.example",
    );
    await userEvent.click(
      within(region).getByRole("button", { name: "Send code" }),
    );
    prompt = await within(region).findByRole("group", {
      name: "Confirm it's you first",
    });
    expect(
      within(prompt)
        .getByRole("link", { name: "Sign in again with Google" })
        .getAttribute("href"),
    ).toBe(back("add=email"));
  });

  it("says a provider is connected only when the list shows it connected", async () => {
    window.history.replaceState(null, "", "/#/account/methods?connected=apple");
    mockFetch(routes(maraMethods()));
    renderPortal();
    await methodsRegion();
    await waitFor(() => expect(window.location.hash).toBe("#/account/methods"));
    expect(screen.queryByText("Apple is connected.")).toBeNull();
    cleanup();
    window.history.replaceState(
      null,
      "",
      "/#/account/methods?connected=google",
    );
    renderPortal();
    expect(await screen.findByText("Google is connected.")).toBeTruthy();
  });
});

describe("Where you're signed in (PX-13 on I-07)", () => {
  it("marks this browser and signs another out, focus to the section", async () => {
    let sessions = SESSIONS;
    mockFetch(
      routes(maraMethods(), {
        "/api/sessions": () => ({ sessions }),
        "DELETE /api/sessions/sess_other_phone_0002": () => {
          sessions = SESSIONS.filter((s) => s.current);
          return { ok: true, current: false };
        },
      }),
    );
    renderPortal();
    const region = await screen.findByRole("region", {
      name: "Where you're signed in",
    });
    await within(region).findByText("This browser");
    expect(
      within(region).getByText("Signed in with a passkey · now"),
    ).toBeTruthy();
    // This browser signs out with the page's own Sign out; the other has its own.
    const buttons = within(region)
      .getAllByRole("button", { name: /^Sign out / })
      .filter((b) => b.textContent !== "Sign out everywhere");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe(
      "Sign out Chrome on Android, Signed in with Google · last active yesterday",
    );
    const nav = screen.getByRole("navigation", { name: "On this page" });
    expect(
      within(nav).getByRole("link", { name: "Where you're signed in" }),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(buttons[0]!);
    expect(
      await screen.findByText("Chrome on Android was signed out"),
    ).toBeTruthy();
    const heading = within(region).getByRole("heading", {
      name: "Where you're signed in",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await waitFor(() =>
      expect(within(region).queryByText("Chrome on Android")).toBeNull(),
    );
  });

  it("signs out everywhere only after it says what that does", async () => {
    let ended = false;
    mockFetch(
      routes(maraMethods(), {
        "/api/me": () =>
          ended ? { status: 401 } : { account: ACCOUNT, csrf: "csrf-token" },
        "POST /api/sessions/sign-out-everywhere": () => {
          ended = true;
          return { ok: true, ended: 2, devices: 1 };
        },
      }),
    );
    renderPortal();
    const region = await screen.findByRole("region", {
      name: "Where you're signed in",
    });
    await userEvent.click(
      await within(region).findByRole("button", {
        name: "Sign out everywhere",
      }),
    );
    const heading = await within(region).findByRole("heading", {
      name: "Sign out everywhere?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      within(region).getByText(
        "This browser and 1 other sign out of Polaris Key.",
      ),
    ).toBeTruthy();
    expect(fetchedRequests()).not.toContain(
      "POST /api/sessions/sign-out-everywhere",
    );
    await userEvent.click(
      within(region).getByRole("button", { name: "Sign out everywhere" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: /Sign in/ }),
    ).toBeTruthy();
    expect(
      await screen.findByText("You're signed out everywhere"),
    ).toBeTruthy();
  });

  it("is left out on a Worker without sessions", async () => {
    mockFetch(signedIn());
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Account" });
    await waitFor(() =>
      expect(fetchedRequests()).toContain("GET /api/sessions"),
    );
    expect(
      screen.queryByRole("region", { name: "Where you're signed in" }),
    ).toBeNull();
  });
});

describe("Sign-in methods model (PX-13)", () => {
  it("names a passkey by its provider, else where it was added, else Passkey", () => {
    expect(passkeyName({ aaguid: ICLOUD, addedFrom: "Safari on macOS" })).toBe(
      "iCloud Keychain",
    );
    expect(
      passkeyName({
        aaguid: "BADA5566-A7AA-401F-BD96-45619A55120D",
        addedFrom: null,
      }),
    ).toBe("1Password");
    expect(
      passkeyName({
        aaguid: "00000000-0000-0000-0000-000000000000",
        addedFrom: "Firefox on Windows",
      }),
    ).toBe("Firefox on Windows");
    expect(passkeyName({ aaguid: null, addedFrom: null })).toBe("Passkey");
    expect(passkeyName({ aaguid: null, addedFrom: "  " })).toBe("Passkey");
    expect(passkeyProvider(ICLOUD)?.glyph).toBe("apple");
  });

  it("says what stays after a removal", () => {
    const view = maraMethods();
    expect(remainingAfter(view.methods, "lnk_steam")).toBe(
      "Google, 2 emails and 1 passkey",
    );
    expect(remainingAfter(view.methods, "lnk_pk")).toBe(
      "Google, Steam and 2 emails",
    );
    expect(remainingAfter(samMethods().methods, "lnk_apple")).toBeNull();
  });

  it("words a session's sign-in and judges step-up freshness with a margin", () => {
    expect(sessionMethodText(["passkey"])).toBe("Signed in with a passkey");
    expect(sessionMethodText(["google", "email"])).toBe(
      "Signed in with Google and an email code",
    );
    expect(sessionMethodText(["mystery"])).toBeNull();
    const stepUp = {
      authenticatedAt: 1000,
      freshUntil: 1300,
      fresh: true,
      maxAgeSeconds: 300,
    };
    expect(stepUpFresh(stepUp, 1200)).toBe(true);
    expect(stepUpFresh(stepUp, 1290)).toBe(false);
    expect(stepUpFresh({ ...stepUp, fresh: false }, 1000)).toBe(false);
    expect(stepUpFresh(undefined, 1000)).toBe(false);
  });
});
