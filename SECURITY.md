# Security Policy

Polaris Key issues licensing credentials, signs managed-configuration documents, and
distributes application binaries to end-user machines. A vulnerability here can affect every
product on the platform and every machine running one of them, so we treat reports seriously
and want to hear about them early.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Report privately, by either route:

- **GitHub Security Advisories** — [open a draft advisory](https://github.com/vladzaharia/polaris-key/security/advisories/new)
  on this repository. This is preferred: it keeps the report, the fix, and the disclosure in one
  place.
- **Email** — `accounts@vlad.gg`, subject line starting `[polaris-key security]`.

Please include, as far as you have it:

- the affected component (Worker route, SDK and language, admin console, portal, release path);
- the version, commit, or deployment you tested against;
- what an attacker gains, and what access they need to start;
- reproduction steps or a proof-of-concept;
- anything you think we would get wrong about the impact.

You do not need a polished write-up. A rough report of something real is worth more than a
tidy report of something theoretical.

## What we commit to

|                                                | Target                                   |
| ---------------------------------------------- | ---------------------------------------- |
| Acknowledge your report                        | within **3 business days**               |
| Initial assessment and severity                | within **7 days**                        |
| Fix or documented mitigation for Critical/High | within **30 days**                       |
| Credit in the advisory                         | if you want it — tell us how to name you |

This is a small project maintained by one person. If a deadline is going to slip we will say so
rather than go quiet.

## Disclosure

We follow coordinated disclosure. We will agree a date with you, and we publish an advisory
once a fix is available to affected users — including when the fix requires an SDK upgrade
rather than only a server-side change. If you do not hear back within the acknowledgement
window, escalating publicly is reasonable.

## Scope

**In scope**

- The Worker at `key.plrs.im` and everything under `packages/worker/`
- The admin console and customer portal (`packages/admin/`)
- All six client SDKs — Node, React, Python, Swift, Godot, Kotlin (`packages/sdk-*`, `sdks/`)
- The shared wire contract and conformance corpus (`packages/shared-*`, `conformance/`)
- The release-distribution path: appcasts, `install.sh`, artifact serving, the GitHub App
  integration, and the webhook
- CI/CD workflows and the published npm / PyPI / SwiftPM / Maven packages

**Out of scope**

- Cloudflare's own infrastructure — report those to Cloudflare
- Denial of service demonstrated only by volume against production. If you have found an
  _asymmetric_ resource-exhaustion bug (one cheap request causing disproportionate work), that
  **is** in scope — describe it rather than demonstrating it at scale.
- Social engineering of the maintainer
- Vulnerabilities requiring a compromised identity provider's _signing keys_ (we do model
  malicious _claims_ from an IdP — those are in scope)
- Reports that a licensed user can bypass client-side enforcement on their own machine. This is
  a documented, accepted property of the design; see
  [`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md) §6 for what the licensing
  layer does and does not promise. A bypass that yields something the **server** would not have
  sent — product secrets, edge-mint tokens, another tenant's data — _is_ in scope and we want
  to hear about it.

## Testing guidance

Please test against your own local deployment. `pnpm dev` runs the Worker locally; the test
suite includes a full in-memory harness (`packages/worker/test/helpers.ts`). Do not test
against `key.plrs.im`, and do not access data belonging to anyone else.

## Known accepted risks

Some properties are deliberate trade-offs rather than defects. They are documented in
[`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md) so that reporters and
maintainers agree on what counts as a bug. If you think one of those trade-offs is wrong, that
is a legitimate thing to raise — open a normal issue for it.
