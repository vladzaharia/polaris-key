import { Component, CUSTOM_ELEMENTS_SCHEMA, signal } from "@angular/core";

import { gateInput, states } from "./fixture";
import { OwnUi } from "./own-ui";

@Component({
  selector: "app-root",
  imports: [OwnUi],
  // pk-* are custom elements: the schema lets the template bind them.
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <!-- [input] sets the element's property; (pk-action) is its event. -->
    <pk-gate [input]="input()" (pk-action)="onAction($any($event))">
      <main>
        <h1>Tidewater Studio</h1>
        <p>The license holds. This is the app.</p>
      </main>
    </pk-gate>
    <app-own-ui (action)="onAction($any($event))" />
  `,
})
export class App {
  // ?state= pins the gate for one load; the default is the app behind a valid license.
  private asked = new URLSearchParams(location.search).get("state") ?? "";
  readonly input = signal(
    gateInput(states.includes(this.asked) ? this.asked : "ok"),
  );

  // Welcome's buttons raise pk-action; a real app hands it to the SDK. Here either one grants.
  onAction(e: { detail: { key: string } }) {
    const { key } = e.detail;
    if (key === "welcome.signIn" || key === "welcome.useKey")
      this.input.set(gateInput("ok"));
  }
}
