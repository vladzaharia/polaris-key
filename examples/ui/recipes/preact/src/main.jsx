// The gate in Preact. Preact assigns a prop as a property when the element has one, so `input`
// takes the object as is, and `onpk-action` listens for the element's own event. Registering
// the elements is the import.
import { render } from "preact";
import { useState } from "preact/hooks";
import { PolarisKey } from "@polaris-key/elements";
import { viewOf } from "@polaris-key/elements/headless";

import { STATES, gateInput } from "../../shared/tidewater.js";
import "./app.css";

// ?theme=dark|light picks the scheme; anything else follows the system.
const params = new URLSearchParams(location.search);
const theme = params.get("theme");
PolarisKey.theme({
  colorScheme: theme === "dark" || theme === "light" ? theme : "system",
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

// ?state= pins the gate for one load; the default is the app behind a valid license.
const asked = params.get("state");

function App() {
  const [state, setState] = useState(STATES.includes(asked) ? asked : "ok");
  // Welcome's buttons raise pk-action; a real app hands it to the SDK. Here either one grants.
  const onAction = (e) => {
    const { key } = e.detail;
    if (key === "welcome.signIn" || key === "welcome.useKey") setState("ok");
  };
  return (
    <>
      <pk-gate input={gateInput(state)} onpk-action={onAction}>
        <main>
          <h1>Tidewater Studio</h1>
          <p>The license holds. This is the app.</p>
        </main>
      </pk-gate>
      <OwnUi />
    </>
  );
}

// Your own UI: the view model alone, no elements. Five lines.
function OwnUi() {
  const view = viewOf("PolarisKeyGate", gateInput("grace"));
  return (
    <section class="own">
      <h2>Your own UI</h2>
      <p>
        State <code>{view.state}</code>, main action{" "}
        <code>{view.decisions.primary ?? "none"}</code>
      </p>
    </section>
  );
}

render(<App />, document.getElementById("root"));
