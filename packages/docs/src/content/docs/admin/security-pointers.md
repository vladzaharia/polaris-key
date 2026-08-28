---
title: "Where the security material lives"
description: "The disclosure policy, and why the threat model and audit findings stay repo-only."
sidebar:
  order: 11
---

Two different kinds of security material exist for this platform, meant for two different
audiences. This page is a pointer, not a copy — nothing below is mirrored onto this site.

## The disclosure policy — public, at the repo root

[`SECURITY.md`](https://github.com/vladzaharia/polaris-key/blob/main/SECURITY.md) is the one
document in this list meant to be read by someone **outside** the platform-admin gate: how to
report a vulnerability privately (a GitHub security advisory or email, never a public issue),
response-time targets, what's in and out of scope, and the accepted-risk boundary — a licensed
user bypassing client-side enforcement on their own machine is documented and out of scope; the
same bypass yielding something the *server* would not have sent is very much in scope.

## The threat model, wire contract, and audit — repo-only by decision

`docs/security/` holds the platform's own security reasoning, and it is **not** published to
this site, on the same "repo-only by decision" basis the wire contract's normative spec already
documents at [The wire contract](/docs/build/wire/#where-the-truth-lives-in-repo). Reaching
these files means having a checkout, not an admin session — a deliberate extra step, on top of
the gate this whole `/docs` site already sits behind.

| What | Path |
| --- | --- |
| The threat model — what's promised, what's explicitly not, and why | `docs/security/THREAT-MODEL.md` |
| The normative wire contract (current) | `docs/security/WIRE-CONTRACT-V3.md` |
| Its predecessor (historical) | `docs/security/WIRE-CONTRACT-V2.md` |
| Architecture-level reasoning: anti-piracy realism, business-model fit, multi-tenant blast radius, operational resilience | `docs/security/arch/` |
| The point-in-time security audit | `docs/security/2026-08-26-security-audit.md` |
| Its findings, one file per risk category (control plane, crypto, licensing, client, isolation, release, supply chain, OIDC, injection, DoS, data, secrets) plus a baseline | `docs/security/findings/` |

You'll see this material cited throughout the worker's own source as short codes —
`R11-06`, `R6-05`, `R12-02`, and so on — wherever a comment explains why a piece of code exists
in the shape it does. Those codes name a specific file and finding under `docs/security/findings/`;
if you're reading a comment that cites one and want the finding it points at, that's where to
look.

## Why this section is last

Every other page in [Administering Polaris Key](/docs/admin/) describes what the console lets
you do and what happens when you do it. This page is the map to the material that explains *why*
the platform is shaped the way it is — read it after, not instead of, the pages that describe the
system as built.
