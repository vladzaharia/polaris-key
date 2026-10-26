# I-15b Native redirect sign-in in the SDKs

| Field       | Value                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I                                                                                                                                                                     |
| Size        | 0.6–0.8 engineer-weeks                                                                                                                                                |
| Depends on  | [I-15](I-15-native-redirect.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [CC-01](CC-01-combined-plan.md) |
| Unblocks    | none                                                                                                                                                                  |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                  |
| Plan mode   | yes                                                                                                                                                                   |
| Gates       | drift-gate                                                                                                                                                            |
| Human input | none                                                                                                                                                                  |
| Repo        | vladzaharia/polaris-key                                                                                                                                               |

## Goal

The SDK clients for native redirect sign-in, split from I-15 by `plans/I-15.md` (2026-10-26): client-core helpers, Node and the Electron host, Python, Swift (iOS session, macOS loopback), Kotlin JVM, Android (Auth Tab, else Custom Tabs), Godot desktop, the React desktop adapter, and the docs page. Scope, wire shapes, slices and tests: `plans/I-15.md` §11, slices I-15b.1–.9.

## Acceptance

See plan.
