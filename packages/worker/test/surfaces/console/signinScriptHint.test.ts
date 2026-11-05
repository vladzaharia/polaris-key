/**
 * The console card's returning-person step, driven in a bare DOM stub: the script finds this
 * browser's own record (`pk_console_last_method`, a salted hash), compares it with the typed
 * address in the browser, and shows "Welcome back" without any request. The vector below is the
 * same one `admin/test/consoleLastMethod.test.tsx` pins for the SPA's writer: one hash, two
 * implementations.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { SIGNIN_SCRIPT } from "../../../src/console/signinScript.js";

const SALT = "pk-vector-salt";
const ADDRESS = "vlad@example.com";
const HASH = "a2a7c1f8c73e08cc97be9780";

type Handler = (e: { preventDefault(): void }) => void;
class El {
  hidden = false;
  textContent = "";
  value = "";
  focused = false;
  selected = false;
  handlers: Record<string, Handler[]> = {};
  form: El | null = null;
  attrs: Record<string, string> = {};
  nextElementSibling: El | null = null;
  submitted = 0;
  constructor(readonly id: string) {}
  addEventListener(t: string, h: Handler) {
    (this.handlers[t] ??= []).push(h);
  }
  removeEventListener() {}
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  setAttribute(n: string, v: string) {
    this.attrs[n] = v;
  }
  removeAttribute(n: string) {
    delete this.attrs[n];
  }
  querySelector() {
    return this;
  }
  focus() {
    this.focused = true;
  }
  select() {
    this.selected = true;
  }
  submit() {
    this.submitted++;
  }
  fire(t: string) {
    let prevented = false;
    for (const h of this.handlers[t] ?? [])
      h({ preventDefault: () => (prevented = true) });
    return prevented;
  }
}

function run(opts: {
  cookie: string;
  name?: string | null;
  typed: string;
  loading?: boolean;
}) {
  const ids = [
    "pk",
    "pk-go",
    "pk-msg",
    "h-go",
    "h-msg",
    "email",
    "pk-hint",
    "pk-main",
    "h-title",
    "h-email",
    "h-ini",
    "h-when",
    "h-sso",
    "h-change",
    "h-other",
  ];
  const els = Object.fromEntries(ids.map((i) => [i, new El(i)]));
  const form = new El("form");
  els.email!.form = form;
  els.email!.value = opts.typed;
  els["pk-hint"]!.hidden = true;
  const local = new Map<string, string>([
    ["pk-console-hint-salt", SALT],
    ...(opts.name
      ? [[`pk-console-hint-name:${HASH}`, opts.name] as const]
      : []),
  ]);
  const session = new Map<string, string>();
  const requests: unknown[] = [];
  const ready: [string, () => void][] = [];
  const ctx = {
    document: {
      getElementById: (i: string) => els[i] ?? null,
      cookie: opts.cookie,
      readyState: opts.loading ? "loading" : "complete",
      addEventListener: (t: string, h: () => void) => ready.push([t, h]),
    },
    window: { PublicKeyCredential: function () {}, crypto },
    navigator: { credentials: { get: () => Promise.reject(new Error("no")) } },
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => local.set(k, v),
    },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => session.set(k, v),
      removeItem: (k: string) => session.delete(k),
    },
    crypto,
    TextEncoder,
    Uint8Array,
    Intl,
    Date,
    Number,
    fetch: (...a: unknown[]) => {
      requests.push(a);
      return Promise.reject(new Error("no network"));
    },
    location: { assign() {} },
    AbortController,
  };
  (ctx.window as Record<string, unknown>).PublicKeyCredential = Object.assign(
    function () {},
    {},
  );
  vm.runInNewContext(SIGNIN_SCRIPT, {
    ...ctx,
    PublicKeyCredential: ctx.window.PublicKeyCredential,
    window: ctx.window,
  });
  return { els, form, session, requests, ready };
}

const at = Math.floor(Date.now() / 1000) - 3 * 86_400;
const record = `pk_console_last_method=passkey.${HASH}.${at}`;
const settle = () => new Promise((r) => setTimeout(r, 25));

describe("the returning-person step (script)", () => {
  it("waits for the parser: the step sits after the script in the document", () => {
    const { form, ready } = run({
      cookie: record,
      typed: ADDRESS,
      loading: true,
    });
    expect(ready.map(([t]) => t)).toEqual(["DOMContentLoaded"]);
    expect(form.handlers.submit).toBeUndefined();
    ready[0]![1]();
    expect(form.handlers.submit).toHaveLength(1);
  });

  it("a matching address shows 'Welcome back, Vlad' from this browser's own record, with no request", async () => {
    const { els, form, requests } = run({
      cookie: record,
      name: "Vlad",
      typed: " Vlad@Example.com ",
    });
    expect(form.fire("submit")).toBe(true);
    await settle();
    expect(form.submitted).toBe(0);
    expect(requests).toHaveLength(0);
    expect(els["pk-hint"]!.hidden).toBe(false);
    expect(els["pk-main"]!.hidden).toBe(true);
    expect(els["h-title"]!.textContent).toBe("Welcome back, Vlad");
    expect(els["h-title"]!.focused).toBe(true);
    expect(els["h-ini"]!.textContent).toBe("V");
    expect(els["h-email"]!.textContent).toBe("Vlad@Example.com");
    expect(els["h-when"]!.textContent).toBe(
      "On this browser, last time 3 days ago",
    );
  });

  it("without a stored name it greets without one and shows the address's initial", async () => {
    const { els, form } = run({ cookie: record, typed: ADDRESS });
    form.fire("submit");
    await settle();
    expect(els["h-title"]!.textContent).toBe("Welcome back");
    expect(els["h-ini"]!.textContent).toBe("V");
  });

  it("another address posts as usual and stashes single sign-on for the SPA", async () => {
    const { els, form, session } = run({
      cookie: record,
      name: "Vlad",
      typed: "mara@example.com",
    });
    form.fire("submit");
    await settle();
    expect(els["pk-hint"]!.hidden).toBe(true);
    expect(form.submitted).toBe(1);
    expect(session.get("pk-console-signin-via")).toBe("sso");
  });

  it.each([
    ["no record", ""],
    ["a single sign-on record", `pk_console_last_method=sso.${HASH}.${at}`],
  ])("%s: Continue is not held back", async (_n, cookie) => {
    const { els, form, session } = run({ cookie, typed: ADDRESS });
    expect(form.fire("submit")).toBe(false);
    await settle();
    expect(els["pk-hint"]!.hidden).toBe(true);
    expect(form.submitted).toBe(0);
    expect(session.get("pk-console-signin-via")).toBe("sso");
  });

  it("Change and Other ways return to the address, selected, and Continue then goes straight on", async () => {
    const { els, form } = run({ cookie: record, name: "Vlad", typed: ADDRESS });
    form.fire("submit");
    await settle();
    els["h-other"]!.fire("click");
    expect(els["pk-hint"]!.hidden).toBe(true);
    expect(els["pk-main"]!.hidden).toBe(false);
    expect(els.email!.focused && els.email!.selected).toBe(true);
    // The same address is not hinted twice on this page.
    expect(form.fire("submit")).toBe(false);
  });

  it("Continue with single sign-on on the step posts the form", async () => {
    const { els, form, session } = run({ cookie: record, typed: ADDRESS });
    form.fire("submit");
    await settle();
    els["h-sso"]!.fire("click");
    expect(form.submitted).toBe(1);
    expect(session.get("pk-console-signin-via")).toBe("sso");
  });
});
