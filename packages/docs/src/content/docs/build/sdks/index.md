---
title: "SDKs"
description: "One wire contract, five surfaces — the shared core-plus-sub-client shape, fail-closed capability negotiation, and the PKEY_CONFIG_* env convention."
sidebar:
  order: 4
  label: "SDKs"
---

There is **one** wire contract — the frozen compact-JWS envelope described in
[The wire contract](/docs/build/wire/) — and **five** surfaces that speak it: four language
SDKs, and a CLI built from the same core as a fifth. Whichever one your product links against,
it verifies the identical signed documents, exposes the identical `core` +
per-service-sub-client shape, and fails closed the same way when a capability is not on.

| Surface | Package                                                 | Page                                           |
| ------- | ------------------------------------------------------- | ---------------------------------------------- |
| Node    | `@polaris-key/node`                                     | [Node](/docs/build/sdks/node/)                 |
| React   | `@polaris-key/react`                                    | [React](/docs/build/sdks/react/)               |
| Python  | `polaris-key` (PyPI)                                    | [Python](/docs/build/sdks/python/)             |
| Swift   | `PolarisKey` (SwiftPM)                                  | [Swift](/docs/build/sdks/swift/)               |
| CLI     | `@polaris-key/node/cli`, `polaris-key`'s console script | shipped inside the Node and Python pages above |

Node and React additionally share one isomorphic implementation of the verification, gate,
trust, config-resolution and boot-stage logic, `@polaris-key/client-core`, rather than each reimplementing
it; Python and Swift carry independent ports proven identical by the same cross-language
conformance corpus. See `packages/client-core/README.md` for why that split exists, and
[The wire contract](/docs/build/wire/) for the envelope itself.

## The shared shape

Every SDK composes one always-on **Core** (device id, credential, trust, the offline cache,
`sync()`) with one **sub-client per enabled service**, addressed as `client.<service>.<verb>`:

| Sub-client        | Owns                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `client.license`  | activation, enrollment, deactivation, status, entitlements, profile                                 |
| `client.config`   | the signed config document + layered resolution (`getConfig`, `getSecret`), edge-mint (`mintToken`) |
| `client.devices`  | registration, the roster, fingerprint/facts                                                         |
| `client.identity` | device-code sign-in (`beginSignIn`, `waitForSignIn`)                                                |
| `client.release`  | changelog, install script, artifact URLs                                                            |
| `client.update`   | version check, the Sparkle appcast URL                                                              |

Distribution has no sub-client: storefront clients read its feeds directly, and the SDKs only
carry its slug in their capability map.

A handful of calls — `status`/`isLicensed`, `getConfig`, `sync`, `importBundle` — are also kept
on the top-level client, for the code a host writes before it knows which service it's talking
to. Verbs and field names follow each language's own convention (`activateWithKey` in
TypeScript, `activate_with_key` in Python, `activate(key:)` in Swift), but the _shape_ —
Core plus one sub-client per service, the same services in the same order — never
changes, which is what makes the SDK READMEs on the following pages readable as one document
in four dialects rather than four unrelated APIs.

## Capability negotiation, fail-closed

None of the SDKs will let a product talk to a service it doesn't run. `client.capabilities()`
(or the equivalent property) resolves with **no network call**, in one fixed precedence:

1. a discovery document loaded this session (`await client.discover()`) — always wins;
2. `expectedServices` (or `expected_services`/`expectServices`) — what the build was compiled
   expecting;
3. the suite default: **License + Config on**, Release/Update/Identity **off**.

A sub-client whose service is off refuses every call with a `PolarisError` (`service-unavailable`
or the language's equivalent) rather than silently no-op-ing, and a product with License off
reports gate status **`not-applicable`** with `isLicensed()`/`is_licensed()` true — a
config-only product boots usable instead of sitting on "needs activation" forever. Name
`expectedServices` for what the build actually ships against: an unreachable control plane
should never be able to silently take a service away by omission.

## The `PKEY_CONFIG_*` env convention

Every SDK layers an environment override into config resolution at the same precedence:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

A key's env var is the prefix (default `PKEY_CONFIG_`) plus the key with every `.` replaced by
`__`:

| Config key        | Env var                        |
| ----------------- | ------------------------------ |
| `run.concurrency` | `PKEY_CONFIG_run__concurrency` |
| `quality.floor`   | `PKEY_CONFIG_quality__floor`   |

Nothing else about the name changes, case included, and a variable that is set counts even when
it is empty. The value is the parsed JSON value when the raw string is one **strict** JSON text
(`4` → number, `true` → boolean, `[…]`/`{…}` → array/object, `"…"` → string), and otherwise the
raw string, unchanged; reading a variable never errors (WIRE-CONTRACT-V3 §2.2.1 rule 2, pinned
by `conformance/corpus/v2/config-matrix.json`). Strict means RFC 8259 with no trailing comma,
`NaN`, `Infinity`, leading zero or byte order mark, plus: no two members of the same name (names
compare by Unicode scalar value, never normalized); no member name holding U+0000; no lone
surrogate; every number zero or of magnitude 10^−307 up to below 10^308, judged from its
digits; and at most 64 levels of nesting. Noncharacters such as U+FFFF are ordinary characters.
Every SDK reaches the same verdict for every input. Two parsed values are a declared
representation limit (WIRE-CONTRACT-V3 §10): Swift keeps only the first of two canonically
equivalent member names, and Godot's number reader is not correctly rounded.

`enforced`/`hidden` keys ignore the environment layer entirely — the remote value always wins
for those, in every language. React is the one partial exception: a browser has no environment
to read, so the env layer only ever resolves on the Node side of a desktop build, never in the
browser transport (rule 3). A settings UI's list (`listUserConfig`) holds every document entry
except `hidden` ones, each with its resolved value; a key that only a local override or the
environment supplies is not listed (rule 4).

## In this section

- **[Node](/docs/build/sdks/node/)** — the reference implementation; also ships the framework-
  agnostic CLI core other JS tools embed.
- **[React](/docs/build/sdks/react/)** — one hook API over two transports (desktop-over-Node,
  browser-OIDC), plus brandable drop-in UI.
- **[Python](/docs/build/sdks/python/)** — mirrors the Node SDK module for module; three CLI
  front ends (argparse, click, typer) over one command core.
- **[Swift](/docs/build/sdks/swift/)** — native CryptoKit verification, per-service SwiftPM
  targets so an app links only what it ships.
