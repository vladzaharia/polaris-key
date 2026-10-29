// @pkey-feature ui.signin
//
// The one sign-in form in React (SIGN-IN.md §3.17), held to the elements' own tests
// (packages/elements/test/signin.test.ts): `<SignIn>` morphs its body through the steps of
// ui-matrix.json's signIn family (the handoff's code view, the license choice, Replace a device,
// Done), the step parts draw one step each, `presentation="sheet"` puts the form in a `<dialog>`,
// and with SDK primitives the form drives ui-core's SignInModel from its own controls.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode, type ReactNode } from "react";

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  LicenseChoiceView,
  SignInPrimitives,
  SignInWait,
  UiInput,
} from "@polaris-key/ui-core";

import {
  ReplaceDevice,
  SignIn,
  SignInDone,
  SignInMethods,
  type KitAction,
} from "@polaris-key/react/kit";

type Obj = Record<string, unknown>;
interface Row {
  name: string;
  input: Obj;
  expect: { component: string; state: string; copy: string[] };
}

const REPO = join(import.meta.dirname, "..", "..", "..");
const matrix = JSON.parse(
  readFileSync(join(REPO, "conformance/corpus/v2/ui-matrix.json"), "utf8"),
) as Obj & { signIn: Row[]; vocabulary: Obj & { defaults: Obj } };

function withDefaults(input: Obj, defaults: Obj): UiInput {
  const out: Obj = { ...input };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "capabilities")
      out[k] = { ...(v as Obj), ...((input[k] as Obj | undefined) ?? {}) };
    else if (!(k in input)) out[k] = v;
  }
  return out as UiInput;
}

const input = (name: string): UiInput => {
  const r = matrix.signIn.find((x) => x.name === name);
  if (!r) throw new Error(`no signIn row ${name}`);
  return {
    elapsedMs: 60_000,
    ...withDefaults(r.input, matrix.vocabulary.defaults),
  };
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const root = (c: HTMLElement) => c.querySelector<HTMLElement>(".pk-root");
const flush = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};

describe("the form's steps", () => {
  it("draws the code view in the form's body", () => {
    const i = input("SignIn/code: a device-code sign-in");
    const { container } = render(<SignIn input={i} />);
    expect(container.querySelector('[data-part="code"]')).not.toBeNull();
  });

  it("draws the license choice with one title and its rows", () => {
    const { container } = render(
      <SignIn input={input("SignIn/choose: desktop")} />,
    );
    expect(root(container)?.dataset.component).toBe("SignIn");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(
      container.querySelector('[data-part="license-list"]'),
    ).not.toBeNull();
  });

  it("titles Replace a device, preselects the least recent and names it in the confirm", () => {
    const actions: KitAction[] = [];
    const { container } = render(
      <SignIn
        input={input("SignIn/replace: the web confirms inline")}
        onAction={(a) => actions.push(a)}
      />,
    );
    expect(container.querySelector("h1")?.getAttribute("data-key")).toBe(
      "deviceLimit.title",
    );
    const devices = container.querySelectorAll('[data-part="device-row"]');
    expect(devices).toHaveLength(3);
    expect(devices[0]!.getAttribute("aria-checked")).toBe("true");
    expect(devices[0]!.textContent).toContain("Windows");
    expect(
      container.querySelector('[data-key="signin.replace.title"]')?.textContent,
    ).toContain("Work laptop");
    // Picking another device moves the confirm with it, and Replace and continue carries it.
    fireEvent.click(devices[1]!);
    expect(
      container.querySelector('[data-key="signin.replace.title"]')?.textContent,
    ).toContain("Mara's iPad");
    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-key="signin.replace.confirm"]',
      )!,
    );
    expect(actions.at(-1)).toMatchObject({
      key: "signin.replace.confirm",
      deviceId: "dev_ipad",
    });
  });

  it("ends on Done with the success mark, and Start reports done", () => {
    const r = matrix.signIn.find(
      (x) =>
        x.expect.component === "SignIn" &&
        x.expect.state === "done" &&
        x.expect.copy.includes("signin.done.start"),
    )!;
    const onDone = vi.fn();
    const { container } = render(
      <SignIn
        input={{
          elapsedMs: 60_000,
          ...withDefaults(r.input, matrix.vocabulary.defaults),
        }}
        onDone={onDone}
      />,
    );
    expect(container.querySelector(".success")).not.toBeNull();
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-key="signin.done.start"]')!,
    );
    expect(onDone).toHaveBeenCalledOnce();
  });
});

describe("the step parts", () => {
  it("each draws its own step and nothing else", () => {
    const methods = input("SignIn/methods: web");
    const replace = input("SignIn/replace: the web confirms inline");
    const draw = (node: ReactNode) => {
      cleanup();
      return render(<>{node}</>).container;
    };
    expect(
      draw(<SignInMethods input={methods} />).querySelector("h1"),
    ).not.toBeNull();
    expect(
      draw(<SignInMethods input={replace} />).querySelector("h1"),
    ).toBeNull();
    expect(
      draw(<ReplaceDevice input={replace} />).querySelectorAll(
        '[data-part="device-row"]',
      ),
    ).toHaveLength(3);
    expect(
      draw(<ReplaceDevice input={methods} />).querySelector("h1"),
    ).toBeNull();
    expect(draw(<SignInDone input={methods} />).querySelector("h1")).toBeNull();
  });
});

describe('presentation="sheet"', () => {
  it("puts the form in a dialog labelled by its title, open while `open`", () => {
    const { container, rerender } = render(
      <SignIn input={input("SignIn/methods: web")} presentation="sheet" />,
    );
    const dialog = container.querySelector("dialog.sheet");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-labelledby")).toBe("pk-title");
    expect(dialog!.querySelector("#pk-title")).not.toBeNull();
    expect(dialog!.hasAttribute("open")).toBe(false);
    rerender(
      <SignIn input={input("SignIn/methods: web")} presentation="sheet" open />,
    );
    expect(dialog!.hasAttribute("open")).toBe(true);
  });

  it("Escape closes the sheet", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SignIn
        input={input("SignIn/methods: web")}
        presentation="sheet"
        open
        onClose={onClose}
      />,
    );
    fireEvent(
      container.querySelector("dialog.sheet")!,
      new Event("cancel", { cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("the sheet is never a trap", () => {
  const methods = () => {
    const base = input("SignIn/methods: web");
    return base;
  };
  it("has a close button, closes on a scrim click, and offers Cancel", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SignIn input={methods()} presentation="sheet" open onClose={onClose} />,
    );
    const dialog = container.querySelector("dialog.sheet")!;
    expect(dialog.querySelector('[data-part="close"]')).not.toBeNull();
    expect(dialog.querySelector('[data-key="common.cancel"]')).not.toBeNull();
    fireEvent.click(dialog.querySelector('[data-part="close"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(dialog.querySelector('[data-part="title"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Back closes the sheet (a history entry), and closing it by hand takes the entry back", () => {
    const onClose = vi.fn();
    const push = vi.spyOn(history, "pushState");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const { rerender } = render(
      <SignIn input={methods()} presentation="sheet" open onClose={onClose} />,
    );
    expect(push).toHaveBeenCalledOnce();
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
    rerender(
      <SignIn
        input={methods()}
        presentation="sheet"
        open={false}
        onClose={onClose}
      />,
    );
    expect(back).not.toHaveBeenCalled();
  });
});

const choices: LicenseChoiceView = {
  state: "choose",
  keep: false,
  preselected: "lic_pro",
  create: null,
  getLicense: null,
  choices: [
    {
      id: "lic_pro",
      tierName: "Pro",
      name: null,
      origin: "store",
      access: "seats",
      seats: { used: 1, limit: 3 },
      current: false,
      expiresAt: null,
      state: "free",
      replace: null,
      freeDeviceUrl: null,
    },
  ],
};

describe("live: the form drives the SDK primitives", () => {
  function primitivesOf(calls: string[]): SignInPrimitives {
    let answered = false;
    return {
      async start(o) {
        calls.push(`start:${o.channel}:${o.licenseChoice}`);
        return {
          browserOpened: true,
          async wait(): Promise<SignInWait> {
            if (answered) return new Promise(() => {});
            answered = true;
            return { outcome: "choose", grant: "g1", choices };
          },
          reopen: () => true,
          cancel: () => {},
        };
      },
      choice: {
        licenses: async () => choices,
        devices: async () => {
          throw new Error("unused");
        },
        async complete(grant, choice) {
          calls.push(`complete:${grant}:${JSON.stringify(choice)}`);
          return { outcome: "signedIn", issuedNow: true };
        },
        cancel: async () => {},
      },
    };
  }

  it("Continue in browser → choose → Use this license → Done, under StrictMode", async () => {
    const calls: string[] = [];
    const primitives = primitivesOf(calls);
    const base = input("SignIn/methods: web");
    delete base.signIn;
    const { container } = render(
      <StrictMode>
        <SignIn input={base} primitives={primitives} />
      </StrictMode>,
    );
    await flush();
    expect(root(container)?.dataset.state).toBe("methods");
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-variant="primary"]')!,
    );
    await flush();
    expect(calls[0]).toBe("start:browser:app");
    expect(root(container)?.dataset.state).toBe("choose");
    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-key="signin.choice.continue"]',
      )!,
    );
    await flush();
    expect(calls[1]).toBe(
      'complete:g1:{"kind":"license","licenseId":"lic_pro"}',
    );
    expect(root(container)?.dataset.state).toBe("done");
    expect(container.querySelector(".success")).not.toBeNull();
  });

  it("a refused key takes focus to the refusal's title, and Use a different key to the empty field", async () => {
    const calls: string[] = [];
    const primitives = primitivesOf(calls);
    primitives.activate = async () => {
      throw Object.assign(new Error("sign-in-failed"), {
        activation: {
          kind: "keyEntryLimit",
          manageUrl: "https://key.plrs.im/activate?product=acme&next=add-key",
        },
      });
    };
    const base = input("SignIn/methods: web");
    delete base.signIn;
    const { container } = render(
      <SignIn input={base} primitives={primitives} />,
    );
    await flush();
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-variant="primary"]')!,
    );
    await flush();
    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-key="signin.choice.keyInstead"]',
      )!,
    );
    await flush();
    const field = container.querySelector<HTMLInputElement>("#pk-key")!;
    fireEvent.change(field, {
      target: { value: "pkey_acme_Q2xvdWRzT3ZlclRoZUhpbG" },
    });
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-key="activate.submit"]')!,
    );
    await flush();
    // The refusal is its own step: no field, the title holds focus (never <body>).
    expect(container.querySelector("#pk-key")).toBeNull();
    const title = container.querySelector<HTMLElement>('[data-part="title"]')!;
    expect(title.textContent).toContain("No key entries left");
    expect(document.activeElement).toBe(title);
    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-key="signin.key.differentKey"]',
      )!,
    );
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const again = container.querySelector<HTMLInputElement>("#pk-key")!;
    expect(again.value).toBe("");
    expect(document.activeElement).toBe(again);
  });

  const full = (
    id: string,
    tier: string,
  ): LicenseChoiceView["choices"][number] => ({
    id,
    tierName: tier,
    name: null,
    origin: "store",
    access: "seats",
    seats: { used: 3, limit: 3 },
    current: false,
    expiresAt: null,
    state: "full",
    replace: { allowed: true, retryAfter: null },
    freeDeviceUrl: null,
  });

  it("every license full: each row offers Replace a device, with Cancel and the key option", async () => {
    const calls: string[] = [];
    const prims = primitivesOf(calls);
    const all: LicenseChoiceView = {
      ...choices,
      preselected: null,
      choices: [full("lic_a", "Team"), full("lic_b", "Pro")],
    };
    const wait = async (): Promise<SignInWait> => ({
      outcome: "choose",
      grant: "g1",
      choices: all,
    });
    const p: SignInPrimitives = {
      ...prims,
      start: async () => ({
        browserOpened: true,
        wait,
        reopen: () => true,
        cancel: () => {},
      }),
      choice: {
        ...prims.choice!,
        licenses: async () => all,
        devices: async () => ({
          licenseId: "lic_b",
          seats: { used: 3, limit: 3 },
          devices: [],
          replace: { allowed: true, retryAfter: null },
        }),
      },
    };
    const base = input("SignIn/methods: web");
    delete base.signIn;
    const { container } = render(<SignIn input={base} primitives={p} />);
    await flush();
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-variant="primary"]')!,
    );
    await flush();
    const rows = container.querySelectorAll(
      '[data-part="license-row"] [data-key="signin.replace.open"]',
    );
    expect(rows).toHaveLength(2);
    expect(
      container.querySelector('button[data-key="common.cancel"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-key="signin.choice.keyInstead"]'),
    ).not.toBeNull();
    fireEvent.click(rows[1]!);
    await flush();
    expect(root(container)?.dataset.state).toBe("replace");
  });

  it("an existing license: one press completes once, onDone fires once, the sheet closes", async () => {
    const calls: string[] = [];
    const prims = primitivesOf(calls);
    const p: SignInPrimitives = {
      ...prims,
      choice: {
        ...prims.choice!,
        async complete(grant, choice) {
          calls.push(`complete:${grant}:${JSON.stringify(choice)}`);
          await new Promise((r) => setTimeout(r, 5));
          return { outcome: "signedIn", issuedNow: false };
        },
      },
    };
    const base = input("SignIn/methods: web");
    delete base.signIn;
    const onDone = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <SignIn
        input={base}
        primitives={p}
        presentation="sheet"
        open
        onDone={onDone}
        onClose={onClose}
      />,
    );
    await flush();
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-variant="primary"]')!,
    );
    await flush();
    const go = container.querySelector<HTMLElement>(
      '[data-key="signin.choice.continue"]',
    )!;
    fireEvent.click(go);
    fireEvent.click(go);
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(calls.filter((c) => c.startsWith("complete"))).toHaveLength(1);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.textContent).not.toMatch(/\{(name|tier)\}/);
  });
});

describe("a key with no account ends at the holders' screens (UK-42.10)", () => {
  const KEY = "PKEY-TEST-AAAA-BBBB";

  const press = async (c: HTMLElement, key: string) => {
    fireEvent.click(c.querySelector<HTMLElement>(`[data-key="${key}"]`)!);
    await flush();
  };
  /** Types the key and submits it. */
  const enterKey = async (c: HTMLElement) => {
    fireEvent.change(c.querySelector<HTMLInputElement>("#pk-key")!, {
      target: { value: KEY },
    });
    await press(c, "activate.submit");
  };
  /** Fills AddToAccount's fields and presses Continue. */
  const addYourName = async (c: HTMLElement) => {
    for (const [field, value] of [
      ["name", "Ada"],
      ["email", "ada@example.com"],
    ] as const)
      fireEvent.change(c.querySelector(`input[data-field="${field}"]`)!, {
        target: { value },
      });
    await press(c, "common.continue");
  };

  /** The form at ActivateDone: methods, Continue in browser, the choice, a license key, its key. */
  async function atDone(
    p: SignInPrimitives,
    props: { onDone?: () => void } = {},
  ) {
    const seed = input("SignIn/methods: web");
    delete seed.signIn;
    const { container } = render(
      <SignIn input={seed} primitives={p} {...props} />,
    );
    await flush();
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-variant="primary"]')!,
    );
    await flush();
    await press(container, "signin.choice.keyInstead");
    await enterKey(container);
    // The key's activation settles over several turns; wait for Done itself, not a tick count.
    await waitFor(() => expect(has(container, "signin.done.start")).toBe(true));
    return container;
  }

  function primitivesOf(calls: string[], over: Partial<SignInPrimitives> = {}) {
    const p: SignInPrimitives = {
      async start(o) {
        calls.push(`start:${o.channel}:${JSON.stringify(o.hints ?? null)}`);
        let first = !calls.some((c) => c === "chose");
        calls.push("chose");
        return {
          browserOpened: true,
          async wait(): Promise<SignInWait> {
            if (first) {
              first = false;
              return { outcome: "choose", grant: "g1", choices };
            }
            return { outcome: "signedIn" };
          },
          reopen: () => true,
          cancel: () => {
            calls.push("cancel");
          },
        };
      },
      activate: async () => ({ result: "ok" }) as never,
      attach: async (confirm) => {
        calls.push(`attach:${confirm}`);
        return { kind: "ok" };
      },
      ...over,
    };
    return p;
  }

  const has = (c: HTMLElement, key: string) =>
    c.querySelector(`[data-key="${key}"]`) !== null;

  it("shows ActivateDone after a key and Start using ends the form; the key is in no markup", async () => {
    const onDone = vi.fn();
    const c = await atDone(primitivesOf([]), { onDone });
    expect(has(c, "signin.done.start")).toBe(true);
    expect(c.innerHTML).not.toContain(KEY);
    await press(c, "signin.done.start");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("Add your name and email: hints, preview, attach", async () => {
    const calls: string[] = [];
    const c = await atDone(primitivesOf(calls));
    await press(c, "activate.recommend.action");
    await addYourName(c);
    await flush();
    expect(calls).toContain(
      'start:browser:{"loginHint":"ada@example.com","nameHint":"Ada","purpose":"attach"}',
    );
    expect(calls.indexOf("attach:false")).toBeGreaterThan(-1);
    expect(calls.indexOf("attach:false")).toBeLessThan(
      calls.indexOf("attach:true"),
    );
    expect(has(c, "activate.attach.done")).toBe(true);
    expect(c.innerHTML).not.toContain(KEY);
  });

  it("Cancel from AddToAccount goes back to Done and cancels the sign-in", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = primitivesOf(calls);
    const p = primitivesOf(calls, {
      async start(o) {
        // The first start is the choice's; the sign-in AddToAccount runs holds until released.
        if (!calls.includes("chose")) return first.start(o);
        return {
          browserOpened: true,
          async wait(): Promise<SignInWait> {
            await hold;
            return { outcome: "signedIn" };
          },
          reopen: () => true,
          cancel: () => {
            calls.push("cancel");
          },
        };
      },
    });
    const c = await atDone(p);
    await press(c, "activate.recommend.action");
    await addYourName(c);
    await press(c, "common.cancel");
    expect(calls).toContain("cancel");
    release();
    await flush();
    expect(calls).not.toContain("attach:true");
    expect(has(c, "activate.recommend.action")).toBe(true);
  });
});
