---
"@polaris-key/protocol": minor
"@polaris-key/jws": minor
"@polaris-key/client-core": minor
"@polaris-key/node": minor
"@polaris-key/react": minor
---

Canonical client metadata header values (WIRE-CONTRACT-V3 §5.2) and one config-resolution rule
for every SDK (§2.2.1), pinned by the new `headers.json` and `config-matrix.json` corpus files.

- `@polaris-key/protocol/core` exports `PLATFORM_SPELLINGS` and `ARCH_SPELLINGS`, every runtime
  spelling mapped to its canonical `X-PKey-Platform` / `X-PKey-Arch` value.
- `@polaris-key/client-core` gains `canonicalPlatform` and `canonicalArch` (also the `./headers`
  subpath). Config layers read own properties only, so a key named `constructor` or `toString`
  is an ordinary key. An environment value is parsed only when it is one strict JSON text (no
  duplicate member names, no member name holding U+0000, no lone surrogate, every number zero
  or of magnitude 10^−307 up to below 10^308, at most 64 levels deep); otherwise it is the raw
  string, and reading never throws. `listUserEntries` now takes the `ResolveContext` and lists
  each document entry with its resolved value.
- `@polaris-key/jws` exports `hasDuplicateKeys`.
- `@polaris-key/node` sends `X-PKey-Platform`/`X-PKey-Arch` as canonical values (omitted when
  unmapped) and `X-PKey-SDK: node`; `SDK_NAME` stays the package name and is not sent.
- `@polaris-key/react` sends `X-PKey-Platform: web` and `X-PKey-SDK: react`, and
  `listUserConfig()` no longer lists keys that only a local override supplies.

A host relying on Swift's trailing commas, JS or Python duplicate resolution, Python's `NaN`, a
lone surrogate, a member name holding U+0000, a number of magnitude 10^308 or more (or a
non-zero one below 10^−307), or a value nested more than 64 deep in an environment variable now
gets the raw string.
