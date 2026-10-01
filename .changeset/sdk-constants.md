---
"@polaris-key/node": minor
"@polaris-key/react": minor
---

Shared SDK constants, generated for every language by `pnpm gen:constants` (a new drift gate)
from `conformance/parity/errors.json` and `enums.json`, the feature registry, the service table
and `@polaris-key/protocol/core`. Both packages now export `ErrorCode` (every wire and client
error code, with `ERROR_CODE_KINDS`), `Feature`, `UnsupportedReason`, `Platform`, `Arch`,
`HeaderName`, `ServiceSlug` (now a value as well as a type), each with a `*_VALUES` list, and
`PROTOCOL_VERSION`, `CORPUS_VERSION`, `GATE_MATRIX_VERSION` and `FINGERPRINT_VERSION`. No code a
client raises or sends changes; the Python and Swift SDKs gain the same names.
