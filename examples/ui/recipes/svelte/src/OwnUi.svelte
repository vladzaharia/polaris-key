<script>
  // Your own UI: the headless model gives the state and the actions; you draw them.
  import { viewOf } from "@polaris-key/elements/headless";

  import { gateInput } from "../../shared/tidewater.js";

  let { onAction } = $props();

  const view = viewOf("Welcome", gateInput("needs-activation"));
  // The app's own words for the copy keys the model asks for.
  const words = {
    "welcome.signIn": "Sign in",
    "welcome.useKey": "Use a license key",
  };
  const keys = Object.keys(words).filter((k) => view.copy.includes(k));
</script>

<section class="own" aria-labelledby="own-ui">
  <h2 id="own-ui">Your own UI</h2>
  <p>The same Welcome, drawn by the app.</p>
  <ul>
    {#each keys as key (key)}
      <li>
        <button
          type="button"
          data-primary={key === view.decisions.primary ? "" : undefined}
          onclick={() => onAction({ detail: { key } })}
        >
          {words[key]}
        </button>
      </li>
    {/each}
  </ul>
</section>
