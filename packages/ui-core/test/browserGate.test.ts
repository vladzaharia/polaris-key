// @pkey-feature ui.kit
//
// The browser module both web kits share (UI-KITS.md DL18): the config object `<pk-gate config>`
// takes, the one link validator, and a client that does no I/O until started.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GateDriver,
  createBrowserClient,
  parseGateConfig,
  safeLink,
} from "../src/browser/index.js";
import type { PolarisAdapter } from "../src/browser/sdk/core/index.js";
import { activateDoneView, addToAccountView, contextOf } from "../src/index.js";

describe("parseGateConfig", () => {
  it("reads the attribute's JSON and the object alike", () => {
    const o = {
      product: "acme",
      baseUrl: "https://key.plrs.im",
      version: "1.2.3",
      auth: "cookie",
      expectedServices: ["license", "config"],
      returnUrl: "https://app.example/",
    };
    expect(parseGateConfig(JSON.stringify(o))).toEqual(o);
    expect(parseGateConfig(o)).toEqual(o);
    expect(parseGateConfig({ productSlug: "acme" })).toEqual({
      product: "acme",
    });
  });

  it.each([
    ["not json", "config is not valid JSON"],
    [[], "config must be an object"],
    [{}, "config.product is required"],
    [
      { product: "a", auth: "magic" },
      "config.auth must be cookie, bearer or auto",
    ],
    [
      { product: "a", expectedServices: ["nope"] },
      "config.expectedServices has an unknown service: nope",
    ],
    [{ product: 3 }, "config.product must be a string"],
  ])("refuses %j", (raw, message) => {
    expect(() => parseGateConfig(raw)).toThrow(
      expect.objectContaining({ code: "invalid-options", message }),
    );
  });
});

describe("safeLink", () => {
  it("passes https and loopback http, and drops the rest", () => {
    expect(safeLink("https://key.plrs.im/a")).toBe("https://key.plrs.im/a");
    expect(safeLink("http://localhost:8787/a")).toBe("http://localhost:8787/a");
    expect(safeLink("http://example.test/")).toBeNull();
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://u:p@example.test/")).toBeNull();
    expect(safeLink(undefined)).toBeNull();
  });
});

describe("createBrowserClient", () => {
  it("does no I/O until started", () => {
    const fetchImpl = vi.fn();
    const client = createBrowserClient(
      { product: "acme", baseUrl: "https://key.plrs.im" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    client.dispose();
  });
});

// ── activation without an account (UK-42.6) ──────────────────────────────────────────────────

const KEY = "PKEY-TEST-AAAA-BBBB";

interface FakeOptions {
  identity?: boolean;
  email?: string;
  waits?: Array<Record<string, unknown>>;
  attach?: Array<Record<string, unknown>>;
  activateFails?: boolean;
  portal?: Record<string, unknown>;
  /** The sign-in's wait holds here until released, then answers signed in. */
  hold?: Promise<void>;
}

/** A client double: just the calls the gate makes, recording what they were given. */
function fakeClient(o: FakeOptions = {}) {
  const calls: Array<[string, unknown]> = [];
  const waits = [...(o.waits ?? [{ kind: "signedIn" }])];
  const attach = [
    ...(o.attach ?? [{ kind: "ok", subject: "ps_1", attached: "claimed" }]),
  ];
  const listeners = new Set<(s: unknown) => void>();
  let state: Record<string, unknown> = {
    phase: "ready",
    status: "needs-activation",
    mode: "bearer",
    gate: {},
    activation: null,
    profile: null,
    capabilities: {
      license: { enabled: true },
      identity: { enabled: o.identity ?? true },
      sync: { enabled: false },
      update: { enabled: false },
    },
    busy: { license: false, identity: false },
    error: { license: null, identity: null },
  };
  const set = (patch: Record<string, unknown>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l(state);
  };
  const client = {
    snapshot: () => state,
    subscribe: (cb: (s: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: () => {},
    refresh: async () => {},
    signInWithOidc: async () => {
      calls.push(["signInWithOidc", null]);
    },
    submitKey: async (key: string) => {
      calls.push(["submitKey", key]);
      if (o.activateFails) throw new Error("refused");
      set({
        status: "ok",
        profile: {
          email: o.email ?? "",
          name: "",
          firstName: "",
          activatedAt: 1,
        },
      });
    },
    discovery: async () => ({
      core: {
        portal: o.portal ?? {
          enabled: true,
          activate: "https://polaris.locker/activate?product=acme",
        },
      },
    }),
    attach: async (opts: { confirm: boolean }) => {
      if (!opts.confirm) {
        calls.push(["preview", opts]);
        return {
          kind: "confirm",
          license: { id: "lic_1", tierId: null, name: null },
        };
      }
      calls.push(["attach", opts]);
      return attach.shift() ?? { kind: "refused", code: "failed", status: 500 };
    },
    choice: {
      complete: async (grant: string, choice: unknown) => {
        calls.push(["complete", { grant, choice }]);
        return { kind: "ok", licenseId: "lic_1", subject: "ps_1", scope: "" };
      },
    },
    signIn: {
      start: async (opts: unknown) => {
        calls.push(["signIn.start", opts]);
        return {
          channel: "device-code",
          interval: 0,
          reopen: async () => {
            calls.push(["reopen", null]);
            return true;
          },
          cancel: () => {
            calls.push(["cancel", null]);
          },
          wait: async () => {
            if (o.hold) {
              await o.hold;
              return { kind: "signedIn" };
            }
            return waits.shift() ?? { kind: "cancelled" };
          },
        };
      },
    },
  };
  return { client: client as unknown as PolarisAdapter, calls, set };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

// The in-app Add runs only when switched on (`addIn: "app"`); the web default is the portal.
function gate(o: FakeOptions & { addIn?: "app" | "portal" } = {}) {
  const f = fakeClient(o);
  const d = new GateDriver(f.client, {
    addIn: o.addIn ?? "app",
    product: "acme",
    returnUrl: "https://app.example/",
  });
  d.attach();
  return { ...f, d };
}

describe("GateDriver: a key with no account", () => {
  const opened: string[] = [];
  beforeEach(() => {
    opened.length = 0;
    vi.stubGlobal("window", {
      open: (u: string) => opened.push(u),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", {
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: "visible",
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function activate(g: ReturnType<typeof gate>) {
    g.d.act("welcome.useKey");
    g.d.edit("key", KEY);
    g.d.act("activate.submit");
    await until(() => g.d.snapshot().step === "done");
  }

  function addAndContinue(g: ReturnType<typeof gate>) {
    g.d.act("activate.recommend.action");
    g.d.edit("name", "Ada");
    g.d.edit("email", "ada@example.com");
    g.d.act("common.continue");
  }

  it("lands on Done after the key, floating, with the key out of every input", async () => {
    const g = gate();
    await activate(g);
    const snap = g.d.snapshot();
    expect(snap.input.licenseHolder).toEqual({ email: "" });
    expect(snap.input.keyField?.text).toBe("");
    expect(JSON.stringify(snap)).not.toContain(KEY);
    const v = activateDoneView(contextOf(snap.input));
    expect(v.state).toBe("ready");
    g.d.detach();
  });

  it("reads a license sent to an email as waiting, and Sign in as that email starts the sign-in", async () => {
    const g = gate({ email: "ada@example.com" });
    await activate(g);
    const snap = g.d.snapshot();
    expect(activateDoneView(contextOf(snap.input)).state).toBe("waiting");
    g.d.act("activate.waitingSignIn");
    expect(g.calls).toContainEqual(["signInWithOidc", null]);
    g.d.detach();
  });

  it("continues without an account: Done closes and the key is dropped", async () => {
    const g = gate({ identity: false });
    await activate(g);
    g.d.act("activate.recommend.skip");
    expect(g.d.snapshot().step).toBe("home");
    // The key is gone: the portal opens later with no fragment.
    g.d.act("activate.recommend.action");
    await until(() => opened.length === 1);
    expect(opened[0]).toBe(
      "https://polaris.locker/activate?product=acme&return=https%3A%2F%2Fapp.example%2F",
    );
    g.d.detach();
  });

  it("adds to an account: hints and the app's choice, keep, then attach; the key is not sent", async () => {
    const g = gate({
      waits: [
        { kind: "pending", interval: 0 },
        { kind: "choose", grant: "sg_x", expiresIn: 300, choices: {} },
      ],
    });
    await activate(g);
    g.d.act("activate.recommend.action");
    expect(g.d.snapshot().step).toBe("add");
    expect(addToAccountView(contextOf(g.d.snapshot().input)).state).toBe(
      "form",
    );
    g.d.edit("name", "Ada");
    g.d.edit("email", "ada@example.com");
    g.d.act("common.continue");
    await until(() => g.d.snapshot().input.addToAccount?.step === "added");
    expect(g.calls.find(([n]) => n === "signIn.start")?.[1]).toEqual({
      channel: "device-code",
      licenseChoice: "app",
      loginHint: "ada@example.com",
      nameHint: "Ada",
      purpose: "attach",
    });
    expect(g.calls).toContainEqual([
      "complete",
      { grant: "sg_x", choice: { kind: "keep" } },
    ]);
    expect(g.calls).toContainEqual(["attach", { confirm: true }]);
    expect(
      JSON.stringify(g.calls.filter(([n]) => n !== "submitKey")),
    ).not.toContain(KEY);
    g.d.act("signin.done.start");
    expect(g.d.snapshot().step).toBe("home");
    g.d.detach();
  });

  it("refuses with the typed states, and Cancel goes back to Done", async () => {
    const g = gate({
      attach: [{ kind: "refused", code: "license_owned", status: 409 }],
    });
    await activate(g);
    addAndContinue(g);
    await until(() => g.d.snapshot().input.addToAccount?.step === "owned");
    g.d.act("common.cancel");
    expect(g.d.snapshot().step).toBe("done");
    g.d.detach();
  });

  it("by default (the web switch) Add and Sign in to that account open the portal with the key as a fragment", async () => {
    const g = gate({ addIn: undefined });
    const d = new GateDriver(g.client, { product: "acme" });
    d.attach();
    d.act("welcome.useKey");
    d.edit("key", KEY);
    d.act("activate.submit");
    await until(() => d.snapshot().step === "done");
    d.act("activate.recommend.action");
    await until(() => opened.length === 1);
    expect(opened[0]!).toContain("#key=" + KEY);
    expect(d.snapshot().step).toBe("done");
    d.detach();
    const h = new GateDriver(g.client, { product: "acme" });
    h.attach();
    h.act("welcome.useKey");
    h.edit("key", KEY);
    h.act("signin.key.ownedSignIn");
    await until(() => opened.length === 2);
    expect(opened[1]!).toContain("#key=" + KEY);
    expect(g.calls.some(([n]) => n === "signIn.start")).toBe(false);
    h.detach();
  });

  it("with Identity off opens the portal with the key as a fragment, and never adds an account", async () => {
    const g = gate({ identity: false });
    await activate(g);
    g.d.act("activate.recommend.action");
    await until(() => opened.length === 1);
    expect(opened[0]!).toContain("#key=" + KEY);
    expect(opened[0]!.split("#")[0]).not.toContain(KEY);
    expect(g.d.snapshot().step).toBe("done");
    expect(g.calls.some(([n]) => n === "signIn.start")).toBe(false);
    g.d.detach();
  });

  it("completes the license-owned key sign-in with the key and no list", async () => {
    const g = gate({
      waits: [
        {
          kind: "choose",
          grant: "sg_y",
          expiresIn: 300,
          choices: { choices: [] },
        },
      ],
    });
    g.d.act("welcome.useKey");
    g.d.edit("key", KEY);
    g.d.act("signin.key.ownedSignIn");
    await until(() => g.calls.some(([n]) => n === "complete"));
    expect(g.calls.find(([n]) => n === "signIn.start")?.[1]).toEqual({
      channel: "device-code",
      licenseChoice: "app",
    });
    expect(g.calls.find(([n]) => n === "complete")?.[1]).toEqual({
      grant: "sg_y",
      choice: { kind: "key", key: KEY },
    });
    g.d.detach();
  });

  it("shows the floating row from the holder and opens Add from Settings", async () => {
    const g = gate();
    g.set({
      status: "ok",
      profile: { email: "", name: "", firstName: "", activatedAt: 1 },
    });
    expect(g.d.snapshot().input.licenseHolder).toEqual({ email: "" });
    g.d.act("activate.recommend.action");
    expect(g.d.snapshot().step).toBe("add");
    g.d.act("common.cancel");
    expect(g.d.snapshot().step).toBe("home");
    // An account on this device is never floating.
    g.set({
      profile: {
        email: "",
        name: "",
        firstName: "",
        activatedAt: 1,
        user: { id: "u" },
      },
    });
    expect(g.d.snapshot().input.licenseHolder).toBeUndefined();
    g.d.detach();
  });
  it("Cancel from AddToAccount ends the sign-in: approving it later attaches nothing", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const g = gate({ hold });
    await activate(g);
    addAndContinue(g);
    await until(() => g.calls.some(([n]) => n === "signIn.start"));
    g.d.act("common.cancel");
    expect(g.calls).toContainEqual(["cancel", null]);
    release();
    await tick();
    await tick();
    expect(g.calls.some(([n]) => n === "attach")).toBe(false);
    g.d.detach();
  });

  it("a second press of Sign in to that account starts nothing, and an empty key lets the sign-in go", async () => {
    const g = gate({
      waits: [{ kind: "choose", grant: "sg_z", expiresIn: 300, choices: {} }],
    });
    g.d.act("welcome.useKey");
    g.d.act("signin.key.ownedSignIn");
    g.d.act("signin.key.ownedSignIn");
    await until(() => g.calls.some(([n]) => n === "cancel"));
    expect(g.calls.filter(([n]) => n === "signIn.start")).toHaveLength(1);
    expect(g.calls.some(([n]) => n === "complete")).toBe(false);
    g.d.detach();
  });

  it("gives the key only to the configured portal origin", async () => {
    const g = gate({
      identity: false,
      portal: {
        enabled: true,
        activate: "https://evil.example/activate?product=acme",
      },
    });
    await activate(g);
    g.d.act("activate.recommend.action");
    await until(() => opened.length === 1);
    expect(opened[0]).toContain("evil.example");
    expect(opened[0]).not.toContain("#key=");
    expect(opened[0]).not.toContain(KEY);
    g.d.detach();
  });

  it("does not attach when a different account signed in than the email typed", async () => {
    const g = gate({
      waits: [{ kind: "signedIn", identity: { email: "other@example.com" } }],
    });
    await activate(g);
    addAndContinue(g);
    await until(
      () => g.d.snapshot().input.addToAccount?.step === "email-bound",
    );
    expect(g.calls).toContainEqual(["preview", { confirm: false }]);
    expect(g.calls.some(([n]) => n === "attach")).toBe(false);
    g.d.detach();
  });
});
