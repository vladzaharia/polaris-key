# winget manifest schemas 1.12.0 (vendored)

The four JSON Schemas of the winget manifest format at version 1.12.0, copied unchanged from
`microsoft/winget-cli` (`schemas/JSON/manifests/v1.12.0/`), MIT License, Copyright (c) Microsoft
Corporation. `test/storefrontsPr.test.ts` validates the winget generator's output against them
(A-18i), so a generator change that breaks the format fails CI without a network fetch.

Moving to a newer manifest version is a deliberate change: copy that version's four files here,
bump `WINGET_MANIFEST_VERSION` in `src/storefronts/winget.ts`, and regenerate the golden files.
