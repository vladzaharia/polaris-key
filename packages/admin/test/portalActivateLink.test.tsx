import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PortalProduct } from "../src/portal/api.js";
import { browser } from "../src/portal/browser.js";
import {
  ConfirmStep,
  type ConfirmPreview,
} from "../src/portal/components/ActivateDialog.js";
import {
  ACCOUNT,
  axeViolations,
  CAPS_ALL,
  DAY,
  detail,
  fetchedRequests,
  libraryFor,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
  type MockRoute,
} from "./portalHarness.js";

/**
 * PX-17: the Activate license confirm step and the deep link from apps (PORTAL.md §4.17–§4.19),
 * every §4.19 error state, and the link's `product=`, `next=free-device` and `return=`
 * (plans/PX-W8.md Q3; plans/I-04.md owner decision 2026-10-05). The key never leaves `#/?activate=`
 * for a URL or a request.
 */

const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
const mossgarden = license({
  product: "mossgarden",
  productName: "Mossgarden",
});
const PRODUCT = {
  slug: "mossgarden",
  name: "Mossgarden",
  developerName: "Little Fern",
  iconUrl: null,
  headerUrl: null,
};
const TERMS = {
  tier: "lifetime",
  tierLabel: "Lifetime",
  status: "active",
  usable: true,
  expiresAt: null,
  deviceLimit: 2,
};
const ADDABLE = {
  verdict: "addable",
  product: PRODUCT,
  entries: null,
  license: TERMS,
  platforms: ["macos"],
};

/** Mossgarden in full (`GET /api/products/mossgarden`): on 2 of 2 devices, `mossgarden://` declared. */
function mossgardenProduct(): PortalProduct {
  const seen = (id: string, label: string, days: number) => ({
    deviceId: id,
    label,
    platform: "windows",
    arch: "x86_64",
    appVersion: "1.0.0",
    firstSeen: NOW_S - 90 * DAY,
    lastSeen: NOW_S - days * DAY,
    dormant: false,
  });
  return {
    product: "mossgarden",
    name: "Mossgarden",
    developerName: "Little Fern",
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: { url: null, email: null },
    services: { license: true },
    status: "device_limit",
    addedAt: NOW_S - DAY,
    returnTo: {
      origins: ["https://mossgarden.example"],
      schemes: ["mossgarden"],
    },
    licenses: [
      {
        id: mossgarden.id,
        tier: null,
        status: "device_limit",
        licenseStatus: "active",
        activatedAt: NOW_S - DAY,
        expiresAt: null,
        maxOfflineDays: null,
        deviceLimit: 2,
        activeSeatCount: 2,
        deviceCount: 2,
        dormantCount: 0,
        entitlements: [],
        devices: [seen("desk", "Desk PC", 1), seen("work", "Work laptop", 41)],
      },
    ],
  } as unknown as PortalProduct;
}

function routes(
  preview: MockRoute = ADDABLE,
  claim: { status?: number; body?: unknown } | object = {
    ok: true,
    license: mossgarden,
  },
): Record<string, MockRoute> {
  let claimed = false;
  return signedIn([], {
    "/api/licenses": () => ({ licenses: claimed ? [mossgarden] : [] }),
    "/api/library": () => libraryFor(claimed ? [mossgarden] : []),
    "POST /api/activate/preview": preview,
    "POST /api/claim/license-key": () => {
      if (!("status" in claim)) claimed = true;
      return claim as MockRoute;
    },
    "/api/licenses/mossgarden/lic_mossgarden": detail(mossgarden),
    "/api/products/mossgarden": () => mossgardenProduct(),
  });
}

async function openFromHeader(): Promise<HTMLElement> {
  await userEvent.click(
    await screen.findByRole("button", { name: "Activate license" }),
  );
  return screen.findByRole("dialog", { name: "Activate a license" });
}

async function pasteAndContinue(
  dialog: HTMLElement,
  key: string = KEY,
): Promise<void> {
  fireEvent.paste(
    within(dialog).getByRole("textbox", { name: "License key" }),
    { clipboardData: { getData: () => key } },
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Continue" }),
  );
}

function continueButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole("button", {
    name: "Continue",
  }) as HTMLButtonElement;
}

/** Nothing the page asked for, and nothing in the address bar, holds a license key. */
function expectKeyNowhere(): void {
  expect(window.location.href).not.toContain("pkey_");
  expect(fetchedRequests().filter((r) => r.includes("pkey_"))).toEqual([]);
}

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("§4.19 Activate license errors: every case, inline, never a toast", () => {
  it("Not a license key: at once, before any request, with the Steam line only for a Steam-shaped key", async () => {
    mockFetch(routes());
    renderPortal();
    for (const [typed, copy] of [
      [
        "5XKQ7-B2M9P-HT4LZ",
        "That isn't a Polaris Key license key. Ours start with pkey_. This one looks like a Steam key: activate it in Steam.",
      ],
      [
        "ABCD-1234",
        "That isn't a Polaris Key license key. Ours start with pkey_.",
      ],
    ] as const) {
      const dialog = await openFromHeader();
      const field = within(dialog).getByRole("textbox", {
        name: "License key",
      });
      await userEvent.type(field, typed);
      expect(within(dialog).getByRole("alert").textContent).toBe(copy);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(await axeViolations()).toEqual([]);
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Cancel" }),
      );
    }
    expect(fetchedRequests().some((r) => r.startsWith("POST"))).toBe(false);
  });

  it("Incomplete key: the count after the product's prefix, before any request", async () => {
    mockFetch(routes());
    renderPortal();
    const dialog = await openFromHeader();
    fireEvent.paste(
      within(dialog).getByRole("textbox", { name: "License key" }),
      { clipboardData: { getData: () => "pkey_mossgarden_Q7xZr2Lk9vT3mN8" } },
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "This key is cut short. After mossgarden_ come 22 characters, and this has 15. Copy the whole key again.",
    );
    // The product is named from the prefix alone.
    expect(dialog.textContent).toContain("Key for Mossgarden");
    await userEvent.click(continueButton(dialog));
    expect(fetchedRequests().some((r) => r.includes("preview"))).toBe(false);
  });

  // The preview's typed refusals (G22): inline under the field, Continue held until the key
  // changes, nothing added.
  it.each([
    [
      "Unknown key",
      { verdict: "unknown", product: null, entries: null },
      "We couldn't find that key. Capital letters matter, and l, 1, O and 0 are easy to mix up, so paste the key instead of typing it.",
      [] as string[],
    ],
    [
      "Owned by another account",
      { verdict: "license_owned", product: PRODUCT, entries: null },
      "This Mossgarden license is already in another Polaris Key account. A license never moves by its key.",
      ["Use a different key"],
    ],
    [
      "Verified-email mismatch",
      {
        verdict: "email_mismatch",
        product: PRODUCT,
        entries: null,
        maskedEmail: "m•••@proton.me",
      },
      "Mossgarden was bought with m•••@proton.me. It joins only the account with that email verified.",
      ["Use a different key"],
    ],
    [
      "Product portal off",
      { verdict: "portal_off", product: PRODUCT, entries: null },
      "Little Fern manages this license elsewhere.",
      [] as string[],
    ],
  ])("%s", async (_case, answer, copy, actions) => {
    mockFetch(routes(answer));
    renderPortal();
    const dialog = await openFromHeader();
    await pasteAndContinue(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(copy);
    expect(
      within(dialog)
        .getByRole("textbox", { name: "License key" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(continueButton(dialog).disabled).toBe(true);
    for (const name of actions)
      expect(within(dialog).getByRole("button", { name })).toBeTruthy();
    expect(fetchedRequests()).not.toContain("POST /api/claim/license-key");
    expect(await axeViolations()).toEqual([]);
    // Use a different key clears the field and gives Continue back.
    if (actions.includes("Use a different key")) {
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Use a different key" }),
      );
      const field = within(dialog).getByRole("textbox", {
        name: "License key",
      });
      expect((field as HTMLTextAreaElement).value).toBe("");
      expect(document.activeElement).toBe(field);
      expect(within(dialog).queryByRole("alert")).toBeNull();
    }
  });

  it("No key entries left: a warning on the confirm step that never blocks (Q-5), and the add goes through", async () => {
    mockFetch(routes({ ...ADDABLE, entries: { used: 5, limit: 5 } }));
    renderPortal();
    await pasteAndContinue(await openFromHeader());
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    const notice = within(confirm).getByRole("status");
    expect(notice.textContent).toBe(
      "This key has no entries left in Mossgarden. Add it to your account and Mossgarden signs you in instead.",
    );
    expect(within(confirm).queryByRole("alert")).toBeNull();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Add Mossgarden" }),
    );
    await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    expect(fetchedRequests()).toContain("POST /api/claim/license-key");
  });

  it("Already yours: Done says so and opens it, with nothing added", async () => {
    mockFetch(
      routes({
        ...ADDABLE,
        verdict: "already_yours",
        license: { id: mossgarden.id, ...TERMS },
      }),
    );
    renderPortal();
    await pasteAndContinue(await openFromHeader());
    const done = await screen.findByRole("dialog", {
      name: "Mossgarden is already in your library",
    });
    expect(done.textContent).toContain(
      "This key's license was already linked to your account, so nothing changed.",
    );
    expect(
      within(done).getByRole("button", { name: "Open Mossgarden" }),
    ).toBeTruthy();
    expect(fetchedRequests()).not.toContain("POST /api/claim/license-key");
    expect(await axeViolations()).toEqual([]);
  });

  // A Worker without the preview (404) adds directly; the claim's own refusals say the same
  // things in the same place.
  it.each([
    [
      { status: 401, body: { error: "unauthorized" } },
      /We couldn't find that key/,
    ],
    [
      { status: 403, body: { error: "license_owned" } },
      /already in another Polaris Key account/,
    ],
    [
      { status: 403, body: { error: "email_mismatch" } },
      /joins only the account with the license's email verified/,
    ],
    [
      { status: 404, body: { error: "not_found" } },
      /manages this license elsewhere/,
    ],
    [{ status: 429, body: { error: "rate_limited" } }, /Too many tries/],
  ])("the claim's refusal %j", async (claim, copy) => {
    mockFetch(routes({ status: 404, body: { error: "not_found" } }, claim));
    renderPortal();
    const dialog = await openFromHeader();
    await pasteAndContinue(dialog);
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      copy,
    );
  });
});

describe("§4.18 the deep link from an app (PX-17)", () => {
  it("names the app and its key-entry refusal (signin.key.noEntries), the key filled in from the fragment", async () => {
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden#key=${KEY}`,
    );
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(dialog.textContent).toContain(
      "Mossgarden sent you here. This key has no entries left in Mossgarden. Add it to your account and Mossgarden signs you in instead.",
    );
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "License key",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(KEY);
    expect(
      within(dialog).getByText(
        "Filled in from your link. Check it matches the key you have.",
      ),
    ).toBeTruthy();
    // A warning, never a block: Continue is there to press.
    expect(continueButton(dialog).disabled).toBe(false);
    // One h1 on the screen: the Library's, under the dialog (§9).
    expect(
      screen.getAllByRole("heading", { level: 1, hidden: true }),
    ).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expectKeyNowhere();
  });

  it("without a key (the Worker never puts one in the link), opens empty with the notice", async () => {
    window.history.replaceState(null, "", "/activate?product=mossgarden");
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(dialog.textContent).toContain("Mossgarden sent you here.");
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "License key",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(
      within(dialog).getByText("Starts with pkey_. Case-sensitive."),
    ).toBeTruthy();
  });

  it("next=free-device: after the add, straight to the free-device flow for that license, with for= and return=", async () => {
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden&next=free-device&for=macOS+arm64&return=mossgarden%3A%2F%2Fretry#key=${KEY}`,
    );
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(dialog.textContent).toContain(
      "Mossgarden sent you here. This license is on every device it allows. Add it to your account, then free one up for macOS arm64.",
    );
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(continueButton(dialog));
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Add Mossgarden" }),
    );
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Your license is on 2 of 2 devices",
    });
    const params = new URLSearchParams(window.location.hash.split("?")[1]);
    expect(window.location.hash.split("?")[0]).toBe(
      "#/p/mossgarden/free-device",
    );
    expect(params.get("license")).toBe("lic_mossgarden");
    expect(params.get("for")).toBe("macOS arm64");
    expect(params.get("return")).toBe("mossgarden://retry");
    expect(screen.getByText(/macOS arm64/)).toBeTruthy();
    // The declared return is the flow's way back (PX-10's rule).
    expect(
      screen
        .getAllByRole("link", { name: "Back to Mossgarden" })[0]!
        .getAttribute("href"),
    ).toBe("mossgarden://retry");
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchedRequests()).toContain("POST /api/claim/license-key");
    expectKeyNowhere();
  });

  it("next=free-device with a key already in the library: no add, straight to its free-device flow", async () => {
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden&next=free-device#key=${KEY}`,
    );
    mockFetch(
      routes({
        ...ADDABLE,
        verdict: "already_yours",
        license: { id: mossgarden.id, ...TERMS },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    await userEvent.click(continueButton(dialog));
    await screen.findByRole("heading", {
      level: 1,
      name: "Your license is on 2 of 2 devices",
    });
    expect(window.location.hash).toBe(
      "#/p/mossgarden/free-device?license=lic_mossgarden",
    );
    expect(fetchedRequests()).not.toContain("POST /api/claim/license-key");
  });

  it("return= to the login card: after the add, back to the card, whose chooser now lists the license (I-04)", async () => {
    const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden&return=${encodeURIComponent("/signin?request=rq_0123456789abcdef")}#key=${KEY}`,
    );
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(dialog.textContent).toContain(
      "Signing in to Mossgarden. Add your key here, then you go back to signing in.",
    );
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(continueButton(dialog));
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    expect(go).not.toHaveBeenCalled();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Add Mossgarden" }),
    );
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith("/signin?request=rq_0123456789abcdef"),
    );
    expect(fetchedRequests()).toContain("POST /api/claim/license-key");
    expect(String(go.mock.calls[0]![0])).not.toContain("pkey_");
  });

  it.each([
    ["another origin", "https://evil.example/signin?request=rq_1"],
    ["another page here", "/download/tok_attacker"],
  ])("never follows a return= to %s", async (_, target) => {
    const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden&return=${encodeURIComponent(target)}#key=${KEY}`,
    );
    mockFetch(routes());
    renderPortal();
    await userEvent.click(
      continueButton(
        await screen.findByRole("dialog", { name: "Activate a license" }),
      ),
    );
    await userEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: "Add Mossgarden to your account?",
        }),
      ).getByRole("button", { name: "Add Mossgarden" }),
    );
    const done = await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    expect(
      within(done).getByRole("button", { name: "Open Mossgarden" }),
    ).toBeTruthy();
    expect(within(done).queryByRole("link", { name: /Back to/ })).toBeNull();
    expect(go).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  it("return= the product declares: Done goes back to the app", async () => {
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden&return=mossgarden%3A%2F%2Fsigned-in#key=${KEY}`,
    );
    mockFetch(routes());
    renderPortal();
    await userEvent.click(
      continueButton(
        await screen.findByRole("dialog", { name: "Activate a license" }),
      ),
    );
    await userEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: "Add Mossgarden to your account?",
        }),
      ).getByRole("button", { name: "Add Mossgarden" }),
    );
    const done = await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    const back = await within(done).findByRole("link", {
      name: "Back to Mossgarden",
    });
    expect(back.getAttribute("href")).toBe("mossgarden://signed-in");
    expect(done.textContent).toContain(
      "Go back to Mossgarden and sign in. You won't need the key again.",
    );
    expect(
      within(done).getByRole("button", { name: "See it in your library" }),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("signed out with a keyless link: the login card with the product, then back to the modal and its notice", async () => {
    window.history.replaceState(
      null,
      "",
      "/activate?product=mossgarden&next=free-device",
    );
    let me: unknown = { status: 401 };
    mockFetch({
      ...routes(),
      "/api/me": () => me,
      "/api/capabilities": CAPS_ALL,
      "POST /api/signin/email/start": { ok: true },
    });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      ACCOUNT.email,
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Check your email" });
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([u]) => String(u).includes("/api/signin/email/start"))!;
    const { returnTo } = JSON.parse(String(call[1]!.body)) as {
      returnTo: string;
    };
    // The return URL keeps the modal's place and what the link carried.
    const back = new URLSearchParams(new URL(returnTo).hash.split("?")[1]);
    expect(back.get("activate")).toBe("");
    expect(back.get("product")).toBe("mossgarden");
    expect(back.get("next")).toBe("free-device");
    me = { account: ACCOUNT, csrf: "c" };
    fireEvent.focus(window);
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(dialog.textContent).toContain("Mossgarden sent you here.");
  });
});

describe("a #/?activate= hash written by hand (review fix)", () => {
  const ENCODED = KEY.replaceAll("_", "%5F");

  it("goes through the link's sanitiser: a key-bearing for= or return= is dropped, the rest kept", async () => {
    window.history.replaceState(
      null,
      "",
      `/#/?activate=${KEY}&product=mossgarden&next=free-device&for=${encodeURIComponent(ENCODED)}&return=${encodeURIComponent(`mossgarden://x?k=${KEY}`)}`,
    );
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(dialog.textContent).toContain(
      "Add it to your account, then free one up.",
    );
    expect(dialog.textContent).not.toContain("%5F");
    await userEvent.click(continueButton(dialog));
    await userEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: "Add Mossgarden to your account?",
        }),
      ).getByRole("button", { name: "Add Mossgarden" }),
    );
    await screen.findByRole("heading", {
      level: 1,
      name: "Your license is on 2 of 2 devices",
    });
    expect(window.location.hash).toBe(
      "#/p/mossgarden/free-device?license=lic_mossgarden",
    );
    expectKeyNowhere();
  });

  it("signed out, every sign-in's return URL drops a key however the hash carries it", async () => {
    window.history.replaceState(
      null,
      "",
      `/?x=${ENCODED}#/?activate=${KEY}&product=mossgarden&for=${encodeURIComponent(ENCODED)}&return=${encodeURIComponent(`/signin?k=${KEY}`)}&q=fern`,
    );
    mockFetch({
      ...routes(),
      "/api/me": { status: 401 },
      "/api/capabilities": CAPS_ALL,
      "POST /api/signin/email/start": { ok: true },
    });
    renderPortal();
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      ACCOUNT.email,
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Check your email" });
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([u]) => String(u).includes("/api/signin/email/start"))!;
    const { returnTo } = JSON.parse(String(call[1]!.body)) as {
      returnTo: string;
    };
    let decoded = returnTo;
    for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
    expect(decoded).not.toContain("pkey_");
    const back = new URLSearchParams(new URL(returnTo).hash.split("?")[1]);
    expect(back.get("activate")).toBe("");
    expect(back.get("product")).toBe("mossgarden");
    expect(back.get("q")).toBe("fern");
    expect(back.has("for")).toBe(false);
    expect(back.has("return")).toBe(false);
    expect(new URL(returnTo).search).toBe("");
  });
});

describe("the link notice is part of the dialog's description (review fix)", () => {
  it("a screen reader hears '<Product> sent you here.' with the dialog, and long words wrap", async () => {
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden&next=free-device&for=${"W".repeat(64)}#key=${KEY}`,
    );
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    const ids = (dialog.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    const described = ids.map((id) => document.getElementById(id)?.textContent);
    expect(described[0]).toBe(
      "The product stays in your library even if you lose the key.",
    );
    expect(described[1]).toMatch(/^Mossgarden sent you here\. /);
    expect(document.getElementById(ids[1]!)!.className).toContain(
      "[overflow-wrap:anywhere]",
    );
    expect(await axeViolations()).toEqual([]);
  });

  it("without a notice, the dialog keeps its one description", async () => {
    mockFetch(routes());
    renderPortal();
    const dialog = await openFromHeader();
    const ids = (dialog.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0]!)?.textContent).toBe(
      "The product stays in your library even if you lose the key.",
    );
  });
});

describe("the key across a navigating sign-in (carriedKey.ts)", () => {
  it("the return URL keeps an empty activate= and the link's context; the stashed key goes back into it", async () => {
    const { returnUrl, stashCarriedKey, restoreCarriedKey } =
      await import("../src/portal/carriedKey.js");
    window.history.replaceState(
      null,
      "",
      `/#/?activate=${KEY}&product=mossgarden&next=free-device`,
    );
    const back = returnUrl();
    expect(back).not.toContain("pkey_");
    expect(
      back.endsWith("#/?activate=&product=mossgarden&next=free-device"),
    ).toBe(true);
    stashCarriedKey();
    // Back from the provider at the return URL.
    window.history.replaceState(
      null,
      "",
      new URL(back).pathname + new URL(back).hash,
    );
    restoreCarriedKey();
    const params = new URLSearchParams(window.location.hash.split("?")[1]);
    expect(params.get("activate")).toBe(KEY);
    expect(params.get("product")).toBe("mossgarden");
    // A key already in the hash is never replaced.
    window.sessionStorage.setItem(
      "pk-portal-carried-key",
      "pkey_other_AAAAAAAAAAAAAAAAAAAAAA",
    );
    restoreCarriedKey();
    expect(
      new URLSearchParams(window.location.hash.split("?")[1]).get("activate"),
    ).toBe(KEY);
  });
});

describe("the confirm step in the login card (SIGN-IN.md §3.9)", () => {
  afterEach(cleanup);
  it("takes the passthrough primary and PX-23's notes", async () => {
    const onAdd = vi.fn();
    render(
      <div role="dialog" aria-label="Add Mossgarden to your account">
        <ConfirmStep
          preview={{ ...(ADDABLE as unknown as ConfirmPreview) }}
          licenseKey={KEY}
          adding={false}
          onBack={() => undefined}
          onAdd={onAdd}
          primaryLabel="Add and use on this device"
          notes={<p>It's on 2 devices already.</p>}
        />
      </div>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add and use on this device" }),
    );
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Add Mossgarden" })).toBeNull();
    expect(screen.getByText("It's on 2 devices already.")).toBeTruthy();
    expect(screen.getByText("Lifetime · up to 2 devices")).toBeTruthy();
  });
});
