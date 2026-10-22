// Tidewater Studio, gated by <pk-gate> on fixtures (no Worker, no network). The live page is
// index.html: `<pk-gate config>` drives itself. Here the gate takes its input from the fixture
// (src/fixtures.ts), so this page plays the adapter's part: Sign in opens the one sign-in form (a
// sheet on a fake SignInPrimitives), Use a license key opens Activate (any `pkey_` key works,
// `pkey_full` meets the device limit), and either one ends in the app. There is no --live switch.
import {
  PolarisKey,
  type PkElement,
  type PkGate,
  type PkSignIn,
} from "@polaris-key/elements";

import {
  STATES,
  TIDEWATER,
  activation,
  fakeSignIn,
  gateInput,
  type State,
} from "./fixtures";

// The product as the hero. A live app gets this from the SDK's presentation source with no
// code; the fixture has none, so the integrator's identity says it.
PolarisKey.theme({
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

const asked = new URLSearchParams(location.search).get("state");
const pinned = (STATES as readonly string[]).includes(asked ?? "");
const gate = document.querySelector<PkGate>("pk-gate")!;
gate.input = gateInput(pinned ? (asked as State) : "needs-activation");

const open = (state: State) => {
  gate.hidden = false;
  gate.input = gateInput(state);
};

function signIn(): void {
  const form = document.createElement("pk-sign-in") as PkSignIn;
  form.presentation = "sheet";
  form.primitives = fakeSignIn();
  form.input = { ...TIDEWATER };
  document.body.append(form);
  form.show();
  // The app opens behind the sheet; Done's Start closes it.
  form.addEventListener("pk-done", () => open("ok"));
  form.addEventListener("pk-close", () => form.remove());
}

function activate(): void {
  const screen = document.createElement("pk-activate") as PkElement;
  screen.input = { ...TIDEWATER, keyField: { text: "" } };
  gate.hidden = true;
  document.body.append(screen);
  const back = () => {
    screen.remove();
    gate.hidden = false;
  };
  screen.addEventListener("pk-action", (e) => {
    const { key, value } = (e as CustomEvent).detail as {
      key: string;
      value?: string;
    };
    if (key === "common.back") return back();
    if (key === "common.done") {
      screen.remove();
      return open("ok");
    }
    if (key !== "activate.submit") return;
    screen.input = { ...screen.input, pending: "activate" };
    setTimeout(() => {
      const { pending: _pending, ...rest } = screen.input;
      screen.input = { ...rest, activation: activation(value ?? "") };
    }, 600);
  });
}

// Every control raises pk-action; a real app hands it to the SDK.
gate.addEventListener("pk-action", (e) => {
  const { key } = (e as CustomEvent).detail as { key: string };
  console.log("pk-action", (e as CustomEvent).detail);
  if (key === "welcome.signIn") signIn();
  else if (key === "welcome.useKey") activate();
  else if (key === "common.reconnect") open("ok");
});
