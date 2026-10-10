# @polaris-key/elements

The Polaris Key UI kit as web components on Lit 3: every component of
[UI-KITS.md §4.1](../../docs/design/UI-KITS.md#41-the-set-and-the-names) as a `pk-*` element, in
the product's accent, over the headless models of [`@polaris-key/ui-core`](../ui-core).

```html
<script type="module" src="https://key.plrs.im/elements/1/pk.js"></script>
<pk-gate><my-app></my-app></pk-gate>
```

```sh
pnpm add @polaris-key/elements
```

```ts
import "@polaris-key/elements"; // registers pk-gate, pk-welcome, pk-activate, …
```

Theme with `PolarisKey.theme({…})`, `<pk-provider theme='{…}'>` or an element's `theme` property;
restyle with `::part(…)` and `--pk-*` custom properties; build your own UI on
`@polaris-key/elements/headless`. Docs: `/docs/build/ui/`.
