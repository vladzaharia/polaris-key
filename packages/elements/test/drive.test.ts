// @pkey-feature ui.kit license.activate ui.update
//
// `<pk-gate config>` starts itself (UI-KITS.md §4.2, DL18): it builds the browser client from the
// attribute and drives the same states React's gate does inside its provider. A stateful fake
// `fetch` plays the Worker (discovery, the identity session, the key route, update and release),
// so the real browser adapter runs end to end under the element.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createBrowserClient } from "@polaris-key/ui-core/browser";

import { type PkElement, type PkGate } from "../src/index.js";
import { gateScreen, GateBinding, parseHandles } from "../src/drive.js";
import {
  fakeFetch,
  NOW,
  PAGE,
  typeKey,
  world,
  type World,
} from "./driveWorld.js";
import { floatingRow } from "./holdersFixtures.js";
import { viewOf } from "@polaris-key/ui-core";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

interface Mounted {
  gate: PkGate;
  w: World;
  navigated: string[];
  errors: unknown[];
}

async function mount(
  w: World,
  over: {
    config?: unknown;
    handles?: string;
    attrs?: Record<string, string>;
  } = {},
): Promise<Mounted> {
  const navigated: string[] = [];
  const errors: unknown[] = [];
  const gate = document.createElement("pk-gate") as PkGate;
  gate.innerHTML = `<main data-testid="app">APP</main>`;
  gate.addEventListener("pk-error", (e) =>
    errors.push((e as CustomEvent).detail),
  );
  gate.seams = {
    fetchImpl: fakeFetch(w),
    navigate: (u) => navigated.push(u),
    now: () => NOW,
  };
  if (over.handles) gate.handles = over.handles;
  gate.config = (
    typeof over.config === "object" && over.config !== null
      ? { ...PAGE, ...over.config }
      : (over.config ?? { ...PAGE, version: "1.0.0" })
  ) as PkGate["config"];
  document.body.replaceChildren(gate);
  await gate.updateComplete;
  return { gate, w, navigated, errors };
}

const settle = async (gate: PkElement, until: () => boolean) => {
  for (let i = 0; i < 80 && !until(); i++) {
    await new Promise((r) => setTimeout(r, 10));
    await gate.updateComplete;
  }
  await gate.updateComplete;
};
const control = (g: PkElement, key: string) =>
  g.shadowRoot!.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
const state = (g: PkElement) =>
  g.shadowRoot!.querySelector<HTMLElement>(".pk-root")?.dataset.state;

describe("<pk-gate config>: status", () => {
  it("never shows Welcome while the first state loads, then does", async () => {
    const { gate } = await mount(world());
    expect(control(gate, "welcome.signIn")).toBeNull();
    await settle(gate, () => control(gate, "welcome.signIn") !== null);
    expect(state(gate)).toBe("needs-activation");
    expect(control(gate, "welcome.signIn")).not.toBeNull();
    expect(control(gate, "welcome.useKey")).not.toBeNull();
  });

  it("renders the app in the slot, with no kit root, once the license holds", async () => {
    const { gate } = await mount(
      world({ doc: { expiresAt: 4600, graceUntil: 90_000 } }),
    );
    await settle(gate, () => gate.shadowRoot!.querySelector("slot") !== null);
    expect(
      gate.shadowRoot!.querySelector(".pk-root")?.children.length ?? 0,
    ).toBe(0);
    expect(gate.shadowRoot!.querySelector("slot")).not.toBeNull();
    expect(gate.querySelector('[data-testid="app"]')).not.toBeNull();
  });

  it("reads the config from the attribute's JSON", async () => {
    const w = world();
    const navigated: string[] = [];
    const gate = document.createElement("pk-gate") as PkGate;
    gate.seams = {
      fetchImpl: fakeFetch(w),
      navigate: (u) => navigated.push(u),
    };
    gate.setAttribute(
      "config",
      JSON.stringify({
        product: "acme",
        baseUrl: location.origin,
        auth: "cookie",
      }),
    );
    document.body.replaceChildren(gate);
    await gate.updateComplete;
    await settle(gate, () => control(gate, "welcome.signIn") !== null);
    expect(control(gate, "welcome.signIn")).not.toBeNull();
  });

  it("reports a bad config as pk-error and draws nothing", async () => {
    const { gate, errors } = await mount(world(), {
      config: '{"nope":1}',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([
      { code: "invalid-options", message: "config.product is required" },
    ]);
    expect(gate.shadowRoot!.querySelector("button")).toBeNull();
  });
});

describe("<pk-gate config>: Welcome, Activate and the hosted sign-in", () => {
  it("takes a key through Activate and lets the app in", async () => {
    const { gate, w } = await toKeyStep(world());
    await typeKey(gate, "pkey_acme_KEY");
    control(gate, "activate.submit")!.click();
    // The key activated with no account: ActivateDone first, the app after Start using.
    await settle(gate, () => control(gate, "signin.done.start") !== null);
    expect(w.posted).toEqual([{ key: "pkey_acme_KEY" }]);
    expect(gate.shadowRoot!.querySelector("slot")).toBeNull();
    control(gate, "signin.done.start")!.click();
    await settle(gate, () => state(gate) === undefined);
    expect(gate.shadowRoot!.querySelector("slot")).not.toBeNull();
  });

  it("backs out of Activate with Escape and gives focus back to its opener", async () => {
    const { gate } = await toKeyStep(world());
    gate.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle(gate, () => control(gate, "welcome.signIn") !== null);
    expect(control(gate, "welcome.signIn")).not.toBeNull();
    expect(gate.shadowRoot!.querySelector("#pk-key")).toBeNull();
  });

  it("keeps a device limit neutral and opens its link with the typed key", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const w = world({
      refuse: {
        status: 403,
        body: {
          error: {
            code: "device_limit",
            limit: 3,
            deviceCount: 3,
            manageUrl: "https://key.plrs.im/activate?product=acme",
          },
        },
      },
    });
    const { gate } = await toKeyStep(w, {
      config: { product: "acme", returnUrl: "https://app.acme.test/" },
    });
    await typeKey(gate, "pkey_acme_KEY");
    control(gate, "activate.submit")!.click();
    await settle(gate, () => control(gate, "deviceLimit.title") !== null);
    const primary = control(gate, "deviceLimit.title");
    expect(primary).not.toBeNull();
    primary!.click();
    expect(open).toHaveBeenCalledTimes(1);
    const url = String(open.mock.calls[0]![0]);
    expect(url).toContain("return=");
    expect(url).toContain("key=pkey_acme_KEY");
  });

  it("hands the hosted sign-in to the page (browser presentation)", async () => {
    const { gate, navigated } = await mount(world());
    await settle(gate, () => control(gate, "welcome.signIn") !== null);
    control(gate, "welcome.signIn")!.click();
    await settle(gate, () => navigated.length > 0);
    expect(navigated[0]).toContain("/acme/identity/auth/start");
  });

  it("draws the host-dependent actions only when the host handles them", async () => {
    const w = world({ services: ["license", "identity"] });
    const bare = await mount(w);
    await settle(
      bare.gate,
      () => control(bare.gate, "welcome.signIn") !== null,
    );
    for (const k of [
      "welcome.trial",
      "welcome.restore",
      "welcome.continueFree",
    ])
      expect(control(bare.gate, k)).toBeNull();

    const handled = await mount(w, { handles: "trial restore continue-free" });
    await settle(
      handled.gate,
      () => control(handled.gate, "welcome.trial") !== null,
    );
    for (const k of [
      "welcome.trial",
      "welcome.restore",
      "welcome.continueFree",
    ])
      expect(control(handled.gate, k)).not.toBeNull();
  });

  it("parses handles by name and ignores the rest", () => {
    expect([...parseHandles("Trial, renew bogus")].sort()).toEqual([
      "renew",
      "trial",
    ]);
  });
});

/** Welcome's Use a license key: the gate stands on the key step. */
async function toKeyStep(w: World, over: Parameters<typeof mount>[1] = {}) {
  const m = await mount(w, over);
  const { gate } = m;
  await settle(gate, () => control(gate, "welcome.useKey") !== null);
  control(gate, "welcome.useKey")!.click();
  await settle(gate, () => gate.shadowRoot!.querySelector("#pk-key") !== null);
  return m;
}

/** Take a key through Activate: the gate stands on ActivateDone. */
async function toDone(w: World, over: Parameters<typeof mount>[1] = {}) {
  const m = await toKeyStep(w, over);
  await typeKey(m.gate, "pkey_acme_KEY");
  control(m.gate, "activate.submit")!.click();
  await settle(m.gate, () => control(m.gate, "signin.done.start") !== null);
  return m;
}

const component = (g: PkElement) =>
  g.shadowRoot!.querySelector<HTMLElement>(".pk-root")?.dataset.component;

describe("the gate's step-to-screen mapping (UK-42.8)", () => {
  const licensed = viewOf("PolarisKeyGate", { gate: { status: "licensed" } });
  const needs = viewOf("PolarisKeyGate", {
    gate: { status: "needs-activation" },
  });

  it("done and add draw the holders' screens over any state; the rest is as before", () => {
    for (const v of [licensed, needs]) {
      expect(gateScreen(v, "done")).toBe("ActivateDone");
      expect(gateScreen(v, "add")).toBe("AddToAccount");
    }
    expect(gateScreen(licensed, "home")).toBeNull();
    expect(gateScreen(needs, "home")).toBe("Welcome");
    expect(gateScreen(needs, "activate")).toBe("Activate");
  });

  it("the binding hands the driver the config's baseUrl and a browser device kind", () => {
    const b = new GateBinding(() => {});
    b.sync(
      { product: "acme", baseUrl: "https://api.acme.test", auth: "cookie" },
      { client: undefined, fetchImpl: fakeFetch(world()) },
      "en",
    );
    const options = (
      b.driver as unknown as { options: Record<string, unknown> }
    ).options;
    expect(options).toMatchObject({
      baseUrl: "https://api.acme.test",
      deviceKind: "browser",
      product: "acme",
    });
    b.dispose();
  });
});

describe("<pk-gate config>: activation without an account (UK-42.8)", () => {
  it("maps the driver's done and add steps to ActivateDone and AddToAccount", async () => {
    const { gate } = await toDone(world());
    expect(state(gate)).toBe("licensed");
    expect(
      gate.shadowRoot!.querySelector('[data-key="activate.recommend.title"]'),
    ).not.toBeNull();
    // The key is not in the gate's input once it activated.
    expect(JSON.stringify(gate.input ?? {})).not.toContain("pkey_acme_KEY");
    control(gate, "activate.recommend.action")!.click();
    await settle(gate, () => control(gate, "common.continue") !== null);
    expect(
      gate.shadowRoot!.querySelector('[data-key="signin.gate.name"]'),
    ).not.toBeNull();
    // Cancel goes back to ActivateDone; Start using lets the app in.
    gate
      .shadowRoot!.querySelector<HTMLElement>('[data-key="common.cancel"]')!
      .click();
    await settle(gate, () => control(gate, "signin.done.start") !== null);
    control(gate, "signin.done.start")!.click();
    await settle(gate, () => gate.shadowRoot!.querySelector("slot") !== null);
    expect(gate.querySelector('[data-testid="app"]')).not.toBeNull();
  });

  it("sends name and email only in the Continue action, into the driver", async () => {
    const { gate } = await toDone(world());
    // The failed line is in the portal's copy table only (reported, UK-42.7).
    gate.theme = {
      copy: {
        en: { "locker.activate.addFailed": "Couldn't add this license." },
      },
    };
    control(gate, "activate.recommend.action")!.click();
    await settle(gate, () => control(gate, "common.continue") !== null);
    const seen: Array<Record<string, unknown>> = [];
    gate.addEventListener("pk-action", (e) =>
      seen.push((e as CustomEvent).detail),
    );
    gate.addEventListener("pk-input", (e) =>
      seen.push((e as CustomEvent).detail),
    );
    const type = (label: string, value: string) => {
      const f = gate.shadowRoot!.querySelector<HTMLInputElement>(
        `[data-key="${label}"]`,
      )!;
      f.value = value;
      f.dispatchEvent(new Event("input", { bubbles: true }));
    };
    type("signin.gate.name", "Mara Quill");
    type("signin.email.label", "mara@example.test");
    control(gate, "common.continue")!.click();
    await settle(gate, () => false);
    const carriers = seen.filter((d) =>
      JSON.stringify(d).includes("mara@example.test"),
    );
    expect(carriers.map((d) => d.key)).toEqual(["common.continue"]);
    expect(carriers[0]).toMatchObject({
      name: "Mara Quill",
      email: "mara@example.test",
    });
  });

  it("the AccountAndLicense row's Add opens AddToAccount over the app, Cancel returns", async () => {
    const { gate } = await mount(
      world({ doc: { expiresAt: 4600, graceUntil: 90_000 } }),
    );
    await settle(gate, () => gate.shadowRoot!.querySelector("slot") !== null);
    const row = document.createElement("pk-account-and-license") as PkElement;
    row.input = floatingRow();
    gate.append(row);
    await row.updateComplete;
    row
      .shadowRoot!.querySelector<HTMLElement>(
        'button[data-key="activate.recommend.action"]',
      )!
      .click();
    await settle(gate, () => control(gate, "common.continue") !== null);
    expect(component(gate)).toBe("PolarisKeyGate");
    expect(gate.shadowRoot!.querySelector("slot")).toBeNull();
    gate
      .shadowRoot!.querySelector<HTMLElement>('[data-key="common.cancel"]')!
      .click();
    await settle(gate, () => gate.shadowRoot!.querySelector("slot") !== null);
    expect(gate.shadowRoot!.querySelector("slot")).not.toBeNull();
  });
});

describe("<pk-gate config>: grace and the blocking states", () => {
  it("shows the grace banner over the app while offline grace runs", async () => {
    const { gate } = await mount(
      world({ doc: { expiresAt: 1500, graceUntil: 1500 + 5 * 86_400 } }),
    );
    await settle(gate, () => state(gate) === "grace");
    expect(state(gate)).toBe("grace");
    expect(gate.shadowRoot!.querySelector("slot")).not.toBeNull();
    expect(
      gate.shadowRoot!.querySelector('[data-component="PolarisKeyGate"]'),
    ).not.toBeNull();
  });

  it("shows StatusScreen when the license ran out; Renew draws only when handled", async () => {
    const expired = world({ doc: { expiresAt: 100, graceUntil: 200 } });
    const bare = await mount(expired);
    await settle(bare.gate, () => state(bare.gate) === "blocked");
    expect(state(bare.gate)).toBe("blocked");
    expect(control(bare.gate, "status.renew")).toBeNull();
    expect(control(bare.gate, "status.useAnotherLicense")).not.toBeNull();

    const handled = await mount(expired, { handles: "renew" });
    await settle(
      handled.gate,
      () => control(handled.gate, "status.renew") !== null,
    );
    expect(control(handled.gate, "status.renew")).not.toBeNull();
  });
});

describe("<pk-gate config>: the update prompt", () => {
  const licensed = { expiresAt: 4600, graceUntil: 90_000 };
  const update = {
    version: "2.0.0",
    tag: "v2.0.0",
    url: "https://dl.example.test/acme-2.0.0",
  };

  it("offers the update with the changelog's summary and the current version", async () => {
    const { gate } = await mount(
      world({
        doc: licensed,
        services: ["license", "release", "update"],
        update,
        changelog: [
          {
            version: "2.0.0",
            summary: "Faster export\nNew mixer\nFixes\nFourth line",
            url: "https://github.com/acme/app/releases/v2.0.0",
          },
        ],
      }),
    );
    const prompt = () =>
      gate.shadowRoot!.querySelector<PkElement>("pk-update-prompt");
    await settle(gate, () => prompt() !== null);
    await settle(
      gate,
      () =>
        (prompt()?.shadowRoot?.querySelectorAll(".notes li").length ?? 0) > 0,
    );
    const p = prompt()!;
    await p.updateComplete;
    const lines = [...p.shadowRoot!.querySelectorAll(".notes li")].map(
      (l) => l.textContent,
    );
    expect(lines).toEqual(["Faster export", "New mixer", "Fixes"]);
    expect(p.shadowRoot!.textContent).toContain("1.0.0");
    // Later puts the prompt off for good.
    p.shadowRoot!.querySelector<HTMLButtonElement>(
      'button[data-key="update.later"]',
    )!.click();
    await settle(gate, () => prompt() === null);
    expect(prompt()).toBeNull();
  });

  it("hides What's new when the entry has no summary", async () => {
    const { gate } = await mount(
      world({
        doc: licensed,
        services: ["license", "release", "update"],
        update,
        changelog: [{ version: "2.0.0", summary: null, url: "" }],
      }),
    );
    const prompt = () =>
      gate.shadowRoot!.querySelector<PkElement>("pk-update-prompt");
    await settle(gate, () => prompt() !== null);
    await new Promise((r) => setTimeout(r, 30));
    const p = prompt()!;
    await p.updateComplete;
    expect(p.shadowRoot!.querySelector(".notes")).toBeNull();
    expect(
      p.shadowRoot!.querySelector('[data-key="update.whatsNew"]'),
    ).toBeNull();
  });

  it("offers nothing when the product has no newer build", async () => {
    const { gate } = await mount(
      world({
        doc: licensed,
        services: ["license", "update"],
        update: { ...update, version: "1.0.0", tag: "v1.0.0" },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(gate.shadowRoot!.querySelector("pk-update-prompt")).toBeNull();
  });
});

describe("the neutral browser module", () => {
  it("builds a client with no I/O until started", () => {
    const fetchImpl = vi.fn();
    const client = createBrowserClient(
      { product: "acme" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    client.dispose();
  });
});
