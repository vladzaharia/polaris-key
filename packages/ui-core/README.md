# @polaris-key/ui-core

The headless layer every Polaris Key JavaScript UI kit renders from (UI-KITS.md §1.3 layer c,
§5.1): the web components, the React kit, the Electron main process and the Node terminal. It has
no DOM, React or Lit dependency.

- **`viewOf(component, input)`**: one view model per UI-KITS.md §4.1 component. A view is plain
  data: the state, the catalog keys it shows, its actions, the arguments its strings take, and
  the design language's decisions for that state (the one primary, the refusal tone, the error
  slot, the initial focus and the link verdict).
- **Display facts**: a few strings name a value no SDK result carries as text (a tier, a download
  size, the date grace ends, the app's version). `UiInput` has an optional member for each,
  holding text its producer formatted for the kit's locale, and a model passes it into the
  string as it is. ui-core never invents one: a screen drawn without it shows the string's
  `{name}`, and `test/uiMatrix.test.ts` ("no raw placeholder") names each state that does when
  it is drawn from its bare corpus row. The byte counts the boot stage carries are numbers, so
  the model formats them in `UiInput.locale`. A view's `keyArgs` hold the arguments one key takes
  in place of `args` (the update prompt's "You have {version}" is the installed version, its
  title the new one).
- **`SignInModel`**: the one sign-in form's state machine over the SDK primitives of
  `plans/I-04.md` §G.9, with `presentation` and `replace` as inputs. Two ways to let go of it:
  - `dispose()` stops following the session and nothing more: no later answer is applied, and
    the request and any license-choice grant stay open on the server. A binding calls it when
    its view unmounts, so a re-mount (React's StrictMode, a Lit element moved in the DOM) can
    follow the same sign-in again with a new model.
  - `cancel()` ends the sign-in: it cancels the request and the grant and returns the form to
    its first step. A binding calls it only when the person cancels, or when the host closes
    the form for good.
- **`createStore`**: snapshot and `subscribe`, with the "deliver on the UI thread" hook.
- **`Copy`**: the catalog lookup and the ICU-subset formatter over injected tables
  (`@polaris-key/brand/kit-copy`).
- **`linkVerdict`**, **`LOADING_DELAY_MS`**: DL14's validating opener and DL7's loading delay.
- **`@polaris-key/ui-core/theme`**: theme resolution and the `ProductIdentity` resolver over the
  SDK's `PresentationSource`, with every accent run through `@polaris-key/brand`'s
  `resolveAccent` (an optional peer: only this subpath needs it).
- **`@polaris-key/ui-core/terminal`**: the Node terminal kit's text views.

`conformance/corpus/v2/ui-matrix.json` pins every model for every language;
`test/uiMatrix.test.ts` runs every row of it.

```ts
import { viewOf } from "@polaris-key/ui-core";

const view = viewOf("Activate", { keyField: { text: "pkey_tidewater_" } });
view.state; // "typing"
view.decisions.primary; // "activate.submit"
```
