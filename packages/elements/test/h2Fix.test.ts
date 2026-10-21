// @pkey-feature ui.signin ui.activate ui.settings ui.kit
//
// Bug package H2 (v0.9.15): the no-browser hand-off has a heading, CloudSyncStatus offers Review
// only when the host handles it and says a signed-out error once and neutrally, a refused key of
// a well-formed license is a neutral callout, the sign-in code is spelled out for a screen reader,
// the Welcome byline sits under the title, and the "system" scheme follows the host page.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/index.js";
import type { PkElement } from "../src/index.js";
import type { UiInput } from "@polaris-key/ui-core";
import { spellOut, watchGround } from "../src/contract.js";
import { stylesCss } from "../src/styles.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => document.body.replaceChildren());

const BASE: UiInput = {
  elapsedMs: 60_000,
  services: ["license", "sync", "identity"],
  presentation: {
    name: "Tidewater Studio",
    developerName: "Harbor Audio",
    icon: false,
  },
  bundle: { slug: "tidewater", name: "Tidewater Studio" },
  platform: { os: "web", formFactor: "computer" },
  registration: "requires-license",
  capabilities: { signIn: true, keyEntry: true, deviceCode: true },
};

async function draw(tag: string, input: UiInput): Promise<PkElement> {
  const el = document.createElement(tag) as PkElement;
  el.input = { ...BASE, ...input };
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}
const q = (el: PkElement, sel: string) => el.shadowRoot!.querySelector(sel);

describe("the no-browser hand-off", () => {
  it("draws its first line as the heading", async () => {
    const el = await draw("pk-sign-in-handoff", {
      signIn: {
        presentation: "inline",
        replace: "inline",
        channel: "browser",
        outcome: "pending",
        browserOpened: false,
      },
    });
    expect(q(el, 'h1[data-key="signin.handoff.noBrowser"]')).not.toBeNull();
  });
});

describe("CloudSyncStatus", () => {
  it("draws Review only when the host handles the conflict", async () => {
    const plain = await draw("pk-cloud-sync-status", {
      cloudSync: { state: "conflict" },
    });
    expect(q(plain, '[data-key="common.review"]')).toBeNull();
    const handled = await draw("pk-cloud-sync-status", {
      cloudSync: { state: "conflict", canReview: true },
    });
    expect(q(handled, 'button[data-key="common.review"]')).not.toBeNull();
  });

  it("says a signed-out error once, with Sign in to sync, in a neutral status", async () => {
    const el = await draw("pk-cloud-sync-status", {
      cloudSync: { state: "error", signedIn: false },
    });
    expect(q(el, '[data-key="cloudSync.signedOut"]')).not.toBeNull();
    expect(q(el, '[data-key="cloudSync.error"]')).toBeNull();
    expect(q(el, 'button[data-key="cloudSync.signIn"]')).not.toBeNull();
    expect(q(el, '[data-part="status"]')?.getAttribute("data-status")).toBe(
      "neutral",
    );
  });
});

describe("Activate's refusal tone", () => {
  it("is a neutral callout for a refused, well-formed key", async () => {
    const el = await draw("pk-activate", {
      keyField: {
        text: "pkey_tidewater_AbCdEfGhIjKlMnOpQrStUv",
        submitted: true,
      },
      activation: { result: "license-disabled" },
    });
    expect(q(el, ".callout")?.getAttribute("data-tone")).toBe("neutral");
    expect(q(el, "input#pk-key")?.getAttribute("aria-invalid")).toBe("false");
  });
});

describe("the sign-in code", () => {
  it("is spelled out for a screen reader and drawn as served", async () => {
    expect(spellOut("WDJB-MJHT")).toBe("W D J B - M J H T");
    const el = await draw("pk-sign-in-handoff", {
      signIn: {
        presentation: "inline",
        replace: "inline",
        channel: "device-code",
        browserOpened: false,
      },
      deviceCode: {
        phase: "waiting",
        userCode: "WDJB-MJHT",
        secondsLeft: 598,
        verificationUri: "https://polaris.locker/device",
      },
    } as UiInput);
    const code = q(el, '[data-key="a11y.code"]');
    expect(code?.getAttribute("aria-label")).toContain("W D J B - M J H T");
    expect(code?.textContent?.trim()).toBe("WDJB-MJHT");
  });
});

describe("the Welcome byline", () => {
  it("sits under the title, not in the header", async () => {
    const el = await draw("pk-welcome", {});
    const by = q(el, '[data-key="common.byDeveloper"]');
    expect(by).not.toBeNull();
    expect(q(el, '[data-part="developer"]')?.closest(".identity")).toBeNull();
  });
});

describe("the host page's ground", () => {
  it("is watched for a class or style change on the root and body", async () => {
    let calls = 0;
    const stop = watchGround(() => calls++);
    document.body.classList.add("dark");
    await new Promise((r) => setTimeout(r));
    expect(calls).toBeGreaterThan(0);
    stop();
    const before = calls;
    document.body.classList.remove("dark");
    await new Promise((r) => setTimeout(r));
    expect(calls).toBe(before);
  });
});

describe("the link control's colour", () => {
  it("is the default text colour, which clears 4.5:1 where the muted one did not", () => {
    const css = stylesCss();
    const block = /\.btn\[data-variant="link"\] \{([^}]*)\}/.exec(css)![1]!;
    expect(block).toContain("color: var(--pk-text-default)");
    expect(block).not.toContain("--pk-text-muted");
  });
});

describe("the pane's identity header", () => {
  it("starts at the pane's start edge, over its start-aligned title", () => {
    const css = stylesCss();
    const block = /\.pane \.identity\[data-size="medium"\] \{([^}]*)\}/.exec(
      css,
    );
    expect(block?.[1]).toContain("justify-items: start");
    expect(css).toMatch(
      /\.pane \.identity\[data-size="compact"\] \{[^}]*justify-content: start/,
    );
  });
  it("leaves the Sign out link in the default text colour, never danger", () => {
    expect(stylesCss()).not.toMatch(
      /data-key="common\.signOut"\] \{[^}]*--pk-danger/,
    );
  });
});

describe("the native preset's system scheme", () => {
  it("is re-resolved when the host toggles its own ground", async () => {
    const el = (await draw("pk-welcome", {})) as PkElement & {
      preset?: string;
    };
    el.preset = "native";
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    await el.updateComplete;
    const scheme = () => q(el, ".pk-root")?.getAttribute("data-theme");
    expect(scheme()).toBe("light");
    document.body.style.backgroundColor = "rgb(10, 12, 20)";
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;
    expect(scheme()).toBe("dark");
    document.body.style.backgroundColor = "";
  });
});
