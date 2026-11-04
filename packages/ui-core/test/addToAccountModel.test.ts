// @pkey-feature ui.signin
//
// AddToAccountModel (UK-42.4): form → busy → added | owned | email-bound | failed, over the narrow
// driver both gates implement. A fake driver stands in for the SDK.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  previews: number;
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
    previews: 0,
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
      // The preview (`confirm: false`) writes nothing and is counted apart.
      if (args[0] === false) {
        f.previews++;
        return { kind: "ok" as const };
      }
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
    expect(f.attachArgs).toEqual([[true]]);
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

  it("a different account than the email typed is its own step, with both emails masked", async () => {
    const f = fake({ waits: [{ outcome: "signedIn", email: "jo@other.com" }] });
    const m = model(f);
    await m.submit();
    expect(f.previews).toBe(1);
    expect(f.attachArgs).toEqual([]);
    expect(m.snapshot.step).toBe("other-account");
    const v = m.view();
    expect(v.state).toBe("other-account");
    expect(v.args).toMatchObject({
      maskedEmail: "a•••@example.com",
      email: "j•••@other.com",
    });
    expect(JSON.stringify(m.input())).not.toContain("jo@other.com");
    // Try again goes back to the form with the fields kept.
    await m.tryAgain();
    expect(m.snapshot).toMatchObject({
      step: "form",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
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

// The corpus's holdersFlow section (UK-43.2): the same scenarios every native port replays.
interface FlowScenario {
  name: string;
  fields?: { name?: string; email?: string };
  driver: {
    waits?: SignInWait[];
    complete?: ChoiceComplete;
    preview?: Array<AttachOutcome | "network">;
    attach?: Array<AttachOutcome | "network">;
    signInError?: boolean;
  };
  actions: Array<"submit" | "tryAgain" | "cancel" | "submit-then-cancel">;
  expect: {
    steps: string[];
    calls: string[];
    hints: AddToAccountHints[];
    viewState: string;
    field?: string;
    typedEmail?: string;
    signedEmail?: string;
  };
}
const flow = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../conformance/corpus/v2/ui-matrix.json"),
    "utf8",
  ),
).holdersFlow as {
  base: { licenseHolder: { email: string }; deviceKind: string };
  scenarios: FlowScenario[];
};

describe("ui-matrix.json holdersFlow", () => {
  it.each(flow.scenarios.map((s) => [s.name, s] as const))(
    "%s",
    async (_name, sc) => {
      const waits = [...(sc.driver.waits ?? [{ outcome: "signedIn" }])];
      const preview = [...(sc.driver.preview ?? [])];
      const attach = [...(sc.driver.attach ?? [])];
      const calls: string[] = [];
      const hints: AddToAccountHints[] = [];
      const answer = (list: Array<AttachOutcome | "network">) => {
        const r = list.shift() ?? { kind: "ok" as const };
        if (r === "network") throw new Error("network");
        return r;
      };
      const driver: AddToAccountDriver = {
        async signIn(h) {
          calls.push("signIn");
          hints.push(h);
          if (sc.driver.signInError) throw new Error("network");
          return {
            wait: async () =>
              (waits.shift() as SignInWait | undefined) ?? {
                outcome: "cancelled",
              },
            reopen: () => true,
            cancel: () => {
              calls.push("cancel");
            },
          };
        },
        async complete(grant, choice) {
          calls.push(`complete:${grant}:${choice.kind}`);
          return (
            sc.driver.complete ?? { outcome: "signedIn", issuedNow: false }
          );
        },
        async attach(confirm = true) {
          calls.push(confirm ? "attach" : "preview");
          return answer(confirm ? attach : preview);
        },
      };
      const m = new AddToAccountModel({
        driver,
        base: { ...BASE, licenseHolder: flow.base.licenseHolder },
        deviceKind: flow.base.deviceKind,
      });
      m.setField("name", sc.fields?.name ?? "Ada Lovelace");
      m.setField("email", sc.fields?.email ?? "ada@example.com");
      const steps: string[] = [];
      for (const action of sc.actions) {
        if (action === "submit-then-cancel") {
          const p = m.submit();
          await Promise.resolve();
          await m.cancel();
          await p;
        } else await m[action]();
        steps.push(m.snapshot.step);
      }
      expect(steps).toEqual(sc.expect.steps);
      expect(calls).toEqual(sc.expect.calls);
      expect(hints).toEqual(sc.expect.hints);
      expect(m.view().state).toBe(sc.expect.viewState);
      if (sc.expect.field) expect(m.snapshot.field).toBe(sc.expect.field);
      if (sc.expect.typedEmail)
        expect(m.snapshot.typedEmail).toBe(sc.expect.typedEmail);
      if (sc.expect.signedEmail)
        expect(m.snapshot.signedEmail).toBe(sc.expect.signedEmail);
    },
  );
});
