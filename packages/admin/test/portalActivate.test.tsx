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
import { KeyField } from "../src/portal/components/KeyField.js";
import {
  blocksResend,
  checkKey,
  claimVerdict,
  entriesVerdict,
  keyProblem,
  maskKey,
  normaliseKey,
  previewVerdict,
  productLabel,
  readEntries,
  readSignInUrl,
  slugOf,
} from "../src/portal/model/key.js";
import {
  ACCOUNT,
  axeViolations,
  CAPS_ALL,
  detail,
  fetchedRequests,
  libraryFor,
  license,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
const mossgarden = license({
  product: "mossgarden",
  productName: "Mossgarden",
});

describe("license keys (§4.17)", () => {
  it("accepts exactly the minted format, case-sensitive", () => {
    expect(checkKey(KEY)).toEqual({
      kind: "valid",
      slug: "mossgarden",
      secret: "Q7xZr2Lk9vT3mN8pB1cY4w",
    });
    expect(checkKey("pkey_lumen-raw_bN5cW1xP8kQe7Rz2Ha0JvA").kind).toBe(
      "valid",
    );
    expect(checkKey("pkey_x_ab-_CDEFGHIJKLMNOPQRST").kind).toBe("valid");
    expect(checkKey("PKEY_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w").kind).toBe(
      "notKey",
    );
    expect(checkKey("pkey_Mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w").kind).toBe(
      "incomplete",
    );
  });

  it("trims whitespace and newlines and changes nothing else", () => {
    expect(normaliseKey(`  ${KEY}\n`)).toBe(KEY);
    expect(normaliseKey("pkey_a_Bc")).toBe("pkey_a_Bc");
  });

  it("explains a cut-off key with the count", () => {
    const c = checkKey("pkey_mossgarden_Q7xZr2Lk9vT3mN8");
    expect(c).toMatchObject({
      kind: "incomplete",
      slug: "mossgarden",
      length: 15,
      short: true,
    });
    expect(keyProblem(c)).toBe(
      "This key is cut short. After mossgarden_ come 22 characters, and this has 15. Copy the whole key again.",
    );
  });

  it("names a Steam-shaped key", () => {
    expect(keyProblem(checkKey("5XKQ7-B2M9P-HT4LZ"))).toBe(
      "That isn't a Polaris Key license key. Ours start with pkey_. This one looks like a Steam key: activate it in Steam.",
    );
    expect(keyProblem(checkKey("hello"))).toBe(
      "That isn't a Polaris Key license key. Ours start with pkey_.",
    );
  });

  it("stays quiet while the prefix is being typed", () => {
    expect(checkKey("pke").kind).toBe("partial");
  });

  it("reads the product from the prefix and masks to the last 4", () => {
    expect(slugOf("pkey_tidewater_abc")).toBe("tidewater");
    expect(slugOf("pkey_tidewater")).toBeNull();
    expect(maskKey("tidewater", "KQ2w")).toBe("pkey_tidewater_…KQ2w");
    expect(maskKey("tidewater")).toBe("pkey_tidewater_…");
  });
});

describe("key verdicts (UX-05)", () => {
  const PRODUCT = { name: "Mossgarden", developerName: "Little Fern" };

  it("tells cut short, too long, a line break and a wrong character apart", () => {
    expect(keyProblem(checkKey("pkey_mossgarden_Q7xZr2Lk9v"))).toBe(
      "This key is cut short. After mossgarden_ come 22 characters, and this has 10. Copy the whole key again.",
    );
    expect(keyProblem(checkKey(`${KEY}abc`))).toBe(
      "This key is too long. After mossgarden_ come 22 characters, and this has 25. Copy only the key.",
    );
    expect(
      keyProblem(checkKey("pkey_mossgarden_Q7xZr2Lk9v\nT3mN8pB1cY4w")),
    ).toBe(
      "This key has a space or line break in it. Copy the whole key again in one piece.",
    );
    expect(
      keyProblem(checkKey("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4!")),
    ).toMatch(
      /^This key doesn't look right\. After mossgarden_ come exactly 22/,
    );
    // The product so far, no separator yet: cut short. An upper-case product: not cut short.
    expect(keyProblem(checkKey("pkey_mossgarden"))).toMatch(
      /^This key is cut short\./,
    );
    expect(keyProblem(checkKey("pkey_Mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w"))).toBe(
      "This key doesn't look right. After pkey_ comes the product in lowercase, then _ and 22 characters. Copy the whole key again.",
    );
    // Pressing Continue on "pke" explains; while typing, "partial" stays quiet (the caller).
    expect(keyProblem(checkKey("pke"))).toMatch(/^This key is cut short\./);
  });

  it("shows a product by its presentation name, never the slug", () => {
    expect(productLabel("mossgarden")).toBe("Mossgarden");
    expect(productLabel("lumen-raw")).toBe("Lumen Raw");
    expect(productLabel("lumen-raw", "Lumen RAW")).toBe("Lumen RAW");
    expect(productLabel("lumen-raw", " ")).toBe("Lumen Raw");
  });

  it("gives license_owned its sign-in only for an http(s) signInUrl", () => {
    const bare = previewVerdict(
      { verdict: "license_owned", product: PRODUCT },
      "x",
    );
    expect(bare).toEqual({
      code: "license_owned",
      tone: "danger",
      message:
        "This Mossgarden license is already in another Polaris Key account. A license never moves by its key.",
    });
    expect(
      previewVerdict(
        {
          verdict: "license_owned",
          product: PRODUCT,
          signInUrl: "https://key.plrs.im/portal/login?hint=m",
        },
        "x",
      ).signInUrl,
    ).toBe("https://key.plrs.im/portal/login?hint=m");
    expect(readSignInUrl({ signInUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(readSignInUrl({ signInUrl: "/relative" })).toBeUndefined();
    expect(readSignInUrl({ signInUrl: 42 })).toBeUndefined();
    expect(
      claimVerdict(
        {
          status: 403,
          code: "license_owned",
          signInUrl: "https://a.example/s",
        },
        "Mossgarden",
      ),
    ).toMatchObject({
      code: "license_owned",
      signInUrl: "https://a.example/s",
    });
  });

  it("raises the entries notice only once every entry is used, as a warning", () => {
    expect(readEntries({ entries: null })).toBeNull();
    expect(readEntries({ entries: { used: 2, limit: 5 } })).toEqual({
      used: 2,
      limit: 5,
    });
    expect(readEntries({ keyEntries: { used: 5, limit: 5 } })).toEqual({
      used: 5,
      limit: 5,
    });
    expect(readEntries({ entries: { used: "5", limit: 5 } })).toBeNull();
    expect(entriesVerdict({ used: 2, limit: 5 }, "Mossgarden")).toBeNull();
    const notice = entriesVerdict({ used: 5, limit: 5 }, "Ember Tactics");
    expect(notice).toEqual({
      code: "entries",
      tone: "warning",
      message:
        "This key has no entries left in Ember Tactics. Add it to your account and Ember Tactics signs you in instead.",
    });
    expect(blocksResend(notice)).toBe(false);
  });

  it("blocks sending the same key again only for refusals", () => {
    expect(blocksResend(claimVerdict({ status: 401 }, "M"))).toBe(true);
    expect(blocksResend(claimVerdict({ status: 429 }, "M"))).toBe(false);
    expect(blocksResend({ code: "failed", tone: "danger", message: "x" })).toBe(
      false,
    );
    expect(blocksResend(null)).toBe(false);
  });
});

describe("KeyField", () => {
  afterEach(cleanup);
  it("is one labelled, monospace, paste-first control that never re-cases", async () => {
    const onChange = vi.fn();
    render(
      <form>
        <KeyField
          id="k"
          value=""
          onChange={onChange}
          valid={false}
          help="Paste the whole key."
        />
      </form>,
    );
    const field = screen.getByRole("textbox", { name: "License key" });
    expect(field.getAttribute("autocapitalize")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.className).toContain("font-mono");
    expect(screen.getByRole("button", { name: "Paste" })).toBeTruthy();
    fireEvent.paste(field, { clipboardData: { getData: () => `  ${KEY}\n` } });
    expect(onChange).toHaveBeenCalledWith(KEY, "paste");
  });

  it("colours the parts and shows the valid state", () => {
    render(
      <KeyField id="k" value={KEY} onChange={() => undefined} valid help="h" />,
    );
    expect(screen.getByText("mossgarden").className).toContain(
      "text-accent-fg",
    );
    expect(screen.getByText("Key format is valid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Paste" })).toBeNull();
  });
  it("hides the help line once there is a verdict, and marks only danger invalid", () => {
    const { rerender } = render(
      <KeyField
        id="k"
        value="pkey_mossgarden_Q7"
        onChange={() => undefined}
        valid={false}
        help="Starts with pkey_. Case-sensitive."
      />,
    );
    expect(screen.getByText("Starts with pkey_. Case-sensitive.")).toBeTruthy();
    rerender(
      <KeyField
        id="k"
        value="pkey_mossgarden_Q7"
        onChange={() => undefined}
        valid={false}
        verdict={{ tone: "danger", message: "This key is cut short." }}
        help="Starts with pkey_. Case-sensitive."
      />,
    );
    const field = screen.getByRole("textbox", { name: "License key" });
    expect(screen.queryByText("Starts with pkey_. Case-sensitive.")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(
      "This key is cut short.",
    );
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe("k-error");
    rerender(
      <KeyField
        id="k"
        value={KEY}
        onChange={() => undefined}
        valid
        verdict={{
          tone: "warning",
          message: "This key has used all 5 entries.",
          actions: <button type="button">Act</button>,
        }}
        help="Starts with pkey_. Case-sensitive."
      />,
    );
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "This key has used all 5 entries.",
    );
    expect(screen.getByRole("button", { name: "Act" })).toBeTruthy();
    expect(screen.queryByText("Starts with pkey_. Case-sensitive.")).toBeNull();
  });
});

describe("Activate license modal (PX-06)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function routes(claim: unknown = { ok: true, license: mossgarden }) {
    let claimed = false;
    return signedIn([], {
      "/api/licenses": () => ({ licenses: claimed ? [mossgarden] : [] }),
      "/api/library": () => libraryFor(claimed ? [mossgarden] : []),
      "POST /api/claim/license-key": () => {
        claimed = true;
        return claim;
      },
      "/api/licenses/mossgarden/lic_mossgarden": detail(mossgarden),
    });
  }

  async function openFromHeader(): Promise<HTMLElement> {
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate license" }),
    );
    return screen.findByRole("dialog", { name: "Activate a license" });
  }

  it("names the product from the key before any request, then adds it and opens its page", async () => {
    mockFetch(routes());
    renderPortal();
    const dialog = await openFromHeader();
    const field = within(dialog).getByRole("textbox", { name: "License key" });
    const continueBtn = within(dialog).getByRole("button", {
      name: "Continue",
    }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
    fireEvent.paste(field, { clipboardData: { getData: () => KEY } });
    expect(dialog.textContent).toContain("Key for Mossgarden");
    expect(fetchedRequests().some((r) => r.includes("claim"))).toBe(false);
    expect(continueBtn.disabled).toBe(false);
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(continueBtn);
    const done = await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    expect(within(done).getByText("In your library")).toBeTruthy();
    expect(fetchedRequests()).toContain("POST /api/claim/license-key");
    await userEvent.click(
      within(done).getByRole("button", { name: "Open Mossgarden" }),
    );
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Mossgarden",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });

  it("shows the format errors inline, at once for a non-key", async () => {
    mockFetch(routes());
    renderPortal();
    const dialog = await openFromHeader();
    const field = within(dialog).getByRole("textbox", { name: "License key" });
    await userEvent.type(field, "5XKQ7-B2M9P-HT4LZ");
    expect(within(dialog).getByRole("alert").textContent).toMatch(
      /looks like a Steam key/,
    );
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("maps today's refusals to the §4.19 copy, inline", async () => {
    mockFetch(routes({ status: 401, body: { error: "unauthorized" } }));
    renderPortal();
    const dialog = await openFromHeader();
    fireEvent.paste(
      within(dialog).getByRole("textbox", { name: "License key" }),
      {
        clipboardData: { getData: () => KEY },
      },
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Continue" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /We couldn't find that key/,
    );
  });

  it("says when the product manages its licenses elsewhere", async () => {
    mockFetch(routes({ status: 404, body: { error: "not_found" } }));
    renderPortal();
    const dialog = await openFromHeader();
    fireEvent.paste(
      within(dialog).getByRole("textbox", { name: "License key" }),
      {
        clipboardData: { getData: () => KEY },
      },
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Continue" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Mossgarden manages this license elsewhere.",
    );
  });

  const PREVIEW_PRODUCT = {
    slug: "mossgarden",
    name: "Mossgarden",
    developerName: "Little Fern",
    iconUrl: null,
    headerUrl: null,
  };

  async function pasteAndContinue(dialog: HTMLElement): Promise<void> {
    fireEvent.paste(
      within(dialog).getByRole("textbox", { name: "License key" }),
      { clipboardData: { getData: () => KEY } },
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Continue" }),
    );
  }

  it("confirms with the preview (G22) before adding: tier, terms, the key and Change key", async () => {
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "addable",
        product: PREVIEW_PRODUCT,
        entries: null,
        license: {
          tier: "lifetime",
          tierLabel: "Lifetime",
          status: "active",
          usable: true,
          expiresAt: null,
          deviceLimit: 5,
        },
        platforms: ["macos", "windows"],
      },
    });
    renderPortal();
    await pasteAndContinue(await openFromHeader());
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    expect(confirm.textContent).toContain("Key recognized");
    expect(confirm.textContent).toContain("Little Fern");
    expect(confirm.textContent).toContain("Lifetime · up to 5 devices");
    expect(confirm.textContent).toContain(KEY);
    // Nothing is added until the person says so.
    expect(fetchedRequests()).not.toContain("POST /api/claim/license-key");
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Add Mossgarden" }),
    );
    await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    expect(fetchedRequests()).toContain("POST /api/claim/license-key");
  });

  it("Change key goes back to the field with the key kept", async () => {
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "addable",
        product: PREVIEW_PRODUCT,
        entries: null,
      },
    });
    renderPortal();
    await pasteAndContinue(await openFromHeader());
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Change key" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "License key",
        }) as HTMLInputElement
      ).value,
    ).toBe(KEY);
  });

  it("shows the preview's refusals inline in §4.19's words", async () => {
    for (const [answer, copy] of [
      [
        { verdict: "license_owned", product: PREVIEW_PRODUCT },
        "This Mossgarden license is already in another Polaris Key account. A license never moves by its key.",
      ],
      [
        {
          verdict: "email_mismatch",
          product: PREVIEW_PRODUCT,
          maskedEmail: "m•••@proton.me",
        },
        "Mossgarden was bought with m•••@proton.me. It joins only the account with that email verified.",
      ],
      [
        { verdict: "portal_off", product: PREVIEW_PRODUCT },
        "Little Fern manages this license elsewhere.",
      ],
      [{ verdict: "unknown", product: null }, /We couldn't find that key/],
    ] as const) {
      mockFetch({
        ...routes(),
        "POST /api/activate/preview": { entries: null, ...answer },
      });
      renderPortal();
      const dialog = await openFromHeader();
      await pasteAndContinue(dialog);
      const alert = await within(dialog).findByRole("alert");
      if (typeof copy === "string") expect(alert.textContent).toBe(copy);
      else expect(alert.textContent).toMatch(copy);
      expect(fetchedRequests()).not.toContain("POST /api/claim/license-key");
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("focus follows the step: the confirm heading, the done heading, and the field on Change key (UX-79)", async () => {
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "addable",
        product: PREVIEW_PRODUCT,
        entries: null,
      },
    });
    renderPortal();
    await pasteAndContinue(await openFromHeader());
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    const confirmHeading = within(confirm).getByRole("heading", {
      name: "Add Mossgarden to your account?",
    });
    await waitFor(() => expect(document.activeElement).toBe(confirmHeading));
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Change key" }),
    );
    const field = await screen.findByRole("textbox", { name: "License key" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const again = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await userEvent.click(
      within(again).getByRole("button", { name: "Add Mossgarden" }),
    );
    const done = await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    const doneHeading = within(done).getByRole("heading", {
      name: "Mossgarden is in your library",
    });
    await waitFor(() => expect(document.activeElement).toBe(doneHeading));
  });

  it("a refused Continue puts focus on the field, never on body (UX-79)", async () => {
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "unknown",
        product: null,
        entries: null,
      },
    });
    renderPortal();
    const dialog = await openFromHeader();
    await pasteAndContinue(dialog);
    await within(dialog).findByRole("alert");
    const field = within(dialog).getByRole("textbox", { name: "License key" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Continue",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("opens from /activate?key=… as the Library with the key filled in", async () => {
    window.history.replaceState(null, "", `/activate?key=${KEY}`);
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
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
    expect(within(dialog).getByText("Key format is valid")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    // The parameter is consumed: a reload doesn't reopen it.
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Your library",
        hidden: true,
      }),
    ).toBeTruthy();
  });

  it("names the app that sent the key", async () => {
    window.history.replaceState(
      null,
      "",
      `/activate?key=${KEY}&product=mossgarden`,
    );
    mockFetch(routes());
    renderPortal();
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(within(dialog).getByText(/Mossgarden sent you here/)).toBeTruthy();
  });

  it("survives the signed-out round trip: login card first, then the modal", async () => {
    window.history.replaceState(null, "", `/activate?key=${KEY}`);
    let me: unknown = { status: 401 };
    mockFetch({
      ...routes(),
      "/api/me": () => me,
      "/api/capabilities": CAPS_ALL,
      "POST /api/signin/email/start": (init: RequestInit | undefined) => ({
        ok: true,
        echo: init?.body,
      }),
    });
    renderPortal();
    await screen.findByRole("textbox", { name: "Email" });
    await userEvent.type(
      screen.getByRole("textbox", { name: "Email" }),
      ACCOUNT.email,
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Check your email" });
    // The key never leaves the browser: the return URL drops it, and this tab keeps it.
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([u]) => String(u).includes("/api/signin/email/start"))!;
    const body = JSON.parse(String(call[1]!.body)) as { returnTo: string };
    expect(body.returnTo).not.toContain("pkey_");
    expect(window.location.hash).toContain(`activate=${KEY}`);
    me = { account: ACCOUNT, csrf: "c" };
    fireEvent.focus(window);
    const dialog = await screen.findByRole("dialog", {
      name: "Activate a license",
    });
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "License key",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(KEY);
  });

  it("opens from the phone bar's Activate pill", async () => {
    mockFetch(routes());
    renderPortal();
    const bar = await screen.findByRole("navigation", { name: "Phone" });
    await userEvent.click(
      within(bar).getByRole("button", { name: "Activate" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Activate a license" }),
    ).toBeTruthy();
  });

  it("explains a typed cut-short key on Continue and drops the help line (UX-05)", async () => {
    mockFetch(routes());
    renderPortal();
    const dialog = await openFromHeader();
    expect(
      within(dialog).getByText("Starts with pkey_. Case-sensitive."),
    ).toBeTruthy();
    const field = within(dialog).getByRole("textbox", { name: "License key" });
    await userEvent.type(field, "pkey_mossgarden_Q7xZr2Lk9v");
    // Typing stays quiet until the person is done.
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Continue" }),
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "This key is cut short. After mossgarden_ come 22 characters, and this has 10. Copy the whole key again.",
    );
    expect(
      within(dialog).queryByText("Starts with pkey_. Case-sensitive."),
    ).toBeNull();
    expect(fetchedRequests().some((r) => r.includes("preview"))).toBe(false);
    expect(await axeViolations()).toEqual([]);
  });

  it("offers license_owned's way forward: a different key, or that account's sign-in (UX-05)", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "license_owned",
        product: PREVIEW_PRODUCT,
        entries: null,
        signInUrl: "https://key.plrs.im/portal/login?product=mossgarden",
      },
    });
    renderPortal();
    const dialog = await openFromHeader();
    await pasteAndContinue(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "This Mossgarden license is already in another Polaris Key account. A license never moves by its key.",
    );
    // The same key gets the same answer: Continue waits for a new one.
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Continue",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in to that account" }),
    );
    expect(assign).toHaveBeenCalledWith(
      "https://key.plrs.im/portal/login?product=mossgarden",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Use a different key" }),
    );
    const field = within(dialog).getByRole("textbox", { name: "License key" });
    expect((field as HTMLTextAreaElement).value).toBe("");
    expect(document.activeElement).toBe(field);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("offers only Use a different key while the Worker sends no signInUrl", async () => {
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "license_owned",
        product: PREVIEW_PRODUCT,
        entries: null,
      },
    });
    renderPortal();
    const dialog = await openFromHeader();
    await pasteAndContinue(dialog);
    await within(dialog).findByRole("alert");
    expect(
      within(dialog).getByRole("button", { name: "Use a different key" }),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Sign in to that account" }),
    ).toBeNull();
  });

  it("names the product as the preview did once it has answered (UX-05)", async () => {
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "portal_off",
        product: { ...PREVIEW_PRODUCT, name: "Mossgarden: Deluxe" },
        entries: null,
      },
    });
    renderPortal();
    const dialog = await openFromHeader();
    await pasteAndContinue(dialog);
    await within(dialog).findByRole("alert");
    expect(dialog.textContent).toContain("Key for Mossgarden: Deluxe");
    expect(dialog.textContent).not.toContain("Key for mossgarden");
  });

  it("shows the entries notice on the confirm step and keeps Add enabled (Q-5)", async () => {
    mockFetch({
      ...routes(),
      "POST /api/activate/preview": {
        verdict: "addable",
        product: PREVIEW_PRODUCT,
        entries: { used: 5, limit: 5 },
      },
    });
    renderPortal();
    await pasteAndContinue(await openFromHeader());
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    expect(within(confirm).getByRole("status").textContent).toBe(
      "This key has no entries left in Mossgarden. Add it to your account and Mossgarden signs you in instead.",
    );
    const add = within(confirm).getByRole("button", {
      name: "Add Mossgarden",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(await axeViolations()).toEqual([]);
  });
});
