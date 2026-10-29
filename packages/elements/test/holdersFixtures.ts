// SDK primitives for a key with no account (UK-42.8): the key activates, an account signs in at
// once, attach answers `ok` unless `attach.code` says otherwise. The spies say what the form did.

import type {
  SignInPrimitives,
  SignInWait,
  UiInput,
} from "@polaris-key/ui-core";

export const KEY = "PKEY-TEST-KEY-0001";
export const NAME = "Mara Quill";
export const EMAIL = "mara@example.test";

export interface FakeHolders {
  primitives: SignInPrimitives;
  starts: Array<Record<string, unknown>>;
  attaches: Array<boolean | undefined>;
  cancelled: number[];
  /** A refusal `attach` answers (`license_owned`, `license_email_bound`), else ok. */
  attach: { code?: string };
}

export function fakeHolders(): FakeHolders {
  const f: FakeHolders = {
    primitives: undefined as unknown as SignInPrimitives,
    starts: [],
    attaches: [],
    cancelled: [],
    attach: {},
  };
  f.primitives = {
    async start(o) {
      f.starts.push(o as unknown as Record<string, unknown>);
      const n = f.starts.length;
      return {
        browserOpened: true,
        async wait(): Promise<SignInWait> {
          return { outcome: "signedIn", email: EMAIL };
        },
        reopen: () => true,
        cancel: () => {
          f.cancelled.push(n);
        },
      };
    },
    async attach(confirm) {
      f.attaches.push(confirm);
      return f.attach.code
        ? { kind: "refused", code: f.attach.code }
        : { kind: "ok" };
    },
    async activate() {
      return { result: "ok" };
    },
    choice: {
      licenses: async () => {
        throw new Error("unused");
      },
      devices: async () => {
        throw new Error("unused");
      },
      complete: async () => ({ outcome: "signedIn", issuedNow: false }),
      cancel: async () => {},
    },
  };
  return f;
}

/** AccountAndLicense for a license held by its key alone: the row says so and offers Add. */
export const floatingRow = (
  services: string[] = ["license", "identity"],
): UiInput =>
  ({
    elapsedMs: 60_000,
    services,
    gate: { status: "licensed" },
    licenseHolder: {},
    account: { signedIn: false, tier: "Pro" },
  }) as UiInput;
