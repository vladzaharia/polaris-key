// The gate around an htmx region. Registering the elements is the import; htmx.org then finds
// the hx-* attributes in the app. The gate sits outside the swapped region, so a swap never
// rebuilds it: it keeps its input and its place (afterSwap proves it below).
import "htmx.org";
import { PolarisKey } from "@polaris-key/elements";

import { STATES, gateInput } from "../../shared/tidewater.js";

// ?theme=dark|light picks the scheme; anything else follows the system.
const theme = new URLSearchParams(location.search).get("theme");
PolarisKey.theme({
  colorScheme: theme === "dark" || theme === "light" ? theme : "system",
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

// ?state= pins the gate for one load; the default is the app behind a valid license.
const asked = new URLSearchParams(location.search).get("state");
const gate = document.querySelector("pk-gate");
gate.input = gateInput(STATES.includes(asked) ? asked : "ok");

// Welcome's buttons raise pk-action; a real app hands it to the SDK. Here either one grants.
gate.addEventListener("pk-action", (e) => {
  const { key } = e.detail;
  if (key === "welcome.signIn" || key === "welcome.useKey")
    gate.input = gateInput("ok");
});

// The gate survives a swap: same element, same input.
document.body.addEventListener("htmx:afterSwap", () => {
  gate.dataset.swaps = String(Number(gate.dataset.swaps ?? 0) + 1);
});
