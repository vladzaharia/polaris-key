// @pkey-feature ui.kit.holders ui.kit license.activate
//
// `<PolarisKeyGate>` after a key with no account (UK-42.10), mirroring ui-core's GateDriver cases
// (browserGate.test.ts): Done after the key, Add your name and email, the typed refusals, the
// portal while Identity is off, the license-owned key sign-in, and the security rules (Cancel ends
// the sign-in, one owned sign-in at a time, the key only to the configured origin, a preview
// before attach, the key in no markup).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import type { PolarisAdapter } from "../src/core/index.js";

const KEY = "PKEY-TEST-AAAA-BBBB";

beforeAll(() => {
  const noop = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = noop;
      disconnect = noop;
      unobserve = noop;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface FakeOptions {
  identity?: boolean;
  email?: string;
  waits?: Array<Record<string, unknown>>;
  attach?: Array<Record<string, unknown>>;
  portal?: Record<string, unknown>;
  hold?: Promise<void>;
  status?: string;
}

/** A client double: the calls the gate makes, recording what they were given. */
function fake(o: FakeOptions = {}) {
  const calls: Array<[string, unknown]> = [];
  const waits = [...(o.waits ?? [{ kind: "signedIn" }])];
  const attach = [
    ...(o.attach ?? [{ kind: "ok", subject: "ps_1", attached: "claimed" }]),
  ];
  const listeners = new Set<() => void>();
  let state: Record<string, unknown> = {
    phase: "ready",
    status: o.status ?? "needs-activation",
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
    entitlements: {},
  };
  const set = (patch: Record<string, unknown>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const adapter = {
    snapshot: () => state,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: () => {},
    supports: () => ({ supported: false }),
    refresh: async () => {},
    signOut: async () => ({ released: true }),
    signInWithOidc: async () => {
      calls.push(["signInWithOidc", null]);
      return null;
    },
    activateWithKey: async (key: string) => {
      calls.push(["activateWithKey", key]);
      set({
        status: "ok",
        profile: {
          email: o.email ?? "",
          name: "",
          firstName: "",
          activatedAt: 1,
        },
      });
      return { keyEntries: null };
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
          reopen: async () => true,
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
  return { adapter: adapter as unknown as PolarisAdapter, calls, set };
}

function mount(o: FakeOptions = {}, baseUrl?: string) {
  const f = fake(o);
  const opened: string[] = [];
  vi.spyOn(window, "open").mockImplementation((u) => {
    opened.push(String(u));
    return null;
  });
  const view = render(
    <PolarisKeyProvider
      config={{
        productSlug: "acme",
        adapter: f.adapter,
        ...(baseUrl ? { baseUrl } : {}),
      }}
    >
      <PolarisKeyGate
        returnUrl="https://app.example/"
        theme={{ product: { name: "Acme Studio" } }}
      >
        <div data-testid="app">APP</div>
      </PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  const c = view.container;
  const btn = (key: string) =>
    c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
  const press = async (key: string) => {
    await waitFor(() => expect(btn(key)).not.toBeNull());
    fireEvent.click(btn(key)!);
  };
  const app = () => c.querySelector('[data-testid="app"]');
  const state = () => c.querySelector<HTMLElement>(".pk-root")?.dataset.state;
  /** Type the key and submit: ends on ActivateDone. */
  const activate = async () => {
    await press("welcome.useKey");
    const field = await waitFor(() => {
      const f = c.querySelector<HTMLInputElement>("#pk-key");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.change(field, { target: { value: KEY } });
    await press("activate.submit");
    await waitFor(() => expect(btn("signin.done.start")).not.toBeNull());
  };
  const fill = async () => {
    const name = await waitFor(() => {
      const e = c.querySelector<HTMLInputElement>('input[data-field="name"]');
      expect(e).not.toBeNull();
      return e!;
    });
    fireEvent.change(name, { target: { value: "Ada" } });
    fireEvent.change(
      c.querySelector<HTMLInputElement>('input[data-field="email"]')!,
      { target: { value: "ada@example.com" } },
    );
    fireEvent.click(btn("common.continue")!);
  };
  /** Done, then Add your name and email with the fields filled and sent. */
  const addFilled = async () => {
    await activate();
    await press("activate.recommend.action");
    await fill();
  };
  /** Done, then Add with Identity off: the portal opens. */
  const portal = async () => {
    await activate();
    await press("activate.recommend.action");
    await waitFor(() => expect(opened).toHaveLength(1));
  };
  return {
    ...f,
    ...view,
    btn,
    press,
    app,
    state,
    activate,
    fill,
    opened,
    addFilled,
    portal,
  };
}

const added = (c: HTMLElement) =>
  c.querySelector('[data-key="activate.attach.done"]');

describe("<PolarisKeyGate>: a key with no account", () => {
  it("lands on Done after the key, floating, holding the app back, with the key in no markup", async () => {
    const m = mount();
    await m.activate();
    expect(m.app()).toBeNull();
    expect(m.btn("activate.recommend.action")).not.toBeNull();
    expect(m.container.innerHTML).not.toContain(KEY);
  });

  it("reads a license sent to an email as waiting; Sign in starts the sign-in", async () => {
    const m = mount({ email: "ada@example.com" });
    await m.activate();
    expect(m.btn("activate.recommend.action")).toBeNull();
    await m.press("activate.waitingSignIn");
    await waitFor(() =>
      expect(m.calls).toContainEqual(["signInWithOidc", null]),
    );
  });

  it("continues without an account: Done closes, the app shows and the key is dropped", async () => {
    const m = mount({ identity: false });
    await m.activate();
    await m.press("signin.done.start");
    await waitFor(() => expect(m.app()).not.toBeNull());
    expect(m.container.querySelector(".pk-root")).toBeNull();
  });

  it("adds to an account: hints and the app's choice, keep, preview, attach; the key is not sent", async () => {
    const m = mount({
      waits: [
        { kind: "pending", interval: 0 },
        { kind: "choose", grant: "sg_x", expiresIn: 300, choices: {} },
      ],
    });
    await m.addFilled();
    await waitFor(() => expect(added(m.container)).not.toBeNull());
    expect(m.calls.find(([n]) => n === "signIn.start")?.[1]).toEqual({
      channel: "device-code",
      licenseChoice: "app",
      loginHint: "ada@example.com",
      nameHint: "Ada",
      purpose: "attach",
    });
    expect(m.calls).toContainEqual([
      "complete",
      { grant: "sg_x", choice: { kind: "keep" } },
    ]);
    // Previewed first (confirm: false), then written.
    const names = m.calls.map(([n]) => n);
    expect(names.indexOf("preview")).toBeLessThan(names.indexOf("attach"));
    expect(m.calls).toContainEqual(["attach", { confirm: true }]);
    expect(
      JSON.stringify(m.calls.filter(([n]) => n !== "activateWithKey")),
    ).not.toContain(KEY);
    expect(m.container.innerHTML).not.toContain(KEY);
    await m.press("signin.done.start");
    await waitFor(() => expect(m.app()).not.toBeNull());
  });

  it("owned: Sign in on the refusal is the gate's own sign-in", async () => {
    const m = mount({
      attach: [{ kind: "refused", code: "license_owned", status: 409 }],
    });
    await m.addFilled();
    await m.press("signin.key.ownedSignIn");
    // (the owned state's own sign-in is the gate's)
    await waitFor(() =>
      expect(m.calls).toContainEqual(["signInWithOidc", null]),
    );
  });

  it("Cancel from AddToAccount goes back to Done with its sign-in cancelled", async () => {
    const m = mount({
      attach: [{ kind: "refused", code: "license_owned", status: 409 }],
    });
    await m.addFilled();
    await waitFor(() => expect(m.btn("signin.key.ownedSignIn")).not.toBeNull());
    await m.press("common.cancel");
    await waitFor(() =>
      expect(m.btn("activate.recommend.action")).not.toBeNull(),
    );
    expect(m.app()).toBeNull();
  });

  it("with Identity off opens the portal with the key as a fragment, and adds no account", async () => {
    const m = mount({ identity: false });
    await m.portal();
    expect(m.opened[0]!).toContain("#key=" + KEY);
    expect(m.opened[0]!.split("#")[0]).not.toContain(KEY);
    expect(m.btn("signin.done.start")).not.toBeNull();
    expect(m.calls.some(([n]) => n === "signIn.start")).toBe(false);
  });

  it("gives the key only to the configured portal origin", async () => {
    const m = mount({
      identity: false,
      portal: {
        enabled: true,
        activate: "https://evil.example/activate?product=acme",
      },
    });
    await m.portal();
    expect(m.opened[0]).toContain("evil.example");
    expect(m.opened[0]).not.toContain("#key=");
    expect(m.opened[0]).not.toContain(KEY);
  });

  it("gives the key to the provider's own baseUrl origin", async () => {
    const m = mount(
      {
        identity: false,
        portal: {
          enabled: true,
          activate: "https://keys.example.org/activate?product=acme",
        },
      },
      "https://keys.example.org",
    );
    await m.portal();
    expect(m.opened[0]!).toContain("#key=" + KEY);
  });

  it("does not attach when a different account signed in than the email typed", async () => {
    const m = mount({
      waits: [{ kind: "signedIn", identity: { email: "other@example.com" } }],
    });
    await m.addFilled();
    await waitFor(() =>
      expect(m.btn("activate.otherEmail.verify")).not.toBeNull(),
    );
    expect(m.calls).toContainEqual(["preview", { confirm: false }]);
    expect(m.calls.some(([n]) => n === "attach")).toBe(false);
  });

  it("Cancel while the sign-in is out ends it: approving it later attaches nothing", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = mount({ hold });
    await m.addFilled();
    await waitFor(() =>
      expect(m.calls.some(([n]) => n === "signIn.start")).toBe(true),
    );
    await m.press("common.cancel");
    await waitFor(() => expect(m.calls).toContainEqual(["cancel", null]));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(m.calls.some(([n]) => n === "attach")).toBe(false);
  });

  it("Try again after a failed attach lets the previous sign-in go", async () => {
    const m = mount({
      attach: [
        { kind: "refused", code: "failed", status: 500 },
        { kind: "ok", subject: "ps_1", attached: "claimed" },
      ],
      waits: [{ kind: "signedIn" }],
    });
    await m.addFilled();
    await m.press("common.tryAgain");
    await waitFor(() => expect(added(m.container)).not.toBeNull());
  });
});

describe("<PolarisKeyGate>: Sign in to that account on a license-owned refusal", () => {
  const refuse = (m: ReturnType<typeof mount>) => {
    m.set({
      error: {
        license: {
          code: "license_owned",
          activation: {
            kind: "licenseOwned",
            code: "license_owned",
            signInUrl: "https://polaris.locker/signin",
          },
        },
        identity: null,
      },
    });
  };

  it("completes the sign-in with the key and shows no list", async () => {
    const m = mount({
      waits: [
        {
          kind: "choose",
          grant: "sg_y",
          expiresIn: 300,
          choices: { choices: [] },
        },
      ],
    });
    await m.press("welcome.useKey");
    const field = await waitFor(() => {
      const f = m.container.querySelector<HTMLInputElement>("#pk-key");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.change(field, { target: { value: KEY } });
    refuse(m);
    await m.press("signin.key.ownedSignIn");
    await waitFor(() =>
      expect(m.calls.some(([n]) => n === "complete")).toBe(true),
    );
    expect(m.calls.find(([n]) => n === "signIn.start")?.[1]).toEqual({
      channel: "device-code",
      licenseChoice: "app",
    });
    expect(m.calls.find(([n]) => n === "complete")?.[1]).toEqual({
      grant: "sg_y",
      choice: { kind: "key", key: KEY },
    });
    // The handle is let go whatever ended it.
    await waitFor(() => expect(m.calls).toContainEqual(["cancel", null]));
  });

  it("a second press while one is live starts nothing; an empty key lets the sign-in go", async () => {
    const m = mount({
      waits: [{ kind: "choose", grant: "sg_z", expiresIn: 300, choices: {} }],
    });
    await m.press("welcome.useKey");
    refuse(m);
    await m.press("signin.key.ownedSignIn");
    fireEvent.click(m.btn("signin.key.ownedSignIn")!);
    await waitFor(() => expect(m.calls).toContainEqual(["cancel", null]));
    expect(m.calls.filter(([n]) => n === "signIn.start")).toHaveLength(1);
    expect(m.calls.some(([n]) => n === "complete")).toBe(false);
  });
});
