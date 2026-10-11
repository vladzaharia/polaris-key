---
title: "Upgrade to 0.9"
description: "Move an integration from 0.8 to 0.9, change by change."
type: "how-to"
status: "stub"
sidebar:
  hidden: true
pagefind: false
head:
  - tag: meta
    attrs:
      name: robots
      content: noindex
---

## Service registration

| Replaces                               | Replacement                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.pkey/product` `devices.registration` | Enable License for licence registration, Identity for sign-in registration, or neither for open registration. The policy is derived from that service set. |

Remove `devices.registration` from every manifest. It is not a deprecated alias: the validator
rejects it and names the service-state replacement.
