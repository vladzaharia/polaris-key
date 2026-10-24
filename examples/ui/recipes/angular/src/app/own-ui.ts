// Your own UI: the headless model gives the state and the actions; you draw them.
import { Component, output } from "@angular/core";
import { viewOf } from "@polaris-key/elements/headless";

import { gateInput } from "./fixture";

// The app's own words for the copy keys the model asks for.
const words: Record<string, string> = {
  "welcome.signIn": "Sign in",
  "welcome.useKey": "Use a license key",
};

@Component({
  selector: "app-own-ui",
  template: `
    <section class="own" aria-labelledby="own-ui">
      <h2 id="own-ui">Your own UI</h2>
      <p>The same Welcome, drawn by the app.</p>
      <ul>
        @for (key of keys; track key) {
          <li>
            <button
              type="button"
              [attr.data-primary]="key === view.decisions.primary ? '' : null"
              (click)="action.emit({ detail: { key } })"
            >
              {{ words[key] }}
            </button>
          </li>
        }
      </ul>
    </section>
  `,
})
export class OwnUi {
  readonly action = output<{ detail: { key: string } }>();
  readonly words = words;
  view = viewOf("Welcome", gateInput("needs-activation"));
  keys = Object.keys(words).filter((k) => this.view.copy.includes(k));
}
