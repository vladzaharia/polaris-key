// The Tidewater fixture: the gate's input for each state, a fake SignInPrimitives that walks the
// whole sign-in (methods, the browser handoff, the license choice, Replace a device, Done) and an
// activation answer per key, so the page runs with no Worker, no network and no keys.
// `?state=` on the address pins the gate for one load; the default is needs-activation, which
// draws Welcome.
import type {
  ActivationInput,
  LicenseChoiceView,
  ReplaceView,
  SignInPrimitives,
  SignInWait,
  UiInput,
} from "@polaris-key/elements/headless";

export const STATES = [
  "needs-activation",
  "ok",
  "grace",
  "expired",
  "revoked",
] as const;
export type State = (typeof STATES)[number];

/** What the SDK's presentation source gives the kit: the product as the hero, no theme code. */
export const TIDEWATER: UiInput = {
  presentation: {
    name: "Tidewater Studio",
    developerName: "Harbor Audio",
    accent: "#369186",
    icon: false,
  },
  bundle: { slug: "tidewater", name: "Tidewater Studio" },
  platform: { os: "web", formFactor: "computer" },
  registration: "requires-license",
  capabilities: { signIn: true, keyEntry: true, deviceCode: true },
};

export function gateInput(state: State): UiInput {
  return { ...TIDEWATER, gate: { status: state, graceDaysLeft: 5 } };
}

const CHOICES: LicenseChoiceView = {
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
      origin: "account",
      access: "seats",
      seats: { used: 1, limit: 3 },
      current: false,
      expiresAt: null,
      state: "free",
      replace: null,
      freeDeviceUrl: null,
    },
    {
      id: "lic_team",
      tierName: "Team",
      name: null,
      origin: "account",
      access: "seats",
      seats: { used: 3, limit: 3 },
      current: false,
      expiresAt: null,
      state: "full",
      replace: { allowed: true, retryAfter: null },
      freeDeviceUrl: null,
    },
  ],
};

const DEVICES: ReplaceView = {
  licenseId: "lic_team",
  seats: { used: 3, limit: 3 },
  devices: [
    {
      id: "dev_laptop",
      label: "Work laptop",
      platform: "windows",
      deviceType: "computer",
      lastSeen: Date.now() / 1000 - 12 * 86_400,
      leastRecent: true,
      activeNow: false,
      thisBrowser: false,
    },
    {
      id: "dev_ipad",
      label: "Mara's iPad",
      platform: "ios",
      deviceType: "tablet",
      lastSeen: Date.now() / 1000 - 3 * 86_400,
      leastRecent: false,
      activeNow: false,
      thisBrowser: false,
    },
    {
      id: "dev_mac",
      label: "MacBook Pro",
      platform: "macos",
      deviceType: "computer",
      lastSeen: Date.now() / 1000,
      leastRecent: false,
      activeNow: true,
      thisBrowser: false,
    },
  ],
  replace: { allowed: true, retryAfter: null },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A sign-in that takes about a second in the "browser", then asks which license to use. */
export function fakeSignIn(): SignInPrimitives {
  return {
    async start() {
      let answered = false;
      return {
        browserOpened: true,
        async wait(): Promise<SignInWait> {
          if (answered) return new Promise(() => {});
          await sleep(1200);
          answered = true;
          return { outcome: "choose", grant: "g1", choices: CHOICES };
        },
        reopen: () => true,
        cancel: () => {},
      };
    },
    choice: {
      licenses: async () => CHOICES,
      devices: async () => DEVICES,
      async complete() {
        await sleep(500);
        return { outcome: "signedIn", issuedNow: false };
      },
      cancel: async () => {},
    },
    async activate(key) {
      return activation(key);
    },
  };
}

/** The key step's answer: `pkey_full…` meets the device limit, `pkey_…` activates, the rest
 *  is refused. */
export function activation(key: string): ActivationInput {
  if (/^pkey_full/.test(key))
    return {
      result: "device-limit",
      limit: 3,
      deviceCount: 3,
      manageUrl: "https://key.plrs.im/",
    };
  if (/^pkey_/.test(key))
    return { result: "ok", tier: "Pro", term: "Lifetime" };
  return { result: "unauthorized" };
}
