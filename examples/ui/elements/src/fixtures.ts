// The Tidewater fixture: the gate's input for each state, so the page runs with no Worker, no
// network and no keys. `?state=` on the address pins the gate for one load; the default is
// needs-activation, which draws Welcome.
import type { UiInput } from "@polaris-key/elements/headless";

export const STATES = [
  "needs-activation",
  "ok",
  "grace",
  "expired",
  "revoked",
] as const;
export type State = (typeof STATES)[number];

/** What the SDK's presentation source gives the kit: the product as the hero, no theme code. */
const TIDEWATER: UiInput = {
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
