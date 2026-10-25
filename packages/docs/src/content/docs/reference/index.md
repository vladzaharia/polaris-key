---
title: "Reference"
description: "Look up a command, a code, a setting, a route or a byte format, and see what each page is generated from."
type: "overview"
lastReviewed: "2026-10-16"
sidebar:
  order: 0
---

Look things up here. Most pages are generated from the source and byte-compared in CI, so they can't drift from the code they describe.

## Generated from source

| Page                                                           | Generated from                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| [pkey CLI](/docs/reference/cli/)                               | the CLI's command table                                       |
| [Manifest validation codes](/docs/reference/validation-codes/) | every emit site in `validateManifestDocuments`                |
| [ConfigEntry](/docs/reference/config-entry/)                   | `@polaris-key/catalog`'s types, verbatim                      |
| [Wire error codes](/docs/reference/error-codes/)               | the protocol taxonomy and the worker's `ErrorCode` map        |
| [Public route table](/docs/reference/routes/)                  | the OpenAPI spec, which is coverage-tested against the router |
| [Channels](/docs/reference/channels/)                          | the distribution channel catalogue                            |
| [SDK parity matrix](/docs/reference/parity/)                   | the feature registry and every SDK's `parity.json`            |
| [SDK API names](/docs/reference/api-names/)                    | the canonical name of every SDK concept, per SDK, and the 0.9 removals |
| [Settings reference](/docs/reference/settings/)                | the settings registry                                         |
| [Generators](/docs/reference/generators/)                      | the generator registry                                        |

## Protocol

The frozen wire format every SDK verifies. These pages summarize wire contract v4.

| Page                                                                     | Covers                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| [The protocol](/docs/reference/protocol/)                                | The envelope, the documents and the version counters |
| [Conformance corpus v2](/docs/reference/protocol/corpus/)                | Case counts, generated from the corpus files         |
| [Fingerprint constants](/docs/reference/protocol/fingerprint-constants/) | The frozen hash domains, generated from the corpus   |

## Written by hand

| Page                                                    | Covers                                                   |
| ------------------------------------------------------- | -------------------------------------------------------- |
| [HTTP API](/docs/reference/http-api/)                   | Base URL, authentication, errors, versioning, pagination |
| [Polaris Locker API](/docs/reference/portal-api/)               | Polaris Locker's routes                             |
| [What apps collect](/docs/reference/what-apps-collect/) | What a product collects from a device, and why           |
