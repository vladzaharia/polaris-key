<script setup>
// Your own UI: the headless model gives the state and the actions; you draw them.
import { viewOf } from "@polaris-key/elements/headless";

import { gateInput } from "../../shared/tidewater.js";

const view = viewOf("Welcome", gateInput("needs-activation"));
</script>

<template>
  <section>
    <h2>Your own UI</h2>
    <p>Welcome is {{ view.state }}.</p>
    <ul>
      <li v-for="a in view.actions" :key="a">
        <button type="button">{{ a }}</button>
      </li>
    </ul>
  </section>
</template>
