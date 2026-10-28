# @polaris-key/elements

The Polaris Key UI kit as web components on Lit 3, for developers who add licensing to a web app without a framework: every component in [UI-KITS.md](https://github.com/vladzaharia/polaris-key/blob/main/docs/design/UI-KITS.md) as a `pk-*` element, in the product's accent.

## Install

The `@polaris-key` scope is published only on Polaris Key's feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/elements
```

See [Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/) for the other feeds. A page can also load the CDN module the Worker serves at `https://key.plrs.im/elements/<major>/pk.js`.

## Quick start

```ts
import "@polaris-key/elements"; // registers pk-gate, pk-welcome, pk-activate, ...
```

```html
<pk-gate><my-app></my-app></pk-gate>
```

`<pk-gate>` runs every screen the license calls for and renders the app inside; each other component is its own `pk-*` element.

- Theme with `PolarisKey.theme({...})`, `<pk-provider theme='{...}'>` or an element's `theme` property.
- Restyle with `::part(...)` and `--pk-*` custom properties.
- Build your own UI on `@polaris-key/elements/headless`, which re-exports the `@polaris-key/ui-core` models.
- The shared stylesheet is `@polaris-key/elements/styles.css`, which the React kit reuses.

## Before you start

The elements draw the views of `@polaris-key/ui-core` with the tokens and fonts of `@polaris-key/brand`. Most apps on a framework want that framework's kit instead; see [UI kits](https://key.plrs.im/docs/build/ui/).

## Cloud Sync screens

`pk-unlock-sync`, `pk-recovery-code` and `pk-ring-change` are parts: you set `input` and listen for
`pk-action` (Unlock carries the typed code as `detail.value`, Accept carries `detail.served`).
`pk-recovery-code` takes the code as the `code` property, never in `input`.
`pk-cloud-sync-status` draws Unlock sync (locked) and Review (ring changed) only when the element
names them: `handles="unlock review"`. Without it they are left out, and the element warns in
development, so no press goes nowhere.

## Docs

- [UI kits](https://key.plrs.im/docs/build/ui/)
- [Elements](https://key.plrs.im/docs/build/ui/frameworks/elements/)
- [Theming](https://key.plrs.im/docs/build/ui/theming/)

## For agents

Read [AGENTS.md](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md).

## Versions

The package carries the platform's version, in lockstep. It needs Node 22.13 or later to build.

## License

MIT
