<script>
  // Your own UI: the headless model gives the state and the actions; you draw them.
  import { viewOf } from "@polaris-key/elements/headless";

  import { gateInput } from "../../shared/tidewater.js";

  const view = viewOf("Welcome", gateInput("needs-activation"));
</script>

<section>
  <h2>Your own UI</h2>
  <p>Welcome is {view.state}.</p>
  <ul>
    {#each view.actions as a (a)}
      <li><button type="button">{a}</button></li>
    {/each}
  </ul>
</section>
