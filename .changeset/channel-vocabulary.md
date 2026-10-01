---
"@polaris-key/protocol": minor
"@polaris-key/client-core": minor
"@polaris-key/node": minor
"@polaris-key/manifest": minor
---

One channel vocabulary for the licence build gate, Release and every SDK (WIRE-CONTRACT-V3 §5.1):
`stable`, `beta`, `pr-<n>` (a `pr` grant covers every PR), a product's manual channels, and `dev`,
the gate's pseudo-channel for `0.0.0-dev*` builds. `staging` (the legacy spelling of `beta`) and
`latest` (→ `stable`) stay accepted aliases that no SDK sends.

- `@polaris-key/protocol/core` exports the vocabulary: `CHANNEL_STABLE`, `CHANNEL_BETA`,
  `CHANNEL_PR`, `CHANNEL_DEV`, `CHANNEL_ALIASES`, `CHANNEL_NAME_PATTERN`, `PR_CHANNEL_PATTERN`,
  `PR_NUMBER_MAX_DIGITS` and the `BuildChannel` type.
- `@polaris-key/client-core`: `channelForVersion` returns `BuildChannel` and maps `0.0.0-beta*`
  and `0.0.0-staging*` to `"beta"`. **`"staging"` leaves its TypeScript return type.**
- `@polaris-key/node` inherits the new default: a `0.0.0-staging*` or `0.0.0-beta*` build sends
  `X-PKey-Channel: beta`. Against a Worker older than this change, pass `channel: "staging"`.
- `@polaris-key/manifest` adds two validator warnings, `noncanonical_channel_name` and
  `reserved_channel_name`, and exports `isReservedChannelName`.
