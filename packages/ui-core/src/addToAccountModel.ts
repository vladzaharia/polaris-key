// `AddToAccountModel`: the state machine behind AddToAccount (UK-42.4, holders.ts). A license that
// a key activated is floating; this adds it to an account. The person types a name and an email
// (they live only here, never in the views' input), the browser confirms the email, and the license
// is attached:
//
//   form → busy → added | owned | email-bound | other-account | failed   (invalid: a field is wrong)
//
// The model runs over `AddToAccountDriver`, three calls both gates implement over their SDK
// primitives (`driverOf`): sign in with the hints, keep this device's license, attach. A sign-in
// that ends `signedIn` with no choice goes straight to attach. The hints only prefill the page:
// nothing here sends a code. `attach()` carries no address; the kit masks `profile.email` itself.

import { maskEmail } from "./format.js";
import { contextOf, type UiInput } from "./input.js";
import { addToAccountView } from "./models/holders.js";
import type {
  AttachOutcome,
  ChoiceComplete,
  SignInPrimitives,
  SignInSessionHandle,
} from "./signInModel.js";
import { createStore, type Deliver, type Store } from "./store.js";
import type { View } from "./view.js";

/** The hints the sign-in carries: the typed email and name, and the purpose. */
export interface AddToAccountHints {
  loginHint: string;
  nameHint: string;
  purpose: "attach";
}

/** The narrow interface both gates implement. */
export interface AddToAccountDriver {
  signIn(hints: AddToAccountHints): Promise<SignInSessionHandle>;
  /** Keep this device's license in the signed-in account (`{kind: "keep"}`). */
  complete(grant: string, choice: { kind: "keep" }): Promise<ChoiceComplete>;
  /** `confirm: false` previews (nothing is written); the default writes. */
  attach(confirm?: boolean): Promise<AttachOutcome>;
}

/** The driver over a form's primitives. A missing member is the typed `planned` failure. */
export function driverOf(p: SignInPrimitives): AddToAccountDriver {
  return {
    signIn: (hints) =>
      p.start({
        channel: "browser",
        licenseChoice: "app",
        hints,
      }),
    complete: async (grant, choice) => {
      if (!p.choice) throw new Error("planned");
      return p.choice.complete(grant, choice);
    },
    attach: async (confirm = true) => {
      if (!p.attach) throw new Error("planned");
      return p.attach(confirm);
    },
  };
}

export type AddToAccountModelStep =
  | "form"
  | "invalid"
  | "busy"
  | "added"
  | "owned"
  | "email-bound"
  | "other-account"
  | "failed";

export interface AddToAccountSnapshot {
  step: AddToAccountModelStep;
  /** `invalid`: the field to fix. */
  field?: "name" | "email" | "both";
  /** `other-account`: both emails, masked (never the full address). */
  typedEmail?: string;
  signedEmail?: string;
  name: string;
  email: string;
}

export interface AddToAccountOptions {
  driver?: AddToAccountDriver;
  /** Everything else the views read (identity, platform, services, `licenseHolder`). */
  base?: UiInput;
  deliver?: Deliver;
  /** The device kind already worded, for the lines that name this device. */
  deviceKind?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AddToAccountModel {
  readonly store: Store<AddToAccountSnapshot>;
  private readonly driver: AddToAccountDriver | undefined;
  private readonly deviceKind: string | undefined;
  private handle: SignInSessionHandle | null = null;
  /** Bumped when an attempt ends, so a late answer from an old one is dropped. */
  private epoch = 0;
  /** The account sign-in finished: Try again then attaches again, with no second sign-in. */
  private signedIn = false;
  /** The email of the account that signed in, when the sign-in named it. */
  private signedEmail: string | undefined;

  constructor(options: AddToAccountOptions = {}) {
    this.driver = options.driver;
    this.base = options.base ?? {};
    this.deviceKind = options.deviceKind;
    this.store = createStore<AddToAccountSnapshot>(
      { step: "form", name: "", email: "" },
      { deliver: options.deliver },
    );
  }

  get snapshot(): AddToAccountSnapshot {
    return this.store.get();
  }

  /** The identity, platform and `licenseHolder` the views read; set it when they change. */
  base: UiInput;

  /** The views' input: the base with the step on top. Name and email are not in it. */
  input(): UiInput {
    const { step, field, typedEmail, signedEmail } = this.store.get();
    return {
      ...this.base,
      addToAccount: {
        step,
        ...(field ? { field } : {}),
        ...(step === "other-account" && typedEmail ? { typedEmail } : {}),
        ...(step === "other-account" && signedEmail ? { signedEmail } : {}),
        ...(this.deviceKind ? { deviceKind: this.deviceKind } : {}),
      },
    };
  }

  view(): View<"AddToAccount"> {
    return addToAccountView(contextOf(this.input()));
  }

  /** The person typed in a field; an `invalid` step goes back to `form`. */
  setField(field: "name" | "email", value: string): void {
    this.store.set((s) =>
      s.step === "busy"
        ? s
        : {
            ...s,
            [field]: value,
            step: s.step === "invalid" ? "form" : s.step,
            field: undefined,
          },
    );
  }

  /** True when Continue (or Try again) would start the browser sign-in right now: the fields are
   *  valid and no sign-in has finished. A gate arms its tab inside the press only then. */
  get willOpenBrowser(): boolean {
    const { step, name, email } = this.store.get();
    if (step === "busy" || step === "other-account") return false;
    return name.trim() !== "" && EMAIL.test(email.trim()) && !this.signedIn;
  }

  /** Continue: check the fields, then sign in and attach. */
  async submit(): Promise<void> {
    const s = this.store.get();
    if (s.step === "busy") return;
    const name = s.name.trim();
    const email = s.email.trim();
    const badName = name === "";
    const badEmail = !EMAIL.test(email);
    if (badName || badEmail) {
      this.store.set({
        ...s,
        step: "invalid",
        field: badName && badEmail ? "both" : badName ? "name" : "email",
      });
      return;
    }
    await this.run(name, email);
  }

  /** Try again after `failed`: the same attempt, kept fields included. */
  async tryAgain(): Promise<void> {
    const step = this.store.get().step;
    // A different account signed in: back to the form, the fields kept, to sign in again.
    if (step === "other-account") return this.cancel();
    if (step !== "failed") return;
    await this.submit();
  }

  /** Cancel: back to the form with the fields kept, any sign-in in flight let go. */
  async cancel(): Promise<void> {
    const h = this.handle;
    this.end();
    this.signedIn = false;
    this.signedEmail = undefined;
    this.store.set((s) => ({
      ...s,
      step: "form",
      field: undefined,
      typedEmail: undefined,
      signedEmail: undefined,
    }));
    if (h) await Promise.resolve(h.cancel()).catch(() => {});
  }

  private end(): void {
    this.epoch++;
    this.handle = null;
  }

  private set(step: AddToAccountModelStep, epoch: number): void {
    if (epoch === this.epoch)
      this.store.set((s) => ({ ...s, step, field: undefined }));
  }

  private async run(name: string, email: string): Promise<void> {
    const d = this.driver;
    if (!d) throw new Error("ui-core AddToAccountModel: no driver");
    // Try again lets the previous sign-in go before it starts another.
    const prev = this.handle;
    this.end();
    if (prev) void Promise.resolve(prev.cancel()).catch(() => {});
    const epoch = this.epoch;
    this.store.set((s) => ({ ...s, step: "busy", field: undefined }));
    try {
      if (!this.signedIn && !(await this.signIn(d, name, email, epoch))) return;
      if (epoch !== this.epoch) return;
      this.signedIn = true;
      // Preview first: nothing is written until the account is the one the person typed.
      const preview = await d.attach(false);
      if (epoch !== this.epoch) return;
      if (preview.kind === "refused") {
        if (preview.code === "account_required") this.signedIn = false;
        this.set(stepOf(preview), epoch);
        return;
      }
      if (
        this.signedEmail !== undefined &&
        this.signedEmail.trim().toLowerCase() !== email.toLowerCase()
      ) {
        // A different account signed in than the email typed: the license is added nowhere, and
        // Try again goes back to the form. Both emails are shown masked, never in full.
        this.signedIn = false;
        if (epoch === this.epoch)
          this.store.set((s) => ({
            ...s,
            step: "other-account",
            field: undefined,
            typedEmail: maskEmail(email),
            signedEmail: maskEmail(this.signedEmail),
          }));
        return;
      }
      const r = await d.attach(true);
      if (epoch !== this.epoch) return;
      // No account session after all: Try again signs in again.
      if (r.kind === "refused" && r.code === "account_required")
        this.signedIn = false;
      this.set(stepOf(r), epoch);
    } catch {
      this.set("failed", epoch);
    }
  }

  /** True when the account sign-in ended signed in; otherwise the step is already set. */
  private async signIn(
    d: AddToAccountDriver,
    name: string,
    email: string,
    epoch: number,
  ): Promise<boolean> {
    const handle = await d.signIn({
      loginHint: email,
      nameHint: name,
      purpose: "attach",
    });
    if (epoch !== this.epoch) {
      void Promise.resolve(handle.cancel()).catch(() => {});
      return false;
    }
    this.handle = handle;
    for (;;) {
      const r = await handle.wait();
      if (epoch !== this.epoch) return false;
      switch (r.outcome) {
        case "pending":
          continue;
        case "signedIn":
          this.signedEmail = r.email;
          // Settled: nothing left to cancel on Try again.
          this.handle = null;
          return true;
        case "choose": {
          const c = await d.complete(r.grant, { kind: "keep" });
          if (epoch !== this.epoch) return false;
          if (c.outcome === "signedIn") {
            this.signedEmail = undefined;
            return true;
          }
          this.set("failed", epoch);
          return false;
        }
        case "cancelled":
          this.set("form", epoch);
          return false;
        case "expired":
          this.set("failed", epoch);
          return false;
      }
    }
  }
}

/** The step an attach answer lands on. */
function stepOf(r: AttachOutcome): AddToAccountModelStep {
  if (r.kind === "ok") return "added";
  switch (r.code) {
    case "license_owned":
      return "owned";
    case "license_email_bound":
      return "email-bound";
    default:
      // `account_required` and anything else: Try again.
      return "failed";
  }
}
