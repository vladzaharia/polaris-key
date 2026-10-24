<script setup>
import { ref } from "vue";

import { STATES, gateInput } from "../../shared/tidewater.js";
import OwnUi from "./OwnUi.vue";

// ?state= pins the gate for one load; the default is the app behind a valid license.
const asked = new URLSearchParams(location.search).get("state");
const input = ref(gateInput(STATES.includes(asked) ? asked : "ok"));

// Welcome's buttons raise pk-action; a real app hands it to the SDK. Here either one grants.
function onAction(e) {
  const { key } = e.detail;
  if (key === "welcome.signIn" || key === "welcome.useKey")
    input.value = gateInput("ok");
}
</script>

<template>
  <!-- .prop sets the property (an object cannot ride an attribute); @pk-action is the event. -->
  <pk-gate :input.prop="input" @pk-action="onAction">
    <main>
      <h1>Tidewater Studio</h1>
      <p>The license holds. This is the app.</p>
      <OwnUi />
    </main>
  </pk-gate>
</template>
