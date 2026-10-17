---
title: "Security material"
description: "Where the disclosure policy, the threat model and the wire contract live, and why the audit write-ups are not published."
type: "overview"
lastReviewed: "2026-10-16"
sidebar:
  order: 11
---

This page points to the security material. Nothing on it is copied to this site.

**Role required:** Platform admin.

| What                                                      | Where                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| How to report a vulnerability, response targets and scope | [`SECURITY.md`](https://github.com/vladzaharia/polaris-key/blob/main/SECURITY.md), public |
| What the platform promises, what it does not, and why     | `docs/security/THREAT-MODEL.md`, repo only                                                |
| The normative wire contract                               | `docs/security/WIRE-CONTRACT-V4.md`, repo only                                            |
| The previous wire contracts                               | `docs/security/WIRE-CONTRACT-V3.md` and `WIRE-CONTRACT-V2.md`, repo only                  |
| Multi-tenant blast radius and operational resilience      | `docs/security/arch/`, repo only                                                          |

The repo-only files need a checkout, not a console session. That is a decision, on top of the platform-admin gate on this section.

Worker source cites findings by short codes such as `R11-06`. They name a point-in-time audit. The exploit-level write-ups are not published; the threat model records the promises, and the attack suites in `packages/worker/test/attack/` pin each fix.

To report a problem, use the policy in `SECURITY.md`. To handle a leaked secret, see [Respond to a key compromise](/docs/operate/platform/runbook/respond-to-a-key-compromise/).
