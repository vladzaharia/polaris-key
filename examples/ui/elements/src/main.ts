// Tidewater Studio, gated by <pk-gate>. Importing the package registers every pk-* element; the
// gate takes its input from the fixture (src/fixtures.ts). A live adapter that drives the gate
// from the SDK is not part of the kit yet, so there is no --live switch here.
import { PolarisKey, type PkGate } from "@polaris-key/elements";

import { STATES, gateInput, type State } from "./fixtures";

// The product as the hero. A live app gets this from the SDK's presentation source with no code;
// the fixture has none, so the integrator's identity says it.
PolarisKey.theme({
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

const asked = new URLSearchParams(location.search).get("state");
const state = (STATES as readonly string[]).includes(asked ?? "")
  ? (asked as State)
  : "needs-activation";

const gate = document.querySelector<PkGate>("pk-gate")!;
gate.input = gateInput(state);
// Every control raises pk-action; a real app hands it to the SDK.
gate.addEventListener("pk-action", (e) => {
  console.log("pk-action", (e as CustomEvent).detail);
});
