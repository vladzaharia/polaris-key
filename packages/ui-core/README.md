# @polaris-key/ui-core

The headless layer every Polaris Key JavaScript UI kit renders from, for developers building a kit or their own UI on the Polaris Key SDKs. It has no DOM, React or Lit dependency.

## Install

The `@polaris-key` scope is published only on Polaris Key's feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/ui-core
```

See [Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/) for the other feeds.

## Quick start

```ts
import { viewOf } from "@polaris-key/ui-core";

const view = viewOf("Activate", { keyField: { text: "pkey_tidewater_" } });
view.state; // "typing"
view.decisions.primary; // "activate.submit"
```

A view is plain data: the state, the catalog keys it shows, its actions, the arguments its strings take, and the design language's decisions for that state (the one primary, the refusal tone, the error slot, the initial focus and the link verdict).

The package exports:

- **`viewOf(component, input)`**: one view model per component in [UI-KITS.md](https://github.com/vladzaharia/polaris-key/blob/main/docs/design/UI-KITS.md).
- **`SignInModel`**: the sign-in form's state machine over the SDK primitives, with `presentation` and `replace` as inputs. Two ways to let go of it:
  - `dispose()` stops following the session and nothing more: no later answer is applied, and the request and any license-choice grant stay open on the server. A binding calls it when its view unmounts, so a re-mount (React's StrictMode, a Lit element moved in the DOM) can follow the same sign-in again with a new model.
  - `cancel()` ends the sign-in: it cancels the request and the grant and returns the form to its first step. A binding calls it only when the person cancels, or when the host closes the form for good.
- **`createStore`**: snapshot and `subscribe`, with the "deliver on the UI thread" hook.
- **`Copy`**: the catalog lookup and the ICU-subset formatter over injected tables (`@polaris-key/brand/kit-copy`).
- **`linkVerdict`** and **`LOADING_DELAY_MS`**: the validating link opener and the loading delay.
- **`@polaris-key/ui-core/theme`**: theme resolution and the `ProductIdentity` resolver over the SDK's `PresentationSource`. Every accent runs through `@polaris-key/brand`'s `resolveAccent`, an optional peer that only this subpath needs.
- **`@polaris-key/ui-core/terminal`**: the Node terminal kit's text views.

`conformance/corpus/v2/ui-matrix.json` pins every model for every language.

## Before you start

Most apps want a UI kit, not this headless layer. See [UI kits](https://key.plrs.im/docs/build/ui/) for the kit that fits your framework. The JavaScript kits that render from this package:

- [`@polaris-key/elements`](https://github.com/vladzaharia/polaris-key/tree/main/packages/elements#readme): web components.
- [`@polaris-key/react`](https://github.com/vladzaharia/polaris-key/tree/main/packages/sdk-react#readme): the React kit.
- [`@polaris-key/node`](https://github.com/vladzaharia/polaris-key/tree/main/packages/sdk-node#readme): the Node SDK and terminal kit.

## Docs

- [UI kits](https://key.plrs.im/docs/build/ui/)
- [Theming](https://key.plrs.im/docs/build/ui/theming/)
- [Localization](https://key.plrs.im/docs/build/ui/localization/)
- [Terminal (Node)](https://key.plrs.im/docs/build/ui/frameworks/terminal-node/)
- [Your own UI (Node)](https://key.plrs.im/docs/build/sdks/node/your-own-ui/)

## For agents

Read [AGENTS.md](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md).

## Versions

The package carries the platform's version, in lockstep. It needs Node 22.13 or later.

## License

MIT
