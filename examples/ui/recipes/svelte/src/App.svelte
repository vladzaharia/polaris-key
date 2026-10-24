<script>
  import { STATES, gateInput } from "../../shared/tidewater.js";
  import OwnUi from "./OwnUi.svelte";

  // ?state= pins the gate for one load; the default is the app behind a valid license.
  const asked = new URLSearchParams(location.search).get("state");
  let input = $state(gateInput(STATES.includes(asked) ? asked : "ok"));

  // Welcome's buttons raise pk-action; a real app hands it to the SDK. Here either one grants.
  function onAction(e) {
    const { key } = e.detail;
    if (key === "welcome.signIn" || key === "welcome.useKey")
      input = gateInput("ok");
  }
</script>

<!-- On a custom element Svelte sets `input` as a property; onpk-action is the event. -->
<pk-gate {input} onpk-action={onAction}>
  <main>
    <h1>Tidewater Studio</h1>
    <p>The license holds. This is the app.</p>
  </main>
</pk-gate>
<OwnUi {onAction} />
