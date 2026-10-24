// Your own UI: the headless model gives the state and the actions; you draw them.
import { Component } from "@angular/core";
import { viewOf } from "@polaris-key/elements/headless";

import { gateInput } from "./fixture";

@Component({
  selector: "app-own-ui",
  template: `
    <section>
      <h2>Your own UI</h2>
      <p>Welcome is {{ view.state }}.</p>
      <ul>
        @for (a of view.actions; track a) {
          <li>
            <button type="button">{{ a }}</button>
          </li>
        }
      </ul>
    </section>
  `,
})
export class OwnUi {
  view = viewOf("Welcome", gateInput("needs-activation"));
}
