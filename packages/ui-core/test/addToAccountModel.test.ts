// @pkey-feature ui.signin
//
// AddToAccountModel (UK-42.4): form → busy → added | owned | email-bound | failed, over the narrow
// driver both gates implement. A fake driver stands in for the SDK.

import { describe, expect, it } from "vitest";

import {
  AddToAccountModel,
  driverOf,
  type AddToAccountDriver,
  type AddToAccountHints,
  type AttachOutcome,
  type ChoiceComplete,
  type SignInPrimitives,
  type SignInWait,
} from "../src/index.js";

const BASE = {
  platform: { os: "macos", formFactor: "mac" },
  presentation: { name: "Tidewater Studio", icon: true },
  services: ["license", "identity"],
  licenseHolder: { email: "ada@example.com" },
} as const;

interface Fake extends AddToAccountDriver {
  calls: string[];
  hints: AddToAccountHints[];
  attachArgs: unknown[][];
}

function fake(opts: {
  waits?: SignInWait[];
  complete?: ChoiceComplete;
  attach?: Array<AttachOutcome | Error>;
  signInError?: boolean;
}): Fake {
  const waits = [...(opts.waits ?? [{ outcome: "signedIn" as const }])];
  const attach = [...(opts.attach ?? [{ kind: "ok" as const }])];
  const f: Fake = {
    calls: [],
    hints: [],
    attachArgs: [],
    async signIn(h) {
      f.calls.push("signIn");
      f.hints.push(h);
      if (opts.signInError) throw new Error("network");
      return {
        wait: async () => waits.shift() ?? { outcome: "cancelled" },
        reopen: () => true,
        cancel: () => {
          f.calls.push("cancel");
        },
      };
    },
    async complete(grant, choice) {
      f.calls.push(`complete:${grant}:${choice.kind}`);
      return opts.complete ?? { outcome: "signedIn", issuedNow: false };
    },
    async attach(...args: unknown[]) {
      f.calls.push("attach");
      f.attachArgs.push(args);
      const r = attach.shift() ?? { kind: "ok" as const };
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return f;
}

function model(driver: AddToAccountDriver) {
  const m = new AddToAccountModel({ driver, base: BASE, deviceKind: "Mac" });
  m.setField("name", "Ada Lovelace");
  m.setField("email", "ada@example.com");
  return m;
}

describe("AddToAccountModel", () => {
  it("starts on the form and shows the AddToAccount form view", () => {
    const m = new AddToAccountModel({ driver: fake({}), base: BASE });
    expect(m.snapshot.step).toBe("form");
    expect(m.view().state).toBe("form");
  });

  it("names the field to fix and clears it on typing", async () => {
    const f = fake({});
    const m = new AddToAccountModel({ driver: f, base: BASE });
    await m.submit();
    expect(m.snapshot).toMatchObject({ step: "invalid", field: "both" });
    m.setField("name", "Ada");
    expect(m.snapshot.step).toBe("form");
    await m.submit();
    expect(m.snapshot).toMatchObject({ step: "invalid", field: "email" });
    m.setField("email", "ada@example.com");
    m.setField("name", "  ");
    await m.submit();
    expect(m.snapshot).toMatchObject({ step: "invalid", field: "name" });
    expect(m.view().state).toBe("invalid");
    expect(f.calls).toEqual([]);
  });

  it("keeps the name and email out of the views' input", () => {
    const m = model(fake({}));
    expect(JSON.stringify(m.input())).not.toContain("Ada Lovelace");
    expect(m.input().addToAccount).toEqual({ step: "form", deviceKind: "Mac" });
  });

  it("passes the typed values as hints, purpose attach", async () => {
    const f = fake({});
    await model(f).submit();
    expect(f.hints).toEqual([
      {
        loginHint: "ada@example.com",
        nameHint: "Ada Lovelace",
        purpose: "attach",
      },
    ]);
  });

  it("signedIn without choose goes straight to attach", async () => {
    const f = fake({});
    const m = model(f);
    const p = m.submit();
    expect(m.snapshot.step).toBe("busy");
    await p;
    expect(f.calls).toEqual(["signIn", "attach"]);
    expect(m.snapshot.step).toBe("added");
    expect(m.view().state).toBe("added");
  });

  it("choose completes keep, then attaches", async () => {
    const f = fake({
      waits: [
        { outcome: "pending" },
        {
          outcome: "choose",
          grant: "g1",
          choices: {
            state: "choose",
            choices: [],
            keep: true,
            preselected: null,
            create: null,
          },
        } as unknown as SignInWait,
      ],
    });
    const m = model(f);
    await m.submit();
    expect(f.calls).toEqual(["signIn", "complete:g1:keep", "attach"]);
    expect(m.snapshot.step).toBe("added");
  });

  it("a choice that does not complete fails", async () => {
    const f = fake({
      waits: [
        { outcome: "choose", grant: "g", choices: {} } as unknown as SignInWait,
      ],
      complete: { outcome: "raced" },
    });
    const m = model(f);
    await m.submit();
    expect(f.calls).not.toContain("attach");
    expect(m.snapshot.step).toBe("failed");
  });

  it("sends no address on attach", async () => {
    const f = fake({});
    await model(f).submit();
    expect(f.attachArgs).toEqual([[]]);
  });

  it.each([
    ["license_owned", "owned"],
    ["license_email_bound", "email-bound"],
    ["account_required", "failed"],
    ["unauthorized", "failed"],
  ])("refusal %s lands on %s", async (code, step) => {
    const m = model(fake({ attach: [{ kind: "refused", code }] }));
    await m.submit();
    expect(m.snapshot.step).toBe(step);
    expect(m.view().state).toBe(step);
  });

  it("a network failure at sign-in or attach is failed", async () => {
    const a = model(fake({ signInError: true }));
    await a.submit();
    expect(a.snapshot.step).toBe("failed");
    const b = model(fake({ attach: [new Error("network")] }));
    await b.submit();
    expect(b.snapshot.step).toBe("failed");
  });

  it("Try again after a failed attach attaches again without a second sign-in", async () => {
    const f = fake({ attach: [new Error("network"), { kind: "ok" }] });
    const m = model(f);
    await m.submit();
    await m.tryAgain();
    expect(f.calls).toEqual(["signIn", "attach", "attach"]);
    expect(m.snapshot.step).toBe("added");
  });

  it("Try again after account_required signs in again", async () => {
    const f = fake({
      waits: [{ outcome: "signedIn" }, { outcome: "signedIn" }],
      attach: [{ kind: "refused", code: "account_required" }, { kind: "ok" }],
    });
    const m = model(f);
    await m.submit();
    await m.tryAgain();
    expect(f.calls).toEqual(["signIn", "attach", "signIn", "attach"]);
    expect(m.snapshot.step).toBe("added");
  });

  it("Try again after a failed sign-in signs in again, fields kept", async () => {
    const f = fake({
      waits: [{ outcome: "expired" }, { outcome: "signedIn" }],
    });
    const m = model(f);
    await m.submit();
    expect(m.snapshot.step).toBe("failed");
    expect(m.snapshot.email).toBe("ada@example.com");
    await m.tryAgain();
    expect(m.snapshot.step).toBe("added");
  });

  it("a cancelled browser returns to the form; Cancel lets the sign-in go", async () => {
    const m = model(fake({ waits: [{ outcome: "cancelled" }] }));
    await m.submit();
    expect(m.snapshot.step).toBe("form");
    const f = fake({ waits: [{ outcome: "pending" }] });
    const n = model(f);
    const p = n.submit();
    await Promise.resolve();
    await n.cancel();
    await p;
    expect(n.snapshot.step).toBe("form");
    expect(f.calls).toContain("cancel");
    expect(f.calls).not.toContain("attach");
  });
});

describe("driverOf", () => {
  it("starts the browser sign-in with the hints and the app's choice", async () => {
    const seen: unknown[] = [];
    const p: SignInPrimitives = {
      start: async (o) => {
        seen.push(o);
        return {
          wait: async () => ({ outcome: "signedIn" }),
          reopen: () => true,
          cancel: () => {},
        };
      },
      attach: async () => ({ kind: "ok" }),
    };
    const hints = {
      loginHint: "a@b.co",
      nameHint: "A",
      purpose: "attach",
    } as const;
    await driverOf(p).signIn(hints);
    expect(seen).toEqual([{ channel: "browser", licenseChoice: "app", hints }]);
  });

  it("a missing member is the planned failure", async () => {
    const d = driverOf({
      start: async () => {
        throw new Error("x");
      },
    });
    await expect(d.attach()).rejects.toThrow("planned");
    await expect(d.complete("g", { kind: "keep" })).rejects.toThrow("planned");
  });
});
