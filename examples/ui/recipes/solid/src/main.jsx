// The gate in Solid. Solid sets a custom element's attributes as strings unless told otherwise:
// `prop:input` assigns the property (an object), `on:pk-action` listens for the element's own
// event. Registering the elements is the import.
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { PolarisKey } from "@polaris-key/elements";
import { viewOf } from "@polaris-key/elements/headless";

import { STATES, gateInput } from "../../shared/tidewater.js";
import "./app.css";

// ?theme=dark|light picks the scheme; anything else follows the system.
const params = new URLSearchParams(location.search);
const theme = params.get("theme");
if (theme === "dark" || theme === "light")
  document.body.style.colorScheme = theme;
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
  const [state, setState] = createSignal(STATES.includes(asked) ? asked : "ok");
  // Welcome's buttons raise pk-action; a real app hands it to the SDK. Here either one grants.
  const onAction = (e) => {
    const { key } = e.detail;
    if (key === "welcome.signIn" || key === "welcome.useKey") setState("ok");
  };
  return (
    <>
      <pk-gate prop:input={gateInput(state())} on:pk-action={onAction}>
        <main>
          <h1>Tidewater Studio</h1>
          <p>The license holds. This is the app.</p>
        </main>
      </pk-gate>
      <OwnUi onAction={onAction} />
    </>
  );
}

// Your own UI: the view model alone, no elements. The app draws Welcome in its own words.
const words = {
  "welcome.signIn": "Sign in",
  "welcome.useKey": "Use a license key",
};

function OwnUi({ onAction }) {
  const view = viewOf("Welcome", gateInput("needs-activation"));
  const keys = Object.keys(words).filter((k) => view.copy.includes(k));
  return (
    <section class="own" aria-labelledby="own-ui">
      <h2 id="own-ui">Your own UI</h2>
      <p>The same Welcome, drawn by the app.</p>
      <ul>
        {keys.map((key) => (
          <li>
            <button
              type="button"
              data-primary={key === view.decisions.primary ? "" : undefined}
              onClick={() => onAction({ detail: { key } })}
            >
              {words[key]}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

render(() => <App />, document.getElementById("root"));
