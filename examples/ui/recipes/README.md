# UI-kit recipes

The Polaris Locker gate in other front ends, each on the Tidewater fixtures (no Worker, no
network, no keys). A standalone pnpm workspace: not part of the repo's workspace or lockfile.

| Recipe     | Shows                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `htmx/`    | `<pk-gate>` around an `hx-get` region; the gate survives a swap                                   |
| `vue/`     | Vue 3: `:input.prop`, `@pk-action`, `isCustomElement`; your own UI over `headless`                |
| `svelte/`  | Svelte 5: `input` as a property, `on:pk-action`, `customElement` off; your own UI over `headless` |
| `solid/`   | `prop:input` and `on:pk-action`; your own UI over `headless`                                      |
| `preact/`  | native properties (`input`) and `onpk-action`; your own UI over `headless`                        |
| `angular/` | Angular 22: `CUSTOM_ELEMENTS_SCHEMA`, `[input]`, `(pk-action)`; your own UI over `headless`       |

## Run

```sh
pnpm --filter @polaris-key/elements build        # from the repo root, once
pnpm install --frozen-lockfile --dir examples/ui/recipes
pnpm --dir examples/ui/recipes -r build
pnpm --dir examples/ui/recipes/htmx dev          # ?theme=dark|light, ?state=needs-activation|ok|grace|expired|revoked
```

Lint it, both colour schemes at a phone and a desktop size:

```sh
pnpm ui:lint --html=examples/ui/recipes/htmx/dist/index.html --size=390x844,1440x900 --scheme=dark,light
```

## Rules

- Every dependency is pinned to an exact release at least 14 days old (`minimumReleaseAge` in
  `pnpm-workspace.yaml`; no ranges, no `latest`). After changing one, run a plain `pnpm install`
  here and commit `pnpm-lock.yaml`.
- `@polaris-key/elements` is aliased to the repo's build (`alias.mjs`) until it is published.
- No recipe styles into a shadow root: use `--pk-*` custom properties, `::part()` and `theme`.
