// The Tidewater fixture, as the gate's input: no Worker, no network, no keys. The SDK's
// presentation source gives a live app this identity with no code.
export const TIDEWATER = {
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

export const STATES = ["needs-activation", "ok", "grace", "expired", "revoked"];

export const gateInput = (state) => ({
  ...TIDEWATER,
  gate: { status: state, graceDaysLeft: 5 },
});
