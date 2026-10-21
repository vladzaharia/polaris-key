import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
  type MockRoute,
} from "./portalHarness.js";
import { hashAddress } from "../src/portal/lastMethod.js";

// PX-12 (I-16's browser half): the passkey button, conditional UI in the email field, the
// unknown-credential signal, and the usual-method hint (SIGN-IN.md §3.3–§3.4; THREAT-MODEL G30).

const CAPS = {
  auth: { oidc: false, magic: true, passkey: true, providers: ["steam"] },
  modules: { licensing: true, claim: true, releases: true },
};
const OPTIONS = {
  options: { challenge: "Y2hhbGxlbmdl", rpId: "key.plrs.im", timeout: 60000 },
  expiresIn: 300,
};
const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;

function assertion(): unknown {
  return {
    id: "cred_abc",
    rawId: BYTES,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: BYTES,
      authenticatorData: BYTES,
      signature: BYTES,
      userHandle: null,
    },
  };
}

let get: ReturnType<typeof vi.fn>;
let signal: ReturnType<typeof vi.fn>;

function stubBrowser(opts: { conditional: boolean; signal: boolean }): void {
  get = vi.fn();
  signal = vi.fn(async () => undefined);
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  const pk = window.PublicKeyCredential as unknown as Record<string, unknown>;
  pk.isConditionalMediationAvailable = async () => opts.conditional;
  if (opts.signal) pk.signalUnknownCredential = signal;
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get },
  });
}

function routes(extra: Record<string, MockRoute> = {}): void {
  let me: MockRoute = { status: 401 };
  mockFetch({
    ...signedIn(),
    "/api/me": () => me,
    "/api/capabilities": CAPS,
    "POST /api/signin/passkey/options": OPTIONS,
    "POST /api/signin/passkey/verify": () => {
      me = { account: signedIn()["/api/me"] as never } as MockRoute;
      return { status: "signed_in", next: "/" };
    },
    ...extra,
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.cookie = "pk_last_method=; Max-Age=0; Path=/";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
});

describe("passkey button (modal)", () => {
  it("asks for options, the browser for an assertion, and the Worker to verify it", async () => {
    stubBrowser({ conditional: false, signal: true });
    get.mockResolvedValueOnce(assertion());
    routes();
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in with a passkey" }),
    );
    await waitFor(() =>
      expect(fetchedRequests()).toContain("POST /api/signin/passkey/verify"),
    );
    expect(get).toHaveBeenCalledTimes(1);
    const arg = get.mock.calls[0]![0] as {
      publicKey: PublicKeyCredentialRequestOptions;
      mediation?: string;
    };
    expect(arg.mediation).toBeUndefined();
    expect(arg.publicKey.rpId).toBe("key.plrs.im");
    expect(signal).not.toHaveBeenCalled();
  });

  it("a dismissed prompt says so, once, and the offer stays", async () => {
    stubBrowser({ conditional: false, signal: true });
    get.mockRejectedValueOnce(
      Object.assign(new Error("x"), { name: "NotAllowedError" }),
    );
    routes();
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in with a passkey" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /passkey|cancel/i,
    );
    expect(fetchedRequests()).not.toContain("POST /api/signin/passkey/verify");
    expect(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    ).toBeTruthy();
  });

  it("signals an unknown credential to the browser and shows the one failure line", async () => {
    stubBrowser({ conditional: false, signal: true });
    get.mockResolvedValue(assertion());
    routes({
      "POST /api/signin/passkey/verify": {
        status: 401,
        body: { error: "unauthorized", unknownCredential: true },
      },
    });
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in with a passkey" }),
    );
    await waitFor(() => expect(signal).toHaveBeenCalledTimes(1));
    expect(signal).toHaveBeenCalledWith({
      rpId: "key.plrs.im",
      credentialId: "cred_abc",
    });
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
  });

  it("every other refusal is the same line and signals nothing", async () => {
    stubBrowser({ conditional: false, signal: true });
    get.mockResolvedValue(assertion());
    routes({
      "POST /api/signin/passkey/verify": {
        status: 401,
        body: { error: "unauthorized" },
      },
    });
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in with a passkey" }),
    );
    await screen.findByRole("alert");
    expect(signal).not.toHaveBeenCalled();
  });

  it("without the Signal API, an unknown credential is still just a refusal", async () => {
    stubBrowser({ conditional: false, signal: false });
    get.mockResolvedValue(assertion());
    routes({
      "POST /api/signin/passkey/verify": {
        status: 401,
        body: { error: "unauthorized", unknownCredential: true },
      },
    });
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in with a passkey" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("is not offered when the Worker does not name passkeys", async () => {
    stubBrowser({ conditional: false, signal: true });
    routes({
      "/api/capabilities": { ...CAPS, auth: { ...CAPS.auth, passkey: false } },
    });
    renderPortal();
    await screen.findByRole("textbox", { name: "Email" });
    expect(
      screen.queryByRole("button", { name: "Sign in with a passkey" }),
    ).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("conditional UI in the email field", () => {
  it("starts a conditional get (autofill) with an abort signal, without a prompt", async () => {
    stubBrowser({ conditional: true, signal: true });
    get.mockReturnValue(new Promise(() => undefined));
    routes();
    renderPortal();
    const field = await screen.findByRole("textbox", { name: "Email" });
    expect(field.getAttribute("autocomplete")).toBe("username webauthn");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const arg = get.mock.calls[0]![0] as {
      mediation?: string;
      signal?: AbortSignal;
    };
    expect(arg.mediation).toBe("conditional");
    expect(arg.signal?.aborted).toBe(false);
    expect(await axeViolations()).toEqual([]);
  });

  it("stops the offer when the card leaves the methods step", async () => {
    stubBrowser({ conditional: true, signal: true });
    get.mockReturnValue(new Promise(() => undefined));
    routes();
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    const ctl = (get.mock.calls[0]![0] as { signal: AbortSignal }).signal;
    await userEvent.click(
      await screen.findByRole("button", { name: /license key/i }),
    );
    await waitFor(() => expect(ctl.aborted).toBe(true));
  });

  it("a browser without conditional mediation never starts one", async () => {
    stubBrowser({ conditional: false, signal: true });
    routes();
    renderPortal();
    await screen.findByRole("textbox", { name: "Email" });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the usual method (HintStep; no server lookup)", () => {
  async function remember(email: string, kind: string): Promise<void> {
    const h = await hashAddress(email);
    document.cookie = `pk_last_method=${kind}.${h}.${Math.floor(Date.now() / 1000) - 86400 * 3}; Path=/`;
  }

  it("offers the provider this browser used for that address, first, with the other ways under it", async () => {
    stubBrowser({ conditional: false, signal: true });
    await remember("mara@fennick.studio", "steam");
    routes();
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("You usually sign in with Steam"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Continue with Steam/ })
        .getAttribute("href"),
    ).toMatch(/^\/login\/steam\?return_to=/);
    // Nothing was started by looking the address up.
    expect(fetchedRequests().some((r) => r.includes("/email/start"))).toBe(
      false,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it("another address gets the normal start, as an unknown one does", async () => {
    stubBrowser({ conditional: false, signal: true });
    await remember("mara@fennick.studio", "steam");
    routes({ "POST /api/signin/email/start": { ok: true, resendIn: 60 } });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "someone@else.example",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    expect(fetchedRequests()).toContain("POST /api/signin/email/start");
  });

  it("a method the card no longer offers is not a hint", async () => {
    stubBrowser({ conditional: false, signal: true });
    await remember("mara@fennick.studio", "apple");
    routes({ "POST /api/signin/email/start": { ok: true, resendIn: 60 } });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "mara@fennick.studio",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
  });
});
