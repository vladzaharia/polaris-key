---
"@polaris-key/manifest": minor
"@polaris-key/cli": minor
"@polaris-key/node": patch
"@polaris-key/react": patch
---

The opt-in services are now declared once, in a service table (`tools/services.json`), and every
language's slug constants are generated from it (`pnpm gen:services`; `-- --check` is a new drift
gate). No wire shape changes: the discovery document is byte-identical.

- `@polaris-key/manifest` additionally exports `DEFAULT_ENABLED_SERVICES`, `MODULE_SERVICES`,
  `SERVICE_REQUIRES` and the `LegacyModule` type, generated from the table. The table itself
  leaves `ServiceSlug`, `SERVICE_SLUGS` and `ProductModule` unchanged; the `distribution-service`
  changeset adds the sixth slug.
- `@polaris-key/cli`: `pkey init --modules` accepts the service slugs (`license`, `config`,
  `release`, `update`, `identity`) as well as the legacy module names, and the scaffold now
  writes the `modules` block in service slugs, one line per service. `normalizeModules` returns
  the service slugs the list enables, in canonical order, and the exported `ProductModule` type
  is the manifest package's (both vocabularies).
- `@polaris-key/node` and `@polaris-key/react` build their service maps from the generated
  constants; behaviour and exports are unchanged.
